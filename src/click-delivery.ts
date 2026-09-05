import { ConvexHttpClient } from "convex/browser";
import { sendAnalyticsEvent } from "./analytics";
import { parseQueuedClick } from "./click-envelope";
import { recordClick } from "./convex-api";
import { archiveFailedClick } from "./failed-clicks";
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

export async function deliverClick(
	event: AnalyticsEvent,
	env: Bindings,
): Promise<string> {
	if (!event.tracking_enabled) return "tracking_disabled";
	if (
		!env.INGEST_ENDPOINT ||
		!env.API_SECRET ||
		!env.CONVEX_URL ||
		!env.SHARED_SECRET
	) {
		throw new Error("Click delivery settings are incomplete");
	}
	const ingestOutcome = await sendAnalyticsEvent({
		endpoint: env.INGEST_ENDPOINT,
		token: env.API_SECRET,
		event,
	});
	if (ingestOutcome === "ignored") return "tracking_disabled";
	if (event.is_bot) return "bot_recorded";
	if (!event.link_id) throw new Error("Click event is missing its link ID");
	const convex = new ConvexHttpClient(env.CONVEX_URL, {
		fetch: (input, init) =>
			fetch(input, {
				...init,
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
			}),
	});
	const result = await convex.mutation(recordClick, {
		sharedSecret: env.SHARED_SECRET,
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

export async function consumeClicks(
	batch: MessageBatch<unknown>,
	env: Bindings,
): Promise<void> {
	const log = createLogger(env.LOG_LEVEL, {
		component: "click_delivery",
		queue: batch.queue,
	});
	await Promise.all(
		batch.messages.map(async (message) => {
			let requestId: string | undefined;
			try {
				let event: AnalyticsEvent;
				try {
					event = parseQueuedClick(message.body).event;
				} catch {
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
					return;
				}
				requestId = event.idempotency_key;
				const outcome = await deliverClick(event, env);
				message.ack();
				log.info("Click delivery completed", {
					request_id: requestId,
					outcome,
					attempts: message.attempts,
				});
			} catch (error) {
				log.error("Click delivery will be retried", {
					request_id: requestId,
					message_id: message.id,
					attempts: message.attempts,
					error,
				});
				message.retry({
					delaySeconds: Math.min(3600, 5 * 2 ** Math.min(message.attempts, 10)),
				});
			}
		}),
	);
}
