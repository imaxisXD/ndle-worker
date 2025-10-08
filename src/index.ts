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
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex-api";

type Bindings = EnvBindings;
const convexAddress = "https://tame-sparrow-238.convex.cloud";

const app = new Hono<{ Bindings: Bindings }>();
const convex = new ConvexHttpClient(convexAddress);

async function drainOrCancel(res: Response) {
	try {
		if (res.ok) {
			await res.arrayBuffer();
		} else {
			res.body?.cancel();
		}
	} catch {
		try { res.body?.cancel(); } catch {}
	}
}

async function executeConvexMutation(c: Context, urlId: string, userId: string) {
	const log = createRequestLogger(c, { component: "convex" });
	try {
		await convex.mutation(api.urlAnalytics.mutateClickCount, {
			sharedSecret: c.env.SHARED_SECRET,
			urlId,
			userId,
		});
		log.debug("Convex mutation done", { urlId, userId });
	} catch (err) {
		log.warn("Convex mutation failed", { error: String(err) });
	}
}

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

function buildNoContentResponse(status = 204, cacheSeconds = 31536000): Response {
	return new Response(null, {
		status,
		headers: { "Cache-Control": `public, max-age=${cacheSeconds}, immutable` },
	});
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

app.get("/:websiteSlug{[A-Za-z0-9_-]+}", async (c) => {
	const start = Date.now();
	const slug = c.req.param("websiteSlug");
	const log = createRequestLogger(c, { slug });
	log.info("Incoming request");
	if (!slug) {
		log.warn("Missing slug in path");
		return c.text("Not found", 404);
	}
	if (c.req.method !== "GET") {
		log.warn("Blocked non-GET request", { method: c.req.method });
		return c.text("Method not allowed", 405);
	}
	log.debug("Opening cache", { cache: "redirects" });
	const cache = await caches.open("redirects");

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
                        log.info("Sending analytics (cache hit)", { source: "cache" });
                        tasks.push(
                            sendAnalyticsEvent({
                                endpoint: c.env.ANALYTICS_ENDPOINT,
                                token: c.env.ANALYTICS_TOKEN,
                                event,
                            }).then(drainOrCancel),
                        );
                    }
                    if (redisValue?.link_id && redisValue?.user_id) {
                        tasks.push(executeConvexMutation(c, redisValue.link_id, redisValue.user_id));
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

	log.info("Cache miss — looking up in Redis");
	const redisResult = await getUrlFromRedis(c, log.child({ component: "redis" }));

	if (redisResult?.url) {
		const url = redisResult.url;
		c.executionCtx.waitUntil(
			(async () => {
				try {
					const cacheRequest = makeCacheRequestFromContext(c);
					const redirectResponse = buildCacheableRedirectResponse(url);

					log.info("Storing redirect in cache", { destination: url.toString() });
					await cache.put(cacheRequest, redirectResponse);

					log.info("Stored redirect in cache", { destination: url.toString() });
				} catch (error) {
					log.error(
						"Failed to store in cache",
						{ error: String(error) },
					);
				}
			})(),
		);
		const response = buildClientRedirectResponse(url);
		const redirectLatency = Date.now() - start;
		log.info("Redirecting to destination", { source: "redis", destination: url.toString(), latency_ms: redirectLatency, status: 302 });

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
					const tasks: Promise<unknown>[] = [];
					if (c.env.ANALYTICS_ENDPOINT && c.env.ANALYTICS_TOKEN) {
						log.info("Sending analytics (cache miss)", { source: "redis" });
						tasks.push(
							sendAnalyticsEvent({
								endpoint: c.env.ANALYTICS_ENDPOINT,
								token: c.env.ANALYTICS_TOKEN,
								event,
							}).then(drainOrCancel),
						);
					}
					const { link_id: linkId, user_id: userId } = redisResult.redisValue;
					if (linkId && userId) {
						tasks.push(executeConvexMutation(c, linkId, userId));
					}
					if (tasks.length) await Promise.allSettled(tasks);
				} catch (error) {
					log.error("Failed to send analytics (cache miss)", { source: "redis", error: String(error) });
				}
			})(),
		);
		return response;
	} else {
		log.warn("Slug not found");
		return c.notFound();
	}
});

export default app;
