import assert from "node:assert/strict";
import test from "node:test";
import { decideRedirect } from "./redirect-decision.ts";
import type { RedisValueObject } from "./types";

const activeLink: RedisValueObject = {
	destination: "https://example.com/path?utm_source=kept",
	tenant_id: "tenant_1",
	redirect_type: 302,
	created_at: 100,
	updated_at: 100,
	link_id: "link_1",
	is_active: true,
	expires_at: null,
	max_clicks: null,
	tags: [],
	utm_params: {
		utm_source: "new",
		utm_medium: "email",
	},
	rules: {},
	features: {
		track_clicks: true,
		track_conversions: true,
	},
	custom_metadata: {},
	version: 1,
};

const readHeader = (name: string) => {
	if (name === "user-agent") return "test-agent";
	if (name === "cf-connecting-ip") return "203.0.113.1";
	return undefined;
};

test("blocks inactive links", async () => {
	const decision = await decideRedirect({
		redisValue: { ...activeLink, is_active: false },
		readHeader,
	});

	assert.deepEqual(decision, {
		kind: "blocked",
		reason: "link is turned off",
	});
});

test("blocks expired links", async () => {
	const decision = await decideRedirect({
		redisValue: { ...activeLink, expires_at: 1_000 },
		readHeader,
		now: 1_000,
	});

	assert.deepEqual(decision, {
		kind: "blocked",
		reason: "link has expired",
	});
});

test("blocks an invalid stored destination without throwing", async () => {
	const decision = await decideRedirect({
		redisValue: { ...activeLink, destination: "not a URL" },
		readHeader,
	});

	assert.deepEqual(decision, {
		kind: "blocked",
		reason: "invalid destination",
	});
});

test("keeps existing UTM values and adds missing ones", async () => {
	const decision = await decideRedirect({
		redisValue: activeLink,
		readHeader,
	});

	assert.equal(decision.kind, "redirect");
	if (decision.kind === "redirect") {
		assert.equal(
			decision.destination.toString(),
			"https://example.com/path?utm_source=kept&utm_medium=email",
		);
		assert.equal(decision.variantId, null);
	}
});

test("uses a safe A/B variant", async () => {
	const decision = await decideRedirect({
		redisValue: {
			...activeLink,
			rules: {
				ab_test: {
					enabled: true,
					distribution: "deterministic",
					variants: [
						{ id: "variant_1", url: "https://variant.example", weight: 100 },
					],
				},
			},
		},
		readHeader,
	});

	assert.equal(decision.kind, "redirect");
	if (decision.kind === "redirect") {
		assert.equal(decision.destination.hostname, "variant.example");
		assert.equal(decision.variantId, "variant_1");
	}
});

test("falls back when an A/B variant is unsafe", async () => {
	const decision = await decideRedirect({
		redisValue: {
			...activeLink,
			rules: {
				ab_test: {
					enabled: true,
					distribution: "deterministic",
					variants: [
						{ id: "variant_1", url: "javascript:alert(1)", weight: 100 },
					],
				},
			},
		},
		readHeader,
	});

	assert.equal(decision.kind, "redirect");
	if (decision.kind === "redirect") {
		assert.equal(decision.destination.hostname, "example.com");
		assert.equal(decision.variantId, null);
	}
});

const splitTest = (linkId: string): RedisValueObject => ({
	...activeLink,
	link_id: linkId,
	rules: {
		ab_test: {
			enabled: true,
			distribution: "deterministic",
			variants: [
				{ id: "control", url: "https://control.example", weight: 50 },
				{ id: "variant_a", url: "https://variant.example", weight: 50 },
			],
		},
	},
});

async function assignedVariant(
	link: RedisValueObject,
	ip: string,
	userAgent: string,
): Promise<string | null> {
	const decision = await decideRedirect({
		redisValue: link,
		readHeader: (name) =>
			name === "cf-connecting-ip"
				? ip
				: name === "user-agent"
					? userAgent
					: undefined,
	});
	return decision.kind === "redirect" ? decision.variantId : null;
}

test("a visitor keeps the same A/B variant on repeat clicks", async () => {
	const link = splitTest("link_sticky");
	const first = await assignedVariant(link, "203.0.113.7", "agent-1");
	for (let click = 0; click < 5; click++) {
		assert.equal(
			await assignedVariant(link, "203.0.113.7", "agent-1"),
			first,
		);
	}
});

test("visitors sharing one network are split across A/B variants", async () => {
	const link = splitTest("link_office");
	let control = 0;
	for (let visitor = 0; visitor < 400; visitor++) {
		const variant = await assignedVariant(
			link,
			"198.51.100.20",
			`Mozilla/5.0 browser-${visitor}`,
		);
		if (variant === "control") control++;
	}
	assert.ok(control > 150 && control < 250, `control got ${control} of 400`);
});

test("each link splits the same visitors independently", async () => {
	const first = splitTest("link_first");
	const second = splitTest("link_second");
	let differs = 0;
	for (let visitor = 0; visitor < 400; visitor++) {
		const ip = `192.0.2.${visitor % 250}`;
		const userAgent = `agent-${visitor}`;
		if (
			(await assignedVariant(first, ip, userAgent)) !==
			(await assignedVariant(second, ip, userAgent))
		)
			differs++;
	}
	assert.ok(differs > 150 && differs < 250, `${differs} of 400 differ`);
});
