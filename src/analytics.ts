import type { AnalyticsEvent, AnalyticsEventInput } from "./types";

/**
 * Normalize input into the exact payload the API expects.
 */
export function normalizeAnalyticsEvent(input: AnalyticsEventInput): AnalyticsEvent {
	const occurredAtIso = typeof input.occurred_at === "string"
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
	};
}

/**
 * Send an analytics event to the ingestion API.
 * - endpoint example: "https://api.tinybird.co/v0/events?name=your_datasource_name"
 * - token should be a Tinybird token with EVENTS_WRITE scope
 */
export async function sendAnalyticsEvent(params: {
	endpoint: string;
	token: string;
	event: AnalyticsEventInput;
	fetchImpl?: typeof fetch;
}): Promise<Response> {
	const { endpoint, token, event, fetchImpl } = params;
	const payload = normalizeAnalyticsEvent(event);
	const doFetch = fetchImpl ?? fetch;

	return doFetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});
}