/**
 * Plain-language operator emails. Each problem explains what happened, what it
 * means for visitors and data, the steps to check and fix it, and how to know
 * it is fixed. Only fixed wording and measured numbers are included: never
 * exception text, secrets, event bodies or visitor data.
 */

type Urgency = "urgent" | "soon";

export type AlertLinks = {
	analyticsReady: string;
	analyticsDetailedCommand: string;
	analyticsBackupCommand: string;
	monitorReady: string;
	coolify: string;
	cloudflareQueues: string;
	cloudflareR2: string;
	cloudflareWorker: string;
	cloudflareStatus: string;
};

export type FailedClickRef = { queue: string; messageId: string };

export type AlertContext = {
	now: number;
	timeZone: string;
	links: AlertLinks;
	/** Measured details per problem, e.g. "3 clicks are waiting". */
	facts: Partial<Record<string, string>>;
	/** When each problem was first seen, if known. */
	firstSeen: Partial<Record<string, number>>;
	failedClicks: FailedClickRef[];
};

type Playbook = {
	area: string;
	title: string;
	urgency: Urgency;
	meaning: string;
	lost: string;
	steps: (context: AlertContext) => string[];
	fixed: string;
	/** Shown when this problem often clears by itself, e.g. after a deploy. */
	selfHeals?: string;
};

const clearsItself =
	"This often happens for a few minutes after deploying the redirect Worker or restarting the analytics service. If an all-clear email arrives within about 10 minutes, nothing needs doing.";
const nextCheck =
	"The next check, within 5 minutes, sends an all-clear email once this passes.";

function analyticsSteps(links: AlertLinks, extra: string[] = []): string[] {
	return [
		`Open ${links.analyticsReady} in a browser. A healthy service shows {"status":"ready"}.`,
		`Open Coolify (${links.coolify}), select the ndle-ingest-service app and check it says Running (healthy). If it is stopped or restarting, open Logs, then press Redeploy.`,
		...extra,
		`For the full picture, run: ${links.analyticsDetailedCommand} (use API_SECRET if OPS_SECRET is not set). Any part not marked "ok" is the one to look at.`,
	];
}

const legacyAnalytics: Omit<Playbook, "title"> = {
	area: "Analytics service",
	urgency: "soon",
	meaning:
		"Only the previous analytics version (the one that used Redis) reports this. Seeing it means that old version may be running again.",
	lost: "Clicks wait safely in the Cloudflare queue while this is sorted out.",
	steps: ({ links }) => [
		`Open Coolify (${links.coolify}) → ndle-ingest-service and check which commit is deployed.`,
		"Redeploy the latest master of ndle-ingest-service.",
	],
	fixed: nextCheck,
};

export const issuePlaybooks = {
	click_queue_old: {
		area: "Clicks",
		title: "Clicks are waiting longer than usual to be counted",
		urgency: "soon",
		meaning:
			"Links still redirect visitors normally. New clicks are waiting in the Cloudflare delivery queue instead of reaching analytics, so dashboards are behind.",
		lost: "No. Waiting clicks are kept for 14 days and retried automatically.",
		selfHeals: clearsItself,
		steps: ({ links }) => [
			`Check the analytics service: open ${links.analyticsReady}. It should show {"status":"ready"}. If it doesn't, open Coolify (${links.coolify}) → ndle-ingest-service → Logs.`,
			`Open Cloudflare → Queues → ndle-click-events (${links.cloudflareQueues}). The Backlog number should be going down.`,
			`If the backlog is still growing after 30 minutes, open the redirect Worker's logs (${links.cloudflareWorker} → Logs) and search for "Click delivery will be retried" to see why.`,
		],
		fixed:
			"The next check sends an all-clear email once no click has waited more than 5 minutes.",
	},
	click_queue_large: {
		area: "Clicks",
		title: "A large number of clicks are piling up",
		urgency: "urgent",
		meaning:
			"More than 10,000 clicks (or 100 MB) are waiting to be counted. Links still redirect, but analytics is far behind, usually because the analytics service is down or failing.",
		lost: "Not yet. Waiting clicks are kept for 14 days, but after about 22 hours of failed retries they move to the failed-click queue and need a manual replay.",
		steps: ({ links }) =>
			analyticsSteps(links, [
				`Open Cloudflare → Queues → ndle-click-events (${links.cloudflareQueues}) and watch the Backlog fall once the service is healthy.`,
			]),
		fixed:
			"The next check sends an all-clear email once the backlog is back under the limit.",
	},
	click_queue_unavailable: {
		area: "Clicks",
		title: "Could not read the click queue's status",
		urgency: "soon",
		meaning:
			"The check could not get the delivery queue's numbers from Cloudflare. On its own this says nothing is wrong with your clicks; it is usually a brief Cloudflare hiccup.",
		lost: "No sign of it. Clicks keep flowing independently of this check.",
		selfHeals:
			"Usually clears by the next check. If an all-clear email arrives, nothing needs doing.",
		steps: ({ links }) => [
			`If this repeats for 30 minutes, check ${links.cloudflareStatus} for a Queues incident.`,
			`Open Cloudflare → Queues → ndle-click-events (${links.cloudflareQueues}) and confirm the page loads and the Backlog is low.`,
		],
		fixed: nextCheck,
	},
	failed_clicks: {
		area: "Failed clicks",
		title: "Some clicks could not be delivered and were set aside",
		urgency: "soon",
		meaning:
			"After repeated delivery failures, some clicks moved to the failed-click queue. The Worker saves each one to R2 automatically so you can replay it.",
		lost: "No, but these clicks are missing from analytics until you replay them.",
		steps: ({ links }) => [
			'Wait for the next check. Once the clicks are saved to R2 the email changes to "Failed clicks are waiting for you to replay them", with the exact commands to run.',
			`If they stay in the queue for more than an hour, open Cloudflare → Queues → ndle-click-events-failed (${links.cloudflareQueues}) and the Worker's logs (${links.cloudflareWorker} → Logs), searching for "Failed click archive will be retried".`,
		],
		fixed: nextCheck,
	},
	failed_queue_unavailable: {
		area: "Failed clicks",
		title: "Could not read the failed-click queue's status",
		urgency: "soon",
		meaning:
			"The check could not get the failed-click queue's numbers from Cloudflare. On its own this does not mean any click failed; it is usually a brief Cloudflare hiccup.",
		lost: "No sign of it.",
		selfHeals:
			"Usually clears by the next check. If an all-clear email arrives, nothing needs doing.",
		steps: ({ links }) => [
			`If this repeats for 30 minutes, check ${links.cloudflareStatus} for a Queues incident.`,
			`Open Cloudflare → Queues → ndle-click-events-failed (${links.cloudflareQueues}) and confirm its Backlog is 0.`,
		],
		fixed: nextCheck,
	},
	archived_failed_clicks: {
		area: "Failed clicks",
		title: "Failed clicks are waiting for you to replay them",
		urgency: "soon",
		meaning:
			"Some clicks could not be delivered earlier and are saved in R2. They are missing from analytics until you replay them.",
		lost: "No. They are kept in R2 and do not expire. Never delete them to silence this email.",
		steps: ({ links, failedClicks }) => {
			const examples = failedClicks.length
				? failedClicks
				: [{ queue: "QUEUE", messageId: "MESSAGE" }];
			return [
				`Make sure the analytics service is healthy first: ${links.analyticsReady} should show {"status":"ready"}.`,
				"In the ndle-worker folder, set the environment variables listed in its README section on failed clicks (Cloudflare token, bucket, queue names and service secrets).",
				...examples.map(
					({ queue, messageId }) =>
						`For ${messageId}: run "node scripts/failed-clicks.mjs inspect ${queue} ${messageId}", then "node scripts/failed-clicks.mjs replay ${queue} ${messageId}", wait a minute, then "node scripts/failed-clicks.mjs resolve ${queue} ${messageId}".`,
				),
				'"resolve" confirms the click is saved and then clears the reminder. If it refuses, keep the files and ask for help rather than deleting them.',
			];
		},
		fixed:
			"When every saved click is resolved, the next check sends an all-clear email.",
	},
	failed_archive_unavailable: {
		area: "Failed clicks",
		title: "Could not check the saved failed clicks in R2",
		urgency: "soon",
		meaning:
			"The check could not list the failed-click records in the R2 bucket. This is usually a brief Cloudflare R2 hiccup.",
		lost: "No sign of it.",
		selfHeals:
			"Usually clears by the next check. If an all-clear email arrives, nothing needs doing.",
		steps: ({ links }) => [
			`If this repeats for 30 minutes, check ${links.cloudflareStatus} for an R2 incident.`,
			`Open the ndle-analytics bucket (${links.cloudflareR2}) and confirm it loads.`,
		],
		fixed: nextCheck,
	},
	ingest_health_transport: {
		area: "Analytics service",
		title: "The analytics service can't be reached",
		urgency: "urgent",
		meaning:
			"api.ndle.app did not answer. Links still redirect and clicks wait safely in the queue, but dashboards can't load and new clicks aren't being counted.",
		lost: "No. Clicks are kept in the queue for 14 days; after about 22 hours of failed retries they move to the failed-click queue and need a replay.",
		steps: ({ links }) =>
			analyticsSteps(links, [
				`If the app looks fine, check the server itself in Coolify → Servers (disk full or out of memory) and the domain's DNS in Cloudflare.`,
			]),
		fixed: nextCheck,
	},
	ingest_health_timeout: {
		area: "Analytics service",
		title: "The analytics service is responding very slowly",
		urgency: "urgent",
		meaning:
			"The health check did not finish within 10 seconds. The service may be restarting, busy with a backup, or overloaded. Clicks wait safely in the queue meanwhile.",
		lost: "No. Clicks are kept in the queue and retried.",
		selfHeals:
			"A restart or a large backup can cause this briefly. If an all-clear email arrives within about 10 minutes, nothing needs doing.",
		steps: ({ links }) =>
			analyticsSteps(links, [
				"In Coolify, check the server's CPU and memory graphs for the time of this email.",
			]),
		fixed: nextCheck,
	},
	ingest_health_http: {
		area: "Analytics service",
		title: "The analytics service returned an error",
		urgency: "urgent",
		meaning:
			"api.ndle.app answered with an error status instead of a health report. Dashboards may fail to load and new clicks may not be counted.",
		lost: "No. Clicks wait safely in the queue and are retried.",
		steps: ({ links }) => analyticsSteps(links),
		fixed: nextCheck,
	},
	ingest_health_invalid: {
		area: "Analytics service",
		title: "The analytics service's health report wasn't understood",
		urgency: "soon",
		meaning:
			"The service answered, but not in the format the checker expects. This usually happens for a minute when the analytics service and the redirect Worker are updated at different times.",
		lost: "No sign of it. Clicks wait safely in the queue if the service is failing.",
		selfHeals:
			"Expected for a minute or two during a deploy. If an all-clear email arrives, nothing needs doing.",
		steps: ({ links }) =>
			analyticsSteps(links, [
				"If it lasts longer than 15 minutes, make sure both the analytics service (Coolify) and the redirect Worker (Cloudflare) run their latest master.",
			]),
		fixed: nextCheck,
	},
	ingest_not_ready: {
		area: "Analytics service",
		title: "The analytics service is up but not accepting clicks",
		urgency: "urgent",
		meaning:
			"The service is running but says it is not ready, for example because its database is unavailable or a recent save failed. New clicks wait in the queue meanwhile.",
		lost: "No. Clicks wait in the queue and are retried.",
		steps: ({ links }) => analyticsSteps(links),
		fixed: nextCheck,
	},
	ingest_health_failed: {
		area: "Analytics service",
		title: "The analytics service reports a problem",
		urgency: "soon",
		meaning:
			"The service says it is unhealthy but didn't name which part. Clicks wait safely in the queue if it can't save them.",
		lost: "No sign of it.",
		steps: ({ links }) => analyticsSteps(links),
		fixed: nextCheck,
	},
	ingest_database_health: {
		area: "Analytics service",
		title: "The analytics database check failed",
		urgency: "urgent",
		meaning:
			"The service could not use its DuckDB database. Dashboards may fail and new clicks can't be saved until this is fixed; they wait in the queue meanwhile.",
		lost: "No. Clicks wait in the queue, and daily backups plus the R2 journal protect saved data.",
		steps: ({ links }) =>
			analyticsSteps(links, [
				"In the Coolify logs, look for DuckDB errors and check free disk space on the server; the database lives on the /app/data volume.",
			]),
		fixed: nextCheck,
	},
	ingest_writer_health: {
		area: "Analytics service",
		title: "Saving clicks to the database failed recently",
		urgency: "urgent",
		meaning:
			"The last attempt to save a batch of clicks failed. Those clicks were not confirmed, so Cloudflare retries them automatically.",
		lost: "No. Unconfirmed clicks are retried from the queue.",
		steps: ({ links }) =>
			analyticsSteps(links, [
				'In the Coolify logs, search for "Ingest error" and check free disk space on the server.',
			]),
		fixed: nextCheck,
	},
	ingest_archiver_health: {
		area: "Analytics service",
		title: "Moving old clicks to long-term storage failed",
		urgency: "soon",
		meaning:
			"Clicks older than 30 days are moved from the database to R2 each hour, and that step failed. Counts and dashboards are not affected.",
		lost: "No. Old clicks stay in the database until the move succeeds.",
		steps: ({ links }) => [
			`In Coolify → ndle-ingest-service → Logs, look for archive errors, often R2 credentials or a network problem.`,
			`Check ${links.cloudflareStatus} for an R2 incident.`,
		],
		fixed: nextCheck,
	},
	ingest_journal_health: {
		area: "Analytics service",
		title: "The off-site copy of new clicks had a problem",
		urgency: "urgent",
		meaning:
			"Every batch of clicks is copied to R2 before it is saved, and either that copy failed or the startup check of recent copies couldn't finish. While copies fail, new clicks wait in the queue instead of being saved.",
		lost: "No. Clicks wait in the queue until a copy succeeds.",
		steps: ({ links }) => [
			`Run: ${links.analyticsDetailedCommand} (use API_SECRET if OPS_SECRET is not set) and read checks.journal.details.`,
			`"writes.failing": true means R2 copies are failing: check ${links.cloudflareStatus} and the R2 credentials in Coolify.`,
			'"replay.state": "failed" retries by itself every 5 minutes. A non-zero "invalidFiles" or "conflicts" needs a look: keep those files and ask for help rather than deleting them.',
		],
		fixed: nextCheck,
	},
	ingest_backup_health: {
		area: "Backups",
		title: "The last database backup failed",
		urgency: "soon",
		meaning:
			"The analytics service backs up its database to R2 at every start and once a day, and the most recent attempt failed. Nothing is lost now; the risk only matters if the server's disk fails before a backup succeeds.",
		lost: "No.",
		steps: ({ links }) => [
			'In Coolify → ndle-ingest-service → Logs, look for "backup" errors, often R2 credentials or disk space.',
			`Start a backup by hand: ${links.analyticsBackupCommand}. A good result prints the backup's key and sha256.`,
		],
		fixed: nextCheck,
	},
	ingest_queue_health: {
		...legacyAnalytics,
		title: "An old analytics component reported a queue problem",
	},
	ingest_recovery_health: {
		...legacyAnalytics,
		title: "An old analytics recovery check failed",
	},
	ingest_recovery_overdue: {
		...legacyAnalytics,
		title: "Old analytics recovery work is overdue",
	},
	ingest_recovery_stalled: {
		...legacyAnalytics,
		title: "Old analytics recovery has stopped",
	},
	ingest_recovery_unavailable: {
		...legacyAnalytics,
		title: "Old analytics recovery hasn't checked in",
	},
	ingest_recovery_records: {
		...legacyAnalytics,
		title: "Old analytics recovery found records to review",
	},
	ingest_recovery_scan_overdue: {
		...legacyAnalytics,
		title: "An old analytics scan is overdue",
	},
	ingest_recovery_error: {
		...legacyAnalytics,
		title: "Old analytics recovery reported an error",
	},
	ingest_recovery_scan_error: {
		...legacyAnalytics,
		title: "An old analytics scan reported an error",
	},
	ingest_failed_jobs: {
		...legacyAnalytics,
		title: "The old analytics queue has failed jobs",
	},
	ingest_queue_large: {
		...legacyAnalytics,
		title: "The old analytics queue is backed up",
	},
	backup_old: {
		area: "Backups",
		title: "The latest database backup is more than a day old",
		urgency: "soon",
		meaning:
			"Backups normally run at every start and once a day. None has succeeded for over 26 hours, so a disk failure now would lose more history than usual (recent clicks are still protected by the R2 journal).",
		lost: "No.",
		steps: ({ links }) => [
			'In Coolify → ndle-ingest-service → Logs, look for "backup" errors.',
			`Start a backup by hand: ${links.analyticsBackupCommand}. A good result prints the backup's key and sha256.`,
		],
		fixed: nextCheck,
	},
	backup_unavailable: {
		area: "Backups",
		title: "The latest backup couldn't be found or verified",
		urgency: "soon",
		meaning:
			"The check could not read snapshots/duckdb/latest.json in R2, or the backup it points to doesn't match. Until a verified backup exists, a disk failure would be harder to recover from.",
		lost: "No.",
		steps: ({ links }) => [
			`Open the ndle-analytics bucket (${links.cloudflareR2}) and check snapshots/duckdb/latest.json exists.`,
			`Start a backup by hand: ${links.analyticsBackupCommand}.`,
		],
		fixed: nextCheck,
	},
	monitor_unavailable: {
		area: "Link monitoring",
		title: "Link monitoring is not running",
		urgency: "soon",
		meaning:
			"The service that checks whether your links' destinations are up is not ready, so link-health results are paused. Redirects and analytics are not affected.",
		lost: "No clicks are affected. Health checks simply resume once it's back.",
		steps: ({ links }) => [
			`Open ${links.monitorReady}. A healthy service shows {"status":"ready"}.`,
			`Open Coolify (${links.coolify}) → ndle-link-monitoring. If it isn't Running (healthy), open Logs, check its Postgres and Redis are running, then press Redeploy.`,
		],
		fixed: nextCheck,
	},
} satisfies Record<string, Playbook>;

export type Issue = keyof typeof issuePlaybooks;

function formatTime(instant: number, timeZone: string): string {
	const local = new Intl.DateTimeFormat(
		timeZone === "Asia/Kolkata" ? "en-IN" : "en-US",
		{
			timeZone,
			day: "numeric",
			month: "short",
			hour: "numeric",
			minute: "2-digit",
			timeZoneName: "short",
		},
	).format(instant);
	const utc = new Date(instant).toISOString().slice(11, 16);
	return timeZone === "UTC" ? `${local}` : `${local} (${utc} UTC)`;
}

export function describeDuration(milliseconds: number): string {
	const minutes = Math.max(1, Math.round(milliseconds / 60_000));
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	const days = Math.round(hours / 24);
	return `${days} days`;
}

type Section = {
	heading: string;
	urgency: Urgency;
	lines: Array<[label: string, value: string]>;
	steps: string[];
	fixed: string;
	note?: string;
};

function problemSections(issues: Issue[], context: AlertContext): Section[] {
	return issues.map((issue) => {
		const playbook: Playbook = issuePlaybooks[issue];
		const lines: Section["lines"] = [];
		const fact = context.facts[issue];
		if (fact) lines.push(["What we measured", fact]);
		const since = context.firstSeen[issue];
		if (since !== undefined && context.now - since >= 60_000)
			lines.push([
				"Going on since",
				`${formatTime(since, context.timeZone)}, about ${describeDuration(context.now - since)}`,
			]);
		lines.push(["What it means", playbook.meaning]);
		lines.push(["Is anything lost?", playbook.lost]);
		return {
			heading: `${playbook.area}: ${playbook.title}`,
			urgency: playbook.urgency,
			lines,
			steps: playbook.steps(context),
			fixed: playbook.fixed,
			note: playbook.selfHeals,
		};
	});
}

const urgencyLabel: Record<Urgency, string> = {
	urgent: "Urgent",
	soon: "Needs attention",
};

const footer =
	"Checks run every 5 minutes. If the same problems continue you get a reminder at most once an hour, and an all-clear email when everything passes again.";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Escapes text and turns bare https links into anchors. */
function htmlText(value: string): string {
	return escapeHtml(value).replace(
		/https:\/\/[^\s)"&]+[^\s)".,&]/g,
		(url) => `<a href="${url}" style="color:#2563eb">${url}</a>`,
	);
}

function renderText(
	title: string,
	intro: string[],
	sections: Section[],
): string {
	const parts = [title, ...intro, ""];
	sections.forEach((section, index) => {
		parts.push(
			`${index + 1}. ${section.heading} [${urgencyLabel[section.urgency]}]`,
		);
		for (const [label, value] of section.lines)
			parts.push(`   ${label}${label.endsWith("?") ? "" : ":"} ${value}`);
		parts.push("   What to do:");
		for (const [stepIndex, step] of section.steps.entries())
			parts.push(`     ${stepIndex + 1}) ${step}`);
		if (section.note) parts.push(`   Good to know: ${section.note}`);
		parts.push(`   It's fixed when: ${section.fixed}`, "");
	});
	parts.push(footer);
	return parts.join("\n");
}

function renderHtml(
	title: string,
	intro: string[],
	sections: Section[],
): string {
	const cards = sections
		.map((section, index) => {
			const color = section.urgency === "urgent" ? "#b91c1c" : "#b45309";
			const rows = section.lines
				.map(
					([label, value]) =>
						`<p style="margin:0 0 8px"><strong>${escapeHtml(label)}${label.endsWith("?") ? "" : ":"}</strong> ${htmlText(value)}</p>`,
				)
				.join("");
			const steps = section.steps
				.map((step) => `<li style="margin:0 0 6px">${htmlText(step)}</li>`)
				.join("");
			const note = section.note
				? `<p style="margin:8px 0 0;color:#475569"><strong>Good to know:</strong> ${htmlText(section.note)}</p>`
				: "";
			return `<div style="border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:6px;padding:14px 16px;margin:0 0 16px">
<p style="margin:0 0 4px;font-size:12px;font-weight:600;color:${color};text-transform:uppercase">${index + 1} · ${urgencyLabel[section.urgency]}</p>
<h2 style="margin:0 0 10px;font-size:16px">${escapeHtml(section.heading)}</h2>
${rows}
<p style="margin:10px 0 6px"><strong>What to do:</strong></p>
<ol style="margin:0 0 8px;padding-left:20px">${steps}</ol>
${note}
<p style="margin:8px 0 0"><strong>It's fixed when:</strong> ${htmlText(section.fixed)}</p>
</div>`;
		})
		.join("");
	const introHtml = intro
		.map(
			(line) => `<p style="margin:0 0 8px;color:#334155">${htmlText(line)}</p>`,
		)
		.join("");
	return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:640px">
<h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(title)}</h1>
${introHtml}
<div style="margin-top:16px">${cards}</div>
<p style="margin:16px 0 0;font-size:12px;color:#64748b">${escapeHtml(footer)}</p>
</div>`;
}

export function buildAlertEmail(issues: Issue[], context: AlertContext) {
	const unique = [...new Set(issues)].sort(
		(left, right) =>
			Number(issuePlaybooks[left].urgency !== "urgent") -
				Number(issuePlaybooks[right].urgency !== "urgent") ||
			left.localeCompare(right),
	);
	const sections = problemSections(unique, context);
	const urgent = unique.some(
		(issue) => issuePlaybooks[issue].urgency === "urgent",
	);
	const first = issuePlaybooks[unique[0]].title;
	const more = unique.length > 1 ? ` (+${unique.length - 1} more)` : "";
	const title = `NDLE: ${unique.length} problem${unique.length === 1 ? "" : "s"} found`;
	const intro = [
		`Checked ${formatTime(context.now, context.timeZone)}.`,
		"Each problem below says what happened, whether anything is lost, what to do and how to tell it's fixed.",
	];
	return {
		subject: `[NDLE] ${urgent ? "Urgent" : "Needs attention"}: ${first}${more}`,
		text: renderText(title, intro, sections),
		html: renderHtml(title, intro, sections),
	};
}

export function buildAllClearEmail(resolved: Issue[], context: AlertContext) {
	const unique = [...new Set(resolved)].sort();
	const lines = unique.map((issue) => {
		const since = context.firstSeen[issue];
		const lasted =
			since === undefined
				? ""
				: ` — first seen ${formatTime(since, context.timeZone)}, lasted about ${describeDuration(context.now - since)}`;
		return `${issuePlaybooks[issue].area}: ${issuePlaybooks[issue].title}${lasted}`;
	});
	const title = "NDLE: all clear";
	const intro = [
		`Every check passed at ${formatTime(context.now, context.timeZone)}. Nothing more to do.`,
		"Resolved:",
	];
	const text = [
		title,
		...intro,
		...lines.map((line) => `- ${line}`),
		"",
		footer,
	].join("\n");
	const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:640px">
<h1 style="font-size:20px;margin:0 0 8px;color:#15803d">${escapeHtml(title)}</h1>
<p style="margin:0 0 8px">${htmlText(intro[0])}</p>
<p style="margin:0 0 4px"><strong>Resolved:</strong></p>
<ul style="margin:0;padding-left:20px">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
<p style="margin:16px 0 0;font-size:12px;color:#64748b">${escapeHtml(footer)}</p>
</div>`;
	return {
		subject: "[NDLE] All clear: everything is working again",
		text,
		html,
	};
}
