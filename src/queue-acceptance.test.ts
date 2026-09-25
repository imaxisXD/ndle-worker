import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Redis } from "@upstash/redis/cloudflare";
import { app } from "./index";
import type { QueuedClick } from "./types";

afterEach(() => mock.restore());

function setup(trackingEnabled = true) {
	const sessionKeys = new Set<string>();
	const set = mock(
		async (
			key: string,
			_value: string,
			options: { nx: boolean; ex: number },
		) => {
			expect(options).toEqual({ nx: true, ex: 1800 });
			if (sessionKeys.has(key)) return null;
			sessionKeys.add(key);
			return "OK";
		},
	);
	spyOn(Redis, "fromEnv").mockReturnValue({
		json: {
			get: async () => ({
				destination: "https://example.org/",
				is_active: true,
				expires_at: null,
				link_id: "link123",
				analytics_owner_key: "user:account123",
				features: { track_clicks: trackingEnabled },
			}),
		},
		set,
	} as unknown as Redis);
	return { set };
}

test("a tracked redirect waits for durable queue acceptance", async () => {
	setup();
	let accept: () => void = () => {};
	const accepted = new Promise<void>((resolve) => {
		accept = resolve;
	});
	const send = mock(() => accepted);
	let responseReturned = false;
	const pending = app
		.request("https://ndle.test/test", {}, { CLICK_EVENTS: { send } })
		.then((response) => {
			responseReturned = true;
			return response;
		});
	await new Promise((resolve) => setTimeout(resolve, 15));
	expect(responseReturned).toBe(false);
	expect(send).toHaveBeenCalledTimes(1);
	accept();
	const response = await pending;
	expect(response.status).toBe(302);
	expect(response.headers.get("Cache-Control")).toContain("no-store");
});

test("queue failure returns a retryable response without a lossy redirect", async () => {
	setup();
	const send = mock(async () => {
		throw new Error("Queue unavailable");
	});
	const response = await app.request(
		"https://ndle.test/test",
		{},
		{ CLICK_EVENTS: { send } },
	);
	expect(response.status).toBe(503);
	expect(response.headers.get("Location")).toBeNull();
	expect(response.headers.get("Retry-After")).toBe("5");
});

for (const disabledBy of ["link", "environment"]) {
	test(`tracking disabled by ${disabledBy} skips the queue and session store`, async () => {
		const { set } = setup(disabledBy !== "link");
		const send = mock();
		const response = await app.request(
			"https://ndle.test/test",
			{},
			{
				CLICK_EVENTS: { send },
				TRACKING_ENABLED: disabledBy === "environment" ? "false" : "true",
			},
		);
		expect(response.status).toBe(302);
		expect(send).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
	});
}

test("simultaneous clicks claim one first-session marker and have distinct event IDs", async () => {
	setup();
	const events: QueuedClick[] = [];
	const send = mock(async (body: QueuedClick) => {
		events.push(body);
	});
	await Promise.all(
		[1, 2].map(() =>
			app.request(
				"https://ndle.test/test",
				{
					headers: {
						"user-agent": "browser",
						"cf-connecting-ip": "203.0.113.1",
						"x-request-id": "forged-same-id",
					},
				},
				{ CLICK_EVENTS: { send } },
			),
		),
	);
	expect(
		events.map(({ event }) => event.first_click_of_session).sort(),
	).toEqual([false, true]);
	expect(new Set(events.map(({ event }) => event.idempotency_key)).size).toBe(
		2,
	);
	for (const { event } of events)
		expect(event.request_id).toBe(event.idempotency_key);
});

const encode = (value: string) => new TextEncoder().encode(value);
const hex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
const sha256 = async (value: string) =>
	hex(await crypto.subtle.digest("SHA-256", encode(value)));

async function visitorEvent(env: Record<string, unknown>) {
	setup();
	const events: QueuedClick[] = [];
	const send = mock(async (body: QueuedClick) => {
		events.push(body);
	});
	await app.request(
		"https://ndle.test/test",
		{ headers: { "user-agent": "browser", "cf-connecting-ip": "203.0.113.1" } },
		{ CLICK_EVENTS: { send }, ...env },
	);
	mock.restore();
	expect(events).toHaveLength(1);
	return events[0].event;
}

test("without IP_HASH_SECRET the visitor hash and session stay unchanged", async () => {
	for (const env of [{}, { IP_HASH_SECRET: "" }]) {
		const event = await visitorEvent(env);
		expect(event.ip_hash).toBe(await sha256("203.0.113.1"));
		expect(event.session_id).toBe(
			(await sha256(`${event.ip_hash}-browser`)).substring(0, 16),
		);
	}
});

test("IP_HASH_SECRET keys the visitor hash and the session derived from it", async () => {
	for (const secret of [
		"first-test-key",
		"second-test-key",
		"first-test-key",
	]) {
		const key = await crypto.subtle.importKey(
			"raw",
			encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const expected = hex(
			await crypto.subtle.sign("HMAC", key, encode("203.0.113.1")),
		);
		const event = await visitorEvent({ IP_HASH_SECRET: secret });
		expect(event.ip_hash).toBe(expected);
		expect(event.ip_hash).not.toBe(await sha256("203.0.113.1"));
		expect(event.session_id).toBe(
			(await sha256(`${expected}-browser`)).substring(0, 16),
		);
	}
});
