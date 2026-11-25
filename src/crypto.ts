const textEncoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out;
}

/** Compute a SHA-256 hash in lowercase hex for a given string. */
export async function sha256Hex(value: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
}

// Imported once per isolate; keyed by the secret so a changed value re-imports.
let hmacKeyCache: { secret: string; key: CryptoKey } | undefined;

/** Compute an HMAC-SHA256 digest in lowercase hex for a given string and secret. */
export async function hmacSha256Hex(value: string, secret: string): Promise<string> {
	let key = hmacKeyCache?.secret === secret ? hmacKeyCache.key : undefined;
	if (!key) {
		key = await crypto.subtle.importKey(
			"raw",
			textEncoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		hmacKeyCache = { secret, key };
	}
	return toHex(await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)));
}

/**
 * Hash a visitor IP for storage. With a secret this is hex HMAC-SHA256, which
 * cannot be reversed by enumerating IPv4 addresses without that secret. Without
 * one it stays the legacy plain SHA-256, so deploying first changes nothing.
 */
export async function hashVisitorIp(ip: string, secret?: string): Promise<string> {
	return secret ? hmacSha256Hex(ip, secret) : sha256Hex(ip);
}
