import { expect, test } from "bun:test";
import { hashVisitorIp, sha256Hex } from "./helper";

test("a keyed visitor hash is hex HMAC-SHA256", async () => {
	// RFC 4231 test case 2.
	expect(await hashVisitorIp("what do ya want for nothing?", "Jefe")).toBe(
		"5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
	);
});

test("an unset or empty secret keeps the plain SHA-256 visitor hash", async () => {
	const plain =
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
	expect(await sha256Hex("abc")).toBe(plain);
	expect(await hashVisitorIp("abc")).toBe(plain);
	expect(await hashVisitorIp("abc", "")).toBe(plain);
});
