import type { ABTestConfig, ABVariant } from "./types";

/**
 * Select a variant based on weighted random distribution.
 * Uses crypto for secure randomness.
 */
export function selectWeightedVariant(variants: ABVariant[]): ABVariant | null {
	if (!variants.length) return null;
	console.log(`[AB-DEBUG] Starting weighted selection. Variants: ${JSON.stringify(variants)}`);

	const totalWeight = variants.reduce((sum, v) => sum + Number(v.weight), 0);
	console.log(`[AB-DEBUG] Total weight: ${totalWeight}`);
	if (totalWeight <= 0) {
		console.warn(`[AB-DEBUG] Total weight <= 0. Defaulting to first variant.`);
		return variants[0];
	}

	const random = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff;
	let threshold = random * totalWeight;
	console.log(`[AB-DEBUG] Random: ${random}, Start Threshold: ${threshold}`);

	for (const variant of variants) {
		threshold -= Number(variant.weight);
		console.log(`[AB-DEBUG] Checking variant ${variant.id}. Weight: ${variant.weight}, New Threshold: ${threshold}`);
		if (threshold <= 0) {
			console.log(`[AB-DEBUG] Selected variant: ${variant.id}`);
			return variant;
		}
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
	console.log(`[AB-DEBUG] Starting deterministic selection. SessionId: ${sessionId}, Variants: ${JSON.stringify(variants)}`);

	// Hash session ID to get consistent bucket
	let hash = 0;
	for (let i = 0; i < sessionId.length; i++) {
		hash = (hash << 5) - hash + sessionId.charCodeAt(i);
		hash = hash & hash; // Convert to 32-bit integer
	}

	const totalWeight = variants.reduce((sum, v) => sum + Number(v.weight), 0);
	console.log(`[AB-DEBUG] deterministic: Total weight: ${totalWeight}, Hash: ${hash}`);
	if (totalWeight <= 0) return variants[0];

	const bucket = Math.abs(hash) % totalWeight;
	console.log(`[AB-DEBUG] Bucket: ${bucket}`);
	let threshold = 0;

	for (const variant of variants) {
		threshold += Number(variant.weight);
		console.log(`[AB-DEBUG] Checking variant ${variant.id}. Weight: ${variant.weight}, Threshold: ${threshold}`);
		if (bucket < threshold) {
			console.log(`[AB-DEBUG] Selected variant: ${variant.id}`);
			return variant;
		}
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
