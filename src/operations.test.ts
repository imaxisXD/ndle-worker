import { afterEach, expect, mock, spyOn, test } from "bun:test";
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
		queue: { status: "ok", details: { waiting: 0, failed: 0 } },
		duckdb: { status: "ok" },
		batch_writer: { status: "ok" },
		archiver: { status: "ok" },
		backup: { status: "ok" },
		recovery: { status: "ok", details: {} },
	},
};

const skipWait = async (_delayMs: number) => {};

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
						...healthy,
						checks: {
							...healthy.checks,
							queue: { status: "ok", details: { waiting: 0, failed: 1 } },
						},
					}
				: { status: "not ready" },
		);
	});
	await checkOperations(env, now, fetch, 12_000, skipWait);
	await checkOperations(env, now + 5 * 60_000, fetch, 12_000, skipWait);
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
	await checkOperations(env, now, fetch, 12_000, skipWait);
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
	await checkOperations(env, now, fetch, 12_000, skipWait);
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
	await checkOperations(environment(), now, fetch, 12_000, skipWait);
	expect(text).toContain("not ready to accept events");
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
	await expect(
		checkOperations(environment(), now, fetch, 12_000, skipWait),
	).rejects.toThrow("email was not accepted (HTTP 302)");
	expect(message).toContain("unexpected HTTP status");
	expect(message).toContain("link-monitoring service did not pass");
	expect(calls).toEqual([
		"https://monitor.ndle.app/ready",
		"https://api.ndle.app/health/ready",
		"https://api.ndle.app/health/detailed",
		"https://api.ndle.app/health/ready",
		"https://api.ndle.app/health/detailed",
		"https://api.resend.com/emails",
	]);
});

function unhealthyRecovery(details: Record<string, unknown>) {
	return {
		...healthy,
		status: "degraded",
		checks: {
			...structuredClone(healthy.checks),
			recovery: { status: "degraded", details },
		},
	};
}

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
		unhealthyRecovery({
			unavailable: true,
			lastError: "secret URL ?token=private",
		}),
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
		failed_components: ["recovery"],
		recovery_reasons: ["unavailable", "lastError"],
	});
	expect(evidence[1].phase).toBe("confirmation");
	expect(evidence[1].issues).toEqual([]);
	expect(JSON.stringify(evidence)).not.toContain("private");
});

test("health recovery preserves initial failed jobs, large queues, and unresolved archives in one email", async () => {
	const env = environment();
	env.CLICK_EVENTS_FAILED.metrics = mock(async () => ({
		backlogCount: 1,
		backlogBytes: 1,
	}));
	env.FAILED_CLICK_ARCHIVES.list = mock(async () => ({
		objects: [{ key: "private-object" }],
		truncated: false,
	})) as typeof env.FAILED_CLICK_ARCHIVES.list;
	const bad = unhealthyRecovery({ overdue: true, problemRecordsPresent: true });
	bad.checks.queue.details = { waiting: 1_001, failed: 2 };
	const fixture = healthScenario([bad, healthy]);
	await checkOperations(env, now, fixture.send, 12_000, skipWait);
	expect(fixture.emails).toHaveLength(1);
	const text = JSON.parse(fixture.emails[0].body).text;
	expect(text).toContain("failed event jobs");
	expect(text).toContain("1,000 waiting event jobs");
	expect(text).toContain("failed-click queue contains events");
	expect(text).toContain("Archived failed clicks");
	expect(text).toContain("event records that need investigation");
	expect(text).not.toContain("recovery check failed");
	expect(env.CLICK_EVENTS_FAILED.metrics).toHaveBeenCalledTimes(1);
	expect(env.FAILED_CLICK_ARCHIVES.list).toHaveBeenCalledTimes(1);
});

test("failed jobs without a health failure alert immediately without confirmation", async () => {
	const value = structuredClone(healthy);
	value.checks.queue.details.failed = 1;
	const fixture = healthScenario([value]);
	const wait = mock(skipWait);
	await checkOperations(environment(), now, fixture.send, 12_000, wait);
	expect(wait).not.toHaveBeenCalled();
	expect(fixture.emails).toHaveLength(1);
	expect(fixture.calls).toHaveLength(4);
});

test("persistent recovery flags have fixed messages and stable hourly keys despite changed error text", async () => {
	const log = spyOn(console, "info").mockImplementation(() => {});
	const first = unhealthyRecovery({
		auditOverdue: true,
		auditLastError: "first PRIVATE-secret",
	});
	const second = unhealthyRecovery({
		auditOverdue: true,
		auditLastError: "different PRIVATE-secret",
		unknown: "PRIVATE-secret",
	});
	const a = healthScenario([first]);
	const b = healthScenario([second]);
	await checkOperations(environment(), now, a.send, 12_000, skipWait);
	await checkOperations(
		environment(),
		now + 5 * 60_000,
		b.send,
		12_000,
		skipWait,
	);
	expect(a.emails).toEqual(b.emails);
	expect(a.emails[0].body).toContain("scan of saved events is overdue");
	expect(a.emails[0].body).toContain(
		"scan of saved events reports a recent error",
	);
	expect(JSON.stringify([a.emails, log.mock.calls])).not.toContain(
		"PRIVATE-secret",
	);
});

test("each known failed component has a distinct issue code and unknown response data stays out", () => {
	const expected = {
		queue: "ingest_queue_health",
		duckdb: "ingest_database_health",
		batch_writer: "ingest_writer_health",
		archiver: "ingest_archiver_health",
		backup: "ingest_backup_health",
		recovery: "ingest_recovery_health",
	};
	for (const [component, issue] of Object.entries(expected)) {
		const value = {
			...healthy,
			status: "error",
			checks: {
				...healthy.checks,
				[component]: {
					status: "error",
					details: component === "recovery" ? {} : "secret text",
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

test("HTTP, network, malformed and stalled health checks remain distinct and never erase failed jobs", async () => {
	const failedJobs = structuredClone(healthy);
	failedJobs.checks.queue.details.failed = 1;
	const examples = [
		{
			issue: "unexpected HTTP status",
			ready: async () => new Response(null, { status: 502 }),
		},
		{
			issue: "could not connect",
			ready: async () => {
				throw new Error("private-network-secret");
			},
		},
		{
			issue: "invalid response",
			ready: async () => Response.json({ status: "secret-status" }),
		},
		{ issue: "did not finish", ready: () => new Promise<Response>(() => {}) },
	];
	const log = spyOn(console, "info").mockImplementation(() => {});
	for (const example of examples) {
		const fixture = healthScenario([failedJobs], { ready: example.ready });
		const wait = mock(skipWait);
		await checkOperations(environment(), now, fixture.send, 10, wait);
		expect(wait).toHaveBeenCalledTimes(1);
		expect(fixture.emails).toHaveLength(1);
		expect(fixture.emails[0].body).toContain(example.issue);
		expect(fixture.emails[0].body).toContain("failed event jobs");
	}
	expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});

test("a malformed second response alerts instead of treating an uncertain recovery as healthy", async () => {
	const fixture = healthScenario([
		unhealthyRecovery({ stalled: true }),
		{
			status: "ok",
			checks: {
				queue: { status: "ok", details: { failed: 1, waiting: "bad" } },
			},
		},
	]);
	await checkOperations(environment(), now, fixture.send, 12_000, skipWait);
	expect(fixture.emails).toHaveLength(1);
	expect(fixture.emails[0].body).toContain("invalid response");
	expect(fixture.emails[0].body).toContain("failed event jobs");
	expect(fixture.emails[0].body).not.toContain("stopped making progress");
});

test("HTTP 503 cannot be hidden by a healthy component body containing failed jobs", async () => {
	const value = structuredClone(healthy);
	value.checks.queue.details.failed = 1;
	const fixture = healthScenario([], {
		detailed: async () => Response.json(value, { status: 503 }),
	});
	const wait = mock(skipWait);
	await checkOperations(environment(), now, fixture.send, 12_000, wait);
	expect(wait).toHaveBeenCalledTimes(1);
	expect(fixture.emails[0].body).toContain("unexpected HTTP status");
	expect(fixture.emails[0].body).toContain("failed event jobs");
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
		expect(fixture.emails[0].body).toContain(
			"did not finish before its deadline",
		);
		expect(fixture.emails[0].body).not.toContain("invalid response");
		expect(fixture.emails[0].body).not.toContain("could not connect");
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
