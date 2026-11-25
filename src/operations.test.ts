import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { issuePlaybooks } from "./alert-email";
import {
	buildAlert,
	checkClickQueue,
	checkIngestHealth,
	checkOperations,
} from "./operations";
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
	checks: {
		duckdb: { status: "ok" },
		batch_writer: { status: "ok" },
		archiver: { status: "ok" },
		backup: { status: "ok" },
		journal: { status: "ok", details: { writes: { failing: false } } },
	},
};

const skipWait = async (_delayMs: number) => {};

const alertStateKey = "operations/alert-state.json";
/** Saved state in which every problem was first seen an hour ago, so one run emails. */
const seenAnHourAgo = {
	version: 1,
	issues: [],
	firstSeen: Object.fromEntries(
		Object.keys(issuePlaybooks).map((issue) => [issue, now - 60 * 60_000]),
	),
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
			get: async (key: string) =>
				key === alertStateKey
					? { size: 300, json: async () => seenAnHourAgo }
					: { size: 300, json: async () => manifest },
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
	await checkOperations(env, now, fetch, 12_000, skipWait);
	expect(calls.map((call) => call.url)).toEqual([
		"https://monitor.ndle.app/ready",
		"https://api.ndle.app/health/ready",
		"https://api.ndle.app/health/detailed",
	]);
	expect(calls[0].headers.get("Authorization")).toBeNull();
	expect(calls[1].headers.get("Authorization")).toBeNull();
	expect(calls[2].headers.get("Authorization")).toBe("Bearer ingest-test-key");
});

for (const [secrets, expected] of [
	[{ OPS_SECRET: "ops-test-key" }, "Bearer ops-test-key"],
	[
		{ OPS_SECRET: "", INGEST_WRITE_SECRET: "write-test-key" },
		"Bearer ingest-test-key",
	],
	[
		{ API_SECRET: undefined, OPS_SECRET: "ops-test-key" },
		"Bearer ops-test-key",
	],
	[{ API_SECRET: undefined }, null],
] as const) {
	test(`detailed health sends ${expected ?? "no credentials"} given ${JSON.stringify(secrets)}`, async () => {
		const env = { ...environment(), ...secrets } as Bindings;
		const headers = new Map<string, string | null>();
		spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			if (String(input).includes("resend.com"))
				return Response.json({ id: "accepted" });
			headers.set(
				new URL(String(input)).pathname,
				new Headers(init?.headers).get("Authorization"),
			);
			return Response.json(
				String(input).includes("/health/detailed")
					? healthy
					: { status: "ready" },
			);
		});
		await checkOperations(env, now, fetch, 12_000, skipWait);
		expect(headers.get("/health/detailed")).toBe(expected);
		expect(headers.get("/health/ready")).toBeNull();
	});
}

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

function failingEnvironment() {
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
	return env;
}

function captureEmails() {
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
						...healthy,
						status: "degraded",
						checks: {
							...healthy.checks,
							journal: { status: "degraded" },
						},
					}
				: { status: "not ready" },
		);
	});
	return emails;
}

/** The backup manifest plus an in-memory alert state object. */
function withAlertState(env: Bindings) {
	const objects = new Map<string, string>();
	const manifestGet = env.ANALYTICS_BACKUPS.get;
	env.ANALYTICS_BACKUPS.get = (async (key: string) => {
		if (key !== "operations/alert-state.json") return manifestGet(key);
		const value = objects.get(key);
		return value === undefined
			? null
			: { size: value.length, json: async () => JSON.parse(value) };
	}) as unknown as Bindings["ANALYTICS_BACKUPS"]["get"];
	env.ANALYTICS_BACKUPS.put = (async (key: string, value: string) => {
		objects.set(key, value);
	}) as unknown as Bindings["ANALYTICS_BACKUPS"]["put"];
	env.ANALYTICS_BACKUPS.delete = (async (key: string) => {
		objects.delete(key);
	}) as unknown as Bindings["ANALYTICS_BACKUPS"]["delete"];
	return objects;
}

test("failing checks send one plain-language alert once the next check confirms them, repeated at most hourly", async () => {
	const env = failingEnvironment();
	const state = withAlertState(env);
	const emails = captureEmails();
	await checkOperations(env, now, fetch, 12_000, skipWait);
	expect(emails).toHaveLength(0);
	await checkOperations(env, now + 5 * 60_000, fetch, 12_000, skipWait);
	await checkOperations(env, now + 10 * 60_000, fetch, 12_000, skipWait);
	expect(emails).toHaveLength(1);
	expect(state.has("operations/alert-state.json")).toBe(true);
	await checkOperations(env, now + 61 * 60_000, fetch, 12_000, skipWait);
	expect(emails).toHaveLength(2);
	expect(emails[0].headers.get("Idempotency-Key")?.length).toBeLessThan(256);
	const message = JSON.parse(emails[0].body);
	expect(message.to).toEqual(["owner@example.test"]);
	expect(message.subject).toBe(
		"[NDLE] Urgent: The off-site copy of new clicks had a problem (+4 more)",
	);
	// Link monitoring waits 30 minutes, so the first alert leaves it out.
	expect(message.text).not.toContain("Link monitoring is not running");
	for (const expected of [
		"Clicks are waiting longer than usual to be counted",
		"What we measured: 1 click is waiting (1 KB); the oldest has waited 11 minutes.",
		"Is anything lost? No. Waiting clicks are kept for 14 days",
		"What to do:",
		"It's fixed when:",
		"The off-site copy of new clicks had a problem",
		"couldn't be found or verified",
	])
		expect(message.text).toContain(expected);
	expect(message.html).toContain("<ol");
	expect(message.text).not.toContain("ingest-test-key");
	// The reminder an hour later says how long the problem has lasted.
	expect(JSON.parse(emails[1].body).text).toContain("about 1 hour");
});

test("without saved state the hourly email is identical so the provider sends it once", async () => {
	const env = failingEnvironment();
	env.ANALYTICS_BACKUPS.get = (async (key: string) => {
		if (key === "operations/alert-state.json")
			throw new Error("R2 unavailable");
		return { size: 300, json: async () => manifest };
	}) as unknown as Bindings["ANALYTICS_BACKUPS"]["get"];
	const emails = captureEmails();
	await checkOperations(env, now, fetch, 12_000, skipWait);
	await checkOperations(env, now + 5 * 60_000, fetch, 12_000, skipWait);
	expect(emails).toHaveLength(2);
	expect(emails[0].headers.get("Idempotency-Key")).toBe(
		emails[1].headers.get("Idempotency-Key"),
	);
	expect(emails[0].body).toBe(emails[1].body);
});

test("an all-clear email names the problems that were fixed", async () => {
	const env = failingEnvironment();
	const state = withAlertState(env);
	const emails = captureEmails();
	await checkOperations(env, now, fetch, 12_000, skipWait);
	await checkOperations(env, now + 5 * 60_000, fetch, 12_000, skipWait);
	const healthyEnv = {
		...environment(),
		ANALYTICS_BACKUPS: env.ANALYTICS_BACKUPS,
	};
	healthyEnv.ANALYTICS_BACKUPS.head = mock(async () => ({
		size: manifest.size,
	}));
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		if (String(input).includes("resend.com")) {
			emails.push({
				headers: new Headers(init?.headers),
				body: String(init?.body),
			});
			return Response.json({ id: "all-clear" });
		}
		return Response.json(
			String(input).includes("/health/detailed")
				? healthy
				: { status: "ready" },
		);
	});
	await checkOperations(
		healthyEnv as Bindings,
		now + 10 * 60_000,
		fetch,
		12_000,
		skipWait,
	);
	expect(emails).toHaveLength(2);
	const clear = JSON.parse(emails[1].body);
	expect(clear.subject).toBe("[NDLE] All clear: everything is working again");
	expect(clear.text).toContain(
		"Clicks: Clicks are waiting longer than usual to be counted",
	);
	expect(clear.text).toContain("lasted about 10 minutes");
	expect(state.has("operations/alert-state.json")).toBe(false);
	// Later healthy checks stay silent.
	await checkOperations(
		healthyEnv as Bindings,
		now + 15 * 60_000,
		fetch,
		12_000,
		skipWait,
	);
	expect(emails).toHaveLength(2);
});

test("expired backups alert while a failed metric read is only logged", async () => {
	const env = environment();
	env.CLICK_EVENTS.metrics = async () => {
		throw new Error("Queue request failed");
	};
	env.ANALYTICS_BACKUPS.get = expiredBackup(env.ANALYTICS_BACKUPS.get);
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
	await checkOperations(env, now, fetch, 12_000, skipWait);
	expect(text).toContain("more than a day old");
	expect(text).not.toContain("Could not read the click queue's status");
});

/** Serves a 27-hour-old backup manifest; other keys go to `get`. */
function expiredBackup(get: Bindings["ANALYTICS_BACKUPS"]["get"]) {
	return (async (key: string) =>
		key === alertStateKey
			? get(key)
			: {
					size: 300,
					json: async () => ({
						...manifest,
						createdAt: new Date(now - 27 * 60 * 60_000).toISOString(),
					}),
				}) as unknown as Bindings["ANALYTICS_BACKUPS"]["get"];
}

/** Healthy services apart from optional analytics or monitoring outages. */
function captureAlerts(service = { analyticsUp: true, monitorReady: true }) {
	const emails: Array<{ subject: string; text: string }> = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (url.includes("resend.com")) {
			emails.push(JSON.parse(String(init?.body)));
			return Response.json({ id: "accepted" });
		}
		if (url.includes("api.ndle.app") && !service.analyticsUp)
			throw new TypeError("Network connection lost.");
		if (url.includes("/health/detailed")) return Response.json(healthy);
		if (url.includes("monitor.") && !service.monitorReady)
			return Response.json({ status: "not ready" }, { status: 503 });
		return Response.json({ status: "ready" });
	});
	return emails;
}

/** A click queue whose metrics fail like Cloudflare's until made readable. */
function unreadableClickQueue(env: Bindings) {
	const queue = { readable: false };
	env.CLICK_EVENTS.metrics = async () => {
		if (queue.readable) return empty;
		throw new Error("Unknown Internal Error (15000)");
	};
	return queue;
}

function runAt(env: Bindings, minutes: number) {
	return checkOperations(env, now + minutes * 60_000, fetch, 12_000, skipWait);
}

test("a failure to read the click queue is only logged, however long it lasts", async () => {
	const env = environment();
	const state = withAlertState(env);
	const emails = captureAlerts();
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const queue = unreadableClickQueue(env);
	for (let minutes = 0; minutes <= 120; minutes += 5) await runAt(env, minutes);
	expect(emails).toHaveLength(0);
	// Only the error name and Cloudflare's code are logged, not its message.
	expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
		component: "operations",
		level: "warn",
		message: "NDLE operations check failed",
		check: "click_queue_unavailable",
		error: "Error",
		cloudflare_code: "15000",
	});
	queue.readable = true;
	await runAt(env, 125);
	expect(emails).toHaveLength(0);
	expect(state.has(alertStateKey)).toBe(false);
});

test("a failure the next check no longer sees sends nothing", async () => {
	const env = environment();
	const state = withAlertState(env);
	const service = { analyticsUp: false, monitorReady: true };
	const emails = captureAlerts(service);
	await runAt(env, 0);
	expect(state.has(alertStateKey)).toBe(true);
	service.analyticsUp = true;
	await runAt(env, 5);
	expect(emails).toHaveLength(0);
	expect(state.has(alertStateKey)).toBe(false);
});

test("a failure still there at the next check is emailed, then cleared", async () => {
	const env = environment();
	withAlertState(env);
	const service = { analyticsUp: false, monitorReady: true };
	const emails = captureAlerts(service);
	await runAt(env, 0);
	expect(emails).toHaveLength(0);
	await runAt(env, 5);
	expect(emails).toHaveLength(1);
	expect(emails[0].subject).toBe(
		"[NDLE] Urgent: The analytics service can't be reached",
	);
	expect(emails[0].text).toContain("about 5 minutes");
	service.analyticsUp = true;
	await runAt(env, 10);
	expect(emails).toHaveLength(2);
	expect(emails[1].text).toContain(
		"Analytics service: The analytics service can't be reached",
	);
});

test("link monitoring is emailed only after 30 minutes down, then cleared", async () => {
	const env = environment();
	withAlertState(env);
	const service = { analyticsUp: true, monitorReady: false };
	const emails = captureAlerts(service);
	for (const minutes of [0, 5, 10, 15, 20, 25]) await runAt(env, minutes);
	expect(emails).toHaveLength(0);
	await runAt(env, 30);
	await runAt(env, 35);
	expect(emails).toHaveLength(1);
	expect(emails[0].subject).toBe(
		"[NDLE] Needs attention: Link monitoring is not running",
	);
	expect(emails[0].text).toContain("For at least 30 minutes");
	service.monitorReady = true;
	await runAt(env, 40);
	expect(emails).toHaveLength(2);
	expect(emails[1].text).toContain("lasted about 40 minutes");
});

test("a waiting problem keeps its start time while another problem is emailed", async () => {
	const env = environment();
	env.ANALYTICS_BACKUPS.get = expiredBackup(env.ANALYTICS_BACKUPS.get);
	withAlertState(env);
	const service = { analyticsUp: true, monitorReady: true };
	const emails = captureAlerts(service);
	await runAt(env, 0);
	await runAt(env, 5);
	expect(emails).toHaveLength(1);
	service.monitorReady = false;
	for (let minutes = 10; minutes <= 35; minutes += 5) await runAt(env, minutes);
	expect(emails).toHaveLength(1);
	await runAt(env, 40);
	expect(emails).toHaveLength(2);
	expect(emails[1].subject).toBe(
		"[NDLE] Needs attention: The latest database backup is more than a day old (+1 more)",
	);
});

test("an all-clear waits until a logged read failure passes too and keeps original outage duration", async () => {
	const env = environment();
	withAlertState(env);
	const service = { analyticsUp: false, monitorReady: true };
	const emails = captureAlerts(service);
	const queue = unreadableClickQueue(env);
	queue.readable = true;
	await runAt(env, 0);
	await runAt(env, 5);
	expect(emails).toHaveLength(1);
	service.analyticsUp = true;
	queue.readable = false;
	await runAt(env, 10);
	expect(emails).toHaveLength(1);
	queue.readable = true;
	await runAt(env, 15);
	expect(emails).toHaveLength(2);
	expect(emails[1].text).toContain(
		"Analytics service: The analytics service can't be reached",
	);
	expect(emails[1].text).toContain("lasted about 15 minutes");
	expect(emails[1].text).not.toContain("click queue");
});

test("provider rejection fails the run with HTTP status even on non-JSON bodies", async () => {
	const env = environment();
	env.CLICK_EVENTS_FAILED.metrics = async () => ({
		backlogCount: 1,
		backlogBytes: 100,
	});
	spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		if (String(input).includes("resend.com"))
			return new Response("<html>Bad Gateway</html>", { status: 503 });
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
	await checkOperations(env, now, fetch, 12_000, skipWait);
	expect(send).not.toHaveBeenCalled();
	expect(buildAlert(["failed_clicks", "backup_old"], now).key).toBe(
		buildAlert(
			["backup_old", "failed_clicks", "failed_clicks"],
			now + 5 * 60_000,
		).key,
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
	await checkOperations(environment(), now, fetch, 12_000, skipWait);
	expect(text).toContain("up but not accepting clicks");
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
	// Without readable saved state, the stalled read can't be timed, so it waits.
	expect(text).not.toContain("Could not read the click queue's status");
	expect(text).toContain(
		"Some clicks could not be delivered and were set aside",
	);
	expect(text).toContain("couldn't be found or verified");
});

test("redirected health checks alert and redirected email delivery fails without following", async () => {
	const calls: string[] = [];
	let message = "";
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		calls.push(String(input));
		expect(init?.redirect).toBe("manual");
		if (String(input).includes("resend.com"))
			message = JSON.parse(String(init?.body)).text;
		return Response.json(
			{ status: "ready", id: "not-an-email-receipt" },
			{ status: 302, headers: { Location: "https://unexpected.example.test" } },
		);
	});
	await expect(
		checkOperations(environment(), now, fetch, 12_000, skipWait),
	).rejects.toThrow("email was not accepted (HTTP 302)");
	expect(message).toContain("The analytics service returned an error");
	expect(message).toContain("Link monitoring is not running");
	expect(calls).toEqual([
		"https://monitor.ndle.app/ready",
		"https://api.ndle.app/health/ready",
		"https://api.ndle.app/health/detailed",
		"https://api.ndle.app/health/ready",
		"https://api.ndle.app/health/detailed",
		"https://api.resend.com/emails",
	]);
});

function healthScenario(
	samples: unknown[],
	options: {
		ready?: () => Promise<Response>;
		detailed?: () => Promise<Response>;
	} = {},
) {
	const emails: Array<{ body: string; key: string | null }> = [];
	const calls: string[] = [];
	let detailedReads = 0;
	const send = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("resend.com")) {
			emails.push({
				body: String(init?.body),
				key: new Headers(init?.headers).get("Idempotency-Key"),
			});
			return Response.json({ id: "accepted" });
		}
		if (url.includes("/health/detailed")) {
			const sample = samples[Math.min(detailedReads++, samples.length - 1)];
			return options.detailed
				? options.detailed()
				: Response.json(sample, {
						status: (sample as { status: string }).status === "ok" ? 200 : 503,
					});
		}
		if (url.includes("/health/ready") && options.ready) return options.ready();
		return Response.json({ status: "ready" });
	});
	return { send, calls, emails };
}

test("one 15-second confirmation suppresses a recovered component failure and records safe evidence", async () => {
	const log = spyOn(console, "info").mockImplementation(() => {});
	const fixture = healthScenario([
		{
			...healthy,
			status: "degraded",
			checks: {
				...healthy.checks,
				journal: { status: "degraded", details: "secret URL ?token=private" },
			},
		},
		healthy,
	]);
	const wait = mock(async (delay: number) => {
		expect(delay).toBe(15_000);
		expect(fixture.emails).toHaveLength(0);
	});
	await checkOperations(environment(), now, fixture.send, 12_000, wait);
	expect(wait).toHaveBeenCalledTimes(1);
	expect(
		fixture.calls.filter((url) => url.includes("/health/detailed")),
	).toHaveLength(2);
	expect(fixture.calls.filter((url) => url.includes("monitor"))).toHaveLength(
		1,
	);
	expect(fixture.emails).toHaveLength(0);
	const evidence = log.mock.calls.map((call) => JSON.parse(String(call[0])));
	expect(evidence[0].checks[1]).toEqual({
		endpoint: "detailed",
		result: "reported",
		http_status: 503,
		status: "degraded",
		failed_components: ["journal"],
	});
	expect(evidence[1].phase).toBe("confirmation");
	expect(evidence[1].issues).toEqual([]);
	expect(JSON.stringify(evidence)).not.toContain("private");
});

test("health recovery preserves independently observed failed clicks and unresolved archives in one email", async () => {
	const env = environment();
	env.CLICK_EVENTS_FAILED.metrics = mock(async () => ({
		backlogCount: 1,
		backlogBytes: 1,
	}));
	env.FAILED_CLICK_ARCHIVES.list = mock(async () => ({
		objects: [{ key: "failed-clicks/v1/unresolved/main/msg-1.json" }],
		truncated: false,
	})) as typeof env.FAILED_CLICK_ARCHIVES.list;
	const bad = {
		...healthy,
		status: "error",
		checks: { ...healthy.checks, archiver: { status: "error" } },
	};
	const fixture = healthScenario([bad, healthy]);
	await checkOperations(env, now, fixture.send, 12_000, skipWait);
	expect(fixture.emails).toHaveLength(1);
	const text = JSON.parse(fixture.emails[0].body).text;
	expect(text).toContain(
		"Some clicks could not be delivered and were set aside",
	);
	expect(text).toContain("Failed clicks are waiting for you to replay them");
	expect(text).not.toContain("archive job reported a failure");
	expect(env.CLICK_EVENTS_FAILED.metrics).toHaveBeenCalledTimes(1);
	expect(env.FAILED_CLICK_ARCHIVES.list).toHaveBeenCalledTimes(1);
});

test("each required component has a distinct issue code and unknown response data stays out", () => {
	const expected = {
		duckdb: "ingest_database_health",
		batch_writer: "ingest_writer_health",
		archiver: "ingest_archiver_health",
		backup: "ingest_backup_health",
		journal: "ingest_journal_health",
	};
	for (const [component, issue] of Object.entries(expected)) {
		const value = {
			...healthy,
			status: "error",
			checks: {
				...healthy.checks,
				[component]: {
					status: "error",
					details: "secret text",
				},
			},
		};
		expect(checkIngestHealth(value)).toEqual([issue]);
	}
	expect(
		checkIngestHealth({
			status: "error",
			checks: {
				...healthy.checks,
				unknown: { status: "error", details: "PRIVATE-secret" },
			},
		}),
	).toEqual(["ingest_health_failed"]);
	expect(
		checkIngestHealth({ status: "surprise", checks: healthy.checks }),
	).toEqual(["ingest_health_invalid"]);
});

test("every one of the five ingest components is required", () => {
	expect(checkIngestHealth(healthy)).toEqual([]);
	for (const component of [
		"duckdb",
		"batch_writer",
		"archiver",
		"backup",
		"journal",
	]) {
		const checks: Record<string, unknown> = { ...healthy.checks };
		delete checks[component];
		expect(checkIngestHealth({ status: "ok", checks })).toEqual([
			"ingest_health_invalid",
		]);
	}
	for (const broken of [
		{ journal: "broken" },
		{ journal: { status: "surprise" } },
	]) {
		expect(
			checkIngestHealth({
				status: "ok",
				checks: { ...healthy.checks, ...broken },
			}),
		).toContain("ingest_health_invalid");
	}
});

for (const [name, detailed, expectedEmail] of [
	["healthy ingest sends no email", healthy, null],
	[
		"a persistent journal failure sends its specific alert",
		{
			status: "error",
			checks: { ...healthy.checks, journal: { status: "error" } },
		},
		"The off-site copy of new clicks had a problem",
	],
] as const) {
	test(name, async () => {
		const emails: string[] = [];
		spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			if (String(input).includes("resend.com")) {
				emails.push(JSON.parse(String(init?.body)).text);
				return Response.json({ id: "accepted" });
			}
			return Response.json(
				String(input).includes("/health/detailed")
					? detailed
					: { status: "ready" },
				{
					status:
						String(input).includes("/health/detailed") &&
						detailed.status !== "ok"
							? 503
							: 200,
				},
			);
		});
		await checkOperations(environment(), now, fetch, 12_000, skipWait);
		if (expectedEmail === null) expect(emails).toEqual([]);
		else {
			expect(emails).toHaveLength(1);
			expect(emails[0]).toContain(expectedEmail);
		}
	});
}

test("HTTP, network, malformed and stalled health checks remain distinct", async () => {
	const examples = [
		{
			issue: "The analytics service returned an error",
			ready: async () => new Response(null, { status: 502 }),
		},
		{
			issue: "can't be reached",
			ready: async () => {
				throw new Error("private-network-secret");
			},
		},
		{
			issue: "health report wasn't understood",
			ready: async () => Response.json({ status: "secret-status" }),
		},
		{ issue: "did not finish", ready: () => new Promise<Response>(() => {}) },
	];
	const log = spyOn(console, "info").mockImplementation(() => {});
	for (const example of examples) {
		const fixture = healthScenario([healthy], { ready: example.ready });
		const wait = mock(skipWait);
		await checkOperations(environment(), now, fixture.send, 10, wait);
		expect(wait).toHaveBeenCalledTimes(1);
		expect(fixture.emails).toHaveLength(1);
		expect(fixture.emails[0].body).toContain(example.issue);
	}
	expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});

test("a malformed second response alerts instead of treating an uncertain recovery as healthy", async () => {
	const fixture = healthScenario([
		{
			...healthy,
			status: "degraded",
			checks: { ...healthy.checks, backup: { status: "error" } },
		},
		{ status: "ok", checks: {} },
	]);
	await checkOperations(environment(), now, fixture.send, 12_000, skipWait);
	expect(fixture.emails).toHaveLength(1);
	expect(fixture.emails[0].body).toContain("health report wasn't understood");
});

test("HTTP 503 cannot be hidden by a healthy component body", async () => {
	const fixture = healthScenario([], {
		detailed: async () => Response.json(healthy, { status: 503 }),
	});
	const wait = mock(skipWait);
	await checkOperations(environment(), now, fixture.send, 12_000, wait);
	expect(wait).toHaveBeenCalledTimes(1);
	expect(fixture.emails[0].body).toContain(
		"The analytics service returned an error",
	);
});

test("HTTP aborts before headers and during the response body are logged as ten-second timeouts", async () => {
	const log = spyOn(console, "info").mockImplementation(() => {});
	for (const phase of ["headers", "body"]) {
		spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
		const fixture = healthScenario([healthy], {
			ready: async () => {
				if (phase === "headers") throw new Error("PRIVATE aborted headers");
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error("PRIVATE aborted body"));
						},
					}),
					{ status: 200 },
				);
			},
		});
		await checkOperations(environment(), now, fixture.send, 12_000, skipWait);
		expect(fixture.emails[0].body).toContain("responding very slowly");
		expect(fixture.emails[0].body).not.toContain(
			"health report wasn't understood",
		);
		expect(fixture.emails[0].body).not.toContain("can't be reached");
		const evidence = log.mock.calls
			.map((call) => JSON.parse(String(call[0])))
			.filter((value) => value.phase === "confirmation")
			.at(-1).checks[0];
		expect(evidence).toMatchObject({
			endpoint: "ready",
			result: "timeout",
			timeout_ms: 10_000,
		});
	}
	expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
});
