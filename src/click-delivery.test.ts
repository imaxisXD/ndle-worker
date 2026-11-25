import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { consumeClicks, deliverClick } from "./click-delivery";
import { parseQueuedClick } from "./click-envelope";
import type { RecordClickArgs } from "./convex-api";
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

function message(body: unknown = { version: 1, event }, id = "queue-message-1") {
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
async function consume(items: Array<ReturnType<typeof message>>, bindings: Bindings = env) {
	await consumeClicks({ queue: "test", messages: items, ackAll() {}, retryAll() {} }, bindings);
}
async function deliver(item: ReturnType<typeof message>) {
	await consume([item]);
}

type IngestRequest = {
	path: string;
	authorization: string | null;
	events: AnalyticsEvent[];
};

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

type MockTransportOptions = {
	ingest?: (request: IngestRequest) => Response | undefined | Promise<Response | undefined>;
	convex?: (args: RecordClickArgs) => unknown | Promise<unknown>;
};

// Intercepts both ingest HTTP and Convex `/api/mutation` HTTP calls.
function mockTransport(options: MockTransportOptions = {}) {
	const ingestRequests: IngestRequest[] = [];
	const convexCalls: RecordClickArgs[] = [];
	const convexHandler = options.convex ?? (async () => ({ outcome: "recorded" }));

	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const path = url.pathname;
		if (path === "/api/mutation") {
			const parsed = JSON.parse(String(init?.body)) as {
				args: [RecordClickArgs];
			};
			const args = parsed.args[0];
			convexCalls.push(args);
			try {
				const value = await convexHandler(args);
				return Response.json({ status: "success", value });
			} catch (error) {
				return Response.json(
					{
						status: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
					},
					{ status: 560 },
				);
			}
		}
		const body = JSON.parse(String(init?.body));
		const request: IngestRequest = {
			path,
			authorization: new Headers(init?.headers).get("Authorization"),
			events: path.endsWith("/batch") ? body.events : [body],
		};
		ingestRequests.push(request);
		return (await options.ingest?.(request)) ?? batchResults(request);
	});
	return { ingestRequests, convexCalls, fetchSpy };
}

test("retries a rejected ingest response without acknowledging or updating live counts", async () => {
	const { ingestRequests, convexCalls } = mockTransport({
		ingest: () => new Response(null, { status: 503 }),
	});
	const item = message();
	await deliver(item);
	expect(ingestRequests).toHaveLength(1);
	expect(convexCalls).toHaveLength(0);
	expect(item.ack).not.toHaveBeenCalled();
	expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
});

test("retries network errors instead of losing the queued event", async () => {
	spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network unavailable"));
	const item = message();
	await deliver(item);
	expect(item.ack).not.toHaveBeenCalled();
	expect(item.retry).toHaveBeenCalledTimes(1);
});

test("replay keeps one event ID when Convex fails after ingest commits", async () => {
	let convexAttempts = 0;
	const { ingestRequests, convexCalls } = mockTransport({
		convex: async () => {
			convexAttempts++;
			if (convexAttempts === 1) throw new Error("Convex unavailable");
			return { outcome: "duplicate" };
		},
	});
	const first = message();
	await deliver(first);
	const retry = message();
	await deliver(retry);
	expect(first.retry).toHaveBeenCalledTimes(1);
	expect(retry.ack).toHaveBeenCalledTimes(1);
	expect(ingestRequests.map((request) => request.events[0].idempotency_key)).toEqual([
		event.idempotency_key,
		event.idempotency_key,
	]);
	for (const call of convexCalls) {
		expect(call).toMatchObject({
			requestId: event.idempotency_key,
			clickEvent: { occurredAt: Date.parse(event.occurred_at) },
		});
	}
});

for (const outcome of ["recorded", "duplicate", "link_deleted", "tracking_disabled", "too_old"]) {
	test(`acknowledges the explicit Convex outcome ${outcome}`, async () => {
		mockTransport({ convex: async () => ({ outcome }) });
		const item = message();
		await deliver(item);
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	});
}

test("an unknown Convex result is not mistaken for a recorded click", async () => {
	mockTransport({ convex: async () => ({ processed: false }) });
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
	const { ingestRequests, convexCalls } = mockTransport();
	const clicks = Array.from({ length: 25 }, (_, index) => click(`event-${index}`));
	const disabled = click("disabled", { tracking_enabled: false });
	const malformed = message(
		{ version: 1, event: { ...event, request_id: "different-id" } },
		"malformed",
	);
	await consume([disabled, ...clicks, malformed]);
	expect(ingestRequests).toHaveLength(1);
	expect(ingestRequests[0].path).toBe("/ingest/batch");
	expect(ingestRequests[0].authorization).toBe("Bearer test");
	expect(ingestRequests[0].events).toEqual(
		clicks.map((item) => (item.body as { event: AnalyticsEvent }).event),
	);
	for (const item of [...clicks, disabled]) {
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	}
	expect(malformed.retry).toHaveBeenCalledTimes(1);
	expect(convexCalls.map((call) => call.requestId).sort()).toEqual(
		clicks.map((_, index) => `event-${index}`).sort(),
	);
});

test("more than 100 clicks are split into batches of at most 100", async () => {
	const { ingestRequests } = mockTransport();
	const clicks = Array.from({ length: 205 }, (_, index) => click(`event-${index}`));
	await consume(clicks);
	expect(ingestRequests.map((request) => request.events.length)).toEqual([100, 100, 5]);
	expect(ingestRequests.flatMap((request) => request.events)).toHaveLength(205);
	for (const item of clicks) expect(item.ack).toHaveBeenCalledTimes(1);
});

test("each batch result decides its own click's outcome", async () => {
	const { convexCalls } = mockTransport({
		ingest: (request) => batchResults(request, (item) => item.idempotency_key),
	});
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
	expect(convexCalls.map((call) => call.requestId).sort()).toEqual(["duplicate", "recorded"]);
});

test("an invalid result may omit the key it could not read", async () => {
	mockTransport({
		ingest: ({ events }) =>
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
	});
	const [unreadable, recorded] = [click("unreadable"), click("recorded")];
	await consume([unreadable, recorded]);
	expect(unreadable.retry).toHaveBeenCalledTimes(1);
	expect(recorded.ack).toHaveBeenCalledTimes(1);
});

test("bot clicks are committed by ingest but never update live counts", async () => {
	const { convexCalls } = mockTransport();
	const [bot, human] = [click("bot", { is_bot: true }), click("human")];
	await consume([bot, human]);
	expect(bot.ack).toHaveBeenCalledTimes(1);
	expect(human.ack).toHaveBeenCalledTimes(1);
	expect(convexCalls.map((call) => call.requestId)).toEqual(["human"]);
});

test("Convex writes run at most 10 at a time", async () => {
	let active = 0;
	let peak = 0;
	mockTransport({
		convex: async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return { outcome: "recorded" };
		},
	});
	const clicks = Array.from({ length: 35 }, (_, index) => click(`event-${index}`));
	await consume(clicks);
	expect(peak).toBe(10);
	for (const item of clicks) expect(item.ack).toHaveBeenCalledTimes(1);
});

test("a Convex failure retries only that click", async () => {
	mockTransport({
		convex: async (args) => {
			if (args.requestId === "failing") throw new Error("Convex unavailable");
			return { outcome: "recorded" };
		},
	});
	const [before, failing, after] = ["before", "failing", "after"].map((id) => click(id));
	await consume([before, failing, after]);
	expect(failing.ack).not.toHaveBeenCalled();
	expect(failing.retry).toHaveBeenCalledTimes(1);
	for (const item of [before, after]) {
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	}
});

for (const status of [202, 400, 404, 409, 413, 500, 503]) {
	test(`a batch answered with HTTP ${status} retries every click`, async () => {
		const { convexCalls } = mockTransport({
			ingest: () => Response.json({ success: true }, { status }),
		});
		const clicks = ["first", "second", "third"].map((id) => click(id));
		await consume(clicks);
		for (const item of clicks) {
			expect(item.ack).not.toHaveBeenCalled();
			expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
		}
		expect(convexCalls).toHaveLength(0);
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
		const { convexCalls } = mockTransport({
			ingest: ({ events }) => Response.json(reply(events)),
		});
		const clicks = ["first", "second"].map((id) => click(id));
		await consume(clicks);
		for (const item of clicks) {
			expect(item.ack).not.toHaveBeenCalled();
			expect(item.retry).toHaveBeenCalledTimes(1);
		}
		expect(convexCalls).toHaveLength(0);
	});
}

test("a 200 batch response that is not JSON retries every click", async () => {
	mockTransport({
		ingest: () => new Response("committed", { status: 200 }),
	});
	const clicks = ["first", "second"].map((id) => click(id));
	await consume(clicks);
	for (const item of clicks) expect(item.retry).toHaveBeenCalledTimes(1);
});

test("per-click delivery still refuses an ignored response for a tracked click", async () => {
	const { convexCalls } = mockTransport({
		ingest: ({ events }) =>
			Response.json(
				{
					success: true,
					status: "ignored",
					idempotency_key: events[0].idempotency_key,
				},
				{ status: 202 },
			),
	});
	await expect(deliverClick(event, env)).rejects.toThrow("did not confirm this event was accepted");
	expect(convexCalls).toHaveLength(0);
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
		if (url.pathname === "/api/mutation") {
			return Response.json({
				status: "success",
				value: { outcome: "recorded" },
			});
		}
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
		expect(calls).toEqual([{ path: "/ingest", authorization: `Bearer ${write}` }]);
	});

	test(`batch delivery authorizes ingest with ${write} given ${names}`, async () => {
		const { ingestRequests } = mockTransport();
		const item = message();
		await consume([item], secretEnv);
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(
			ingestRequests.map(({ path, authorization }) => ({
				path,
				authorization,
			})),
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

for (const secrets of [{ OPS_SECRET: "ops" }, { INGEST_WRITE_SECRET: "write" }, {}]) {
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

test("a click with a field ingest would reject is archived, not retried", async () => {
	const { ingestRequests } = mockTransport();
	const objects = new Map<string, string>();
	const bucket = {
		async put(key: string, value: string) {
			if (objects.has(key)) return null;
			objects.set(key, value);
			return {};
		},
		async get(key: string) {
			const value = objects.get(key);
			return value === undefined
				? null
				: {
						size: value.length,
						json: async () => JSON.parse(value),
						text: async () => value,
					};
		},
	};
	const oversized = click("oversized", { utm_source: "a".repeat(8193) });
	const longOwner = click("long-owner", { user_id: "u".repeat(257) });
	await consume([oversized, longOwner], {
		...env,
		FAILED_CLICK_ARCHIVES: bucket,
	} as unknown as Bindings);
	expect(() => parseQueuedClick(oversized.body)).toThrow(
		"Click event has a field longer than ingest accepts",
	);
	expect(ingestRequests).toHaveLength(0);
	for (const item of [oversized, longOwner]) {
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	}
	const archives = [...objects.entries()]
		.filter(([key]) => key.includes("/archive/"))
		.map(([, value]) => JSON.parse(value).reason);
	expect(archives).toEqual(["invalid_event", "invalid_event"]);
});
