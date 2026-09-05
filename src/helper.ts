import { Redis } from "@upstash/redis/cloudflare";
import type { Context } from "hono";
import type { AnalyticsEventInput, RedisValueObject } from "./types";

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
			"Accept-CH":
				"Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile, Sec-CH-UA-Full-Version-List",
			"Critical-CH":
				"Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile, Sec-CH-UA-Full-Version-List",
		}),
	});
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map((part) => Number(part));
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return true;
	}
	const [a, b] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe80:") ||
		normalized.startsWith("2001:db8:")
	);
}

function assertSafeDestinationUrl(input: string | URL): URL {
	const url = input instanceof URL ? new URL(input.toString()) : new URL(input);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Unsupported destination protocol");
	}
	if (url.username || url.password) {
		throw new Error("Destination URLs cannot include credentials");
	}

	const hostname = url.hostname.toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error("Local destination hosts are blocked");
	}
	const isIpv4Literal = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
	if (
		(isIpv4Literal && isPrivateIpv4(hostname)) ||
		(hostname.includes(":") && isPrivateIpv6(hostname))
	) {
		throw new Error("Private destination hosts are blocked");
	}

	return url;
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
function getBooleanEnv(
	value: string | undefined,
	defaultValue: boolean,
): boolean {
	if (value === undefined) return defaultValue;
	const normalized = value.trim().toLowerCase();
	if (normalized === "false" || normalized === "0" || normalized === "no")
		return false;
	return true;
}

/**
 * Coarse device type using UA-CH mobile hint first, else UA buckets.
 */
function getDeviceType(
	userAgent: string,
	secChUaMobile?: string | null,
): string | null {
	// Prefer UA-CH: Sec-CH-UA-Mobile: ?1 => mobile, ?0 => not mobile
	const mobileHint = (secChUaMobile ?? "").trim();
	if (mobileHint) {
		const normalized = mobileHint.replace(/"|\?/g, "").trim();
		if (normalized === "1") return "mobile";
	}

	if (!userAgent) return "Unknown";
	const ua = userAgent.toLowerCase();

	// Tablets
	if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
		return "tablet";
	}

	// Mobiles
	if (
		/mobile|iphone|ipod|android|blackberry|opera mini|opera mobi|skyfire|maemo|windows phone|palm|iemobile|symbian|symbianos|fennec/i.test(
			ua,
		)
	) {
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
function getOS(
	userAgent: string,
	secChUaPlatform?: string | null,
): string | null {
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
			const major = parseInt(match[1], 10);
			const minor = parseInt(match[2], 10);
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
function isBot(
	userAgent: string,
	cf?: { botManagement?: { verifiedBot?: boolean; score?: number } },
): boolean {
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
	const botRegex =
		/(bot|crawler|spider|crawling|curl|wget|httpclient|python-requests|libwww|bingpreview|facebookexternalhit|slurp|mediapartners-google|phantomjs|headless|puppeteer|lighthouse|semrush|ahrefs|yandex|googlebot|bingbot|duckduckbot)/i;
	return botRegex.test(ua);
}

/**
 * Parse browser name from sec-ch-ua header or user agent
 */
function getBrowser(userAgent: string, secChUa?: string | null): string | null {
	// 1) Try to parse from UA Client Hints (brand list). This may contain multiple brands.
	const header = (secChUa ?? "").trim();
	if (header) {
		const brandRegex = /"([^"]+)";v="[^"]+"/g;
		const brands: string[] = [];
		let match: RegExpExecArray | null;
		match = brandRegex.exec(header);
		while (match !== null) {
			brands.push(match[1]);
			match = brandRegex.exec(header);
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
	if (
		/chrome\//.test(ua) &&
		!/edg\//.test(ua) &&
		!/opr\//.test(ua) &&
		!/samsungbrowser\//.test(ua)
	)
		return "Chrome";
	if (
		/safari\//.test(ua) &&
		!/chrome\//.test(ua) &&
		!/crios\//.test(ua) &&
		!/fxios\//.test(ua) &&
		!/edgios\//.test(ua) &&
		!/opr\//.test(ua)
	)
		return "Safari";
	if (/firefox\//.test(ua)) return "Firefox";
	if (/msie/.test(ua) || /trident\//.test(ua)) return "Internet Explorer";

	return "Unknown";
}

/**
 * Generate a session ID based on IP hash and user agent
 */
async function generateSessionId(
	ipHash: string,
	userAgent: string,
): Promise<string> {
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
	variantId?: string | null,
	requestId = crypto.randomUUID(),
): Promise<AnalyticsEventInput> {
	const req = c.req;
	const raw = req.raw as Request & { cf?: IncomingRequestCfProperties };
	const cf: Partial<IncomingRequestCfProperties> = raw.cf ?? {};
	const now = new Date();
	const url = new URL(req.url);
	const shortUrl = `${url.origin}/${slug}`;
	const userAgent = req.header("user-agent") ?? "";
	const ref = req.header("referer") ?? req.header("referrer") ?? null;

	// Prefer client hints when available for device, else UA parsing
	const deviceType = getDeviceType(userAgent, req.header("sec-ch-ua-mobile"));
	const browser = getBrowser(
		userAgent,
		req.header("sec-ch-ua-full-version-list") ?? req.header("sec-ch-ua"),
	);
	const os = getOS(userAgent, req.header("sec-ch-ua-platform"));
	const ip =
		req.header("cf-connecting-ip") ?? req.header("x-forwarded-for") ?? "";
	const ipHash = await sha256Hex(ip);
	const languageHeader = req.header("accept-language") ?? null;
	const language = languageHeader
		? languageHeader.split(",")[0]?.trim() || null
		: null;
	const trackingEnabled =
		getBooleanEnv(c.env.TRACKING_ENABLED, true) &&
		redisValue?.features?.track_clicks !== false;

	// Generate session ID based on IP hash and user agent
	const sessionId = await generateSessionId(ipHash, userAgent);

	// Track first-click-of-session using Redis short-lived key
	const redis = Redis.fromEnv(c.env);
	const sessionKey = `session:${sessionId}:${slug}`;
	const firstClickOfSession =
		(await redis.set(sessionKey, requestId, { nx: true, ex: 1800 })) === "OK";

	const utm_source =
		url.searchParams.get("utm_source") ||
		redisValue?.utm_params?.utm_source ||
		null;
	const utm_medium =
		url.searchParams.get("utm_medium") ||
		redisValue?.utm_params?.utm_medium ||
		null;
	const utm_campaign =
		url.searchParams.get("utm_campaign") ||
		redisValue?.utm_params?.utm_campaign ||
		null;
	const utm_term =
		url.searchParams.get("utm_term") ||
		redisValue?.utm_params?.utm_term ||
		null;
	const utm_content =
		url.searchParams.get("utm_content") ||
		redisValue?.utm_params?.utm_content ||
		null;

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
		variant_id: variantId ?? null,
	};
}

/**
 * Build a no content response
 * @param status - The status code
 * @param cacheSeconds - The cache seconds
 * @returns The no content response
 */
function buildNoContentResponse(
	status = 204,
	cacheSeconds = 31536000,
): Response {
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
function appendUtmParamsToUrl(
	destinationUrl: URL,
	utmParams: Record<string, string>,
): URL {
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
	appendUtmParamsToUrl,
	assertSafeDestinationUrl,
	buildAnalyticsInput,
	buildClientRedirectResponse,
	buildNoContentResponse,
	getBooleanEnv,
	getBrowser,
	getDeviceType,
	getOS,
	isBot,
	sha256Hex,
};
