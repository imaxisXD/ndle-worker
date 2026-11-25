const ipv4LiteralRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
const ipv6BracketsRegex = /^\[|\]$/g;
const ipv6DottedSuffixRegex = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ipv6GroupRegex = /^[0-9a-f]{1,4}$/;
const trailingDotRegex = /\.$/;

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

/** Expands an IPv6 literal (with or without brackets) into eight groups. */
function ipv6Groups(hostname: string): number[] | null {
	let value = hostname.toLowerCase().replace(ipv6BracketsRegex, "");
	const dotted = ipv6DottedSuffixRegex.exec(value);
	if (dotted) {
		const bytes = dotted.slice(1).map(Number);
		if (bytes.some((byte) => byte > 255)) return null;
		value = `${value.slice(0, dotted.index)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [
		...head,
		...Array(halves.length === 2 ? missing : 0).fill("0"),
		...tail,
	];
	if (!groups.every((group) => ipv6GroupRegex.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}

function isPrivateIpv6(hostname: string): boolean {
	const groups = ipv6Groups(hostname);
	// Anything that looks like an address but can't be parsed is refused.
	if (!groups) return true;
	const [first] = groups;
	const leadingZeros = groups.slice(0, 5).every((group) => group === 0);
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms.
	if (leadingZeros && (groups[5] === 0xffff || groups[5] === 0)) {
		if (groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) return true; // :: and ::1
		const ipv4 = [
			groups[6] >> 8,
			groups[6] & 0xff,
			groups[7] >> 8,
			groups[7] & 0xff,
		];
		return isPrivateIpv4(ipv4.join("."));
	}
	return (
		(first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
		(first & 0xffc0) === 0xfe80 || // fe80::/10 link local
		(first === 0x2001 && groups[1] === 0x0db8) || // documentation
		first >= 0xff00 // multicast
	);
}

export function assertSafeDestinationUrl(input: string | URL): URL {
	const url = input instanceof URL ? new URL(input.href) : new URL(input);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Unsupported destination protocol");
	}
	if (url.username || url.password) {
		throw new Error("Destination URLs cannot include credentials");
	}

	const hostname = url.hostname.toLowerCase().replace(trailingDotRegex, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error("Local destination hosts are blocked");
	}
	const isIpv4Literal = ipv4LiteralRegex.test(hostname);
	if (
		(isIpv4Literal && isPrivateIpv4(hostname)) ||
		(hostname.includes(":") && isPrivateIpv6(hostname))
	) {
		throw new Error("Private destination hosts are blocked");
	}

	return url;
}

/**
 * Append UTM parameters from Redis to the destination URL without overwriting
 * existing params. Clones the URL only if at least one parameter is added.
 */
export function appendUtmParamsToUrl(
	destinationUrl: URL,
	utmParams: Record<string, string>,
): URL {
	let url: URL | null = null;
	for (const [key, value] of Object.entries(utmParams)) {
		if (value && !(url ?? destinationUrl).searchParams.has(key)) {
			url ??= new URL(destinationUrl.href);
			url.searchParams.set(key, value);
		}
	}
	return url ?? destinationUrl;
}
