// Actual workerd + local R2 verification. Every outbound HTTP request is
// intercepted. This does not load .dev.vars or create a persistent dev server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRequire = createRequire(resolve(project, "package.json"));
const wranglerRequire = createRequire(
	projectRequire.resolve("wrangler/package.json"),
);
const { Miniflare, Response, Log, LogLevel } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const event = {
	idempotency_key: "runtime-original-event",
	request_id: "runtime-original-event",
	occurred_at: "2026-09-05T18:00:00.000Z",
	link_slug: "fixture",
	short_url: "https://fixture.example.test/fixture",
	link_id: "fixture-link",
	user_id: "fixture-owner",
	destination_url: "https://destination.example.test/",
	redirect_status: 302,
	tracking_enabled: true,
	latency_ms_worker: 3,
	session_id: "fixture-session",
	first_click_of_session: true,
	worker_datacenter: "BOM",
	worker_version: "old-version-1",
	user_agent: "fixture-browser",
	device_type: "desktop",
	browser: "Fixture",
	os: "Linux",
	ip_hash: "fixture-hash",
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
const original = {
	version: 1,
	event,
	legacy_extra_field: "must survive replay",
};
const mainQueue = "ndle-click-events-dev";
const failedQueue = "ndle-click-events-failed-dev";
const root = "failed-clicks/v1/";
const archiveKey = (id, queue = failedQueue) =>
	`${root}archive/${queue}/${id}.json`;
const markerKey = (id, queue = failedQueue) =>
	`${root}unresolved/${queue}/${id}.json`;
const wrapper = `
import { consumeQueue } from ${JSON.stringify(resolve(project, "src/queue-handler.ts"))};
import { replayFailedClick, resolveFailedClick, resolveInvalidFailedClick } from ${JSON.stringify(resolve(project, "src/failed-click-recovery.ts"))};
import { checkOperations } from ${JSON.stringify(resolve(project, "src/operations.ts"))};
export default { async fetch(request, bindings) {
  const args = await request.json();
  const storage = bindings.FAILED_CLICK_ARCHIVES;
  let acked = 0, retried = 0, delay;
  const calls = [];
  const bucket = {
    async put(key, value, options) {
      calls.push({ method: "put", key });
      if (args.fault === "write" || (args.fault === "marker-write" && key.includes("/unresolved/")) || (args.fault === "resolution-write" && key.includes("/resolved/"))) throw new Error("Injected R2 write failure");
      const saved = await storage.put(key, value, options);
      if (args.fault === "crash-after-archive" && key.includes("/archive/")) throw new Error("Injected crash after archive commit");
      return saved;
    },
    async get(key) {
      calls.push({ method: "get", key });
      if (args.fault === "marker-read" && key.includes("/unresolved/")) return null;
      return storage.get(key);
    },
    delete: key => storage.delete(key),
    list: options => { calls.push({ method: "list", options }); return storage.list(options); }
  };
  const env = { ...bindings, FAILED_CLICK_ARCHIVES: bucket,
    CLICK_EVENTS_QUEUE_NAME: ${JSON.stringify(mainQueue)}, CLICK_EVENTS_FAILED_QUEUE_NAME: ${JSON.stringify(failedQueue)},
    CLICK_EVENTS: { metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }), send: async body => { const result = await fetch("https://queue.example.test/send", { method: "POST", body: JSON.stringify(body) }); if (!result.ok) throw new Error("Injected queue failure"); } },
    CLICK_EVENTS_FAILED: { metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }) },
    CONVEX_URL: "https://fixture.convex.cloud", SHARED_SECRET: "FAKE-convex-secret",
    INGEST_ENDPOINT: "https://ingest.example.test/ingest", API_SECRET: "FAKE-ingest-secret", LOG_LEVEL: "silent",
    MONITOR_READY_ENDPOINT: "https://monitor.example.test/ready", OPS_ALERTS_ENABLED: "true",
    OPS_ALERT_FROM: "NDLE <alerts@example.test>", OPS_ALERT_TO: "owner@example.test", RESEND_API_KEY: "FAKE-email-key",
    ANALYTICS_BACKUPS: { get: async () => ({ size: 300, json: async () => ({ version: 3, key: "snapshots/duckdb/fixture/analytics.duckdb", size: 1024, sha256: "a".repeat(64), createdAt: "2026-09-05T18:00:00.000Z" }) }), head: async () => ({ size: 1024 }) }
  };
  try {
    let result;
    if (args.action === "replay") result = await replayFailedClick(args.key, bucket, env.CLICK_EVENTS);
    else if (args.action === "resolve") result = await resolveFailedClick(args.key, bucket, env, args.operator);
    else if (args.action === "resolve-invalid") result = await resolveInvalidFailedClick(args.key, bucket, args.decision);
    else if (args.action === "operations") await checkOperations(env, Date.parse("2026-09-05T18:05:00Z"));
    else await consumeQueue({ queue: args.queue || ${JSON.stringify(failedQueue)}, messages: [{
      id: args.id, timestamp: new Date("2026-09-05T18:01:00Z"), attempts: args.attempts || 1,
      body: args.body || ${JSON.stringify(original)},
      ack() { if (args.fault === "crash-before-ack") throw new Error("Injected crash before acknowledgement"); acked++; },
      retry(options) { retried++; delay = options.delaySeconds; }
    }], ackAll() { throw new Error("Unexpected batch acknowledgement"); }, retryAll() {} }, env);
    return Response.json({ accepted: true, result, acked, retried, delay, calls });
  } catch(error) { return Response.json({ accepted: false, error: error.message, acked, retried, calls }); }
} };
`;
const bundled = await build({
	stdin: { contents: wrapper, loader: "ts", resolveDir: project },
	bundle: true,
	write: false,
	format: "esm",
	platform: "browser",
	target: "es2022",
});
let scenario = {};
let outbound = [];
const ingestIds = new Set();
const convexIds = new Set();
const republished = [];
const runtime = new Miniflare({
	modules: true,
	script: bundled.outputFiles[0].text,
	compatibilityDate: "2025-09-15",
	host: "127.0.0.1",
	port: 0,
	r2Buckets: ["FAILED_CLICK_ARCHIVES"],
	log: new Log(LogLevel.ERROR),
	outboundService: async (request) => {
		const url = new URL(request.url);
		outbound.push({
			url: request.url,
			headers: Object.fromEntries(request.headers),
		});
		if (url.hostname === "queue.example.test") {
			republished.push(await request.json());
			return Response.json({ accepted: true });
		}
		if (url.pathname === "/internal/events/receipt" && scenario.receiptRedirect)
			return new Response(null, {
				status: 302,
				headers: { Location: "https://unexpected.example.test/" },
			});
		if (url.pathname === "/internal/events/receipt")
			return Response.json({
				idempotency_key: scenario.wrongReceipt
					? "different-event"
					: url.searchParams.get("idempotency_key"),
				committed:
					!scenario.notCommitted &&
					ingestIds.has(url.searchParams.get("idempotency_key")),
				user_id: scenario.wrongOwner ? "another-owner" : event.user_id,
				occurred_at: scenario.wrongTime
					? "2026-09-05T18:00:01.000Z"
					: event.occurred_at,
				link_id: scenario.wrongLink ? "another-link" : event.link_id,
			});
		if (url.pathname === "/ingest") {
			assert.equal(
				request.headers.get("Authorization"),
				"Bearer FAKE-ingest-secret",
			);
			const body = await request.json();
			if (scenario.ingestConflict)
				return Response.json({ error: "different body" }, { status: 409 });
			assert.deepEqual(body, event);
			if (scenario.falseIgnored)
				return Response.json(
					{
						success: true,
						status: "ignored",
						idempotency_key: body.idempotency_key,
					},
					{ status: 202 },
				);
			ingestIds.add(body.idempotency_key);
			return Response.json(
				{
					success: true,
					status: "queued",
					idempotency_key: body.idempotency_key,
				},
				{ status: 202 },
			);
		}
		if (url.hostname === "fixture.convex.cloud") {
			const body = await request.json();
			assert.equal(body.args[0].requestId, event.idempotency_key);
			if (scenario.convexFailure)
				return Response.json({
					status: "error",
					errorMessage: "Injected Convex failure",
				});
			const outcome = convexIds.has(body.args[0].requestId)
				? "duplicate"
				: "recorded";
			convexIds.add(body.args[0].requestId);
			return Response.json({
				status: "success",
				value: { outcome },
				logLines: [],
			});
		}
		if (url.pathname === "/health/detailed")
			return Response.json({
				status: "ok",
				checks: { queue: { details: { waiting: 0, failed: 0 } } },
			});
		if (
			url.pathname === "/health/ready" ||
			url.hostname === "monitor.example.test"
		)
			return Response.json({ status: "ready" });
		if (url.hostname === "api.resend.com") {
			outbound.at(-1).email = await request.json();
			return Response.json({ id: "isolated-alert" });
		}
		throw new Error("Unexpected outbound request blocked: " + request.url);
	},
});
let passed = 0;
async function run(name, args, check) {
	scenario = args;
	outbound = [];
	const response = await runtime.dispatchFetch("http://fixture.example.test/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(args),
	});
	const result = await response.json();
	await check(result);
	passed++;
	console.log("PASS " + name);
	return result;
}
try {
	const bucket = await runtime.getR2Bucket("FAILED_CLICK_ARCHIVES");
	await run(
		"DLQ v1 body is archived and verified before acknowledgement",
		{ id: "original" },
		async (result) => {
			assert.equal(result.acked, 1);
			assert.equal(result.retried, 0);
			const archive = await (await bucket.get(archiveKey("original"))).json();
			assert.deepEqual(JSON.parse(archive.body.data), original);
			assert.equal(archive.source.attempts, 1);
			assert.equal(archive.eventId, event.idempotency_key);
			assert.ok(await bucket.get(markerKey("original")));
			assert.equal(outbound.length, 0);
		},
	);
	await run(
		"duplicate message preserves first observed attempt metadata",
		{ id: "original", attempts: 12 },
		async (result) => {
			assert.equal(result.acked, 1);
			assert.equal(
				(await (await bucket.get(archiveKey("original"))).json()).source
					.attempts,
				1,
			);
		},
	);
	for (const fault of [
		"write",
		"crash-after-archive",
		"marker-write",
		"marker-read",
		"crash-before-ack",
	]) {
		await run(
			fault + " does not acknowledge the message",
			{ id: fault, fault },
			(result) => {
				assert.equal(result.acked, 0);
				assert.equal(result.retried, 1);
			},
		);
		await run(
			fault + " recovers on redelivery without replacing the body",
			{ id: fault, attempts: 2 },
			async (result) => {
				assert.equal(result.acked, 1);
				assert.deepEqual(
					JSON.parse(
						(await (await bucket.get(archiveKey(fault))).json()).body.data,
					),
					original,
				);
			},
		);
	}
	await run(
		"reused message ID with different body is never acknowledged",
		{ id: "original", body: { ...original, extra: "different" } },
		(result) => {
			assert.equal(result.acked, 0);
			assert.equal(result.retried, 1);
		},
	);
	await run(
		"malformed main-queue message is archived without downstream attempts",
		{
			id: "invalid",
			queue: mainQueue,
			body: { version: 17, malformed: [null, "kept", 3] },
		},
		async (result) => {
			assert.equal(result.acked, 1);
			assert.equal(result.retried, 0);
			assert.equal(outbound.length, 0);
			assert.deepEqual(
				JSON.parse(
					(await (await bucket.get(archiveKey("invalid", mainQueue))).json())
						.body.data,
				),
				{ version: 17, malformed: [null, "kept", 3] },
			);
		},
	);
	await run(
		"unknown queue fails without acknowledging",
		{ id: "unknown", queue: "unrelated-queue" },
		(result) => {
			assert.equal(result.accepted, false);
			assert.equal(result.acked, 0);
		},
	);
	await run(
		"empty DLQ still alerts on unresolved R2 failures using bounded listing",
		{ action: "operations" },
		(result) => {
			assert.equal(result.accepted, true);
			assert.deepEqual(
				result.calls.find((call) => call.method === "list").options,
				{ prefix: `${root}unresolved/`, limit: 1 },
			);
			assert.match(
				outbound.find((call) => call.email).email.text,
				/Archived failed clicks still need investigation/,
			);
		},
	);
	for (let attempt = 0; attempt < 2; attempt++) {
		await run(
			"manual replay keeps old v1 envelope exactly (attempt " + attempt + ")",
			{ action: "replay", key: archiveKey("original") },
			async (result) => {
				assert.equal(result.accepted, true);
				assert.deepEqual(republished.at(-1), original);
				assert.ok(await bucket.get(markerKey("original")));
			},
		);
		await run(
			"replayed delivery uses the same downstream event ID (attempt " +
				attempt +
				")",
			{ id: "replayed-" + attempt, queue: mainQueue, body: republished.at(-1) },
			(result) => {
				assert.equal(result.acked, 1);
				assert.equal(ingestIds.size, 1);
				assert.equal(convexIds.size, 1);
			},
		);
	}
	await run(
		"tracked event ignored by ingest is retried without a Convex write",
		{ id: "false-ignored", queue: mainQueue, falseIgnored: true },
		(result) => {
			assert.equal(result.acked, 0);
			assert.equal(result.retried, 1);
			assert.equal(
				outbound.some((call) => call.url.includes("fixture.convex.cloud")),
				false,
			);
		},
	);
	for (const failure of [
		"notCommitted",
		"wrongReceipt",
		"wrongOwner",
		"wrongTime",
		"wrongLink",
		"convexFailure",
		"receiptRedirect",
		"ingestConflict",
		"falseIgnored",
	]) {
		await run(
			failure + " keeps the failure unresolved",
			{ action: "resolve", key: archiveKey("original"), [failure]: true },
			async (result) => {
				assert.equal(result.accepted, false);
				assert.ok(await bucket.get(markerKey("original")));
			},
		);
	}
	const originalMarker = await (await bucket.get(markerKey("original"))).text();
	const otherMarker = JSON.stringify({
		version: 1,
		archiveKey: archiveKey("another-message"),
		bodySha256: "different-body",
	});
	await bucket.put(markerKey("original"), otherMarker);
	await run(
		"resolution never removes a different identity or body marker",
		{ action: "resolve", key: archiveKey("original") },
		async (result) => {
			assert.equal(result.accepted, false);
			assert.equal(
				await (await bucket.get(markerKey("original"))).text(),
				otherMarker,
			);
		},
	);
	await bucket.put(markerKey("original"), originalMarker);
	await run(
		"legacy fractional timestamp archive is preserved",
		{
			id: "legacy-time",
			body: {
				...original,
				event: { ...event, occurred_at: "2026-09-05T18:00:00.123Z" },
			},
		},
		(result) => assert.equal(result.acked, 1),
	);
	await run(
		"ambiguous legacy whole-second receipt stays unresolved",
		{ action: "resolve", key: archiveKey("legacy-time") },
		async (result) => {
			assert.equal(result.accepted, false);
			assert.ok(await bucket.get(markerKey("legacy-time")));
		},
	);
	await run(
		"resolution write failure keeps the investigation marker",
		{
			action: "resolve",
			key: archiveKey("original"),
			fault: "resolution-write",
		},
		async (result) => {
			assert.equal(result.accepted, false);
			assert.ok(await bucket.get(markerKey("original")));
		},
	);
	await run(
		"verified exact receipts clear only the marker and preserve source and evidence",
		{ action: "resolve", key: archiveKey("original") },
		async (result) => {
			assert.equal(result.accepted, true);
			assert.equal(await bucket.get(markerKey("original")), null);
			assert.ok(await bucket.get(archiveKey("original")));
			assert.ok(await bucket.get(result.result.resolutionKey));
			assert.equal(ingestIds.size, 1);
			assert.equal(convexIds.size, 1);
		},
	);
	await run(
		"late DLQ redelivery reopens the warning conservatively",
		{ id: "original", attempts: 13 },
		async (result) => {
			assert.equal(result.acked, 1);
			assert.ok(await bucket.get(markerKey("original")));
		},
	);
	await run(
		"malformed message cannot be blindly replayed",
		{ action: "replay", key: archiveKey("invalid", mainQueue) },
		(result) => assert.equal(result.accepted, false),
	);
	await run(
		"valid message cannot use invalid-message resolution",
		{
			action: "resolve-invalid",
			key: archiveKey("original"),
			decision: {
				operator: "fixture operator",
				reason: "This should be rejected because the event is valid.",
			},
		},
		(result) => assert.equal(result.accepted, false),
	);
	await run(
		"explicit malformed-message decision preserves the original archive",
		{
			action: "resolve-invalid",
			key: archiveKey("invalid", mainQueue),
			decision: {
				operator: "fixture operator",
				reason:
					"Reviewed fixture with unsupported envelope version; no real event can be delivered.",
			},
		},
		async (result) => {
			assert.equal(result.accepted, true);
			assert.ok(await bucket.get(archiveKey("invalid", mainQueue)));
			assert.equal(await bucket.get(markerKey("invalid", mainQueue)), null);
		},
	);
	await run(
		"disabled event archive remains private",
		{
			id: "disabled",
			body: { ...original, event: { ...event, tracking_enabled: false } },
		},
		(result) => {
			assert.equal(result.acked, 1);
			assert.equal(outbound.length, 0);
		},
	);
	await run(
		"explicit disabled-event resolution collects no data",
		{
			action: "resolve",
			key: archiveKey("disabled"),
			operator: "fixture operator",
		},
		async (result) => {
			assert.equal(result.accepted, true);
			assert.equal(outbound.length, 0);
			assert.ok(await bucket.get(archiveKey("disabled")));
			assert.equal(await bucket.get(markerKey("disabled")), null);
			assert.equal(
				(await (await bucket.get(result.result.resolutionKey)).json()).decision,
				"tracking_disabled",
			);
		},
	);
	// Run the real CLI entry point in Node. Intercept its HTTP transport, not
	// Queue.send(), so a second JSON encoding at the API boundary is detectable.
	const transportDirectory = await mkdtemp(join(tmpdir(), "ndle-replay-http-"));
	try {
		const fixturePath = join(transportDirectory, "fixture.json");
		const callsPath = join(transportDirectory, "calls.json");
		await writeFile(
			fixturePath,
			JSON.stringify({
				archive: await (await bucket.get(archiveKey("original"))).json(),
				archiveKey: archiveKey("original"),
				mainQueue,
			}),
			{ mode: 0o600 },
		);
		const intercept = `
			import { readFileSync, writeFileSync } from "node:fs";
			const fixture = JSON.parse(readFileSync(process.env.NDLE_REPLAY_FIXTURE, "utf8"));
			const calls = [];
			globalThis.fetch = async (input, options = {}) => {
				const url = new URL(String(input));
				calls.push({ url: url.href, method: options.method || "GET", redirect: options.redirect, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
				writeFileSync(process.env.NDLE_REPLAY_CALLS, JSON.stringify(calls), { mode: 0o600 });
				if (url.origin !== "https://api.cloudflare.com") throw new Error("Unexpected outbound request blocked");
				if (url.pathname === "/client/v4/accounts/fixture-account/queues/fixture-queue-id") return Response.json({ success: true, result: { queue_name: fixture.mainQueue } });
				if (url.pathname === "/client/v4/accounts/fixture-account/r2/buckets/fixture-bucket/objects/" + fixture.archiveKey) return Response.json(fixture.archive);
				if (url.pathname === "/client/v4/accounts/fixture-account/queues/fixture-queue-id/messages" && options.method === "POST") return Response.json({ success: true });
				throw new Error("Unexpected outbound request blocked");
			};
		`;
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				`data:text/javascript,${encodeURIComponent(intercept)}`,
				join(project, "scripts/failed-clicks.mjs"),
				"replay",
				failedQueue,
				"original",
			],
			{
				cwd: project,
				encoding: "utf8",
				timeout: 15_000,
				env: {
					PATH: process.env.PATH,
					CLOUDFLARE_ACCOUNT_ID: "fixture-account",
					CLOUDFLARE_API_TOKEN: "FAKE-cloudflare-key",
					FAILED_CLICK_BUCKET: "fixture-bucket",
					CLICK_EVENTS_QUEUE_NAME: mainQueue,
					CLICK_EVENTS_FAILED_QUEUE_NAME: failedQueue,
					CLICK_EVENTS_QUEUE_ID: "fixture-queue-id",
					NDLE_REPLAY_FIXTURE: fixturePath,
					NDLE_REPLAY_CALLS: callsPath,
				},
			},
		);
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout), {
			eventId: event.idempotency_key,
			status: "requeued",
			unresolved: true,
		});
		const calls = JSON.parse(await readFile(callsPath, "utf8"));
		assert.equal(calls.length, 3);
		const push = calls.find((call) => call.method === "POST");
		assert.deepEqual(push.body, { body: original, content_type: "json" });
		assert.equal(typeof push.body.body, "object");
		assert.equal(calls.filter((call) => call.method !== "GET").length, 1);
		for (const call of calls) {
			assert.equal(call.redirect, "manual");
			assert.equal(call.headers.Authorization, "Bearer FAKE-cloudflare-key");
		}
		assert.ok(await bucket.get(markerKey("original")));
		assert.ok(await bucket.get(archiveKey("original")));
		passed++;
		console.log(
			"PASS real replay CLI sends the original object in the Cloudflare HTTP request",
		);
	} finally {
		await rm(transportDirectory, { recursive: true, force: true });
	}
	console.log(
		JSON.stringify({
			passed,
			runtime: "actual workerd + isolated R2",
			realCloudWrites: 0,
			realEmailSent: 0,
		}),
	);
} finally {
	await runtime.dispose();
	console.log("Runtime stopped; no persistent server remains.");
}
