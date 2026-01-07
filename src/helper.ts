import type { Context } from "hono";
import type { AnalyticsEventInput, HealthStatus, RedisValueObject } from "./types";
import { Redis } from "@upstash/redis/cloudflare";
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
            // Encourage browsers to send UA-CH on subsequent requests
            "Accept-CH": "Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile, Sec-CH-UA-Full-Version-List",
            "Critical-CH": "Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile, Sec-CH-UA-Full-Version-List",
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
            // Encourage browsers to send UA-CH on subsequent requests
            "Accept-CH": "Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile, Sec-CH-UA-Full-Version-List",
            "Critical-CH": "Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile, Sec-CH-UA-Full-Version-List",
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
 * Coarse device type using UA-CH mobile hint first, else UA buckets.
 */
function getDeviceType(userAgent: string, secChUaMobile?: string | null): string | null {
    // Prefer UA-CH: Sec-CH-UA-Mobile: ?1 => mobile, ?0 => not mobile
    const mobileHint = (secChUaMobile ?? "").trim();
    if (mobileHint) {
        const normalized = mobileHint.replace(/\"|\?/g, "").trim();
        if (normalized === "1") return "mobile";
    }

    if (!userAgent) return "Unknown";
    const ua = userAgent.toLowerCase();

    // Tablets
    if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
        return "tablet";
    }

    // Mobiles
    if (/mobile|iphone|ipod|android|blackberry|opera mini|opera mobi|skyfire|maemo|windows phone|palm|iemobile|symbian|symbianos|fennec/i.test(ua)) {
        return "mobile";
    }

    // Desktops
    if (/windows|macintosh|mac os x|linux|x11/i.test(ua)) {
        return "desktop";
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
		// Normalize common platform names
		const normalizedPlatform = platform.toLowerCase();
		if (normalizedPlatform === "macos") return "macOS";
		if (normalizedPlatform === "windows") return "Windows";
		if (normalizedPlatform === "linux") return "Linux";
		if (normalizedPlatform === "android") return "Android";
		if (normalizedPlatform === "ios") return "iOS";
		return platform;
	}

	// Fallback to UA parsing
	if (!userAgent) return "Unknown";
	const ua = userAgent.toLowerCase();

	// iOS devices (check first to avoid false positives)
	if (/iphone|ipad|ipod/.test(ua)) return "iOS";
	// Android (check before Linux)
	if (/android/.test(ua)) return "Android";
	// ChromeOS
	if (/cros\s/.test(ua)) return "ChromeOS";
	// Windows (more specific patterns first)
	if (/windows nt \d+\.\d+/.test(ua)) {
		if (/windows nt 10\.0/.test(ua)) return "Windows 10";
		if (/windows nt 6\.3/.test(ua)) return "Windows 8.1";
		if (/windows nt 6\.2/.test(ua)) return "Windows 8";
		if (/windows nt 6\.1/.test(ua)) return "Windows 7";
		return "Windows";
	}
	if (/windows/.test(ua)) return "Windows";
	// macOS (more specific patterns)
	if (/mac os x \d+_\d+/.test(ua)) {
		// Extract version for more specific macOS detection
		const match = ua.match(/mac os x (\d+)_(\d+)/);
		if (match) {
			const major = parseInt(match[1]);
			const minor = parseInt(match[2]);
			if (major >= 12) return "macOS Monterey+";
			if (major >= 11) return "macOS Big Sur+";
			if (major >= 10 && minor >= 15) return "macOS Catalina+";
		}
		return "macOS";
	}
	if (/mac os x|macintosh/.test(ua)) return "macOS";
	// Generic Linux (exclude Android which is already returned)
	if (/linux/.test(ua)) return "Linux";

	// If we have a user agent but can't identify the OS, return "Unknown"
	return "Unknown";
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
 * Parse browser name from sec-ch-ua header or user agent
 */
function getBrowser(userAgent: string, secChUa?: string | null): string | null {
	// 1) Try to parse from UA Client Hints (brand list). This may contain multiple brands.
	const header = (secChUa ?? "").trim();
	if (header) {
		const brandRegex = /"([^\"]+)";v="[^"]+"/g;
		const brands: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = brandRegex.exec(header)) !== null) {
			brands.push(match[1]);
		}
		// Filter out the generic NotA_Brand marker
		const filtered = brands.filter((b) => !/not\??a_brand/i.test(b));
		// Priority map for known brands from UA-CH
		const normalize = (b: string): string | null => {
			if (/brave/i.test(b)) return "Brave";
			if (/microsoft edge/i.test(b)) return "Edge";
			if (/edge/i.test(b)) return "Edge";
			if (/opera/i.test(b)) return "Opera";
			if (/vivaldi/i.test(b)) return "Vivaldi";
			if (/google chrome/i.test(b)) return "Chrome";
			if (/chrome/i.test(b)) return "Chrome";
			if (/chromium/i.test(b)) return "Chrome";
			if (/firefox/i.test(b)) return "Firefox";
			if (/safari/i.test(b)) return "Safari";
			if (/samsung internet/i.test(b)) return "Samsung Internet";
			return null;
		};
		const knownOrder = [
			"Brave",
			"Edge",
			"Opera",
			"Vivaldi",
			"Chrome",
			"Firefox",
			"Safari",
			"Samsung Internet",
		];
		const normalizedSet = new Set<string>();
		for (const b of filtered) {
			const n = normalize(b);
			if (n) normalizedSet.add(n);
		}
		for (const candidate of knownOrder) {
			if (normalizedSet.has(candidate)) return candidate;
		}
		// If we saw a brand but couldn't normalize, return the first as-is
		if (filtered.length > 0) return filtered[0];
	}

	// 2) Fallback to User-Agent parsing
	if (!userAgent) return "Unknown";
	const ua = userAgent.toLowerCase();

	// iOS-specific tokens to avoid Safari false positives
	if (/crios\//.test(ua)) return "Chrome"; // Chrome on iOS
	if (/fxios\//.test(ua)) return "Firefox"; // Firefox on iOS
	if (/edgios\//.test(ua)) return "Edge"; // Edge on iOS

	// Desktop/mobile tokens
	if (ua.includes("brave")) return "Brave";
	if (/edg\//.test(ua) || /edge\//.test(ua)) return "Edge";
	if (/opr\//.test(ua) || /opera\//.test(ua)) return "Opera";
	if (/vivaldi/.test(ua)) return "Vivaldi";
	if (/samsungbrowser\//.test(ua)) return "Samsung Internet";
	if (/duckduckgo/.test(ua)) return "DuckDuckGo";
	if (/yabrowser/.test(ua)) return "Yandex";
	if (/ucbrowser/.test(ua)) return "UC Browser";
	if (/chrome\//.test(ua) && !/edg\//.test(ua) && !/opr\//.test(ua) && !/samsungbrowser\//.test(ua)) return "Chrome";
	if (/safari\//.test(ua) && !/chrome\//.test(ua) && !/crios\//.test(ua) && !/fxios\//.test(ua) && !/edgios\//.test(ua) && !/opr\//.test(ua)) return "Safari";
	if (/firefox\//.test(ua)) return "Firefox";
	if (/msie/.test(ua) || /trident\//.test(ua)) return "Internet Explorer";

	return "Unknown";
}

/**
 * Generate a session ID based on IP hash and user agent
 */
async function generateSessionId(ipHash: string, userAgent: string): Promise<string> {
	const sessionKey = `${ipHash}-${userAgent}`;
	if (crypto.subtle) {
		// Use crypto.subtle if available (more secure)
		const hash = await sha256Hex(sessionKey);
		return hash.substring(0, 16);
	} else {
		// Fallback for environments without crypto.subtle
		return sessionKey.substring(0, 16);
	}
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
    const deviceType = getDeviceType(userAgent, req.header("sec-ch-ua-mobile"));
	const browser = getBrowser(
		userAgent,
		req.header("sec-ch-ua-full-version-list") ?? req.header("sec-ch-ua")
	);
	const os = getOS(userAgent, req.header("sec-ch-ua-platform"));
	const requestId = req.header("cf-ray") ?? req.header("x-request-id") ?? crypto.randomUUID();
	const ip = req.header("cf-connecting-ip") ?? req.header("x-forwarded-for") ?? "";
	const ipHash = await sha256Hex(ip);
	const languageHeader = req.header("accept-language") ?? null;
	const language = languageHeader ? languageHeader.split(",")[0]?.trim() || null : null;
	const trackingEnabled = getBooleanEnv(c.env.TRACKING_ENABLED, true);

	// Generate session ID based on IP hash and user agent
	const sessionId = await generateSessionId(ipHash, userAgent);

	// Track first-click-of-session using Redis short-lived key
	let firstClickOfSession = true;
	try {
		const redis = Redis.fromEnv(c.env);
		const sessionKey = `session:${sessionId}:${slug}`;
		const exists = await redis.exists(sessionKey);
		firstClickOfSession = exists === 0;
		if (firstClickOfSession) {
			await redis.set(sessionKey, "1", { ex: 1800 });
		}
	} catch (err) {
		const log = createRequestLogger(c, { component: "analytics" });
		log.warn("Failed to evaluate first-click flag", { error: String(err) });
	}

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
		session_id: sessionId,
		first_click_of_session: firstClickOfSession,
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
 * @param clickEvent - Optional click event data for real-time activity
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
	},
	clickEvent?: {
		linkSlug: string;
		occurredAt: number;
		country: string;
		city?: string;
		deviceType: string;
		browser: string;
		os: string;
		referer?: string;
	}
) {
	const log = createRequestLogger(c, { component: "convex" });
	const requestId = c.req.header("cf-ray") ?? c.req.header("x-request-id") ?? crypto.randomUUID();

	try {
		await convex.mutation(api.urlAnalytics.mutateUrlAnalytics, {
			sharedSecret: c.env.SHARED_SECRET,
			urlId,
			userId,
			urlStatusCode: healthCheckData?.responseStatus ?? 0,
			urlStatusMessage: healthCheckData?.healthStatus ?? "",
			requestId,
			clickEvent,
		});
		log.debug("Convex writes completed", { urlId, userId, healthCheckRecorded: !!healthCheckData, clickEventRecorded: !!clickEvent, request_id: requestId });
	} catch (err) {
		log.warn("Convex write failed", { urlId, userId, error: String(err), request_id: requestId });
	}
}


/**
 * Perform a health check
 * @param c - The context
 * @param destinationUrl - The destination URL
 * @param urlId - The URL ID
 * @param userId - The user ID
 * @param convex - The Convex client
 * @param clickEvent - Optional click event data for real-time activity
 */
export async function performHealthCheck(
	c: Context, 
	destinationUrl: string, 
	urlId: string, 
	userId: string,
	convex: ConvexHttpClient,
	clickEvent?: {
		linkSlug: string;
		occurredAt: number;
		country: string;
		city?: string;
		deviceType: string;
		browser: string;
		os: string;
		referer?: string;
	}
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
		
		// Record both analytics and health check data (and click event if provided)
		await executeConvexWrites(c, urlId, userId, convex, {
			destinationUrl,
			responseStatus: response.status,
			responseTimeMs: responseTime,
			isHealthy,
			healthStatus,
		}, clickEvent);
		
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

/**
 * Append UTM parameters from Redis to the destination URL.
 * Does not overwrite existing UTM params in the destination.
 * @param destinationUrl - The destination URL to append UTM params to
 * @param utmParams - Record of UTM params from Redis
 * @returns New URL with UTM params appended
 */
function appendUtmParamsToUrl(destinationUrl: URL, utmParams: Record<string, string>): URL {
	const url = new URL(destinationUrl.toString());
	for (const [key, value] of Object.entries(utmParams)) {
		// Only add if the param doesn't already exist in the destination URL
		if (value && !url.searchParams.has(key)) {
			url.searchParams.set(key, value);
		}
	}
	return url;
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
	getBrowser,
	getOS,
	isBot,
	buildAnalyticsInput,
	determineHealthStatus,
	drainOrCancel,
	executeConvexWrites,
	buildNoContentResponse,
	appendUtmParamsToUrl,
};

