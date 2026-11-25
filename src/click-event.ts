import type { Context } from "hono";
import { hashVisitorIp, sha256Hex } from "./crypto";
import { readClientIp } from "./guards";
import { claimFirstClickOfSession } from "./redirect-tracking";
import type { AnalyticsEventInput, Bindings, RedisValueObject } from "./types";
import { analyzeUserAgent } from "./user-agent";

// Visitors control these fields. Ingest rejects any text over 8192 characters,
// so each is cut well below that: one oversized header or query parameter must
// not turn a click undeliverable.
const visitorFieldLimits = {
	userAgent: 512,
	referer: 2048,
	utm: 256,
	language: 35,
	browser: 64,
	os: 64,
} as const;

const trailingHighSurrogateRegex = /[\uD800-\uDBFF]$/;

function clip<T extends string | null>(value: T, max: number): T {
	if (value === null || value.length <= max) return value;
	// Drop a high surrogate the cut would leave unpaired.
	return value.slice(0, max).replace(trailingHighSurrogateRegex, "") as T;
}

/** Generate a session ID based on IP hash and user agent. */
async function generateSessionId(
	ipHash: string,
	userAgent: string,
): Promise<string> {
	return (await sha256Hex(`${ipHash}-${userAgent}`)).slice(0, 16);
}

/** Build analytics event input mapped from Cloudflare Worker request/environment. */
export async function buildAnalyticsInput(params: {
	c: Context<{ Bindings: Bindings }>;
	requestUrl: URL;
	destinationUrl: string;
	slug: string;
	latencyMs: number;
	trackingEnabled: boolean;
	redisValue?: RedisValueObject | null;
	variantId?: string | null;
	requestId: string;
}): Promise<AnalyticsEventInput> {
	const {
		c,
		requestUrl,
		destinationUrl,
		slug,
		latencyMs,
		trackingEnabled,
		redisValue,
		variantId,
		requestId,
	} = params;
	const req = c.req;
	const raw = req.raw as Request & { cf?: IncomingRequestCfProperties };
	const cf: Partial<IncomingRequestCfProperties> = raw.cf ?? {};
	const readHeader = (name: string) => req.header(name);
	const now = new Date();
	const shortUrl = `${requestUrl.origin}/${slug}`;
	const userAgent = req.header("user-agent") ?? "";
	const ref = clip(
		req.header("referer") ?? req.header("referrer") ?? null,
		visitorFieldLimits.referer,
	);

	const ua = analyzeUserAgent({
		userAgent,
		secChUa:
			req.header("sec-ch-ua-full-version-list") ?? req.header("sec-ch-ua"),
		secChUaPlatform: req.header("sec-ch-ua-platform"),
		secChUaMobile: req.header("sec-ch-ua-mobile"),
		cf,
		readHeader,
	});
	const browser = clip(ua.browser, visitorFieldLimits.browser);
	const os = clip(ua.os, visitorFieldLimits.os);
	const ip = readClientIp(readHeader);
	const ipHash = await hashVisitorIp(ip, c.env.IP_HASH_SECRET);
	const languageHeader = req.header("accept-language") ?? null;
	const language = languageHeader
		? clip(
				languageHeader.split(",")[0]?.trim() || null,
				visitorFieldLimits.language,
			)
		: null;

	const sessionId = await generateSessionId(ipHash, userAgent);
	const firstClickOfSession = await claimFirstClickOfSession(
		c.env,
		sessionId,
		slug,
		requestId,
	);

	const utm_source = clip(
		requestUrl.searchParams.get("utm_source") ||
			redisValue?.utm_params?.utm_source ||
			null,
		visitorFieldLimits.utm,
	);
	const utm_medium = clip(
		requestUrl.searchParams.get("utm_medium") ||
			redisValue?.utm_params?.utm_medium ||
			null,
		visitorFieldLimits.utm,
	);
	const utm_campaign = clip(
		requestUrl.searchParams.get("utm_campaign") ||
			redisValue?.utm_params?.utm_campaign ||
			null,
		visitorFieldLimits.utm,
	);
	const utm_term = clip(
		requestUrl.searchParams.get("utm_term") ||
			redisValue?.utm_params?.utm_term ||
			null,
		visitorFieldLimits.utm,
	);
	const utm_content = clip(
		requestUrl.searchParams.get("utm_content") ||
			redisValue?.utm_params?.utm_content ||
			null,
		visitorFieldLimits.utm,
	);

	return {
		idempotency_key: requestId,
		occurred_at: now,
		link_slug: slug,
		short_url: shortUrl,
		link_id: redisValue?.link_id ?? null,
		user_id: redisValue?.analytics_owner_key ?? redisValue?.user_id ?? null,
		destination_url: destinationUrl,
		redirect_status: 302,
		tracking_enabled: trackingEnabled,
		latency_ms_worker: latencyMs,
		session_id: sessionId,
		first_click_of_session: firstClickOfSession,
		request_id: requestId,
		worker_datacenter: cf.colo ?? "",
		worker_version: c.env.WORKER_VERSION ?? "dev",
		user_agent: clip(userAgent, visitorFieldLimits.userAgent),
		device_type: ua.deviceType,
		browser,
		os,
		ip_hash: ipHash,
		country: cf.country ?? "",
		region: cf.region ?? null,
		city: cf.city ?? null,
		referer: ref,
		utm_source,
		utm_medium,
		utm_campaign,
		utm_term,
		utm_content,
		is_bot: ua.isBot,
		language,
		timezone: cf.timezone ?? null,
		variant_id: variantId ?? null,
	};
}
