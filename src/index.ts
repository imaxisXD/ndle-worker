import { Redis } from "@upstash/redis/cloudflare";
import { type Context, Hono } from "hono";

import {
	buildClientRedirectResponse,
	buildCacheableRedirectResponse,
	checkCacheAndReturnElseSave,
	makeCacheRequestFromContext,
	buildAnalyticsInput,
} from "@helper";
import { sendAnalyticsEvent } from "./analytics";
import type { Bindings as EnvBindings, RedisValueObject } from "./types";
import { createRequestLogger, type RequestLogger } from "./log";

type Bindings = EnvBindings;

const app = new Hono<{ Bindings: Bindings }>();

/**
 * Get the full short-link object from Redis and its destination URL.
 * Reads Redis once and returns both values for reuse by callers.
 */
async function getUrlFromRedis(c: Context, log?: RequestLogger): Promise<{ url: URL; redisValue: RedisValueObject } | undefined> {
	const slug = c.req.param("websiteSlug");
	const redis = Redis.fromEnv(c.env);
	log?.debug("redis.get.start", { slug });
	const value = await redis.json.get<RedisValueObject>(slug);

	if (value && value.destination) {
		try {
			const url = new URL(value.destination);
			log?.info("redis.get.hit", { slug, destination: url.toString() });
			return { url, redisValue: value };
		} catch (_err) {
			log?.warn("redis.get.invalid_url", { slug, destination: value.destination });
			return undefined;
		}
	}
	log?.info("redis.get.miss", { slug });
}

app.get("/:websiteSlug", async (c) => {
	const start = Date.now();
	const slug = c.req.param("websiteSlug");
	const log = createRequestLogger(c, { slug });
	log.info("request.received");
	if (!slug) {
		log.warn("request.slug_missing");
		return c.text("Not found", 404);
	}
	if (c.req.method !== "GET") {
		log.warn("request.method_not_allowed", { method: c.req.method });
		return c.text("Method not allowed", 405);
	}
	log.debug("cache.open.start", { cache: "redirects" });
	const cache = await caches.open("redirects");

	const cached = await checkCacheAndReturnElseSave(c, cache);
	if (cached) {
		const redirectLatency = Date.now() - start;
		const destination = cached.headers.get("Location") || "";
		log.info("cache.hit", { destination, latency_ms: redirectLatency, status: 301 });

		c.executionCtx.waitUntil(
			(async () => {
				try {
					const destination = cached.headers.get("Location") || "";
					let redisValue: RedisValueObject | null = null;
					try {
						const result = await getUrlFromRedis(c, log.child({ component: "redis" }));
						redisValue = result?.redisValue ?? null;
					} catch (_err) {
						log.warn("redis.get.background.error", { error: String(_err) });
						redisValue = null;
					}
					const event = await buildAnalyticsInput(c, destination, slug, redirectLatency, redisValue);
					if (c.env.ANALYTICS_ENDPOINT && c.env.ANALYTICS_TOKEN) {
						log.info("analytics.send.start", { source: "cache" });
						const response = await sendAnalyticsEvent({
							endpoint: c.env.ANALYTICS_ENDPOINT,
							token: c.env.ANALYTICS_TOKEN,
							event,
						});
						log.info("analytics.send.success", { source: "cache", status: response.status });
					}
				} catch (error) {
					log.error("analytics.send.error", { source: "cache", error: String(error) });
				}
			})(),
		);
		return cached;
	}

	log.info("cache.miss");
	const redisResult = await getUrlFromRedis(c, log.child({ component: "redis" }));

	if (redisResult?.url) {
		const url = redisResult.url;
		c.executionCtx.waitUntil(
			(async () => {
				try {
					const cacheRequest = makeCacheRequestFromContext(c);
					const redirectResponse = buildCacheableRedirectResponse(url);

					log.info("cache.put.start", { destination: url.toString() });
					await cache.put(cacheRequest, redirectResponse);

					log.info("cache.put.success", { destination: url.toString() });
				} catch (error) {
					log.error(
						"cache.put.error",
						{ error: String(error) },
					);
				}
			})(),
		);
		const response = buildClientRedirectResponse(url);
		const redirectLatency = Date.now() - start;
		log.info("redirect", { source: "redis", destination: url.toString(), latency_ms: redirectLatency, status: 302 });

		c.executionCtx.waitUntil(
			(async () => {
				try {
					const event = await buildAnalyticsInput(
						c,
						url.toString(),
						slug,
						redirectLatency,
						redisResult.redisValue,
					);
					if (c.env.ANALYTICS_ENDPOINT && c.env.ANALYTICS_TOKEN) {
						log.info("analytics.send.start", { source: "redis" });
						await sendAnalyticsEvent({
							endpoint: c.env.ANALYTICS_ENDPOINT,
							token: c.env.ANALYTICS_TOKEN,
							event,
						});
						log.info("analytics.send.success", { source: "redis" });
					}
				} catch (error) {
					log.error("analytics.send.error", { source: "redis", error: String(error) });
				}
			})(),
		);
		return response;
	} else {
		log.warn("not_found", { slug });
		return c.notFound();
	}
});

export default app;
