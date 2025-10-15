import type { Context } from "hono";
import { MAX_AGE_SECONDS } from "./const";
import type { AnalyticsEventInput, HealthStatus, RedisValueObject } from "./types";
import { createRequestLogger } from "./log";
import { api } from "./convex-api";
import { ConvexHttpClient } from "convex/browser";

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
function buildClientRedirectResponse(location: URL): Response {
    return new Response("", {
        status: 302,
        headers: new Headers({
            Location: location.toString(),
            "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
            Pragma: "no-cache",
            Expires: "0",
            "Content-Type": "text/plain; charset=utf-8",
        }),
    });
}

// Cacheable variant for server-side Worker Cache storage
function buildCacheableRedirectResponse(location: URL): Response {
    return new Response("", {
        status: 301,
        headers: new Headers({
            Location: location.toString(),
            "Cache-Control": "no-store",
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
 * Determine operating system using Client Hints when available, else fallback to UA parsing.
 */
function getOS(userAgent: string, secChUaPlatform?: string | null): string | null {
	// Prefer client hints if provided
	const platform = (secChUaPlatform ?? "").replace(/"/g, "").trim();
	if (platform && platform.toLowerCase() !== "unknown") {
		return platform;
	}

	// Fallback to coarse UA parsing
	if (!userAgent) return null;
	const ua = userAgent.toLowerCase();

	// iOS devices
	if (/iphone|ipad|ipod/.test(ua)) return "iOS";
	// Android before Linux check
	if (/android/.test(ua)) return "Android";
	// ChromeOS
	if (/cros\s/.test(ua)) return "ChromeOS";
	// Windows
	if (/windows nt/.test(ua) || /windows/.test(ua)) return "Windows";
	// macOS (exclude iOS which is already returned)
	if (/mac os x|macintosh/.test(ua)) return "macOS";
	// Generic Linux (exclude Android which is already returned)
	if (/linux/.test(ua)) return "Linux";

	return null;
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
	const os = getOS(userAgent, req.header("sec-ch-ua-platform") ?? null);
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

/**
 * Determine the health status of a response
 * @param response 
 * @param responseTime 
 * @param error 
 * @returns The health status and whether the response is healthy
 */

function determineHealthStatus(
	response: Response | null,
	responseTime: number,
	error: Error | null
): { status: HealthStatus; isHealthy: boolean } {

	if (error) {
		const errorMessage = error.message.toLowerCase();
		
		if (errorMessage.includes('timeout') || errorMessage.includes('aborted')) {
			return { status: "timeout", isHealthy: false };
		}
		if (errorMessage.includes('ssl') || errorMessage.includes('certificate')) {
			return { status: "ssl_error", isHealthy: false };
		}
		if (errorMessage.includes('dns') || errorMessage.includes('name resolution')) {
			return { status: "dns_error", isHealthy: false };
		}
		if (errorMessage.includes('network') || errorMessage.includes('connection')) {
			return { status: "down", isHealthy: false };
		}
		return { status: "error", isHealthy: false };
	}
	

	if (response) {
		const status = response.status;
		
		if (status >= 300 && status < 400) {
			const location = response.headers.get('location');
			if (location && location.includes('redirect')) {
				return { status: "redirect_loop", isHealthy: false };
			}
		}
		
		if (status >= 500) {
			return { status: "down", isHealthy: false };
		}
		
		if (status >= 400 && status < 500) {
			return { status: "unstable", isHealthy: false };
		}
		
		if (status >= 200 && status < 400) {
			if (responseTime > 5000) {
				return { status: "slow", isHealthy: false };
			}
			if (responseTime > 3000) {
				return { status: "slow", isHealthy: true };
			}
			return { status: "healthy", isHealthy: true };
		}
	}
	
	return { status: "error", isHealthy: false };
}


/**
 * Drain or cancel a response
 * @param res - The response
 */
async function drainOrCancel(res: Response) {
	try {
		if (res.ok) {
			await res.arrayBuffer();
		} else {
			res.body?.cancel();
		}
	} catch {
		try { res.body?.cancel(); } catch {}
	}
}


/**
 * Execute combined Convex mutations for analytics and health checks
 * @param c - The context
 * @param urlId - The URL ID
 * @param userId - The user ID
 * @param convex - The Convex client
 * @param healthCheckData - Optional health check data to record
 */
async function executeConvexWrites(
	c: Context, 
	urlId: string, 
	userId: string, 
	convex: ConvexHttpClient,
	healthCheckData?: {
		destinationUrl: string;
		responseStatus: number;
		responseTimeMs: number;
		isHealthy: boolean;
		healthStatus: HealthStatus;
		errorMessage?: string;
	}
) {
	const log = createRequestLogger(c, { component: "convex" });
	const tasks: Promise<unknown>[] = [];

	// Always record analytics click count
	tasks.push(
		convex.mutation(api.urlAnalytics.mutateUrlAnalytics, {
			sharedSecret: c.env.SHARED_SECRET,
			urlId,
			userId,
			urlStatusCode: healthCheckData?.responseStatus ?? 0,
			urlStatusMessage: healthCheckData?.healthStatus ?? "",
		}).catch(err => {
			log.warn("Analytics mutation failed", { urlId, userId, error: String(err) });
			throw err;
		})
	);

	try {
		await Promise.allSettled(tasks);
		log.debug("Convex writes completed", { urlId, userId, healthCheckRecorded: !!healthCheckData });
	} catch (err) {
		log.warn("Some Convex writes failed", { urlId, userId, error: String(err) });
	}
}


/**
 * Perform a health check
 * @param c - The context
 * @param destinationUrl - The destination URL
 * @param urlId - The URL ID
 * @param userId - The user ID
 * @param convex - The Convex client
 */
async function performHealthCheck(
	c: Context, 
	destinationUrl: string, 
	urlId: string, 
	userId: string,
	convex: ConvexHttpClient
) {
	const log = createRequestLogger(c, { component: "health-check" });
	const startTime = Date.now();
	
	try {

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 8000);
		
		const response = await fetch(destinationUrl, {
			method: 'HEAD',
			signal: controller.signal,
			headers: {
				'User-Agent': 'NDLE-HealthCheck/1.0',
				'Accept': '*/*',
			},
		});
		
		clearTimeout(timeoutId);
		const responseTime = Date.now() - startTime;
		
		const { status: healthStatus, isHealthy } = determineHealthStatus(response, responseTime, null);
		
		// Record both analytics and health check data
		await executeConvexWrites(c, urlId, userId, convex, {
			destinationUrl,
			responseStatus: response.status,
			responseTimeMs: responseTime,
			isHealthy,
			healthStatus,
		});
		
		log.info("Health check completed", {
			urlId,
			destinationUrl,
			status: response.status,
			responseTime,
			isHealthy,
			healthStatus,
		});
		
	} catch (error) {
		const responseTime = Date.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorObj = error instanceof Error ? error : new Error(errorMessage);
		
		const { status: healthStatus, isHealthy } = determineHealthStatus(null, responseTime, errorObj);
		
		// Record both analytics and health check data (with error)
		await executeConvexWrites(c, urlId, userId, convex, {
			destinationUrl,
			responseStatus: 0,
			responseTimeMs: responseTime,
			isHealthy,
			healthStatus,
			errorMessage,
		});
		
		log.warn("Health check failed", {
			urlId,
			destinationUrl,
			error: errorMessage,
			responseTime,
			isHealthy,
			healthStatus,
		});
	}
}


/**
 * Build a no content response
 * @param status - The status code
 * @param cacheSeconds - The cache seconds
 * @returns The no content response
 */
function buildNoContentResponse(status = 204, cacheSeconds = 31536000): Response {
	return new Response(null, {
		status,
		headers: { "Cache-Control": `public, max-age=${cacheSeconds}, immutable` },
	});
}



export {
	makeCacheKeyFromContext,
	makeCacheRequestFromContext,
    buildClientRedirectResponse,
    buildCacheableRedirectResponse,
	checkCacheAndReturnElseSave,
	sha256Hex,
	getBooleanEnv,
	getDeviceType,
	isBot,
	buildAnalyticsInput,
	determineHealthStatus,
	drainOrCancel,
	executeConvexWrites,
	performHealthCheck,
	buildNoContentResponse,
};

