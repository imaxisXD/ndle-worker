import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import {
	consumeClicks,
	deliverClick,
	parseQueuedClick,
} from "./click-delivery";
import { resolveFailedClick } from "./failed-click-recovery";
import { bodyHash, failedClickKeys } from "./failed-clicks";
import { createLogger } from "./log";
import type { AnalyticsEvent, Bindings } from "./types";

afterEach(() => mock.restore());

const event: AnalyticsEvent = {
	idempotency_key: "event-123",
	request_id: "event-123",
	occurred_at: new Date().toISOString(),
	link_slug: "test",
	short_url: "https://ndle.test/test",
	link_id: "link123",
	user_id: "user:account123",
	destination_url: "https://example.org/",
	redirect_status: 302,
	tracking_enabled: true,
	latency_ms_worker: 3,
	session_id: "session123",
	first_click_of_session: true,
	worker_datacenter: "BOM",
	worker_version: "test",
	user_agent: "browser",
	device_type: "desktop",
	browser: "Chrome",
	os: "Linux",
	ip_hash: "hashed",
	country: "IN",
	region: null,
	city: null,
	referer: null,
	utm_source: null,
	utm_medium: null,
	utm_campaign: null,
	utm_term: null,
	utm_content: null,
	is_bot: false,
	language: "en",
	timezone: null,
	variant_id: null,
};
const env = {
	CONVEX_URL: "https://example.convex.cloud",
	INGEST_ENDPOINT: "https://ingest.test/ingest",
	API_SECRET: "test",
	SHARED_SECRET: "test",
	LOG_LEVEL: "error",
} as Bindings;

function message(
	body: unknown = { version: 1, event },
	id = "queue-message-1",
) {
	return {
		body,
		id,
		attempts: 1,
		timestamp: new Date(),
		ack: mock(),
		retry: mock(),
	};
}
function click(id: string, fields: Partial<AnalyticsEvent> = {}) {
	return message(
		{
			version: 1,
			event: { ...event, ...fields, idempotency_key: id, request_id: id },
		},
		`message-${id}`,
	);
}
async function consume(
	items: Array<ReturnType<typeof message>>,
	bindings: Bindings = env,
) {
	await consumeClicks(
		{ queue: "test", messages: items, ackAll() {}, retryAll() {} },
		bindings,
	);
}
async function deliver(item: ReturnType<typeof message>) {
	await consume([item]);
}

type IngestRequest = {
	path: string;
	authorization: string | null;
	events: AnalyticsEvent[];
};
// Intercepts ingest HTTP. Batch bodies are `{ events }`; single bodies are one event.
function mockIngest(
	respond: (
		request: IngestRequest,
	) => Response | undefined | Promise<Response | undefined>,
) {
	const requests: IngestRequest[] = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const path = new URL(String(input)).pathname;
		const body = JSON.parse(String(init?.body));
		const request = {
			path,
			authorization: new Headers(init?.headers).get("Authorization"),
			events: path.endsWith("/batch") ? body.events : [body],
		};
		requests.push(request);
		return (await respond(request)) ?? batchResults(request);
	});
	return requests;
}
function batchResults(
	{ events }: IngestRequest,
	status: (event: AnalyticsEvent) => string = () => "recorded",
) {
	return Response.json({
		success: true,
		results: events.map((item, index) => ({
			index,
			idempotency_key: item.idempotency_key,
			status: status(item),
		})),
	});
}
function recordInConvex(outcome: unknown = { outcome: "recorded" }) {
	return spyOn(ConvexHttpClient.prototype, "mutation").mockResolvedValue(
		outcome,
	);
}
const convexRequestIds = (mutation: ReturnType<typeof recordInConvex>) =>
	mutation.mock.calls.map(
		(call) => (call[1] as { requestId: string }).requestId,
	);

test("retries a rejected ingest response without acknowledging or updating live counts", async () => {
	const send = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(null, { status: 503 }),
	);
	const mutation = recordInConvex();
	const item = message();
	await deliver(item);
	expect(send).toHaveBeenCalledTimes(1);
	expect(mutation).not.toHaveBeenCalled();
	expect(item.ack).not.toHaveBeenCalled();
	expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
});

test("retries network errors instead of losing the queued event", async () => {
	spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Network unavailable"),
	);
	const item = message();
	await deliver(item);
	expect(item.ack).not.toHaveBeenCalled();
	expect(item.retry).toHaveBeenCalledTimes(1);
});

test("replay keeps one event ID when Convex fails after ingest commits", async () => {
	const requests = mockIngest(() => undefined);
	const mutation = spyOn(ConvexHttpClient.prototype, "mutation")
		.mockRejectedValueOnce(new Error("Convex unavailable"))
		.mockResolvedValueOnce({ outcome: "duplicate" });
	const first = message();
	await deliver(first);
	const retry = message();
	await deliver(retry);
	expect(first.retry).toHaveBeenCalledTimes(1);
	expect(retry.ack).toHaveBeenCalledTimes(1);
	expect(requests.map((request) => request.events[0].idempotency_key)).toEqual([
		event.idempotency_key,
		event.idempotency_key,
	]);
	for (const call of mutation.mock.calls) {
		expect(call[1]).toMatchObject({
			requestId: event.idempotency_key,
			clickEvent: { occurredAt: Date.parse(event.occurred_at) },
		});
	}
});

for (const outcome of [
	"recorded",
	"duplicate",
	"link_deleted",
	"tracking_disabled",
	"too_old",
]) {
	test(`acknowledges the explicit Convex outcome ${outcome}`, async () => {
		mockIngest(() => undefined);
		recordInConvex({ outcome });
		const item = message();
		await deliver(item);
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	});
}

test("an unknown Convex result is not mistaken for a recorded click", async () => {
	mockIngest(() => undefined);
	recordInConvex({ processed: false });
	const item = message();
	await deliver(item);
	expect(item.ack).not.toHaveBeenCalled();
	expect(item.retry).toHaveBeenCalledTimes(1);
});

test("disabled tracking never sends personal event data downstream", async () => {
	const send = spyOn(globalThis, "fetch");
	const item = message({
		version: 1,
		event: { ...event, tracking_enabled: false },
	});
	await deliver(item);
	expect(send).not.toHaveBeenCalled();
	expect(item.ack).toHaveBeenCalledTimes(1);
});

test("malformed queued events retry if durable archival is unavailable", async () => {
	const send = spyOn(globalThis, "fetch");
	const item = message({
		version: 1,
		event: { ...event, request_id: "different-id" },
	});
	await deliver(item);
	expect(send).not.toHaveBeenCalled();
	expect(item.ack).not.toHaveBeenCalled();
	expect(item.retry).toHaveBeenCalledTimes(1);
	expect(() => parseQueuedClick({ version: 2, event })).toThrow();
});

test("one batch request carries every tracked click in queue order", async () => {
	const requests = mockIngest(() => undefined);
	const mutation = recordInConvex();
	const clicks = Array.from({ length: 25 }, (_, index) =>
		click(`event-${index}`),
	);
	const disabled = click("disabled", { tracking_enabled: false });
	const malformed = message(
		{ version: 1, event: { ...event, request_id: "different-id" } },
		"malformed",
	);
	await consume([disabled, ...clicks, malformed]);
	expect(requests).toHaveLength(1);
	expect(requests[0].path).toBe("/ingest/batch");
	expect(requests[0].authorization).toBe("Bearer test");
	expect(requests[0].events).toEqual(
		clicks.map((item) => (item.body as { event: AnalyticsEvent }).event),
	);
	for (const item of [...clicks, disabled]) {
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	}
	expect(malformed.retry).toHaveBeenCalledTimes(1);
	expect(convexRequestIds(mutation).sort()).toEqual(
		clicks.map((_, index) => `event-${index}`).sort(),
	);
});

test("more than 100 clicks are split into batches of at most 100", async () => {
	const requests = mockIngest(() => undefined);
	recordInConvex();
	const clicks = Array.from({ length: 205 }, (_, index) =>
		click(`event-${index}`),
	);
	await consume(clicks);
	expect(requests.map((request) => request.events.length)).toEqual([
		100, 100, 5,
	]);
	expect(requests.flatMap((request) => request.events)).toHaveLength(205);
	for (const item of clicks) expect(item.ack).toHaveBeenCalledTimes(1);
});

test("each batch result decides its own click's outcome", async () => {
	mockIngest((request) =>
		batchResults(request, (item) => item.idempotency_key),
	);
	const mutation = recordInConvex();
	const [recorded, duplicate, ignored, invalid, conflict] = [
		"recorded",
		"duplicate",
		"ignored",
		"invalid",
		"conflict",
	].map((status) => click(status));
	await consume([recorded, duplicate, ignored, invalid, conflict]);
	for (const item of [recorded, duplicate]) {
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	}
	// Only tracked clicks are sent, so "ignored" is retried like a rejection.
	for (const item of [ignored, invalid, conflict]) {
		expect(item.ack).not.toHaveBeenCalled();
		expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
	}
	expect(convexRequestIds(mutation).sort()).toEqual(["duplicate", "recorded"]);
});

test("an invalid result may omit the key it could not read", async () => {
	mockIngest(({ events }) =>
		Response.json({
			success: true,
			results: events.map((item, index) =>
				index === 0
					? { index, idempotency_key: null, status: "invalid" }
					: {
							index,
							idempotency_key: item.idempotency_key,
							status: "recorded",
						},
			),
		}),
	);
	recordInConvex();
	const [unreadable, recorded] = [click("unreadable"), click("recorded")];
	await consume([unreadable, recorded]);
	expect(unreadable.retry).toHaveBeenCalledTimes(1);
	expect(recorded.ack).toHaveBeenCalledTimes(1);
});

test("bot clicks are committed by ingest but never update live counts", async () => {
	mockIngest(() => undefined);
	const mutation = recordInConvex();
	const [bot, human] = [click("bot", { is_bot: true }), click("human")];
	await consume([bot, human]);
	expect(bot.ack).toHaveBeenCalledTimes(1);
	expect(human.ack).toHaveBeenCalledTimes(1);
	expect(convexRequestIds(mutation)).toEqual(["human"]);
});

test("Convex writes run at most 10 at a time", async () => {
	mockIngest(() => undefined);
	let active = 0;
	let peak = 0;
	spyOn(ConvexHttpClient.prototype, "mutation").mockImplementation(async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return { outcome: "recorded" };
	});
	const clicks = Array.from({ length: 35 }, (_, index) =>
		click(`event-${index}`),
	);
	await consume(clicks);
	expect(peak).toBe(10);
	for (const item of clicks) expect(item.ack).toHaveBeenCalledTimes(1);
});

test("a Convex failure retries only that click", async () => {
	mockIngest(() => undefined);
	spyOn(ConvexHttpClient.prototype, "mutation").mockImplementation(
		async (_mutation, args) => {
			if ((args as { requestId: string }).requestId === "failing")
				throw new Error("Convex unavailable");
			return { outcome: "recorded" };
		},
	);
	const [before, failing, after] = ["before", "failing", "after"].map((id) =>
		click(id),
	);
	await consume([before, failing, after]);
	expect(failing.ack).not.toHaveBeenCalled();
	expect(failing.retry).toHaveBeenCalledTimes(1);
	for (const item of [before, after]) {
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	}
});

for (const status of [202, 400, 409, 413, 500, 503]) {
	test(`a batch answered with HTTP ${status} retries every click`, async () => {
		mockIngest(() => Response.json({ success: true }, { status }));
		const mutation = recordInConvex();
		const clicks = ["first", "second", "third"].map((id) => click(id));
		await consume(clicks);
		for (const item of clicks) {
			expect(item.ack).not.toHaveBeenCalled();
			expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
		}
		expect(mutation).not.toHaveBeenCalled();
	});
}

for (const [name, reply] of [
	["success is not true", () => ({ success: false, results: [] })],
	["results are missing", () => ({ success: true })],
	[
		"a result is missing",
		(events: AnalyticsEvent[]) => ({
			success: true,
			results: events.slice(1).map((item, index) => ({
				index,
				idempotency_key: item.idempotency_key,
				status: "recorded",
			})),
		}),
	],
	[
		"indexes are out of order",
		(events: AnalyticsEvent[]) => ({
			success: true,
			results: events.map((item, index) => ({
				index: events.length - 1 - index,
				idempotency_key: item.idempotency_key,
				status: "recorded",
			})),
		}),
	],
	[
		"a key does not match its event",
		(events: AnalyticsEvent[]) => ({
			success: true,
			results: events.map((_, index) => ({
				index,
				idempotency_key: "another-event",
				status: "recorded",
			})),
		}),
	],
	[
		"a committed result has no key",
		(events: AnalyticsEvent[]) => ({
			success: true,
			results: events.map((_, index) => ({
				index,
				idempotency_key: null,
				status: "recorded",
			})),
		}),
	],
	[
		"a status is unknown",
		(events: AnalyticsEvent[]) => ({
			success: true,
			results: events.map((item, index) => ({
				index,
				idempotency_key: item.idempotency_key,
				status: "queued",
			})),
		}),
	],
] as const) {
	test(`a 200 batch response where ${name} retries every click`, async () => {
		mockIngest(({ events }) => Response.json(reply(events)));
		const mutation = recordInConvex();
		const clicks = ["first", "second"].map((id) => click(id));
		await consume(clicks);
		for (const item of clicks) {
			expect(item.ack).not.toHaveBeenCalled();
			expect(item.retry).toHaveBeenCalledTimes(1);
		}
		expect(mutation).not.toHaveBeenCalled();
	});
}

test("a 200 batch response that is not JSON retries every click", async () => {
	mockIngest(() => new Response("committed", { status: 200 }));
	const clicks = ["first", "second"].map((id) => click(id));
	await consume(clicks);
	for (const item of clicks) expect(item.retry).toHaveBeenCalledTimes(1);
});

test("an ingest without the batch route falls back to per-click delivery", async () => {
	const requests = mockIngest(({ path, events }) =>
		path.endsWith("/batch")
			? new Response("Not found", { status: 404 })
			: Response.json(
					{
						success: true,
						status: "queued",
						idempotency_key: events[0].idempotency_key,
						committed: true,
						outcome: "recorded",
					},
					{ status: 202 },
				),
	);
	const mutation = recordInConvex();
	const clicks = ["first", "second", "third"].map((id) => click(id));
	await consume(clicks);
	expect(requests.map((request) => request.path)).toEqual([
		"/ingest/batch",
		"/ingest",
		"/ingest",
		"/ingest",
	]);
	expect(
		requests.slice(1).map((request) => request.events[0].idempotency_key),
	).toEqual(["first", "second", "third"]);
	for (const item of clicks) expect(item.ack).toHaveBeenCalledTimes(1);
	expect(mutation).toHaveBeenCalledTimes(3);
});

test("per-click delivery still refuses an ignored response for a tracked click", async () => {
	mockIngest(({ events }) =>
		Response.json(
			{
				success: true,
				status: "ignored",
				idempotency_key: events[0].idempotency_key,
			},
			{ status: 202 },
		),
	);
	const mutation = recordInConvex();
	await expect(deliverClick(event, env)).rejects.toThrow(
		"did not confirm this event was accepted",
	);
	expect(mutation).not.toHaveBeenCalled();
});

test("incomplete delivery settings retry every tracked click without sending", async () => {
	const send = spyOn(globalThis, "fetch");
	const clicks = ["first", "second"].map((id) => click(id));
	await consume(clicks, { ...env, API_SECRET: undefined } as Bindings);
	expect(send).not.toHaveBeenCalled();
	for (const item of clicks) expect(item.retry).toHaveBeenCalledTimes(1);
});

test("logs retain the request ID, reason, and readable error", () => {
	const write = spyOn(console, "error").mockImplementation(() => {});
	createLogger("error", { request_id: "event-123" }).error("Delivery failed", {
		reason: "unavailable",
		error: new Error("Try again"),
	});
	expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
		request_id: "event-123",
		reason: "unavailable",
		error: { message: "Try again" },
	});
});

function acceptIngest() {
	const calls: Array<{ path: string; authorization: string | null }> = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		calls.push({
			path: url.pathname,
			authorization: new Headers(init?.headers).get("Authorization"),
		});
		return url.pathname === "/internal/events/receipt"
			? Response.json({
					idempotency_key: event.idempotency_key,
					committed: true,
					user_id: event.user_id,
					occurred_at: event.occurred_at,
					link_id: event.link_id,
				})
			: Response.json(
					{
						success: true,
						status: "queued",
						idempotency_key: event.idempotency_key,
					},
					{ status: 202 },
				);
	});
	spyOn(ConvexHttpClient.prototype, "mutation").mockResolvedValue({
		outcome: "recorded",
	});
	return calls;
}

async function archivedClick() {
	const body = {
		encoding: "json" as const,
		data: JSON.stringify({ version: 1, event }),
	};
	const keys = failedClickKeys("ndle-click-events-failed", "message-1");
	const archive = {
		version: 1,
		source: {
			queue: "ndle-click-events-failed",
			messageId: "message-1",
			sentAt: event.occurred_at,
			attempts: 1,
		},
		archivedAt: event.occurred_at,
		reason: "delivery_failed",
		eventId: event.idempotency_key,
		body,
		bodySha256: await bodyHash(body),
	};
	const bucket = {
		get: async (key: string) =>
			key === keys.archive ? { size: 1, json: async () => archive } : null,
	} as unknown as R2Bucket;
	return { key: keys.archive, bucket };
}

const scopedSecrets = [
	{ secrets: { API_SECRET: "shared" }, write: "shared", ops: "shared" },
	{
		secrets: {
			API_SECRET: "shared",
			INGEST_WRITE_SECRET: "write",
			OPS_SECRET: "ops",
		},
		write: "write",
		ops: "ops",
	},
	{
		secrets: { INGEST_WRITE_SECRET: "write", OPS_SECRET: "ops" },
		write: "write",
		ops: "ops",
	},
];

for (const { secrets, write, ops } of scopedSecrets) {
	const names = Object.keys(secrets).join(", ");
	const secretEnv = { ...env, API_SECRET: undefined, ...secrets } as Bindings;

	test(`click delivery authorizes ingest with ${write} given ${names}`, async () => {
		const calls = acceptIngest();
		expect(await deliverClick(event, secretEnv)).toBe("recorded");
		expect(calls).toEqual([
			{ path: "/ingest", authorization: `Bearer ${write}` },
		]);
	});

	test(`batch delivery authorizes ingest with ${write} given ${names}`, async () => {
		const requests = mockIngest(() => undefined);
		recordInConvex();
		const item = message();
		await consume([item], secretEnv);
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(
			requests.map(({ path, authorization }) => ({ path, authorization })),
		).toEqual([{ path: "/ingest/batch", authorization: `Bearer ${write}` }]);
	});

	test(`resolve checks the receipt with ${ops} and delivers with ${write} given ${names}`, async () => {
		const { key, bucket } = await archivedClick();
		const calls = acceptIngest();
		// The fake bucket has no unresolved marker, so resolution stops after
		// both authenticated ingest requests.
		await expect(resolveFailedClick(key, bucket, secretEnv)).rejects.toThrow(
			"no unresolved marker",
		);
		expect(calls).toEqual([
			{ path: "/internal/events/receipt", authorization: `Bearer ${ops}` },
			{ path: "/ingest", authorization: `Bearer ${write}` },
		]);
	});
}

test("click delivery settings are incomplete without a write or shared secret", async () => {
	const send = spyOn(globalThis, "fetch");
	await expect(
		deliverClick(event, {
			...env,
			API_SECRET: undefined,
			OPS_SECRET: "ops",
		} as Bindings),
	).rejects.toThrow("Click delivery settings are incomplete");
	expect(send).not.toHaveBeenCalled();
});

for (const secrets of [
	{ OPS_SECRET: "ops" },
	{ INGEST_WRITE_SECRET: "write" },
	{},
]) {
	test(`resolve refuses to start with only ${Object.keys(secrets).join(", ") || "no ingest secret"}`, async () => {
		const { key, bucket } = await archivedClick();
		const send = spyOn(globalThis, "fetch");
		await expect(
			resolveFailedClick(key, bucket, {
				...env,
				API_SECRET: undefined,
				...secrets,
			} as Bindings),
		).rejects.toThrow("to verify delivery");
		expect(send).not.toHaveBeenCalled();
	});
}
