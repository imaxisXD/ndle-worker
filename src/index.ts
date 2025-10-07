import { Redis } from "@upstash/redis/cloudflare";
import { type Context, Hono } from "hono";
import { logger } from "hono/logger";
import {
    buildRedirectResponse,
    checkCacheAndReturnElseSave,
    makeCacheRequestFromContext,
    buildAnalyticsInput,
} from "@helper";
import { sendAnalyticsEvent } from "./analytics";
import type { AnalyticsEventInput, Bindings as EnvBindings, RedisValueObject } from "./types";

type Bindings = EnvBindings;

const app = new Hono<{ Bindings: Bindings }>();
app.use(logger());

/**
 * Get the full short-link object from Redis and its destination URL.
 * Reads Redis once and returns both values for reuse by callers.
 */
async function getUrlFromRedis(c: Context): Promise<{ url: URL; redisValue: RedisValueObject } | undefined> {
    const slug = c.req.param("websiteSlug");
    const redis = Redis.fromEnv(c.env);
    const value = await redis.json.get<RedisValueObject>(slug);

    if (value && value.destination) {
        try {
            const url = new URL(value.destination);
            console.log("Redis: Found the url", url.toString());
            return { url, redisValue: value };
        } catch (_err) {
            // Invalid URL stored; treat as not found
            return undefined;
        }
    }
}


app.get("/:websiteSlug", async (c) => {
	const start = Date.now();
	const slug = c.req.param("websiteSlug");
	if (!slug) return c.text("Not found", 404);
	if (c.req.method !== "GET") return c.text("Method not allowed", 405);
	const cache = await caches.open("redirects");

    // Cache hit - return cached redirect (301 with Location header)
	const cached = await checkCacheAndReturnElseSave(c, cache);
	if (cached) {
		const redirectLatency = Date.now() - start;
		console.log(`🕰️ Redirect latency: ${redirectLatency}ms`);
		console.log(
			"Cache: Found the cached redirect",
			cached.headers.get("Location"),
		);

		// Fire-and-forget analytics event
		c.executionCtx.waitUntil(
			(async () => {
				try {
					const destination = cached.headers.get("Location") || "";
                    // Fetch Redis value in background to enrich analytics without blocking response
                    let redisValue: RedisValueObject | null = null;
                    try {
                        const result = await getUrlFromRedis(c);
                        redisValue = result?.redisValue ?? null;
                    } catch (_err) {
                        redisValue = null;
                    }
                    const event = await buildAnalyticsInput(c, destination, slug, redirectLatency, redisValue);
					if (c.env.ANALYTICS_ENDPOINT && c.env.ANALYTICS_TOKEN) {
						console.log("Background task: Sending analytics event", event);
						const response = await sendAnalyticsEvent({
							endpoint: c.env.ANALYTICS_ENDPOINT,
							token: c.env.ANALYTICS_TOKEN,
							event,
						});
						console.log("Background task: Analytics event sent", response);
					}
				} catch (error) {
					console.error("Error: Background analytics send (cache hit)", error);
				}
			})(),
		);
		return cached;
	}

    // Cache miss - get url and redis value from Redis and store in Cloudflare cache
    const redisResult = await getUrlFromRedis(c);

    if (redisResult?.url) {
        const url = redisResult.url;
		// Store in Cloudflare cache as a background task - response is sent immediately
		// while cache is updated asynchronously
		c.executionCtx.waitUntil(
			(async () => {
				try {
					const cacheRequest = makeCacheRequestFromContext(c);
					const redirectResponse = buildRedirectResponse(url);

					await cache.put(cacheRequest, redirectResponse);

					console.log("Background task: Stored new response in cache");
				} catch (error) {
					console.error(
						"Error: Background task: Failed to store in cache:",
						error,
					);
				}
			})(),
		);
		const response = buildRedirectResponse(url);
		const redirectLatency = Date.now() - start;
		console.log(`🕰️ Redirect latency: ${redirectLatency}ms`);

		// Fire-and-forget analytics event
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
						await sendAnalyticsEvent({
							endpoint: c.env.ANALYTICS_ENDPOINT,
							token: c.env.ANALYTICS_TOKEN,
							event,
						});
					}
				} catch (error) {
					console.error("Error: Background analytics send (cache miss)", error);
				}
			})(),
		);
		return response;
	} else {
		return c.notFound();
	}
});

export default app;
