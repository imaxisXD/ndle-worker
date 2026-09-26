import {
	type AlertContext,
	type AlertLinks,
	buildAlertEmail,
	buildAllClearEmail,
	describeDuration,
	type FailedClickRef,
	type Issue,
	issuePlaybooks,
} from "./alert-email";
import { unresolvedClickPrefix } from "./failed-clicks";
import { opsSecret } from "./ingest-auth";
import type { Bindings } from "./types";

const minute = 60_000;
const hour = 60 * minute;

type OperationsBindings = Pick<
	Bindings,
	| "CLICK_EVENTS"
	| "CLICK_EVENTS_FAILED"
	| "ANALYTICS_BACKUPS"
	| "FAILED_CLICK_ARCHIVES"
	// Detailed health uses OPS_SECRET, else the legacy API_SECRET.
	| "OPS_SECRET"
	| "API_SECRET"
	| "INGEST_ENDPOINT"
	| "MONITOR_READY_ENDPOINT"
	| "OPS_ALERTS_ENABLED"
	| "OPS_ALERT_TO"
	| "OPS_ALERT_FROM"
	| "RESEND_API_KEY"
	| "OPS_ALERT_TIMEZONE"
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

/** Plain numbers for the alert email, e.g. "3 clicks are waiting". */
export function describeClickQueue(metrics: QueueMetrics, now: number): string {
	const waiting = count(metrics.backlogCount);
	const bytes = count(metrics.backlogBytes);
	const oldest = Number(metrics.oldestMessageTimestamp);
	const size =
		bytes >= 1024 * 1024
			? `${(bytes / 1024 / 1024).toFixed(1)} MB`
			: `${Math.ceil(bytes / 1024)} KB`;
	const age =
		oldest > 0
			? `; the oldest has waited ${describeDuration(now - oldest)}`
			: "";
	return `${waiting.toLocaleString("en-US")} click${waiting === 1 ? " is" : "s are"} waiting (${size})${age}.`;
}

const componentIssues = {
	queue: "ingest_queue_health",
	duckdb: "ingest_database_health",
	batch_writer: "ingest_writer_health",
	archiver: "ingest_archiver_health",
	backup: "ingest_backup_health",
	recovery: "ingest_recovery_health",
	journal: "ingest_journal_health",
} as const satisfies Record<string, Issue>;
// Older ingest versions report queue and recovery; newer ones report journal.
// Each is checked only when present. Every other component is required.
const optionalComponents = new Set<keyof typeof componentIssues>([
	"queue",
	"recovery",
	"journal",
]);
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
		if (checks[component] === undefined && optionalComponents.has(component))
			continue;
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
			// Without any secret, ingest rejects the request and the HTTP check alerts.
			const token = endpoint === "detailed" ? opsSecret(env) : undefined;
			let response: Response;
			try {
				response = await sendRequest(
					new URL(`/health/${endpoint}`, env.INGEST_ENDPOINT),
					{
						...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
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
	facts: Partial<Record<Issue, string>> = {},
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
	if (now - created > 26 * hour) {
		facts.backup_old = `The latest verified backup is ${describeDuration(now - created)} old.`;
		return ["backup_old"];
	}
	return [];
}

const defaultLinks: AlertLinks = {
	analyticsReady: "https://api.ndle.app/health/ready",
	analyticsDetailedCommand:
		'curl -s -H "Authorization: Bearer $OPS_SECRET" https://api.ndle.app/health/detailed',
	analyticsBackupCommand:
		'curl -s -X POST -H "Authorization: Bearer $OPS_SECRET" https://api.ndle.app/internal/backup',
	monitorReady: "https://monitor.ndle.app/ready",
	coolify: "https://coolify.superlinkify.com/",
	cloudflareQueues: "https://dash.cloudflare.com/?to=/:account/workers/queues",
	cloudflareR2:
		"https://dash.cloudflare.com/?to=/:account/r2/default/buckets/ndle-analytics",
	cloudflareWorker:
		"https://dash.cloudflare.com/?to=/:account/workers/services/view/ndleworker/production",
	cloudflareStatus: "https://www.cloudflarestatus.com/",
};

function alertLinks(env: OperationsBindings): AlertLinks {
	try {
		const analytics = new URL(env.INGEST_ENDPOINT).origin;
		return {
			...defaultLinks,
			analyticsReady: `${analytics}/health/ready`,
			analyticsDetailedCommand: `curl -s -H "Authorization: Bearer $OPS_SECRET" ${analytics}/health/detailed`,
			analyticsBackupCommand: `curl -s -X POST -H "Authorization: Bearer $OPS_SECRET" ${analytics}/internal/backup`,
			monitorReady: env.MONITOR_READY_ENDPOINT || defaultLinks.monitorReady,
		};
	} catch {
		return defaultLinks;
	}
}

function alertKey(issues: Issue[], now: number): string {
	// Keep the body stable for a given key: retries and overlapping cron runs
	// cannot send duplicate mail. Persistent conditions remind at most hourly.
	return `ndle-operations/${Math.floor(now / hour)}/${[...new Set(issues)].sort().join("-")}`;
}

export function buildAlert(
	issues: Issue[],
	now: number,
	context: Partial<AlertContext> = {},
) {
	return {
		key: alertKey(issues, now),
		...buildAlertEmail(issues, {
			now,
			timeZone: "UTC",
			links: defaultLinks,
			facts: {},
			firstSeen: {},
			failedClicks: [],
			...context,
		}),
	};
}

/** Remembers the problems last emailed so a later all-clear can name them. */
const alertStateKey = "operations/alert-state.json";
type AlertState = {
	version: 1;
	issues: Issue[];
	firstSeen: Partial<Record<Issue, number>>;
	alertedAt?: number;
};

/** Resolves null when no usable state exists; rejects when R2 can't be read. */
async function readAlertState(
	env: OperationsBindings,
): Promise<AlertState | null> {
	const object = await env.ANALYTICS_BACKUPS.get(alertStateKey);
	if (!object || object.size > 16_384) return null;
	try {
		const value = record(await object.json());
		if (
			value.version !== 1 ||
			!Array.isArray(value.issues) ||
			!value.issues.every(
				(issue) => typeof issue === "string" && issue in issuePlaybooks,
			)
		)
			return null;
		const firstSeen = record(value.firstSeen ?? {});
		return {
			version: 1,
			issues: value.issues as Issue[],
			firstSeen: Object.fromEntries(
				Object.entries(firstSeen).filter(
					([issue, time]) => issue in issuePlaybooks && Number.isFinite(time),
				),
			) as AlertState["firstSeen"],
			alertedAt:
				typeof value.alertedAt === "number" ? value.alertedAt : undefined,
		};
	} catch {
		return null;
	}
}

async function writeAlertState(
	env: OperationsBindings,
	state: AlertState | null,
): Promise<void> {
	try {
		await withDeadline(
			async () =>
				state
					? await env.ANALYTICS_BACKUPS.put(
							alertStateKey,
							JSON.stringify(state),
							{ httpMetadata: { contentType: "application/json" } },
						)
					: await env.ANALYTICS_BACKUPS.delete(alertStateKey),
			10_000,
		);
	} catch (error) {
		// Emails still go out; only the all-clear summary may be missed.
		console.warn(
			JSON.stringify({
				message: "NDLE alert state could not be saved",
				error: error instanceof Error ? error.name : "unknown",
			}),
		);
	}
}

async function digestText(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sendEmail(
	env: OperationsBindings,
	sendRequest: typeof fetch,
	idempotencyKey: string,
	email: { subject: string; text: string; html: string },
): Promise<string> {
	// Hash the bounded signature to keep Resend's key under 256 characters.
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`${idempotencyKey}/${env.OPS_ALERT_FROM}/${env.OPS_ALERT_TO}`,
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
			subject: email.subject,
			text: email.text,
			html: email.html,
		}),
	});
	const receipt = record(await readJson(response));
	if (!response.ok || typeof receipt.id !== "string" || !receipt.id) {
		throw new Error(
			`NDLE alert email was not accepted (HTTP ${response.status})`,
		);
	}
	return receipt.id;
}

function describeIngest(evidence: IngestEvidence[]): string {
	return `${evidence
		.map((check) => {
			const path = `/health/${check.endpoint}`;
			const outcome =
				check.result === "timeout"
					? "did not answer within 10 seconds"
					: check.result === "transport_error"
						? "could not be reached"
						: check.result === "invalid_response"
							? `answered HTTP ${check.http_status} in an unexpected format`
							: `answered HTTP ${check.http_status}${check.status ? ` (${check.status})` : ""}`;
			const failing = check.failed_components?.length
				? `; failing parts: ${check.failed_components.join(", ")}`
				: "";
			return `${path} ${outcome}${failing}`;
		})
		.join(". ")}.`;
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
	// Measured details for the email. Only counts, ages and fixed labels.
	const facts: Partial<Record<Issue, string>> = {};
	const failedClicks: FailedClickRef[] = [];
	const checkSources = [
		{
			failure: "click_queue_unavailable",
			run: async () => {
				const metrics = await env.CLICK_EVENTS.metrics();
				const issues = checkClickQueue(metrics, now);
				if (issues.length) {
					const description = describeClickQueue(metrics, now);
					for (const issue of issues) facts[issue] = description;
				}
				return issues;
			},
		},
		{
			failure: "failed_queue_unavailable",
			run: async () => {
				const waiting = count(
					(await env.CLICK_EVENTS_FAILED.metrics()).backlogCount,
				);
				if (!waiting) return [];
				facts.failed_clicks = `${waiting.toLocaleString("en-US")} click${waiting === 1 ? " is" : "s are"} in the failed-click queue.`;
				return ["failed_clicks"];
			},
		},
		{
			failure: "failed_archive_unavailable",
			run: async () => {
				const result = await env.FAILED_CLICK_ARCHIVES.list({
					prefix: unresolvedClickPrefix,
					limit: 20,
				});
				if (!Array.isArray(result.objects))
					throw new Error("Failed archive list is invalid");
				if (!result.objects.length && !result.truncated) return [];
				for (const object of result.objects.slice(0, 5)) {
					const [queue, file] = String(object.key)
						.slice(unresolvedClickPrefix.length)
						.split("/");
					if (queue && file?.endsWith(".json"))
						failedClicks.push({ queue, messageId: file.slice(0, -5) });
				}
				const total = result.truncated
					? `More than ${result.objects.length}`
					: String(result.objects.length);
				facts.archived_failed_clicks = `${total} saved failed click${result.objects.length === 1 && !result.truncated ? "" : "s"} still need replaying${failedClicks.length < result.objects.length ? `; the first ${failedClicks.length} are listed below` : ""}.`;
				return ["archived_failed_clicks"];
			},
		},
		{
			failure: "backup_unavailable",
			run: () => checkBackup(env, now, facts),
		},
		{
			failure: "monitor_unavailable",
			run: async () => {
				const response = await sendRequest(env.MONITOR_READY_ENDPOINT, {
					signal: AbortSignal.timeout(10_000),
					redirect: "manual",
				});
				const status = record(await readJson(response)).status;
				if (response.ok && status === "ready") return [];
				facts.monitor_unavailable = `The readiness check answered HTTP ${response.status}.`;
				return ["monitor_unavailable"];
			},
		},
	] satisfies Array<{ failure: Issue; run: () => Promise<Issue[]> }>;
	const [results, initialIngest, stored] = await Promise.all([
		Promise.allSettled(
			checkSources.map((check) => withDeadline(check.run, checkTimeoutMs)),
		),
		checkIngest(env, sendRequest, checkTimeoutMs),
		// A stalled R2 read must not hold back the alert itself.
		withDeadline(() => readAlertState(env), checkTimeoutMs).then(
			(state) => ({ available: true as const, state }),
			() => ({ available: false as const, state: null }),
		),
	]);
	const previous = stored.state;
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
	const ingestFact = describeIngest(ingest.evidence as IngestEvidence[]);
	for (const issue of issues)
		if (issue.startsWith("ingest_") && !facts[issue]) facts[issue] = ingestFact;
	console.info(
		JSON.stringify({
			message: "NDLE operations checked",
			issues,
			checked_at: new Date(now).toISOString(),
		}),
	);
	const context: AlertContext = {
		now,
		timeZone: env.OPS_ALERT_TIMEZONE || "UTC",
		links: alertLinks(env),
		facts,
		firstSeen: Object.fromEntries(
			issues.map((issue) => [issue, previous?.firstSeen[issue] ?? now]),
		),
		failedClicks,
	};
	if (!issues.length) {
		// Say so once when problems that were emailed have all cleared.
		if (previous?.alertedAt !== undefined && previous.issues.length) {
			const id = await sendEmail(
				env,
				sendRequest,
				`all-clear/${previous.alertedAt}/${[...previous.issues].sort().join("-")}`,
				buildAllClearEmail(previous.issues, {
					...context,
					firstSeen: previous.firstSeen,
				}),
			);
			console.info(
				JSON.stringify({
					message: "NDLE all-clear email accepted",
					message_id: id,
					resolved: previous.issues,
				}),
			);
		}
		if (previous) await writeAlertState(env, null);
		return;
	}
	const sameProblems =
		previous !== null &&
		previous.issues.length === issues.length &&
		issues.every((issue) => previous.issues.includes(issue));
	// An unchanged set of problems is repeated at most once an hour.
	if (
		sameProblems &&
		previous.alertedAt !== undefined &&
		now - previous.alertedAt < hour
	)
		return;
	let email: ReturnType<typeof buildAlertEmail>;
	let idempotencyKey: string;
	if (stored.available) {
		email = buildAlertEmail(issues, context);
		// Retries of this exact email are sent once; changed numbers are new mail.
		idempotencyKey = `${alertKey(issues, now)}/${await digestText(email.text)}`;
	} else {
		// Without saved state, fall back to an email that stays identical for the
		// hour so the provider's idempotency key limits reminders to hourly.
		email = buildAlertEmail(issues, {
			...context,
			now: Math.floor(now / hour) * hour,
			facts: {},
			firstSeen: {},
		});
		idempotencyKey = alertKey(issues, now);
	}
	const id = await sendEmail(env, sendRequest, idempotencyKey, email);
	await writeAlertState(env, {
		version: 1,
		issues,
		firstSeen: context.firstSeen,
		alertedAt: now,
	});
	console.info(
		JSON.stringify({
			message: "NDLE alert email accepted",
			message_id: id,
			issues,
		}),
	);
}
