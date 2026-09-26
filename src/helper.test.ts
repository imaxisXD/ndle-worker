import { expect, test } from "bun:test";
import {
	assertSafeDestinationUrl,
	buildClientRedirectResponse,
	hashVisitorIp,
	isBot,
	sha256Hex,
} from "./helper";

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

test("private and special IPv6 destinations are refused, public ones allowed", () => {
	for (const blocked of [
		"http://[::1]/",
		"http://[::]/",
		"http://[fd00::1]/",
		"http://[fc12:3456::1]/",
		"http://[fe80::1]/",
		"http://[febf::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:169.254.169.254]/latest",
		"http://[::ffff:10.0.0.1]/",
		"http://[::127.0.0.1]/",
		"http://[2001:db8::1]/",
		"http://[ff02::1]/",
		"http://localhost./",
	])
		expect(() => assertSafeDestinationUrl(blocked)).toThrow();
	for (const allowed of [
		"https://[2606:4700:4700::1111]/",
		"https://[::ffff:8.8.8.8]/",
		"https://youtube.com/@creator",
		"https://example.com/?next=data:text",
	])
		expect(assertSafeDestinationUrl(allowed).toString()).toBe(
			new URL(allowed).toString(),
		);
});

test("browser clicks are people; scripts, previews and scanners are bots", () => {
	const chrome =
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
	const pinterestApp =
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Pinterest/iOS]";
	expect(isBot(chrome)).toBe(false);
	expect(isBot(pinterestApp)).toBe(false);
	for (const automated of [
		"",
		"WhatsApp/2.23.20.0",
		"Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
		"Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
		"SkypeUriPreview Preview/0.5",
		"Microsoft Office Existence Discovery",
		"Mozilla/5.0 (Windows NT 10.0; Microsoft Outlook 16.0.1; ms-office; MSOffice 16)",
		"Go-http-client/2.0",
		"okhttp/4.12.0",
		"axios/1.7.2",
		"node-fetch/1.0",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0",
	])
		expect(isBot(automated)).toBe(true);
});

test("redirects no longer ask the browser to repeat the first visit for hints", () => {
	const response = buildClientRedirectResponse(new URL("https://example.org/"));
	expect(response.headers.get("Critical-CH")).toBeNull();
	expect(response.headers.get("Accept-CH")).toContain("Sec-CH-UA");
});
