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
