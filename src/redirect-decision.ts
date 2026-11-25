import { resolveABTest } from "./ab-testing";
import { sha256Hex } from "./crypto";
import { type HeaderReader, readClientIp } from "./guards";
import {
	getRedirectBlockReason,
	type RedirectBlockReason,
} from "./redirect-safety";
import type { RedisValueObject } from "./types";
import { appendUtmParamsToUrl, assertSafeDestinationUrl } from "./url-safety";

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
	const ip = readClientIp(readHeader);
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
	// getRedirectBlockReason verified redisValue and redisValue.destination exist.
	const link = redisValue as RedisValueObject;

	let destination: URL;
	try {
		destination = assertSafeDestinationUrl(link.destination);
	} catch {
		return { kind: "blocked", reason: "invalid destination" };
	}
	let variantId: string | null = null;
	const abConfig = link.rules?.ab_test;

	if (abConfig?.enabled && abConfig.variants?.length) {
		const sessionId = await buildVariantSessionId(
			link.link_id ?? "",
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

	const utmParams = link.utm_params;
	if (utmParams && Object.keys(utmParams).length > 0) {
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
