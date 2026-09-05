import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { consumeClicks, parseQueuedClick } from "./click-delivery";
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

function message(body: unknown = { version: 1, event }) {
	return {
		body,
		id: "queue-message-1",
		attempts: 1,
		timestamp: new Date(),
		ack: mock(),
		retry: mock(),
	};
}
async function deliver(item: ReturnType<typeof message>) {
	await consumeClicks(
		{ queue: "test", messages: [item], ackAll() {}, retryAll() {} },
		env,
	);
}

test("retries a rejected ingest response without acknowledging or updating live counts", async () => {
	const send = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(null, { status: 503 }),
	);
	const mutation = spyOn(
		ConvexHttpClient.prototype,
		"mutation",
	).mockResolvedValue({ outcome: "recorded" });
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

test("replay keeps one event ID when Convex fails after ingest accepts", async () => {
	const deliveredIds: string[] = [];
	spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		deliveredIds.push(JSON.parse(String(init?.body)).idempotency_key);
		return Response.json(
			{
				success: true,
				status: "queued",
				idempotency_key: event.idempotency_key,
			},
			{ status: 202 },
		);
	});
	const mutation = spyOn(ConvexHttpClient.prototype, "mutation")
		.mockRejectedValueOnce(new Error("Convex unavailable"))
		.mockResolvedValueOnce({ outcome: "duplicate" });
	const first = message();
	await deliver(first);
	const retry = message();
	await deliver(retry);
	expect(first.retry).toHaveBeenCalledTimes(1);
	expect(retry.ack).toHaveBeenCalledTimes(1);
	expect(deliveredIds).toEqual([event.idempotency_key, event.idempotency_key]);
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
		spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(
				{
					success: true,
					status: "queued",
					idempotency_key: event.idempotency_key,
				},
				{ status: 202 },
			),
		);
		spyOn(ConvexHttpClient.prototype, "mutation").mockResolvedValue({
			outcome,
		});
		const item = message();
		await deliver(item);
		expect(item.ack).toHaveBeenCalledTimes(1);
		expect(item.retry).not.toHaveBeenCalled();
	});
}

test("an unknown Convex result is not mistaken for a recorded click", async () => {
	spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json(
			{
				success: true,
				status: "queued",
				idempotency_key: event.idempotency_key,
			},
			{ status: 202 },
		),
	);
	spyOn(ConvexHttpClient.prototype, "mutation").mockResolvedValue({
		processed: false,
	});
	const item = message();
	await deliver(item);
	expect(item.ack).not.toHaveBeenCalled();
	expect(item.retry).toHaveBeenCalledTimes(1);
});

test("a successful HTTP status without this event's durable receipt is retried", async () => {
	spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json(
			{ success: true, status: "queued", idempotency_key: "another-event" },
			{ status: 202 },
		),
	);
	const mutation = spyOn(ConvexHttpClient.prototype, "mutation");
	const item = message();
	await deliver(item);
	expect(item.ack).not.toHaveBeenCalled();
	expect(item.retry).toHaveBeenCalledTimes(1);
	expect(mutation).not.toHaveBeenCalled();
});

test("an explicit ignored ingest receipt does not increment the live view", async () => {
	spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json(
			{
				success: true,
				status: "ignored",
				idempotency_key: event.idempotency_key,
			},
			{ status: 202 },
		),
	);
	const mutation = spyOn(ConvexHttpClient.prototype, "mutation");
	const item = message();
	await deliver(item);
	expect(item.ack).toHaveBeenCalledTimes(1);
	expect(mutation).not.toHaveBeenCalled();
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

test("malformed queued events are retained for retries and dead letter inspection", async () => {
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
