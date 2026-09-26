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
			reason: RedirectBlockReason | "invalid destination";
	  };

// A visitor (network and browser) keeps the same variant of a link, and each
// link splits visitors independently of every other link's test.
async function buildVariantSessionId(
	linkId: string,
	readHeader: HeaderReader,
): Promise<string> {
	const userAgent = readHeader("user-agent") ?? "";
	const ip =
		readHeader("cf-connecting-ip") ?? readHeader("x-forwarded-for") ?? "";
	return sha256Hex(`${linkId}\n${ip}\n${userAgent}`);
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

	let destination: URL;
	try {
		destination = assertSafeDestinationUrl(destinationText);
	} catch {
		return { kind: "blocked", reason: "invalid destination" };
	}
	let variantId: string | null = null;
	const abConfig = redisValue?.rules?.ab_test;

	if (abConfig?.enabled && abConfig.variants?.length) {
		const sessionId = await buildVariantSessionId(
			redisValue?.link_id ?? "",
			readHeader,
		);
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
