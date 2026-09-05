import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { buildAlert, checkClickQueue, checkOperations } from "./operations";
import type { Bindings } from "./types";

afterEach(() => mock.restore());
const now = Date.parse("2026-09-05T18:00:00Z");
const empty = { backlogCount: 0, backlogBytes: 0 };
const manifest = {
	version: 3,
	key: "snapshots/duckdb/release-check/analytics.duckdb",
	size: 1024,
	sha256: "a".repeat(64),
	createdAt: new Date(now - 60_000).toISOString(),
};
const healthy = {
	status: "ok",
	checks: { queue: { details: { waiting: 0, failed: 0 } } },
};

function environment() {
	return {
		OPS_ALERTS_ENABLED: "true",
		OPS_ALERT_FROM: "NDLE <alerts@example.test>",
		OPS_ALERT_TO: "owner@example.test",
		RESEND_API_KEY: "send-only-test-key",
		API_SECRET: "ingest-test-key",
		INGEST_ENDPOINT: "https://api.ndle.app/ingest",
		MONITOR_READY_ENDPOINT: "https://monitor.ndle.app/ready",
		CLICK_EVENTS: { metrics: async () => empty },
		CLICK_EVENTS_FAILED: { metrics: async () => empty },
		FAILED_CLICK_ARCHIVES: {
			list: async () => ({ objects: [], truncated: false }),
		},
		ANALYTICS_BACKUPS: {
			get: async () => ({ size: 300, json: async () => manifest }),
			head: async () => ({ size: manifest.size }),
		},
	} as Bindings;
}

test("healthy checks read only metrics and the verified backup and send no email", async () => {
	const env = environment();
	const calls: Array<{ url: string; headers: Headers }> = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		calls.push({ url: String(input), headers: new Headers(init?.headers) });
		return Response.json(
			String(input).includes("/health/detailed")
				? healthy
				: { status: "ready" },
		);
	});
	await checkOperations(env, now);
	expect(calls.map((call) => call.url)).toEqual([
		"https://api.ndle.app/health/ready",
		"https://api.ndle.app/health/detailed",
		"https://monitor.ndle.app/ready",
	]);
	expect(calls[0].headers.get("Authorization")).toBeNull();
	expect(calls[1].headers.get("Authorization")).toBe("Bearer ingest-test-key");
	expect(calls[2].headers.get("Authorization")).toBeNull();
});

test("queue age and size thresholds do not flag a small fresh backlog", () => {
	expect(
		checkClickQueue(
			{
				backlogCount: 1,
				backlogBytes: 100,
				oldestMessageTimestamp: new Date(now),
			},
			now,
		),
	).toEqual([]);
	expect(
		checkClickQueue(
			{
				backlogCount: 10_001,
				backlogBytes: 101 * 1024 * 1024,
				oldestMessageTimestamp: new Date(now - 6 * 60_000),
			},
			now,
		),
	).toEqual(["click_queue_old", "click_queue_large"]);
	expect(
		checkClickQueue(
			{ ...empty, oldestMessageTimestamp: new Date(now - 60 * 60_000) },
			now,
		),
	).toEqual([]);
});

test("several failing checks send one bounded alert with the same retry key and body", async () => {
	const env = environment();
	env.CLICK_EVENTS.metrics = async () => ({
		backlogCount: 1,
		backlogBytes: 100,
		oldestMessageTimestamp: new Date(now - 6 * 60_000),
	});
	env.CLICK_EVENTS_FAILED.metrics = async () => ({
		backlogCount: 1,
		backlogBytes: 100,
	});
	env.ANALYTICS_BACKUPS.head = mock(async () => null);
	const emails: Array<{ headers: Headers; body: string }> = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		if (String(input).includes("resend.com")) {
			emails.push({
				headers: new Headers(init?.headers),
				body: String(init?.body),
			});
			return Response.json({ id: "accepted-email" });
		}
		return Response.json(
			String(input).includes("/health/detailed")
				? {
						status: "ok",
						checks: { queue: { details: { waiting: 0, failed: 1 } } },
					}
				: { status: "not ready" },
		);
	});
	await checkOperations(env, now);
	await checkOperations(env, now + 5 * 60_000);
	expect(emails).toHaveLength(2);
	expect(emails[0].headers.get("Idempotency-Key")).toBe(
		emails[1].headers.get("Idempotency-Key"),
	);
	expect(emails[0].body).toBe(emails[1].body);
	expect(emails[0].headers.get("Idempotency-Key")?.length).toBeLessThan(256);
	const message = JSON.parse(emails[0].body);
	expect(message.to).toEqual(["owner@example.test"]);
	expect(message.text).toContain("more than 5 minutes");
	expect(message.text).toContain("failed event jobs");
	expect(message.text).toContain("missing or invalid");
	expect(message.text).not.toContain("ingest-test-key");
});

test("expired backups and failed metric reads produce actionable alerts", async () => {
	const env = environment();
	env.CLICK_EVENTS.metrics = async () => {
		throw new Error("Queue request failed");
	};
	env.ANALYTICS_BACKUPS.get = mock(async () => ({
		size: 300,
		json: async () => ({
			...manifest,
			createdAt: new Date(now - 27 * 60 * 60_000).toISOString(),
		}),
	}));
	let text = "";
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		if (String(input).includes("resend.com")) {
			text = JSON.parse(String(init?.body)).text;
			return Response.json({ id: "accepted" });
		}
		return Response.json(
			String(input).includes("/health/detailed")
				? healthy
				: { status: "ready" },
		);
	});
	await checkOperations(env, now);
	expect(text).toContain("more than 26 hours");
	expect(text).toContain("delivery queue could not be checked");
});

test("provider rejection fails the run instead of claiming email delivery", async () => {
	const env = environment();
	env.CLICK_EVENTS_FAILED.metrics = async () => ({
		backlogCount: 1,
		backlogBytes: 100,
	});
	spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		if (String(input).includes("resend.com"))
			return Response.json({ message: "Unavailable" }, { status: 503 });
		return Response.json(
			String(input).includes("/health/detailed")
				? healthy
				: { status: "ready" },
		);
	});
	await expect(checkOperations(env, now)).rejects.toThrow(
		"email was not accepted (HTTP 503)",
	);
});

test("development is silent and reminder keys change only at the next hour", async () => {
	const env = environment();
	env.OPS_ALERTS_ENABLED = "false";
	const send = spyOn(globalThis, "fetch");
	await checkOperations(env, now);
	expect(send).not.toHaveBeenCalled();
	expect(buildAlert(["failed_clicks", "backup_old"], now)).toEqual(
		buildAlert(
			["backup_old", "failed_clicks", "failed_clicks"],
			now + 5 * 60_000,
		),
	);
	expect(buildAlert(["failed_clicks"], now).key).not.toBe(
		buildAlert(["failed_clicks"], now + 60 * 60_000).key,
	);
});

test("an unready database alerts even when detailed component checks look healthy", async () => {
	let text = "";
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (url.includes("resend.com")) {
			text = JSON.parse(String(init?.body)).text;
			return Response.json({ id: "accepted" });
		}
		if (url.includes("/health/ready"))
			return Response.json({ status: "not_ready" }, { status: 503 });
		return Response.json(
			url.includes("/health/detailed") ? healthy : { status: "ready" },
		);
	});
	await checkOperations(environment(), now);
	expect(text).toContain("analytics service is unavailable");
});

test("stalled native bindings cannot suppress a known failed-event alert", async () => {
	const env = environment();
	env.CLICK_EVENTS.metrics = () => new Promise(() => {});
	env.ANALYTICS_BACKUPS.get = mock(() => new Promise(() => {}));
	env.CLICK_EVENTS_FAILED.metrics = async () => ({
		backlogCount: 1,
		backlogBytes: 100,
	});
	let text = "";
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		if (String(input).includes("resend.com")) {
			text = JSON.parse(String(init?.body)).text;
			return Response.json({ id: "accepted" });
		}
		return Response.json(
			String(input).includes("/health/detailed")
				? healthy
				: { status: "ready" },
		);
	});
	await checkOperations(env, now, fetch, 10);
	expect(text).toContain("delivery queue could not be checked");
	expect(text).toContain("failed-click queue contains events");
	expect(text).toContain("backup or its manifest is missing or invalid");
});

test("redirected health checks alert and redirected email delivery fails without following", async () => {
	const calls: string[] = [];
	let message = "";
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		calls.push(String(input));
		// Cloudflare only supports follow and manual. Manual also keeps service
		// credentials from being forwarded to an unexpected redirect destination.
		expect(init?.redirect).toBe("manual");
		if (String(input).includes("resend.com"))
			message = JSON.parse(String(init?.body)).text;
		return Response.json(
			{ status: "ready", id: "not-an-email-receipt" },
			{ status: 302, headers: { Location: "https://unexpected.example.test" } },
		);
	});
	await expect(checkOperations(environment(), now)).rejects.toThrow(
		"email was not accepted (HTTP 302)",
	);
	expect(message).toContain("analytics service is unavailable");
	expect(message).toContain("link-monitoring service did not pass");
	expect(calls).toEqual([
		"https://api.ndle.app/health/ready",
		"https://api.ndle.app/health/detailed",
		"https://monitor.ndle.app/ready",
		"https://api.resend.com/emails",
	]);
});
