import { ConvexHttpClient } from "convex/browser";
import { sendAnalyticsEvent } from "./analytics";
import { recordClick } from "./convex-api";
import { createLogger } from "./log";
import type { AnalyticsEvent, Bindings, QueuedClick } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
	if (!isRecord(value)) return false;
	const strings = [
		"idempotency_key",
		"occurred_at",
		"link_slug",
		"short_url",
		"destination_url",
		"request_id",
		"worker_datacenter",
		"worker_version",
		"user_agent",
		"ip_hash",
		"country",
	];
	const nullableStrings = [
		"link_id",
		"user_id",
		"session_id",
		"device_type",
		"browser",
		"os",
		"region",
		"city",
		"referer",
		"utm_source",
		"utm_medium",
		"utm_campaign",
		"utm_term",
		"utm_content",
		"language",
		"timezone",
		"variant_id",
	];
	return (
		strings.every((key) => typeof value[key] === "string") &&
		nullableStrings.every(
			(key) => value[key] === null || typeof value[key] === "string",
		) &&
		["tracking_enabled", "first_click_of_session", "is_bot"].every(
			(key) => typeof value[key] === "boolean",
		) &&
		typeof value.latency_ms_worker === "number" &&
		Number.isFinite(value.latency_ms_worker) &&
		value.latency_ms_worker >= 0 &&
		value.redirect_status === 302
	);
}

export function parseQueuedClick(value: unknown): QueuedClick {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isAnalyticsEvent(value.event)
	) {
		throw new Error("Click event has an unsupported format");
	}
	const event = value.event;
	if (
		!/^[A-Za-z0-9_-]{1,128}$/.test(event.idempotency_key) ||
		event.request_id !== event.idempotency_key
	) {
		throw new Error("Click event has an invalid or mismatched event ID");
	}
	if (
		!Number.isFinite(Date.parse(event.occurred_at)) ||
		!event.link_id ||
		!event.user_id ||
		!event.link_slug
	) {
		throw new Error("Click event is missing its time, link, or owner");
	}
	return { version: 1, event };
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
			fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
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
				const { event } = parseQueuedClick(message.body);
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
