import {
	type AlertContext,
	type AlertLinks,
	alertAfter,
	buildAlertEmail,
	buildAllClearEmail,
	type Issue,
} from "../alert-email";
import { sha256Hex } from "../crypto";
import { createLogger } from "../log";
import {
	type AlertState,
	preserveWaitingFirstSeen,
	readAlertState,
	sameFirstSeen,
	writeAlertState,
} from "./alert-state";
import {
	checkClickQueue,
	checkIngest,
	checkIngestHealth,
	describeIngest,
	hour,
	type OperationsBindings,
	runSourceChecks,
	withDeadline,
} from "./probes";
import { sendEmail } from "./resend";

export { checkClickQueue, checkIngestHealth };

const defaultLinks: AlertLinks = {
	analyticsReady: "https://api.ndle.app/health/ready",
	analyticsDetailedCommand:
		'curl -s -H "Authorization: Bearer $OPS_SECRET" https://api.ndle.app/health/detailed',
	analyticsBackupCommand:
		'curl -s -X POST -H "Authorization: Bearer $OPS_SECRET" https://api.ndle.app/internal/backup',
	monitorReady: "https://monitor.ndle.app/ready",
	coolify: "https://coolify.superlinkify.com/",
	cloudflareQueues: "https://dash.cloudflare.com/?to=/:account/workers/queues",
	cloudflareR2: "https://dash.cloudflare.com/?to=/:account/r2/default/buckets/ndle-analytics",
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

export function buildAlert(issues: Issue[], now: number, context: Partial<AlertContext> = {}) {
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
	const log = createLogger(env.LOG_LEVEL, { component: "operations" });

	const [sourceResults, initialIngest, stored] = await Promise.all([
		runSourceChecks(env, now, sendRequest, checkTimeoutMs, log),
		checkIngest(env, sendRequest, checkTimeoutMs),
		// A stalled R2 read must not hold back the alert itself.
		withDeadline(() => readAlertState(env), checkTimeoutMs).then(
			(state) => ({ available: true as const, state }),
			() => ({ available: false as const, state: null }),
		),
	]);
	const { otherIssues, facts, failedClicks } = sourceResults;
	const previous = stored.state;

	const confirmationNeeded = initialIngest.issues.length > 0;
	log.info("NDLE analytics health checked", {
		phase: "initial",
		issues: initialIngest.issues,
		checks: initialIngest.evidence,
		confirmation_needed: confirmationNeeded,
		scheduled_at: new Date(now).toISOString(),
		checked_at: new Date().toISOString(),
	});
	let ingest = initialIngest;
	if (confirmationNeeded) {
		await waitForConfirmation(15_000);
		ingest = await checkIngest(env, sendRequest, checkTimeoutMs);
		log.info("NDLE analytics health checked", {
			phase: "confirmation",
			issues: ingest.issues,
			checks: ingest.evidence,
			delay_ms: 15_000,
			scheduled_at: new Date(now).toISOString(),
			checked_at: new Date().toISOString(),
		});
	}
	// A transient ingest recovery clears its own alert while keeping any
	// independently observed queue, archive, backup or monitor problems.
	const issues = [...new Set([...otherIssues, ...ingest.issues])];
	const ingestFact = describeIngest(ingest.evidence);
	for (const issue of issues)
		if (issue.startsWith("ingest_") && !facts[issue]) facts[issue] = ingestFact;
	log.info("NDLE operations checked", {
		issues,
		checked_at: new Date(now).toISOString(),
	});

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
	// A problem is emailed only once it has lasted its wait, so a blip the next
	// check no longer sees sends nothing. A check that got no answer is only
	// logged. Without saved state nothing can be timed, so real problems send
	// at once and the hourly key keeps them hourly.
	const due = issues.filter((issue) => {
		const wait = alertAfter(issue);
		if (!Number.isFinite(wait)) return false;
		return !stored.available || now - (context.firstSeen[issue] ?? now) >= wait;
	});
	// Keeps the emailed problems (and their start times) while remembering when waiting ones began.
	const waiting: AlertState = {
		version: 1,
		issues: previous?.issues ?? [],
		firstSeen: preserveWaitingFirstSeen(previous, context.firstSeen),
		alertedAt: previous?.alertedAt,
	};
	if (issues.length && !due.length) {
		// Nothing to send yet. Any all-clear waits until these pass too. An
		// unreadable state is left alone so its emailed problems aren't lost.
		if (stored.available && !sameFirstSeen(previous, waiting.firstSeen))
			await writeAlertState(env, waiting, log);
		return;
	}
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
			log.info("NDLE all-clear email accepted", {
				message_id: id,
				resolved: previous.issues,
			});
		}
		if (previous) await writeAlertState(env, null, log);
		return;
	}
	const sameProblems =
		previous !== null &&
		previous.issues.length === due.length &&
		due.every((issue) => previous.issues.includes(issue));
	// An unchanged set of problems is repeated at most once an hour.
	if (sameProblems && previous.alertedAt !== undefined && now - previous.alertedAt < hour) {
		if (!sameFirstSeen(previous, waiting.firstSeen)) await writeAlertState(env, waiting, log);
		return;
	}
	let email: ReturnType<typeof buildAlertEmail>;
	let idempotencyKey: string;
	if (stored.available) {
		email = buildAlertEmail(due, context);
		// Retries of this exact email are sent once; changed numbers are new mail.
		idempotencyKey = `${alertKey(due, now)}/${(await sha256Hex(email.text)).slice(0, 16)}`;
	} else {
		// Without saved state, fall back to an email that stays identical for the
		// hour so the provider's idempotency key limits reminders to hourly.
		email = buildAlertEmail(due, {
			...context,
			now: Math.floor(now / hour) * hour,
			facts: {},
			firstSeen: {},
		});
		idempotencyKey = alertKey(due, now);
	}
	const id = await sendEmail(env, sendRequest, idempotencyKey, email);
	await writeAlertState(
		env,
		{
			version: 1,
			issues: due,
			firstSeen: context.firstSeen,
			alertedAt: now,
		},
		log,
	);
	log.info("NDLE alert email accepted", {
		message_id: id,
		issues: due,
	});
}
