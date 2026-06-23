import { resolveABTest } from "./ab-testing";
import {
	appendUtmParamsToUrl,
	assertSafeDestinationUrl,
	sha256Hex,
} from "./helper";
import {
	getRedirectBlockReason,
	type RedirectBlockReason,
} from "./redirect-safety";
import type { RedisValueObject } from "./types";

type HeaderReader = (name: string) => string | undefined;

type RedirectDecision =
	| {
			kind: "redirect";
			destination: URL;
			variantId: string | null;
	  }
	| {
			kind: "blocked";
			reason: RedirectBlockReason;
	  };

async function buildVariantSessionId(
	readHeader: HeaderReader,
): Promise<string> {
	const userAgent = readHeader("user-agent") ?? "";
	const ip =
		readHeader("cf-connecting-ip") ?? readHeader("x-forwarded-for") ?? "";
	const ipHash = await sha256Hex(ip);
	return `${ipHash}-${userAgent}`.substring(0, 32);
}

async function decideRedirect(params: {
	redisValue: RedisValueObject | null | undefined;
	readHeader: HeaderReader;
	now?: number;
}): Promise<RedirectDecision> {
	const { redisValue, readHeader, now } = params;
	const blockReason = getRedirectBlockReason(redisValue, now);
	if (blockReason) {
		return { kind: "blocked", reason: blockReason };
	}

	const destinationText = redisValue?.destination;
	if (!destinationText) {
		return { kind: "blocked", reason: "missing destination" };
	}

	let destination = assertSafeDestinationUrl(destinationText);
	let variantId: string | null = null;
	const abConfig = redisValue?.rules?.ab_test;

	if (abConfig?.enabled && abConfig.variants?.length) {
		const sessionId = await buildVariantSessionId(readHeader);
		const result = resolveABTest(abConfig, sessionId);
		if (result) {
			try {
				destination = assertSafeDestinationUrl(result.url);
				variantId = result.variantId;
			} catch {
				variantId = null;
			}
		}
	}

	const utmParams = redisValue?.utm_params ?? {};
	if (Object.keys(utmParams).length > 0) {
		destination = appendUtmParamsToUrl(destination, utmParams);
	}

	return {
		kind: "redirect",
		destination,
		variantId,
	};
}

export type { RedirectDecision };
export { decideRedirect };
