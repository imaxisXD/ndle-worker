import {
	describeDuration,
	type FailedClickRef,
	type Issue,
} from "../alert-email";
import { unresolvedClickPrefix } from "../failed-clicks";
import { isRecord } from "../guards";
import { opsSecret } from "../ingest-auth";
import type { RequestLogger } from "../log";
import type { Bindings } from "../types";

export const minute = 60_000;
export const hour = 60 * minute;

const textDecoder = new TextDecoder();
const backupKeyRegex = /^snapshots\/duckdb\/[^/]+\/analytics\.duckdb$/;
const sha256HexRegex = /^[a-f0-9]{64}$/;
const cloudflareCodeRegex = /\((\d{3,6})\)$/;

export type OperationsBindings = Pick<
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
	| "LOG_LEVEL"
>;

export function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error("The check returned an invalid response");
	}
	return value;
}

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("The check returned an invalid count");
	}
	return value;
}

export async function readJson(response: Response): Promise<unknown> {
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
	return JSON.parse(textDecoder.decode(data));
}

export async function withDeadline<T>(
	check: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(check),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					const error = new Error("The operations check timed out");
					error.name = "TimeoutError";
					reject(error);
				}, timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
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
function describeClickQueue(metrics: QueueMetrics, now: number): string {
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

// All five components emitted by `ndle-ingest-service/src/routes/health.ts` are required.
const componentIssues = {
	duckdb: "ingest_database_health",
	batch_writer: "ingest_writer_health",
	archiver: "ingest_archiver_health",
	backup: "ingest_backup_health",
	journal: "ingest_journal_health",
} as const satisfies Record<string, Issue>;

const requiredComponents = Object.keys(componentIssues) as Array<
	keyof typeof componentIssues
>;

type HealthStatus = "ok" | "degraded" | "error" | "invalid";

export type IngestEvidence = {
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
};

type IngestCheck = { issues: Issue[]; evidence: IngestEvidence };

function healthStatus(value: unknown): HealthStatus {
	return value === "ok" || value === "degraded" || value === "error"
		? value
		: "invalid";
}

function inspectIngestHealth(value: unknown): Omit<IngestCheck, "evidence"> & {
	evidence: Pick<IngestEvidence, "status" | "failed_components">;
} {
	const health = record(value);
	const checks = record(health.checks);
	const status = healthStatus(health.status);
	const issues: Issue[] = [];
	const failed: Array<keyof typeof componentIssues> = [];
	if (status === "invalid") issues.push("ingest_health_invalid");
	for (const component of requiredComponents) {
		try {
			const check = record(checks[component]);
			const componentStatus = healthStatus(check.status);
			if (componentStatus === "invalid") issues.push("ingest_health_invalid");
			else if (componentStatus !== "ok") {
				failed.push(component);
				issues.push(componentIssues[component]);
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
		evidence: { status, failed_components: failed },
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

export async function checkIngest(
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

export function describeIngest(evidence: IngestEvidence[]): string {
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

async function checkBackup(
	env: OperationsBindings,
	now: number,
	facts: Partial<Record<Issue, string>>,
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
			: Number.NaN;
	if (
		manifest.version !== 3 ||
		typeof manifest.key !== "string" ||
		!backupKeyRegex.test(manifest.key) ||
		!Number.isFinite(created) ||
		created > now + 5 * minute ||
		typeof manifest.sha256 !== "string" ||
		!sha256HexRegex.test(manifest.sha256)
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

export async function runSourceChecks(
	env: OperationsBindings,
	now: number,
	sendRequest: typeof fetch,
	checkTimeoutMs: number,
	log: RequestLogger,
) {
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
				if (!response.ok) {
					await response.body?.cancel();
					facts.monitor_unavailable = `The readiness check answered HTTP ${response.status}.`;
					return ["monitor_unavailable"];
				}
				const status = record(await readJson(response)).status;
				if (status === "ready") return [];
				facts.monitor_unavailable = `The readiness check answered HTTP ${response.status}.`;
				return ["monitor_unavailable"];
			},
		},
	] satisfies Array<{ failure: Issue; run: () => Promise<Issue[]> }>;

	const results = await Promise.allSettled(
		checkSources.map((check) => withDeadline(check.run, checkTimeoutMs)),
	);
	const otherIssues = results.flatMap((result, index) => {
		if (result.status === "fulfilled") return result.value;
		const failure = checkSources[index].failure;
		const error = result.reason instanceof Error ? result.reason : undefined;
		// Cloudflare binding errors end in a numeric code, e.g. "(15000)". Log
		// only that code and the error name, never the message text.
		log.warn("NDLE operations check failed", {
			check: failure,
			error: error?.name ?? "unknown",
			cloudflare_code: error?.message.match(cloudflareCodeRegex)?.[1],
		});
		return [failure];
	});

	return { otherIssues, facts, failedClicks };
}
