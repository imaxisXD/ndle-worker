import { ConvexHttpClient } from "convex/browser";
import {
	type BatchStatus,
	sendAnalyticsBatch,
	sendAnalyticsEvent,
} from "./analytics";
import { parseQueuedClick } from "./click-envelope";
import { recordClick } from "./convex-api";
import { archiveFailedClick } from "./failed-clicks";
import { ingestWriteSecret } from "./ingest-auth";
import { createLogger } from "./log";
import type { AnalyticsEvent, Bindings } from "./types";

export { parseQueuedClick } from "./click-envelope";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const terminalClickOutcomes = new Set([
	"recorded",
	"duplicate",
	"link_deleted",
	"tracking_disabled",
	"too_old",
]);

function deliverySettings(env: Bindings) {
	const token = ingestWriteSecret(env);
	if (!env.INGEST_ENDPOINT || !token || !env.CONVEX_URL || !env.SHARED_SECRET) {
		throw new Error("Click delivery settings are incomplete");
	}
	return {
		endpoint: env.INGEST_ENDPOINT,
		token,
		convexUrl: env.CONVEX_URL,
		sharedSecret: env.SHARED_SECRET,
	};
}

type DeliverySettings = ReturnType<typeof deliverySettings>;

// Runs after ingest has committed the click. Each click gets its own client:
// one ConvexHttpClient runs its queued mutations one at a time.
async function recordLiveClick(
	event: AnalyticsEvent,
	settings: DeliverySettings,
): Promise<string> {
	if (event.is_bot) return "bot_recorded";
	if (!event.link_id) throw new Error("Click event is missing its link ID");
	const convex = new ConvexHttpClient(settings.convexUrl, {
		fetch: (input, init) =>
			fetch(input, {
				...init,
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
			}),
	});
	const result = await convex.mutation(recordClick, {
		sharedSecret: settings.sharedSecret,
		urlId: event.link_id,
		urlStatusCode: 0,
		urlStatusMessage: "",
		requestId: event.idempotency_key,
		clickEvent: {
			linkSlug: event.link_slug,
			occurredAt: Date.parse(event.occurred_at),
			country: event.country || "Unknown",
			city: event.city ?? undefined,
			deviceType: event.device_type || "desktop",
			browser: event.browser || "Unknown",
			os: event.os || "Unknown",
			referer: event.referer ?? undefined,
		},
	});
	if (
		!isRecord(result) ||
		typeof result.outcome !== "string" ||
		!terminalClickOutcomes.has(result.outcome)
	) {
		throw new Error("Click delivery received an unknown Convex result");
	}
	return result.outcome;
}

/**
 * Deliver one click through the single-event ingest route, then Convex. Used by
 * operator recovery and when ingest does not have the batch route yet.
 */
export async function deliverClick(
	event: AnalyticsEvent,
	env: Bindings,
): Promise<string> {
	if (!event.tracking_enabled) return "tracking_disabled";
	const settings = deliverySettings(env);
	const ingestOutcome = await sendAnalyticsEvent({
		endpoint: settings.endpoint,
		token: settings.token,
		event,
	});
	if (ingestOutcome === "ignored") return "tracking_disabled";
	return recordLiveClick(event, settings);
}

const maxBatchEvents = 100;
// Limits write contention on hot link documents.
const maxConvexWrites = 10;

// 10 s doubling to a one-hour cap. With the configured 30 retries a click
// survives about 22.4 hours of ingest failure before the failed-click queue.
function retryDelay(attempts: number): number {
	return Math.min(3600, 5 * 2 ** Math.min(attempts, 10));
}

// Runs at most `limit` tasks at once. `run` must handle its own errors.
async function forEachLimited<T>(
	items: T[],
	limit: number,
	run: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await run(items[next++]);
		}),
	);
}

type TrackedClick = { message: Message<unknown>; event: AnalyticsEvent };

export async function consumeClicks(
	batch: MessageBatch<unknown>,
	env: Bindings,
): Promise<void> {
	const log = createLogger(env.LOG_LEVEL, {
		component: "click_delivery",
		queue: batch.queue,
	});
	const retry = (
		message: Message<unknown>,
		requestId: string | undefined,
		error: unknown,
	) => {
		log.error("Click delivery will be retried", {
			request_id: requestId,
			message_id: message.id,
			attempts: message.attempts,
			error,
		});
		message.retry({ delaySeconds: retryDelay(message.attempts) });
	};
	const settle = async (
		{ message, event }: TrackedClick,
		work: () => Promise<string>,
	) => {
		try {
			const outcome = await work();
			message.ack();
			log.info("Click delivery completed", {
				request_id: event.idempotency_key,
				outcome,
				attempts: message.attempts,
			});
		} catch (error) {
			retry(message, event.idempotency_key, error);
		}
	};
	const archiveInvalid = async (message: Message<unknown>) => {
		try {
			await archiveFailedClick(
				message,
				batch.queue,
				env.FAILED_CLICK_ARCHIVES,
				"invalid_event",
			);
			message.ack();
			log.error("Invalid click archived for investigation", {
				message_id: message.id,
			});
		} catch (error) {
			retry(message, undefined, error);
		}
	};
	const deliverTracked = async (clicks: TrackedClick[]) => {
		if (!clicks.length) return;
		let settings: DeliverySettings;
		try {
			settings = deliverySettings(env);
		} catch (error) {
			for (const { message, event } of clicks)
				retry(message, event.idempotency_key, error);
			return;
		}
		const writes: Array<[TrackedClick, () => Promise<string>]> = [];
		const groups: TrackedClick[][] = [];
		for (let i = 0; i < clicks.length; i += maxBatchEvents)
			groups.push(clicks.slice(i, i + maxBatchEvents));
		await Promise.all(
			groups.map(async (group) => {
				let statuses: BatchStatus[] | "unsupported";
				try {
					statuses = await sendAnalyticsBatch({
						endpoint: settings.endpoint,
						token: settings.token,
						events: group.map(({ event }) => event),
					});
				} catch (error) {
					// Nothing in a failed batch request can be assumed saved.
					for (const { message, event } of group)
						retry(message, event.idempotency_key, error);
					return;
				}
				group.forEach((click, index) => {
					if (statuses === "unsupported") {
						// Older ingest without the batch route: deliver each click.
						writes.push([click, () => deliverClick(click.event, env)]);
						return;
					}
					const status = statuses[index];
					// Only tracked clicks are sent, so "ignored" is as unexpected as a
					// rejection. Like a rejected single-event request, retries end in
					// the failed-click queue and its archive.
					if (
						status === "invalid" ||
						status === "conflict" ||
						status === "ignored"
					) {
						retry(
							click.message,
							click.event.idempotency_key,
							new Error(`Ingest reported this tracked click as ${status}`),
						);
						return;
					}
					writes.push([click, () => recordLiveClick(click.event, settings)]);
				});
			}),
		);
		await forEachLimited(writes, maxConvexWrites, ([click, work]) =>
			settle(click, work),
		);
	};

	const tracked: TrackedClick[] = [];
	const settled: Promise<void>[] = [];
	for (const message of batch.messages) {
		let event: AnalyticsEvent;
		try {
			event = parseQueuedClick(message.body).event;
		} catch {
			settled.push(archiveInvalid(message));
			continue;
		}
		if (event.tracking_enabled) tracked.push({ message, event });
		else
			settled.push(settle({ message, event }, async () => "tracking_disabled"));
	}
	settled.push(deliverTracked(tracked));
	await Promise.all(settled);
}
