import type { HeaderReader } from "./guards";

const mobileHintStripRegex = /"|\?/g;
const quotesRegex = /"/g;
const tabletUaRegex = /(tablet|ipad|playbook|silk)|(android(?!.*mobi))/;
const mobileUaRegex =
	/mobile|iphone|ipod|android|blackberry|opera mini|opera mobi|skyfire|maemo|windows phone|palm|iemobile|symbian|symbianos|fennec/;

const knownPlatforms: Record<string, string> = {
	macos: "macOS",
	windows: "Windows",
	linux: "Linux",
	android: "Android",
	ios: "iOS",
	"chrome os": "ChromeOS",
	"chromium os": "ChromeOS",
	chromeos: "ChromeOS",
};

const iosUaRegex = /iphone|ipad|ipod/;
const chromeOsUaRegex = /cros\s/;
const windowsNtRegex = /windows nt (\d+\.\d+)/;
const macOsVersionRegex = /mac os x (\d+)_(\d+)/;
const macOsUaRegex = /mac os x|macintosh/;

const automaticFetchRegex = /prefetch|prerender|preview/;
// Crawlers, HTTP libraries, chat/social link previews and the link checks
// email and office apps run before a person clicks. In-app browsers where a
// person really clicked (e.g. Pinterest, Outlook mobile) are not listed.
const botUaRegex =
	/(bot|crawler|spider|crawling|curl|wget|httpclient|python-requests|python-urllib|aiohttp|libwww|go-http-client|okhttp|axios|node-fetch|undici|java\/|apache-httpclient|guzzle|postmanruntime|insomnia|bingpreview|facebookexternalhit|facebookcatalog|slurp|mediapartners-google|googleimageproxy|google-inspectiontool|googleother|phantomjs|headless|puppeteer|playwright|lighthouse|semrush|ahrefs|yandex|duckduckbot|whatsapp|skypeuripreview|microsoftpreview|ms-office|microsoft office existence discovery|embedly|iframely|vkshare)/;

const chBrandRegex = /"([^"]+)";v="[^"]+"/g;
const notABrandRegex = /not\??a_brand/i;

const knownBrowserOrder = [
	"Brave",
	"Edge",
	"Opera",
	"Vivaldi",
	"Chrome",
	"Firefox",
	"Safari",
	"Samsung Internet",
] as const;

const browserBrandRules: ReadonlyArray<[RegExp, (typeof knownBrowserOrder)[number]]> = [
	[/brave/i, "Brave"],
	[/edge/i, "Edge"],
	[/opera/i, "Opera"],
	[/vivaldi/i, "Vivaldi"],
	[/chrome|chromium/i, "Chrome"],
	[/firefox/i, "Firefox"],
	[/safari/i, "Safari"],
	[/samsung internet/i, "Samsung Internet"],
];

function normalizeClientHintBrand(brand: string): string | null {
	for (const [pattern, name] of browserBrandRules) {
		if (pattern.test(brand)) return name;
	}
	return null;
}

type BotManagement = {
	botManagement?: { verifiedBot?: boolean; score?: number };
};

function detectDeviceType(
	userAgent: string,
	lowerUa: string,
	secChUaMobile?: string | null,
): string {
	// Prefer UA-CH: Sec-CH-UA-Mobile: ?1 => mobile, ?0 => not mobile
	const mobileHint = (secChUaMobile ?? "").trim();
	if (mobileHint) {
		const normalized = mobileHint.replace(mobileHintStripRegex, "").trim();
		if (normalized === "1") return "mobile";
	}

	if (!userAgent) return "Unknown";
	if (tabletUaRegex.test(lowerUa)) return "tablet";
	if (mobileUaRegex.test(lowerUa)) return "mobile";
	return "desktop";
}

function detectOS(userAgent: string, lowerUa: string, secChUaPlatform?: string | null): string {
	// Prefer recognized Client Hints; map unrecognized hints via UA fallback / "Other"
	// so arbitrary visitor-controlled text never enters the OS dimension.
	const platform = (secChUaPlatform ?? "").replace(quotesRegex, "").trim();
	const normalizedPlatform = platform.toLowerCase();
	const hasPlatformHint = normalizedPlatform !== "" && normalizedPlatform !== "unknown";
	if (hasPlatformHint) {
		const known = knownPlatforms[normalizedPlatform];
		if (known) return known;
	}

	if (userAgent) {
		if (iosUaRegex.test(lowerUa)) return "iOS";
		if (lowerUa.includes("android")) return "Android";
		if (chromeOsUaRegex.test(lowerUa)) return "ChromeOS";
		const winMatch = windowsNtRegex.exec(lowerUa);
		if (winMatch) {
			if (winMatch[1] === "10.0") return "Windows 10";
			if (winMatch[1] === "6.3") return "Windows 8.1";
			if (winMatch[1] === "6.2") return "Windows 8";
			if (winMatch[1] === "6.1") return "Windows 7";
			return "Windows";
		}
		if (lowerUa.includes("windows")) return "Windows";
		const macMatch = macOsVersionRegex.exec(lowerUa);
		if (macMatch) {
			const major = Number.parseInt(macMatch[1], 10);
			const minor = Number.parseInt(macMatch[2], 10);
			if (major >= 12) return "macOS Monterey+";
			if (major >= 11) return "macOS Big Sur+";
			if (major >= 10 && minor >= 15) return "macOS Catalina+";
			return "macOS";
		}
		if (macOsUaRegex.test(lowerUa)) return "macOS";
		if (lowerUa.includes("linux")) return "Linux";
	}

	return hasPlatformHint ? "Other" : "Unknown";
}

function detectBrowser(userAgent: string, lowerUa: string, secChUa?: string | null): string {
	// 1) Parse recognized brands from UA Client Hints; map unrecognized hints via
	// UA fallback / "Other" so arbitrary visitor text never enters the browser dimension.
	const header = (secChUa ?? "").trim();
	let hasUnrecognizedBrand = false;
	if (header) {
		const normalizedSet = new Set<string>();
		for (const match of header.matchAll(chBrandRegex)) {
			const brand = match[1];
			if (notABrandRegex.test(brand)) continue;
			const normalized = normalizeClientHintBrand(brand);
			if (normalized) normalizedSet.add(normalized);
			else hasUnrecognizedBrand = true;
		}
		for (const candidate of knownBrowserOrder) {
			if (normalizedSet.has(candidate)) return candidate;
		}
	}

	// 2) Fallback to User-Agent parsing
	if (userAgent) {
		if (lowerUa.includes("crios/")) return "Chrome";
		if (lowerUa.includes("fxios/")) return "Firefox";
		if (lowerUa.includes("edgios/")) return "Edge";
		if (lowerUa.includes("brave")) return "Brave";
		if (lowerUa.includes("edg/") || lowerUa.includes("edge/")) return "Edge";
		if (lowerUa.includes("opr/") || lowerUa.includes("opera/")) return "Opera";
		if (lowerUa.includes("vivaldi")) return "Vivaldi";
		if (lowerUa.includes("samsungbrowser/")) return "Samsung Internet";
		if (lowerUa.includes("duckduckgo")) return "DuckDuckGo";
		if (lowerUa.includes("yabrowser")) return "Yandex";
		if (lowerUa.includes("ucbrowser")) return "UC Browser";
		if (lowerUa.includes("chrome/")) return "Chrome";
		if (lowerUa.includes("safari/")) return "Safari";
		if (lowerUa.includes("firefox/")) return "Firefox";
		if (lowerUa.includes("msie") || lowerUa.includes("trident/")) return "Internet Explorer";
	}

	return hasUnrecognizedBrand ? "Other" : "Unknown";
}

function detectBot(userAgent: string, lowerUa: string, cf?: BotManagement): boolean {
	try {
		const bm = cf?.botManagement;
		if (bm) {
			if (bm.verifiedBot === true) return true;
			const score = typeof bm.score === "number" ? bm.score : undefined;
			// Low scores indicate likely bot. Threshold 30 is common guidance.
			if (score !== undefined && score <= 30) return true;
		}
	} catch {
		// Ignore errors and fallback to UA
	}

	// Every real browser sends a user agent; scripts often don't.
	if (!userAgent.trim()) return true;
	return botUaRegex.test(lowerUa);
}

/**
 * Requests a browser makes without a person clicking: prefetch and prerender
 * of links on a page, and preview fetches.
 */
export function isAutomaticFetch(readHeader: HeaderReader): boolean {
	const purpose = [
		readHeader("sec-purpose"),
		readHeader("purpose"),
		readHeader("x-purpose"),
		readHeader("x-moz"),
	]
		.filter(Boolean)
		.join(",")
		.toLowerCase();
	return automaticFetchRegex.test(purpose);
}

/** Coarse device type using UA-CH mobile hint first, else UA buckets. */
export function getDeviceType(userAgent: string, secChUaMobile?: string | null): string {
	return detectDeviceType(userAgent, userAgent.toLowerCase(), secChUaMobile);
}

/** Determine operating system using Client Hints when available, else UA parsing. */
export function getOS(userAgent: string, secChUaPlatform?: string | null): string {
	return detectOS(userAgent, userAgent.toLowerCase(), secChUaPlatform);
}

/** Parse browser name from sec-ch-ua header or user agent. */
export function getBrowser(userAgent: string, secChUa?: string | null): string {
	return detectBrowser(userAgent, userAgent.toLowerCase(), secChUa);
}

/** Bot detection using Cloudflare Bot Management when available, else UA regex fallback. */
export function isBot(userAgent: string, cf?: BotManagement): boolean {
	return detectBot(userAgent, userAgent.toLowerCase(), cf);
}

/** Classify device, browser, OS and bot status while lowercasing the UA once. */
export function analyzeUserAgent(params: {
	userAgent: string;
	secChUa?: string | null;
	secChUaPlatform?: string | null;
	secChUaMobile?: string | null;
	cf?: BotManagement;
	readHeader: HeaderReader;
}): {
	deviceType: string;
	browser: string;
	os: string;
	isBot: boolean;
} {
	const { userAgent } = params;
	const lowerUa = userAgent.toLowerCase();
	return {
		deviceType: detectDeviceType(userAgent, lowerUa, params.secChUaMobile),
		browser: detectBrowser(userAgent, lowerUa, params.secChUa),
		os: detectOS(userAgent, lowerUa, params.secChUaPlatform),
		isBot: detectBot(userAgent, lowerUa, params.cf) || isAutomaticFetch(params.readHeader),
	};
}
