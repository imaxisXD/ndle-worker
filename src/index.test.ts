import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Redis } from "@upstash/redis/cloudflare";
import { app } from "./index";
import type { QueuedClick, RedisValueObject } from "./types";

afterEach(() => mock.restore());

for (const destination of [
	"not a URL",
	"javascript:alert(1)",
	"http://127.0.0.1",
]) {
	test(`returns 404 for an invalid stored destination: ${destination}`, async () => {
		const redisLookup = spyOn(Redis, "fromEnv").mockReturnValue({
			json: { get: async () => ({ destination, is_active: true }) },
		} as unknown as Redis);

		try {
			const response = await app.request(
				"https://ndle.test/example",
				{},
				{
					CONVEX_URL: "https://example.convex.cloud",
				},
			);

			expect(response.status).toBe(404);
			expect(response.headers.get("Location")).toBeNull();
		} finally {
			redisLookup.mockRestore();
		}
	});
}

function serveLink(fields: Partial<RedisValueObject> | null) {
	const set = mock(async () => "OK");
	spyOn(Redis, "fromEnv").mockReturnValue({
		json: {
			get: async () =>
				fields && {
					destination: "https://example.org/",
					is_active: true,
					expires_at: null,
					link_id: "link123",
					analytics_owner_key: "user:account123",
					features: { track_clicks: true },
					...fields,
				},
		},
		set,
	} as unknown as Redis);
	return { set };
}

async function open(
	url: string,
	fields: Partial<RedisValueObject> | null,
	env: Record<string, unknown> = { SHORT_LINK_HOSTS: "ndle.fyi,www.ndle.fyi" },
) {
	const { set } = serveLink(fields);
	const events: QueuedClick[] = [];
	const send = mock(async (body: QueuedClick) => {
		events.push(body);
	});
	const response = await app.request(
		url,
		{},
		{ CLICK_EVENTS: { send }, ...env },
	);
	mock.restore();
	return { response, send, set, events };
}

test("default short-link hosts open links bound to any domain", async () => {
	for (const url of ["https://ndle.fyi/test", "https://www.ndle.fyi/test"]) {
		for (const fields of [
			{ domain: "go.brand.example" },
			{ domain: null },
			{},
		]) {
			const { response, send } = await open(url, fields);
			expect(response.status).toBe(302);
			expect(send).toHaveBeenCalledTimes(1);
		}
	}
});

test("a custom domain opens and tracks its own link", async () => {
	const { response, events } = await open("https://go.brand.example/test", {
		domain: "go.brand.example",
	});
	expect(response.status).toBe(302);
	expect(response.headers.get("Location")).toBe("https://example.org/");
	expect(events).toHaveLength(1);
	expect(events[0].event.short_url).toBe("https://go.brand.example/test");
});

for (const [name, domain] of [
	["another custom domain", "go.brand.example"],
	["the default short domain", null],
] as const) {
	test(`a custom domain cannot open a link bound to ${name}`, async () => {
		const missing = await open("https://other.example/test", null);
		const { response, send, set } = await open("https://other.example/test", {
			domain,
		});
		expect(response.status).toBe(404);
		expect(await response.text()).toBe(await missing.response.text());
		expect(response.headers.get("Location")).toBeNull();
		expect(send).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
	});
}

test("a legacy record without a domain still opens on a custom domain and is logged", async () => {
	const lines: string[] = [];
	spyOn(console, "info").mockImplementation((line) => {
		lines.push(String(line));
	});
	const { response, send } = await open("https://go.brand.example/test", {});
	expect(response.status).toBe(302);
	expect(send).toHaveBeenCalledTimes(1);
	expect(
		lines.map((line) => JSON.parse(line)).filter((line) => line.reason),
	).toEqual([
		expect.objectContaining({
			level: "info",
			slug: "test",
			reason: "legacy_domain_projection",
		}),
	]);
});

test("request hosts are compared without case or a trailing dot", async () => {
	for (const [url, domain] of [
		["https://GO.Brand.Example./test", "go.brand.example"],
		["https://NDLE.FYI./test", null],
	] as const) {
		const { response, send } = await open(url, { domain });
		expect(response.status).toBe(302);
		expect(send).toHaveBeenCalledTimes(1);
	}
});

test("missing or empty SHORT_LINK_HOSTS keeps the production short-link hosts", async () => {
	for (const env of [{}, { SHORT_LINK_HOSTS: "" }]) {
		const allowed = await open("https://ndle.fyi/test", { domain: null }, env);
		expect(allowed.response.status).toBe(302);
		const denied = await open(
			"https://go.brand.example/test",
			{ domain: null },
			env,
		);
		expect(denied.response.status).toBe(404);
		expect(denied.send).not.toHaveBeenCalled();
	}
});
