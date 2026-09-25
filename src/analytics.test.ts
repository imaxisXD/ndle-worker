import { expect, mock, test } from "bun:test";
import {
	batchEndpoint,
	sendAnalyticsBatch,
	sendAnalyticsEvent,
} from "./analytics";
import type { AnalyticsEvent } from "./types";

const event = {
	idempotency_key: "event-123",
	request_id: "event-123",
	occurred_at: "2026-09-05T18:00:00.000Z",
	link_slug: "test",
	short_url: "https://ndle.fyi/test",
	destination_url: "https://example.org/",
	redirect_status: 302,
	tracking_enabled: true,
	latency_ms_worker: 3,
	first_click_of_session: true,
	worker_datacenter: "BOM",
	worker_version: "test",
	user_agent: "browser",
	ip_hash: "hashed",
	country: "IN",
	is_bot: false,
} satisfies Partial<AnalyticsEvent>;

test("the batch route is derived from INGEST_ENDPOINT", () => {
	expect(batchEndpoint("https://api.ndle.app/ingest")).toBe(
		"https://api.ndle.app/ingest/batch",
	);
	expect(batchEndpoint("https://api.ndle.app/ingest/")).toBe(
		"https://api.ndle.app/ingest/batch",
	);
});

test("a batch sends the same normalized events as single delivery", async () => {
	const bodies: unknown[] = [];
	const fetchImpl = mock(async (_input: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return Response.json(
			bodies.length === 1
				? {
						success: true,
						results: [
							{ index: 0, idempotency_key: "event-123", status: "recorded" },
						],
					}
				: { success: true, status: "queued", idempotency_key: "event-123" },
			{ status: bodies.length === 1 ? 200 : 202 },
		);
	}) as unknown as typeof fetch;
	const target = { endpoint: "https://api.ndle.app/ingest", token: "t" };
	expect(
		await sendAnalyticsBatch({ ...target, events: [event], fetchImpl }),
	).toEqual(["recorded"]);
	expect(await sendAnalyticsEvent({ ...target, event, fetchImpl })).toBe(
		"queued",
	);
	expect(bodies[0]).toEqual({ events: [bodies[1]] });
});

test("a batch must contain 1 to 100 events", async () => {
	const fetchImpl = mock() as unknown as typeof fetch;
	const target = { endpoint: "https://api.ndle.app/ingest", token: "t" };
	for (const events of [[], Array.from({ length: 101 }, () => event)])
		await expect(
			sendAnalyticsBatch({ ...target, events, fetchImpl }),
		).rejects.toThrow("1 to 100 events");
	expect(fetchImpl).not.toHaveBeenCalled();
});

test("single delivery tolerates the synchronous-commit receipt fields", async () => {
	const fetchImpl = mock(async () =>
		Response.json(
			{
				success: true,
				status: "queued",
				idempotency_key: "event-123",
				committed: true,
				outcome: "duplicate",
			},
			{ status: 202 },
		),
	) as unknown as typeof fetch;
	expect(
		await sendAnalyticsEvent({
			endpoint: "https://api.ndle.app/ingest",
			token: "t",
			event,
			fetchImpl,
		}),
	).toBe("queued");
});
