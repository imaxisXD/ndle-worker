import type { AnalyticsEvent, AnalyticsEventInput } from "./types";

/**
 * Normalize input into the exact payload the API expects.
 */
export function normalizeAnalyticsEvent(
	input: AnalyticsEventInput,
): AnalyticsEvent {
	const occurredAtIso =
		typeof input.occurred_at === "string"
			? input.occurred_at
			: input.occurred_at.toISOString();

	return {
		idempotency_key: input.idempotency_key,
		occurred_at: occurredAtIso,
		link_slug: input.link_slug,
		short_url: input.short_url,
		link_id: input.link_id ?? null,
		user_id: input.user_id ?? null,
		destination_url: input.destination_url,
		redirect_status: input.redirect_status,
		tracking_enabled: input.tracking_enabled,
		latency_ms_worker: input.latency_ms_worker,
		session_id: input.session_id ?? null,
		first_click_of_session: input.first_click_of_session,
		request_id: input.request_id,
		worker_datacenter: input.worker_datacenter,
		worker_version: input.worker_version,
		user_agent: input.user_agent,
		device_type: input.device_type ?? null,
		browser: input.browser ?? null,
		os: input.os ?? null,
		ip_hash: input.ip_hash,
		country: input.country,
		region: input.region ?? null,
		city: input.city ?? null,
		referer: input.referer ?? null,
		utm_source: input.utm_source ?? null,
		utm_medium: input.utm_medium ?? null,
		utm_campaign: input.utm_campaign ?? null,
		utm_term: input.utm_term ?? null,
		utm_content: input.utm_content ?? null,
		is_bot: input.is_bot,
		language: input.language ?? null,
		timezone: input.timezone ?? null,
		variant_id: input.variant_id ?? null,
	};
}

/**
 * Send an analytics event to the ingestion API.
 * A successful response means the ingestion service accepted the event durably.
 */
export async function sendAnalyticsEvent(params: {
	endpoint: string;
	token: string;
	event: AnalyticsEventInput;
	fetchImpl?: typeof fetch;
}): Promise<"queued" | "ignored"> {
	const { endpoint, token, event, fetchImpl } = params;
	const payload = normalizeAnalyticsEvent(event);
	const doFetch = fetchImpl ?? fetch;

	const response = await doFetch(endpoint, {
		method: "POST",
		redirect: "manual",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status !== 202) {
		await response.body?.cancel();
		throw new Error(`Analytics delivery failed with status ${response.status}`);
	}
	const result: unknown = await response.json();
	if (
		typeof result !== "object" ||
		result === null ||
		!("success" in result) ||
		result.success !== true ||
		!("idempotency_key" in result) ||
		result.idempotency_key !== payload.idempotency_key ||
		!("status" in result) ||
		(result.status !== "queued" && result.status !== "ignored") ||
		(payload.tracking_enabled && result.status !== "queued")
	)
		throw new Error(
			"Analytics delivery did not confirm this event was accepted",
		);
	return result.status;
}

export type BatchStatus =
	| "recorded"
	| "duplicate"
	| "ignored"
	| "invalid"
	| "conflict";

const batchStatuses = new Set<unknown>([
	"recorded",
	"duplicate",
	"ignored",
	"invalid",
	"conflict",
]);

/** `https://api.ndle.app/ingest` becomes `https://api.ndle.app/ingest/batch`. */
export function batchEndpoint(endpoint: string): string {
	const url = new URL(endpoint);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/batch`;
	return url.toString();
}

/**
 * Send up to 100 analytics events in one request and return each event's
 * status in input order. A 200 means every `recorded` or `duplicate` event is
 * committed. Returns "unsupported" for a 404 from an ingest version without the
 * batch route. Any other status or a response that does not match the sent
 * events throws: nothing in the batch can be assumed saved.
 */
export async function sendAnalyticsBatch(params: {
	endpoint: string;
	token: string;
	events: AnalyticsEventInput[];
	fetchImpl?: typeof fetch;
}): Promise<BatchStatus[] | "unsupported"> {
	const { endpoint, token, events, fetchImpl } = params;
	if (events.length < 1 || events.length > 100)
		throw new Error("An analytics batch must contain 1 to 100 events");
	const payload = events.map(normalizeAnalyticsEvent);
	const doFetch = fetchImpl ?? fetch;

	const response = await doFetch(batchEndpoint(endpoint), {
		method: "POST",
		redirect: "manual",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ events: payload }),
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) {
		await response.body?.cancel();
		return "unsupported";
	}
	if (response.status !== 200) {
		await response.body?.cancel();
		throw new Error(`Analytics batch failed with status ${response.status}`);
	}
	const result: unknown = await response.json();
	const results =
		typeof result === "object" &&
		result !== null &&
		"success" in result &&
		result.success === true &&
		"results" in result &&
		Array.isArray(result.results)
			? (result.results as unknown[])
			: undefined;
	if (!results || results.length !== payload.length)
		throw new Error("Analytics batch did not return one result per event");
	return results.map((item, index) => {
		const entry =
			typeof item === "object" && item !== null
				? (item as Record<string, unknown>)
				: {};
		const key = entry.idempotency_key;
		if (
			entry.index !== index ||
			!batchStatuses.has(entry.status) ||
			// Only an unreadable (invalid) event may come back without its key.
			(key !== payload[index].idempotency_key &&
				!(key === null && entry.status === "invalid"))
		)
			throw new Error(
				"Analytics batch returned a result that does not match its event",
			);
		return entry.status as BatchStatus;
	});
}
