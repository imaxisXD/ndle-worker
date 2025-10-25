import { Redis } from "@upstash/redis/cloudflare";
import { type Context, Hono } from "hono";
import {
	buildClientRedirectResponse,
	buildCacheableRedirectResponse,
	checkCacheAndReturnElseSave,
	makeCacheRequestFromContext,
	buildAnalyticsInput,
	buildNoContentResponse,
	drainOrCancel,
	performHealthCheck,
} from "@helper";
import { sendAnalyticsEvent } from "./analytics";
import type { Bindings as EnvBindings, RedisValueObject } from "./types";
import { createRequestLogger, type RequestLogger } from "./log";
import { ConvexHttpClient } from "convex/browser";

type Bindings = EnvBindings;

const app = new Hono<{ Bindings: Bindings }>();
const slugWarmups = new Map<string, Promise<{ url: URL; redisValue: RedisValueObject } | undefined>>();

function createConvexClient(convexUrl: string): ConvexHttpClient {
	return new ConvexHttpClient(convexUrl);
}


app.get("/favicon.ico", () => buildNoContentResponse());
app.get("/apple-touch-icon.png", () => buildNoContentResponse());
app.get("/apple-touch-icon-precomposed.png", () => buildNoContentResponse());
app.get("/apple-touch-icon-:variant.png", () => buildNoContentResponse());

app.get("/:filename{[^/]+\\.[a-zA-Z0-9]+}", () =>
	new Response("Not found", {
		status: 404,
		headers: { "Cache-Control": "public, max-age=86400" },
	}),
);

/**
 * Get the full short-link object from Redis and its destination URL.
 * Reads Redis once and returns both values for reuse by callers.
 */
async function getUrlFromRedis(c: Context, log?: RequestLogger): Promise<{ url: URL; redisValue: RedisValueObject } | undefined> {
	const slug = c.req.param("websiteSlug");
	const redis = Redis.fromEnv(c.env);
	log?.debug("Looking up slug in Redis", { slug });
	const value = await redis.json.get<RedisValueObject>(slug);

	if (value && value.destination) {
		try {
			const url = new URL(value.destination);
			log?.info("Found destination in Redis", { slug, destination: url.toString() });
			return { url, redisValue: value };
		} catch (_err) {
			log?.warn("Destination in Redis is not a valid URL", { slug, destination: value.destination });
			return undefined;
		}
	}
	log?.info("No Redis entry for slug", { slug });
}


app.get("/:websiteSlug{[A-Za-z0-9_-]+}", async (c) => {
	const start = Date.now();
	const slug = c.req.param("websiteSlug");
	const log = createRequestLogger(c, { slug });
	const requestId = c.req.header("cf-ray") ?? c.req.header("x-request-id") ?? crypto.randomUUID();
	log.info("Incoming request", { request_id: requestId });
	if (!slug) {
		log.warn("Missing slug in path", { request_id: requestId });
		return c.text("Not found", 404);
	}
	if (c.req.method !== "GET") {
		log.warn("Blocked non-GET request", { method: c.req.method, request_id: requestId });
		return c.text("Method not allowed", 405);
	}
	log.debug("Opening cache", { cache: "redirects", request_id: requestId });
	const cache = await caches.open("redirects");

	// Create Convex client using environment variable
	const convex = createConvexClient(c.env.CONVEX_URL);

    const cached = await checkCacheAndReturnElseSave(c, cache);
    if (cached) {
        const redirectLatency = Date.now() - start;
        const destination = cached.headers.get("Location") || "";
        log.info("Cache hit — using cached target but returning client redirect", { destination, latency_ms: redirectLatency, status: 302 });

        c.executionCtx.waitUntil(
            (async () => {
                try {
                    const destination = cached.headers.get("Location") || "";
                    let redisValue: RedisValueObject | null = null;
                    try {
                        const result = await getUrlFromRedis(c, log.child({ component: "redis" }));
                        redisValue = result?.redisValue ?? null;
                    } catch (_err) {
                        log.warn("Background Redis lookup failed", { error: String(_err) });
                        redisValue = null;
                    }
                    const event = await buildAnalyticsInput(c, destination, slug, redirectLatency, redisValue);
                    const tasks: Promise<unknown>[] = [];
                    if (c.env.ANALYTICS_ENDPOINT && c.env.ANALYTICS_TOKEN) {
                        log.info("Sending analytics (cache hit)", { source: "cache", request_id: event.request_id });
                        tasks.push(
                            sendAnalyticsEvent({
                                endpoint: c.env.ANALYTICS_ENDPOINT,
                                token: c.env.ANALYTICS_TOKEN,
                                event,
                            }).then(drainOrCancel),
                        );
                    }
                    
					if (redisValue?.link_id && redisValue?.user_id && redisValue?.is_active && !event.is_bot) {
						tasks.push(performHealthCheck(c, destination, redisValue.link_id, redisValue.user_id, convex));
					}
                    
                    if (tasks.length) await Promise.allSettled(tasks);
                } catch (error) {
                    log.error("Failed to send analytics (cache hit)", { source: "cache", error: String(error) });
                }
            })(),
        );
        if (destination) {
            return buildClientRedirectResponse(new URL(destination));
        }
        return c.notFound();
    }

    log.info("Cache miss — looking up in Redis", { request_id: requestId });

    const existingWarmup = slugWarmups.get(slug);
    let redisResult: { url: URL; redisValue: RedisValueObject } | undefined;
    let startedWarmup = false;

    if (existingWarmup) {
        log.debug("Awaiting ongoing warmup", { request_id: requestId });
        redisResult = await existingWarmup;
    } else {
        startedWarmup = true;
        const warmupPromise = (async () => {
            const result = await getUrlFromRedis(c, log.child({ component: "redis" }));
            if (result?.url) {
                try {
                    const cacheRequest = makeCacheRequestFromContext(c);
                    const redirectResponse = buildCacheableRedirectResponse(result.url);

                    log.info("Storing redirect in cache", { destination: result.url.toString(), request_id: requestId });
                    await cache.put(cacheRequest, redirectResponse);
                    log.info("Stored redirect in cache", { destination: result.url.toString(), request_id: requestId });
                } catch (error) {
                    log.error("Failed to store in cache", { error: String(error), request_id: requestId });
                }
            }
            return result;
        })()
            .finally(() => {
                slugWarmups.delete(slug);
            });

        slugWarmups.set(slug, warmupPromise);
        redisResult = await warmupPromise;
    }

    if (!redisResult?.url) {
        log.warn("Slug not found", { request_id: requestId });
        return c.notFound();
    }

    const url = redisResult.url;
    const response = buildClientRedirectResponse(url);
    const redirectLatency = Date.now() - start;

    if (startedWarmup) {
        log.info("Redirecting to destination", { source: "redis", destination: url.toString(), latency_ms: redirectLatency, status: 302, request_id: requestId });

        c.executionCtx.waitUntil(
            (async () => {
                try {
                    const event = await buildAnalyticsInput(
                        c,
                        url.toString(),
                        slug,
                        redirectLatency,
                        redisResult!.redisValue,
                    );
                    const tasks: Promise<unknown>[] = [];
                    if (c.env.ANALYTICS_ENDPOINT && c.env.ANALYTICS_TOKEN) {
                        log.info("Sending analytics (cache miss)", { source: "redis", request_id: event.request_id });
                        tasks.push(
                            sendAnalyticsEvent({
                                endpoint: c.env.ANALYTICS_ENDPOINT,
                                token: c.env.ANALYTICS_TOKEN,
                                event,
                            }).then(drainOrCancel),
                        );
                    }
                    const { link_id: linkId, user_id: userId } = redisResult!.redisValue;

                    if (linkId && userId && redisResult!.redisValue.is_active && !event.is_bot) {
                        tasks.push(performHealthCheck(c, url.toString(), linkId, userId, convex));
                    }

                    if (tasks.length) await Promise.allSettled(tasks);
                } catch (error) {
                    log.error("Failed to send analytics (cache miss)", { source: "redis", error: String(error) });
                }
            })(),
        );
    } else {
        log.info("Redirecting to destination (warmup follower)", { source: "warmup", destination: url.toString(), latency_ms: redirectLatency, status: 302, request_id: requestId });
    }

    return response;
});

export default app;
