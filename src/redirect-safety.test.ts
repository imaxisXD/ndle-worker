import assert from "node:assert/strict";
import test from "node:test";
import { getRedirectBlockReason } from "./redirect-safety.ts";
import type { RedisValueObject } from "./types";

const activeLink: RedisValueObject = {
	destination: "https://example.com",
	tenant_id: "tenant_1",
	redirect_type: 302,
	created_at: 100,
	updated_at: 100,
	link_id: "link_1",
	is_active: true,
	expires_at: null,
	max_clicks: null,
	tags: [],
	utm_params: {},
	rules: {},
	features: {
		track_clicks: true,
		track_conversions: true,
	},
	custom_metadata: {},
	version: 1,
};

test("allows an active link with no expiry", () => {
	assert.equal(getRedirectBlockReason(activeLink, 1_000), undefined);
});

test("blocks a link that is turned off", () => {
	assert.equal(
		getRedirectBlockReason({ ...activeLink, is_active: false }, 1_000),
		"link is turned off",
	);
});

test("blocks an expired link", () => {
	assert.equal(
		getRedirectBlockReason({ ...activeLink, expires_at: 1_000 }, 1_000),
		"link has expired",
	);
});

test("allows a link with a future expiry", () => {
	assert.equal(
		getRedirectBlockReason({ ...activeLink, expires_at: 2_000 }, 1_000),
		undefined,
	);
});
