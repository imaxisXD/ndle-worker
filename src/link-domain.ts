import type { RedisValueObject } from "./types";

const trailingDotRegex = /\.$/;
const defaultShortLinkHosts = new Set(["ndle.fyi", "www.ndle.fyi"]);

let cachedShortLinkHostsRaw: string | undefined;
let cachedShortLinkHosts: Set<string> | undefined;

type LinkDomainDecision = "allowed" | "legacy" | "denied";

function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(trailingDotRegex, "");
}

function parseShortLinkHosts(value: string | undefined): Set<string> {
	if (!value) return defaultShortLinkHosts;
	if (cachedShortLinkHosts && cachedShortLinkHostsRaw === value) {
		return cachedShortLinkHosts;
	}
	const hosts = value.split(",").map(normalizeHost).filter(Boolean);
	const parsed = hosts.length ? new Set(hosts) : defaultShortLinkHosts;
	cachedShortLinkHostsRaw = value;
	cachedShortLinkHosts = parsed;
	return parsed;
}

/**
 * Decide whether a link may open on the requested host.
 * Default short-link hosts serve every link, including custom-domain links, so
 * hosted QR codes and existing shares keep working. A custom host serves only
 * links bound to that exact domain. Records projected before the `domain` field
 * existed are reported as legacy and still allowed until re-projected.
 */
function checkLinkDomain(params: {
	host: string;
	domain: RedisValueObject["domain"];
	shortLinkHosts: string | undefined;
}): LinkDomainDecision {
	const host = normalizeHost(params.host);
	if (parseShortLinkHosts(params.shortLinkHosts).has(host)) return "allowed";
	const { domain } = params;
	if (domain === undefined) return "legacy";
	// null (default-domain link) and malformed values fail closed.
	return typeof domain === "string" && host !== "" && normalizeHost(domain) === host
		? "allowed"
		: "denied";
}

export type { LinkDomainDecision };
export { checkLinkDomain };
