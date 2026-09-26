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

test("a tracked redirect normally waits for queue acceptance", async () => {
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

/** Minimal R2 stand-in with create-only puts, enough for failed-click archives. */
function memoryBucket() {
	const objects = new Map<string, string>();
	const bucket = {
		async put(
			key: string,
			value: string,
			options?: { onlyIf?: { etagDoesNotMatch?: string } },
		) {
			if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key))
				return null;
			objects.set(key, value);
			return {};
		},
		async get(key: string) {
			const value = objects.get(key);
			if (value === undefined) return null;
			return {
				size: value.length,
				json: async () => JSON.parse(value),
				text: async () => value,
			};
		},
	};
	return { objects, bucket: bucket as unknown as R2Bucket };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("a queue outage still redirects and keeps the click for replay", async () => {
	setup();
	const send = mock(async () => {
		throw new Error("Queue unavailable");
	});
	const { objects, bucket } = memoryBucket();
	const response = await app.request(
		"https://ndle.test/test",
		{},
		{
			CLICK_EVENTS: { send },
			FAILED_CLICK_ARCHIVES: bucket,
			CLICK_EVENTS_QUEUE_NAME: "ndle-click-events",
		},
	);
	expect(response.status).toBe(302);
	expect(response.headers.get("Location")).toBe("https://example.org/");
	// Two delayed retries, then an unresolved archive the operator can replay.
	await waitFor(() => objects.size === 2);
	expect(send).toHaveBeenCalledTimes(3);
	const [archiveKey, markerKey] = [...objects.keys()].sort();
	expect(archiveKey).toMatch(
		/^failed-clicks\/v1\/archive\/ndle-click-events\/spool-[0-9a-f-]{36}\.json$/,
	);
	expect(markerKey).toMatch(/^failed-clicks\/v1\/unresolved\//);
	const archive = JSON.parse(objects.get(archiveKey) ?? "null");
	expect(archive.reason).toBe("delivery_failed");
	expect(JSON.parse(archive.body.data).event.idempotency_key).toBe(
		archive.eventId,
	);
});

test("a queue that recovers during the retry needs no archive", async () => {
	setup();
	let calls = 0;
	const send = mock(async () => {
		calls++;
		if (calls === 1) throw new Error("Queue briefly unavailable");
	});
	const { objects, bucket } = memoryBucket();
	const response = await app.request(
		"https://ndle.test/test",
		{},
		{ CLICK_EVENTS: { send }, FAILED_CLICK_ARCHIVES: bucket },
	);
	expect(response.status).toBe(302);
	await waitFor(() => calls === 2);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(objects.size).toBe(0);
});

test("a stalled queue holds the redirect only for a bounded wait", async () => {
	setup();
	const send = mock(() => new Promise<void>(() => {}));
	const { bucket } = memoryBucket();
	const started = Date.now();
	const response = await app.request(
		"https://ndle.test/test",
		{},
		{ CLICK_EVENTS: { send }, FAILED_CLICK_ARCHIVES: bucket },
	);
	expect(response.status).toBe(302);
	expect(Date.now() - started).toBeLessThan(2_500);
});

test("an unavailable session store records the click without a first-session flag", async () => {
	setup();
	spyOn(Redis, "fromEnv").mockReturnValue({
		json: {
			get: async () => ({
				destination: "https://example.org/",
				is_active: true,
				expires_at: null,
				link_id: "link123",
				analytics_owner_key: "user:account123",
				features: { track_clicks: true },
			}),
		},
		set: async () => {
			throw new Error("Session store unavailable");
		},
	} as unknown as Redis);
	const events: QueuedClick[] = [];
	const send = mock(async (body: QueuedClick) => {
		events.push(body);
	});
	const response = await app.request(
		"https://ndle.test/test",
		{},
		{ CLICK_EVENTS: { send } },
	);
	expect(response.status).toBe(302);
	expect(events).toHaveLength(1);
	expect(events[0].event.first_click_of_session).toBe(false);
});

test("a link record that cannot produce a valid event still redirects", async () => {
	spyOn(Redis, "fromEnv").mockReturnValue({
		json: {
			get: async () => ({
				destination: "https://example.org/",
				is_active: true,
				expires_at: null,
				features: { track_clicks: true },
			}),
		},
		set: async () => "OK",
	} as unknown as Redis);
	const send = mock(async () => {});
	const response = await app.request(
		"https://ndle.test/test",
		{},
		{ CLICK_EVENTS: { send } },
	);
	expect(response.status).toBe(302);
	expect(send).not.toHaveBeenCalled();
});

test("a failed link lookup is the only reason a redirect answers 503", async () => {
	spyOn(Redis, "fromEnv").mockReturnValue({
		json: {
			get: async () => {
				throw new Error("Link store unavailable");
			},
		},
	} as unknown as Redis);
	const response = await app.request(
		"https://ndle.test/test",
		{},
		{ CLICK_EVENTS: { send: mock(async () => {}) } },
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

test("HEAD gets the same redirect but is never counted", async () => {
	const { set } = setup();
	const send = mock(async () => {});
	const response = await app.request(
		"https://ndle.test/test",
		{ method: "HEAD" },
		{ CLICK_EVENTS: { send } },
	);
	expect(response.status).toBe(302);
	expect(response.headers.get("Location")).toBe("https://example.org/");
	expect(send).not.toHaveBeenCalled();
	expect(set).not.toHaveBeenCalled();
});

test("prefetch and prerender requests are recorded as bots", async () => {
	setup();
	const events: QueuedClick[] = [];
	const send = mock(async (body: QueuedClick) => {
		events.push(body);
	});
	const browser =
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
	for (const headers of [
		{ "user-agent": browser },
		{ "user-agent": browser, "sec-purpose": "prefetch;prerender" },
		{ "user-agent": browser, purpose: "prefetch" },
	])
		await app.request(
			"https://ndle.test/test",
			{ headers },
			{ CLICK_EVENTS: { send } },
		);
	expect(events.map(({ event }) => event.is_bot)).toEqual([false, true, true]);
});
