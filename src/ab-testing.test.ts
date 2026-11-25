import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { resolveABTest } from "./ab-testing";
import type { ABVariant } from "./types";

afterEach(() => mock.restore());

function mockRandomUint32(value: number) {
	return spyOn(crypto, "getRandomValues").mockImplementation(((
		array: Uint32Array,
	) => {
		array[0] = value;
		return array;
	}) as typeof crypto.getRandomValues);
}

test("weighted random skips zero and negative weights even at boundary random values", () => {
	const variants: ABVariant[] = [
		{ id: "zero-start", url: "https://zero-start.example", weight: 0 },
		{ id: "negative", url: "https://negative.example", weight: -25 },
		{ id: "alpha", url: "https://alpha.example", weight: 50 },
		{ id: "zero-mid", url: "https://zero-mid.example", weight: 0 },
		{ id: "beta", url: "https://beta.example", weight: 50 },
		{ id: "zero-end", url: "https://zero-end.example", weight: 0 },
	];
	const config = {
		enabled: true,
		distribution: "weighted_random" as const,
		variants,
	};

	// Minimum value (0 / 0x100000000 = 0): selects first positive weight ("alpha"), never "zero-start".
	mockRandomUint32(0);
	expect(resolveABTest(config, "")?.variantId).toBe("alpha");

	// Just below midpoint (0x7fffffff / 0x100000000 < 0.5): selects "alpha".
	mockRandomUint32(0x7fffffff);
	expect(resolveABTest(config, "")?.variantId).toBe("alpha");

	// Exact midpoint (0x80000000 / 0x100000000 = 0.5): threshold becomes 0, which is NOT < 0 -> selects "beta".
	mockRandomUint32(0x80000000);
	expect(resolveABTest(config, "")?.variantId).toBe("beta");

	// Maximum uint32 (0xffffffff / 0x100000000 < 1): selects "beta", never "zero-end".
	mockRandomUint32(0xffffffff);
	expect(resolveABTest(config, "")?.variantId).toBe("beta");
});

test("weighted random falls back to first variant when all weights are non-positive", () => {
	const result = resolveABTest(
		{
			enabled: true,
			distribution: "weighted_random",
			variants: [
				{ id: "first", url: "https://first.example", weight: 0 },
				{ id: "second", url: "https://second.example", weight: -1 },
			],
		},
		"",
	);
	expect(result).toEqual({ url: "https://first.example", variantId: "first" });
});
