import { unresolvedClickPrefix } from "./failed-clicks";
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
	archived_failed_clicks:
		"Archived failed clicks still need investigation or verified replay.",
	failed_archive_unavailable: "The failed-click archive could not be checked.",
	ingest_health_transport:
		"The analytics health check could not connect to the service.",
	ingest_health_http:
		"The analytics health check returned an unexpected HTTP status.",
	ingest_health_invalid:
		"The analytics health check returned an invalid response.",
	ingest_health_timeout:
		"The analytics health check did not finish before its deadline.",
	ingest_not_ready:
		"The analytics service reports that it is not ready to accept events.",
	ingest_health_failed:
		"The analytics service reports an unhealthy state without a named failed component.",
	ingest_queue_health: "The analytics service cannot read its event queue.",
	ingest_database_health: "The analytics database check failed.",
	ingest_writer_health:
		"The analytics event writer reports a failed or delayed commit.",
	ingest_archiver_health: "The analytics archive check failed.",
	ingest_backup_health:
		"The analytics service reports a database backup failure.",
	ingest_recovery_health: "The analytics recovery check failed.",
	ingest_recovery_overdue:
		"Analytics events have waited too long for recovery.",
	ingest_recovery_stalled:
		"The analytics recovery process has stopped making progress.",
	ingest_recovery_unavailable:
		"The analytics recovery process has not completed a recent check.",
	ingest_recovery_records:
		"Analytics recovery found event records that need investigation.",
	ingest_recovery_scan_overdue:
		"The analytics recovery scan of saved events is overdue.",
	ingest_recovery_error:
		"The analytics recovery process reports a recent error.",
	ingest_recovery_scan_error:
		"The analytics recovery scan of saved events reports a recent error.",
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
	| "FAILED_CLICK_ARCHIVES"
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

const componentIssues = {
	queue: "ingest_queue_health",
	duckdb: "ingest_database_health",
	batch_writer: "ingest_writer_health",
	archiver: "ingest_archiver_health",
	backup: "ingest_backup_health",
	recovery: "ingest_recovery_health",
} as const satisfies Record<string, Issue>;
const recoveryIssues = {
	overdue: "ingest_recovery_overdue",
	stalled: "ingest_recovery_stalled",
	unavailable: "ingest_recovery_unavailable",
	problemRecordsPresent: "ingest_recovery_records",
	auditOverdue: "ingest_recovery_scan_overdue",
	lastError: "ingest_recovery_error",
	auditLastError: "ingest_recovery_scan_error",
} as const satisfies Record<string, Issue>;
type HealthStatus = "ok" | "degraded" | "error" | "invalid";
type IngestEvidence = {
	endpoint: "ready" | "detailed";
	result:
		| "reported"
		| "http_error"
		| "transport_error"
		| "invalid_response"
		| "timeout";
	http_status?: number;
	timeout_ms?: number;
	status?: HealthStatus | "ready" | "not_ready";
	failed_components?: Array<keyof typeof componentIssues>;
	recovery_reasons?: Array<keyof typeof recoveryIssues>;
};
type IngestCheck = { issues: Issue[]; evidence: IngestEvidence };

function healthStatus(value: unknown): HealthStatus {
	return value === "ok" || value === "degraded" || value === "error"
		? value
		: "invalid";
}

function inspectIngestHealth(value: unknown): Omit<IngestCheck, "evidence"> & {
	evidence: Pick<
		IngestEvidence,
		"status" | "failed_components" | "recovery_reasons"
	>;
} {
	const health = record(value);
	const checks = record(health.checks);
	const status = healthStatus(health.status);
	const issues: Issue[] = [];
	const failed: Array<keyof typeof componentIssues> = [];
	const reasons: Array<keyof typeof recoveryIssues> = [];
	if (status === "invalid") issues.push("ingest_health_invalid");
	for (const component of Object.keys(componentIssues) as Array<
		keyof typeof componentIssues
	>) {
		try {
			const check = record(checks[component]);
			const componentStatus = healthStatus(check.status);
			if (componentStatus === "invalid") issues.push("ingest_health_invalid");
			else if (componentStatus !== "ok") {
				failed.push(component);
				issues.push(componentIssues[component]);
			}
			if (component === "queue" && componentStatus === "ok") {
				const queue = record(check.details);
				if (count(queue.failed) > 0) issues.push("ingest_failed_jobs");
				if (count(queue.waiting) > 1_000) issues.push("ingest_queue_large");
			}
			if (
				component === "recovery" &&
				componentStatus !== "ok" &&
				componentStatus !== "invalid"
			) {
				const details = record(check.details);
				for (const reason of Object.keys(recoveryIssues) as Array<
					keyof typeof recoveryIssues
				>) {
					// Only known flags and the presence of an error are safe to emit.
					// Never copy error text, arbitrary keys, or recovery object paths.
					const present =
						reason === "lastError" || reason === "auditLastError"
							? typeof details[reason] === "string" &&
								details[reason].length > 0
							: details[reason] === true;
					if (present) {
						reasons.push(reason);
						issues.push(recoveryIssues[reason]);
					}
				}
			}
		} catch {
			// Keep any independently observed failures even if another field is bad.
			issues.push("ingest_health_invalid");
		}
	}
	if (status !== "ok" && status !== "invalid" && !failed.length)
		issues.push("ingest_health_failed");
	return {
		issues: [...new Set(issues)],
		evidence: { status, failed_components: failed, recovery_reasons: reasons },
	};
}

export function checkIngestHealth(value: unknown): Issue[] {
	return inspectIngestHealth(value).issues;
}

async function readIngestEndpoint(
	env: OperationsBindings,
	endpoint: IngestEvidence["endpoint"],
	sendRequest: typeof fetch,
	checkTimeoutMs: number,
): Promise<IngestCheck> {
	try {
		return await withDeadline(async () => {
			const signal = AbortSignal.timeout(10_000);
			let response: Response;
			try {
				response = await sendRequest(
					new URL(`/health/${endpoint}`, env.INGEST_ENDPOINT),
					{
						...(endpoint === "detailed"
							? { headers: { Authorization: `Bearer ${env.API_SECRET}` } }
							: {}),
						signal,
						redirect: "manual",
					},
				);
			} catch {
				if (signal.aborted)
					return {
						issues: ["ingest_health_timeout"],
						evidence: { endpoint, result: "timeout", timeout_ms: 10_000 },
					};
				return {
					issues: ["ingest_health_transport"],
					evidence: { endpoint, result: "transport_error" },
				};
			}
			const evidence = { endpoint, http_status: response.status };
			if (response.status !== 200 && response.status !== 503) {
				await response.body?.cancel();
				return {
					issues: ["ingest_health_http"],
					evidence: { ...evidence, result: "http_error" },
				};
			}
			try {
				const value = await readJson(response);
				if (endpoint === "detailed") {
					const details = inspectIngestHealth(value);
					// A 503 with a wholly healthy body is still a failed HTTP check.
					if (
						response.status === 503 &&
						details.evidence.status === "ok" &&
						!details.evidence.failed_components?.length
					)
						details.issues.push("ingest_health_http");
					return {
						issues: details.issues,
						evidence: { ...evidence, ...details.evidence, result: "reported" },
					};
				}
				const status = record(value).status;
				if (status !== "ready" && status !== "not_ready")
					throw new Error("Invalid readiness response");
				return {
					issues:
						status === "not_ready"
							? ["ingest_not_ready"]
							: response.status === 200
								? []
								: ["ingest_health_http"],
					evidence: { ...evidence, status, result: "reported" },
				};
			} catch {
				if (signal.aborted)
					return {
						issues: ["ingest_health_timeout"],
						evidence: { ...evidence, result: "timeout", timeout_ms: 10_000 },
					};
				return {
					issues: ["ingest_health_invalid"],
					evidence: { ...evidence, result: "invalid_response" },
				};
			}
		}, checkTimeoutMs);
	} catch {
		return {
			issues: ["ingest_health_timeout"],
			evidence: { endpoint, result: "timeout", timeout_ms: checkTimeoutMs },
		};
	}
}

function needsHealthConfirmation(issue: Issue): boolean {
	return (
		issue !== "ingest_failed_jobs" &&
		issue !== "ingest_queue_large" &&
		issue !== "ingest_recovery_records"
	);
}

async function checkIngest(
	env: OperationsBindings,
	sendRequest: typeof fetch,
	checkTimeoutMs: number,
) {
	const checks = await Promise.all([
		readIngestEndpoint(env, "ready", sendRequest, checkTimeoutMs),
		readIngestEndpoint(env, "detailed", sendRequest, checkTimeoutMs),
	]);
	return {
		issues: [...new Set(checks.flatMap((check) => check.issues))],
		evidence: checks.map((check) => check.evidence),
	};
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
	waitForConfirmation: (delayMs: number) => Promise<void> = (delayMs) =>
		new Promise((resolve) => setTimeout(resolve, delayMs)),
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
		{
			failure: "failed_archive_unavailable",
			run: async () => {
				const result = await env.FAILED_CLICK_ARCHIVES.list({
					prefix: unresolvedClickPrefix,
					limit: 1,
				});
				if (!Array.isArray(result.objects))
					throw new Error("Failed archive list is invalid");
				return result.objects.length || result.truncated
					? ["archived_failed_clicks"]
					: [];
			},
		},
		{ failure: "backup_unavailable", run: () => checkBackup(env, now) },
		{
			failure: "monitor_unavailable",
			run: async () => {
				const response = await sendRequest(env.MONITOR_READY_ENDPOINT, {
					signal: AbortSignal.timeout(10_000),
					redirect: "manual",
				});
				const status = record(await readJson(response)).status;
				return response.ok && status === "ready" ? [] : ["monitor_unavailable"];
			},
		},
	] satisfies Array<{ failure: Issue; run: () => Promise<Issue[]> }>;
	const [results, initialIngest] = await Promise.all([
		Promise.allSettled(
			checkSources.map((check) => withDeadline(check.run, checkTimeoutMs)),
		),
		checkIngest(env, sendRequest, checkTimeoutMs),
	]);
	const otherIssues = results.flatMap((result, index) =>
		result.status === "fulfilled"
			? result.value
			: [checkSources[index].failure],
	);
	const confirmationNeeded = initialIngest.issues.some(needsHealthConfirmation);
	console.info(
		JSON.stringify({
			message: "NDLE analytics health checked",
			phase: "initial",
			issues: initialIngest.issues,
			checks: initialIngest.evidence,
			confirmation_needed: confirmationNeeded,
			scheduled_at: new Date(now).toISOString(),
			checked_at: new Date().toISOString(),
		}),
	);
	let ingest = initialIngest;
	if (confirmationNeeded) {
		await waitForConfirmation(15_000);
		ingest = await checkIngest(env, sendRequest, checkTimeoutMs);
		console.info(
			JSON.stringify({
				message: "NDLE analytics health checked",
				phase: "confirmation",
				issues: ingest.issues,
				checks: ingest.evidence,
				delay_ms: 15_000,
				scheduled_at: new Date(now).toISOString(),
				checked_at: new Date().toISOString(),
			}),
		);
	}
	// A health recovery must never erase failed jobs or other independently
	// observed problems. Only transient health issues are replaced by the recheck.
	const issues = [
		...new Set([
			...otherIssues,
			...initialIngest.issues.filter(
				(issue) => !needsHealthConfirmation(issue),
			),
			...ingest.issues,
		]),
	];
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
		redirect: "manual",
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
