import type { Bindings } from "./types";

const minute = 60_000;
const hour = 60 * minute;
const issueMessages = {
	click_queue_old:
		"Clicks have waited in the delivery queue for more than 5 minutes.",
	click_queue_large:
		"The click delivery queue exceeds 100 MB or 10,000 messages.",
	click_queue_unavailable: "The click delivery queue could not be checked.",
	failed_clicks:
		"The failed-click queue contains events that need investigation and replay.",
	failed_queue_unavailable: "The failed-click queue could not be checked.",
	ingest_unavailable:
		"The analytics service is unavailable or reports a failed component.",
	ingest_failed_jobs: "The analytics service has failed event jobs.",
	ingest_queue_large:
		"The analytics service has more than 1,000 waiting event jobs.",
	backup_old: "The latest verified database backup is more than 26 hours old.",
	backup_unavailable:
		"The latest database backup or its manifest is missing or invalid.",
	monitor_unavailable:
		"The link-monitoring service did not pass its readiness check.",
} as const;

type Issue = keyof typeof issueMessages;
type OperationsBindings = Pick<
	Bindings,
	| "CLICK_EVENTS"
	| "CLICK_EVENTS_FAILED"
	| "ANALYTICS_BACKUPS"
	| "API_SECRET"
	| "INGEST_ENDPOINT"
	| "MONITOR_READY_ENDPOINT"
	| "OPS_ALERTS_ENABLED"
	| "OPS_ALERT_TO"
	| "OPS_ALERT_FROM"
	| "RESEND_API_KEY"
>;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("The check returned an invalid response");
	}
	return value as Record<string, unknown>;
}

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("The check returned an invalid count");
	}
	return value;
}

async function readJson(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("The check returned an empty response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > 65_536) throw new Error("The check response is too large");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel();
	}
	const data = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder().decode(data));
}

export function checkClickQueue(metrics: QueueMetrics, now: number): Issue[] {
	const waiting = count(metrics.backlogCount);
	const bytes = count(metrics.backlogBytes);
	const issues: Issue[] = [];
	// Published docs and generated types differ here; accept either timestamp form.
	const oldest = Number(metrics.oldestMessageTimestamp);
	if (waiting > 0 && oldest > 0 && now - oldest > 5 * minute)
		issues.push("click_queue_old");
	if (waiting > 10_000 || bytes > 100 * 1024 * 1024)
		issues.push("click_queue_large");
	return issues;
}

export function checkIngestHealth(value: unknown): Issue[] {
	const health = record(value);
	const checks = record(health.checks);
	const queue = record(record(checks.queue).details);
	const issues: Issue[] = [];
	if (health.status !== "ok") issues.push("ingest_unavailable");
	if (count(queue.failed) > 0) issues.push("ingest_failed_jobs");
	if (count(queue.waiting) > 1_000) issues.push("ingest_queue_large");
	return issues;
}

async function checkBackup(
	env: OperationsBindings,
	now: number,
): Promise<Issue[]> {
	const object = await env.ANALYTICS_BACKUPS.get(
		"snapshots/duckdb/latest.json",
	);
	if (!object || object.size > 16_384)
		throw new Error("Backup manifest is unavailable");
	const manifest = record(await object.json());
	const created =
		typeof manifest.createdAt === "string"
			? Date.parse(manifest.createdAt)
			: NaN;
	if (
		manifest.version !== 3 ||
		typeof manifest.key !== "string" ||
		!/^snapshots\/duckdb\/[^/]+\/analytics\.duckdb$/.test(manifest.key) ||
		!Number.isFinite(created) ||
		created > now + 5 * minute ||
		typeof manifest.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(manifest.sha256)
	) {
		throw new Error("Backup manifest is invalid");
	}
	const backup = await env.ANALYTICS_BACKUPS.head(manifest.key);
	if (!backup || backup.size !== count(manifest.size) || backup.size === 0) {
		throw new Error("Backup file does not match its manifest");
	}
	return now - created > 26 * hour ? ["backup_old"] : [];
}

export function buildAlert(issues: Issue[], now: number) {
	const unique = [...new Set(issues)].sort();
	return {
		// Keep the body stable for a given key: retries and overlapping cron runs
		// cannot send duplicate mail. Persistent conditions remind at most hourly.
		key: `ndle-operations/${Math.floor(now / hour)}/${unique.join("-")}`,
		subject: "NDLE needs attention",
		text: [
			"NDLE production checks found:",
			...unique.map((issue) => `- ${issueMessages[issue]}`),
			"",
			"Inspect the NDLE Cloudflare queues and Coolify service logs. Preserve failed events; do not delete them to clear an alert.",
			"https://dash.cloudflare.com/",
			"https://coolify.superlinkify.com/",
			"",
			"Checks run every 5 minutes. An unchanged set of problems sends at most one reminder per hour. Healthy checks do not send email.",
		].join("\n"),
	};
}

async function withDeadline<T>(
	check: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(check),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("The operations check timed out")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function checkOperations(
	env: OperationsBindings,
	now = Date.now(),
	sendRequest: typeof fetch = fetch,
	checkTimeoutMs = 12_000,
): Promise<void> {
	if (env.OPS_ALERTS_ENABLED !== "true") return;
	if (!env.RESEND_API_KEY || !env.OPS_ALERT_FROM || !env.OPS_ALERT_TO) {
		throw new Error("NDLE alert email is not configured");
	}
	const checkSources = [
		{
			failure: "click_queue_unavailable",
			run: async () => checkClickQueue(await env.CLICK_EVENTS.metrics(), now),
		},
		{
			failure: "failed_queue_unavailable",
			run: async () =>
				count((await env.CLICK_EVENTS_FAILED.metrics()).backlogCount) > 0
					? ["failed_clicks"]
					: [],
		},
		{ failure: "backup_unavailable", run: () => checkBackup(env, now) },
		{
			failure: "ingest_unavailable",
			run: async () => {
				const [ready, response] = await Promise.all([
					sendRequest(new URL("/health/ready", env.INGEST_ENDPOINT), {
						signal: AbortSignal.timeout(10_000),
						redirect: "error",
					}),
					sendRequest(new URL("/health/detailed", env.INGEST_ENDPOINT), {
						headers: { Authorization: `Bearer ${env.API_SECRET}` },
						signal: AbortSignal.timeout(10_000),
						redirect: "error",
					}),
				]);
				if (response.status !== 200 && response.status !== 503)
					throw new Error("Ingest check failed");
				const issues = checkIngestHealth(await readJson(response));
				if (!ready.ok || record(await readJson(ready)).status !== "ready")
					issues.push("ingest_unavailable");
				return issues;
			},
		},
		{
			failure: "monitor_unavailable",
			run: async () => {
				const response = await sendRequest(env.MONITOR_READY_ENDPOINT, {
					signal: AbortSignal.timeout(10_000),
					redirect: "error",
				});
				const status = record(await readJson(response)).status;
				return response.ok && status === "ready" ? [] : ["monitor_unavailable"];
			},
		},
	] satisfies Array<{ failure: Issue; run: () => Promise<Issue[]> }>;
	const results = await Promise.allSettled(
		checkSources.map((check) => withDeadline(check.run, checkTimeoutMs)),
	);
	const issues = results.flatMap((result, index) =>
		result.status === "fulfilled"
			? result.value
			: [checkSources[index].failure],
	);
	console.info(
		JSON.stringify({
			message: "NDLE operations checked",
			issues,
			checked_at: new Date(now).toISOString(),
		}),
	);
	if (!issues.length) return;
	const alert = buildAlert(issues, now);
	// Hash the bounded issue signature to keep Resend's key under 256 characters.
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`${alert.key}/${env.OPS_ALERT_FROM}/${env.OPS_ALERT_TO}`,
		),
	);
	const key = [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
	const response = await sendRequest("https://api.resend.com/emails", {
		method: "POST",
		signal: AbortSignal.timeout(10_000),
		redirect: "error",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
			"Idempotency-Key": `ndle-operations/${key}`,
		},
		body: JSON.stringify({
			from: env.OPS_ALERT_FROM,
			to: [env.OPS_ALERT_TO],
			subject: alert.subject,
			text: alert.text,
		}),
	});
	const receipt = record(await readJson(response));
	if (!response.ok || typeof receipt.id !== "string" || !receipt.id) {
		throw new Error(
			`NDLE alert email was not accepted (HTTP ${response.status})`,
		);
	}
	console.info(
		JSON.stringify({
			message: "NDLE alert email accepted",
			message_id: receipt.id,
			issues,
		}),
	);
}
