import type { Context } from "hono";
import { MAX_AGE_SECONDS } from "./const";
import type { AnalyticsEventInput, RedisValueObject } from "./types";

/**
 * Make a cache key from the context
 * @param c - The context
 * @returns The cache key
 */
function makeCacheKeyFromContext(c: Context): string {
	const url = new URL(c.req.url);
	const origin = url.origin.toLowerCase();
	const pathname = url.pathname.replace(/\/+$/, "") || "/";
	return `${origin}${pathname}`;
}

/**
 * Make a cache request from the context
 * @param c - The context
 * @returns The cache request
 */
function makeCacheRequestFromContext(c: Context): Request {
	const cacheKey = makeCacheKeyFromContext(c);
	return new Request(cacheKey, { method: "GET" });
}

/**
 * Build a redirect response
 * @param location - The location to redirect to
 * @returns The redirect response
 */
function buildRedirectResponse(location: URL): Response {
	return new Response("", {
		status: 301,
		headers: new Headers({
			Location: location.toString(),
			"Cache-Control": `public, max-age=${MAX_AGE_SECONDS}`,
			"Content-Type": "text/plain; charset=utf-8",
		}),
	});
}

/**
 * Check the cache and return the response if it exists
 * @param c - The context
 * @param cache - The cache
 * @returns The cached response
 */
async function checkCacheAndReturnElseSave(c: Context, cache: Cache) {
	const cacheKey = makeCacheKeyFromContext(c);
	const cacheRequest = new Request(cacheKey, { method: "GET" });

	// Check for existing cached response first
	const cachedResponse = await cache.match(cacheRequest);

	if (cachedResponse) {
		return cachedResponse;
	}
}

/**
 * Compute a SHA-256 hash in hex for a given string.
 */
async function sha256Hex(value: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(value);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(hash);
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out;
}

/**
 * Normalize common boolean env var strings to boolean with a default.
 */
function getBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	const normalized = value.trim().toLowerCase();
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
	return true;
}

/**
 * Coarse device type from User-Agent with mobile/tablet/desktop buckets.
 */
function getDeviceType(userAgent: string): string | null {
	if (!userAgent) return null;
	const ua = userAgent.toLowerCase();
	if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
		return "tablet";
	}
	if (/mobile|iphone|ipod|android|blackberry|opera mini|opera mobi|skyfire|maemo|windows phone|palm|iemobile|symbian|symbianos|fennec/i.test(ua)) {
		return "mobile";
	}
	return "desktop";
}

/**
 * Bot detection using Cloudflare Bot Management when available, else UA regex fallback.
 */
function isBot(userAgent: string, cf?: any): boolean {
	try {
		const bm = cf?.botManagement;
		if (bm) {
			// Treat verified bots (Googlebot/Bingbot/etc.) as bots
			if (bm.verifiedBot === true) return true;
			const score = typeof bm.score === "number" ? bm.score : undefined;
			// Low scores indicate likely bot. Threshold 30 is common guidance.
			if (score !== undefined && score <= 30) return true;
		}
	} catch {
		// Ignore errors and fallback to UA
	}

	if (!userAgent) return false;
	const ua = userAgent.toLowerCase();
	// Broad but safe list of common bot indicators
	const botRegex = /(bot|crawler|spider|crawling|curl|wget|httpclient|python-requests|libwww|bingpreview|facebookexternalhit|slurp|mediapartners-google|phantomjs|headless|puppeteer|lighthouse|semrush|ahrefs|yandex|googlebot|bingbot|duckduckbot)/i;
	return botRegex.test(ua);
}

/**
 * Build analytics event input mapped from Cloudflare Worker request/environment.
 */
async function buildAnalyticsInput(
	c: Context,
	destinationUrl: string,
	slug: string,
	latencyMs: number,
	redisValue?: RedisValueObject | null,
): Promise<AnalyticsEventInput> {
	const req = c.req;
	const raw = req.raw as Request & { cf?: any };
	const cf = raw.cf ?? {};
	const now = new Date();
	const url = new URL(req.url);
	const shortUrl = `${url.origin}/${slug}`;
	const userAgent = req.header("user-agent") ?? "";
	const ref = req.header("referer") ?? req.header("referrer") ?? null;

	// Prefer client hints when available for device, else UA parsing
	const deviceType = getDeviceType(userAgent);
	const browser = req.header("sec-ch-ua") ?? null;
	const os = req.header("sec-ch-ua-platform") ?? null;
	const requestId = req.header("cf-ray") ?? req.header("x-request-id") ?? crypto.randomUUID();
	const ip = req.header("cf-connecting-ip") ?? req.header("x-forwarded-for") ?? "";
	const ipHash = await sha256Hex(ip);
	const languageHeader = req.header("accept-language") ?? null;
	const language = languageHeader ? languageHeader.split(",")[0]?.trim() || null : null;
	const trackingEnabled = getBooleanEnv(c.env.TRACKING_ENABLED, true);

	const utm_source = url.searchParams.get("utm_source") || redisValue?.utm_params?.utm_source || null;
	const utm_medium = url.searchParams.get("utm_medium") || redisValue?.utm_params?.utm_medium || null;
	const utm_campaign = url.searchParams.get("utm_campaign") || redisValue?.utm_params?.utm_campaign || null;
	const utm_term = url.searchParams.get("utm_term") || redisValue?.utm_params?.utm_term || null;
	const utm_content = url.searchParams.get("utm_content") || redisValue?.utm_params?.utm_content || null;

	return {
		idempotency_key: requestId,
		occurred_at: now,
		link_slug: slug,
		short_url: shortUrl,
		link_id: redisValue?.link_id ?? null,
		user_id: redisValue?.user_id ?? null,
		destination_url: destinationUrl,
		redirect_status: 301,
		tracking_enabled: trackingEnabled,
		latency_ms_worker: latencyMs,
		session_id: null,
		first_click_of_session: false,
		request_id: requestId,
		worker_datacenter: cf.colo ?? "",
		worker_version: c.env.WORKER_VERSION ?? "dev",
		user_agent: userAgent,
		device_type: deviceType,
		browser: browser,
		os: os,
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
		is_bot: isBot(userAgent, cf),
		language,
		timezone: cf.timezone ?? null,
	};
}

export {
	makeCacheKeyFromContext,
	makeCacheRequestFromContext,
	buildRedirectResponse,
	checkCacheAndReturnElseSave,
	sha256Hex,
	getBooleanEnv,
	getDeviceType,
	isBot,
	buildAnalyticsInput,
};
