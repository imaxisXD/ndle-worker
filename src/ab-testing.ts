import type { ABTestConfig, ABVariant } from "./types";

/**
 * Select a variant based on weighted random distribution.
 * Uses crypto for secure randomness.
 */
export function selectWeightedVariant(variants: ABVariant[]): ABVariant | null {
	if (!variants.length) return null;

	const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
	if (totalWeight <= 0) return variants[0];

	const random = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff;
	let threshold = random * totalWeight;

	for (const variant of variants) {
		threshold -= variant.weight;
		if (threshold <= 0) return variant;
	}

	return variants[variants.length - 1];
}

/**
 * Deterministic variant selection based on session ID.
 * Same session always gets same variant for consistency.
 * This solves the #1 complaint about A/B testing in link shorteners.
 */
export function selectDeterministicVariant(
	variants: ABVariant[],
	sessionId: string,
): ABVariant | null {
	if (!variants.length) return null;

	// Hash session ID to get consistent bucket
	let hash = 0;
	for (let i = 0; i < sessionId.length; i++) {
		hash = (hash << 5) - hash + sessionId.charCodeAt(i);
		hash = hash & hash; // Convert to 32-bit integer
	}

	const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
	if (totalWeight <= 0) return variants[0];

	const bucket = Math.abs(hash) % totalWeight;
	let threshold = 0;

	for (const variant of variants) {
		threshold += variant.weight;
		if (bucket < threshold) return variant;
	}

	return variants[variants.length - 1];
}

/**
 * Main A/B test resolver.
 * Returns the variant URL to redirect to, or null if no A/B test configured.
 */
export function resolveABTest(
	config: ABTestConfig | undefined,
	sessionId: string,
): { url: string; variantId: string } | null {
	if (!config?.enabled || !config.variants?.length) {
		return null;
	}

	const variant =
		config.distribution === "deterministic"
			? selectDeterministicVariant(config.variants, sessionId)
			: selectWeightedVariant(config.variants);

	if (!variant) return null;

	return {
		url: variant.url,
		variantId: variant.id,
	};
}
