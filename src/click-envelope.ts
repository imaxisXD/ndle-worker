import { isRecord } from "./guards";
import type { AnalyticsEvent, QueuedClick } from "./types";

const eventIdRegex = /^[A-Za-z0-9_-]{1,128}$/;

const requiredStringFields = [
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
] as const;

const nullableStringFields = [
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
] as const;

const requiredBooleanFields = [
	"tracking_enabled",
	"first_click_of_session",
	"is_bot",
] as const;

function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
	if (!isRecord(value)) return false;
	return (
		requiredStringFields.every((key) => typeof value[key] === "string") &&
		nullableStringFields.every(
			(key) => value[key] === null || typeof value[key] === "string",
		) &&
		requiredBooleanFields.every((key) => typeof value[key] === "boolean") &&
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
		!eventIdRegex.test(event.idempotency_key) ||
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
	// Ingest's limits: a click it would reject is archived now as invalid
	// rather than retried for a day.
	if (
		event.link_id.length > 256 ||
		event.user_id.length > 256 ||
		Object.values(event).some(
			(field) => typeof field === "string" && field.length > 8192,
		)
	) {
		throw new Error("Click event has a field longer than ingest accepts");
	}
	return { version: 1, event };
}
