import {
	assertSafeDestinationUrl,
	buildAnalyticsInput,
	buildClientRedirectResponse,
	buildNoContentResponse,
	drainOrCancel,
	recordClickInConvex,
} from "@helper";
import { Redis } from "@upstash/redis/cloudflare";
import { ConvexHttpClient } from "convex/browser";
import { type Context, Hono } from "hono";
import { sendAnalyticsEvent } from "./analytics";
import { createRequestLogger, type RequestLogger } from "./log";
import { decideRedirect } from "./redirect-decision";
import type { Bindings as EnvBindings, RedisValueObject } from "./types";

type Bindings = EnvBindings;

const app = new Hono<{ Bindings: Bindings }>();

function createConvexClient(convexUrl: string): ConvexHttpClient {
	return new ConvexHttpClient(convexUrl);
}

app.get("/favicon.ico", () => buildNoContentResponse());
app.get("/apple-touch-icon.png", () => buildNoContentResponse());
app.get("/apple-touch-icon-precomposed.png", () => buildNoContentResponse());
app.get("/apple-touch-icon-:variant.png", () => buildNoContentResponse());

app.get(
	"/:filename{[^/]+\\.[a-zA-Z0-9]+}",
	() =>
		new Response("Not found", {
			status: 404,
			headers: { "Cache-Control": "public, max-age=86400" },
		}),
);

/**
 * Get the full short-link object from Redis and its destination URL.
 * Reads Redis once and returns both values for reuse by callers.
 */
async function getUrlFromRedis(
	c: Context,
	log?: RequestLogger,
): Promise<{ url: URL; redisValue: RedisValueObject } | undefined> {
	const slug = c.req.param("websiteSlug");
	if (!slug) {
		log?.warn("Missing slug while looking up Redis");
		return undefined;
	}
	const redis = Redis.fromEnv(c.env);
	log?.debug("Looking up slug in Redis", { slug });
	const value = await redis.json.get<RedisValueObject>(slug);

	if (value?.destination) {
		try {
			const url = assertSafeDestinationUrl(value.destination);
			log?.info("Found destination in Redis", {
				slug,
				destination: url.toString(),
			});
			return { url, redisValue: value };
		} catch (_err) {
			log?.warn("Destination in Redis is not a valid URL", {
				slug,
				destination: value.destination,
			});
			return undefined;
		}
	}
	log?.info("No Redis entry for slug", { slug });
}

app.get("/:websiteSlug{[A-Za-z0-9_-]+}", async (c) => {
	const start = Date.now();
	const slug = c.req.param("websiteSlug");
	const log = createRequestLogger(c, { slug });
	const requestId =
		c.req.header("cf-ray") ??
		c.req.header("x-request-id") ??
		crypto.randomUUID();
	log.info("Incoming request", { request_id: requestId });
	if (!slug) {
		log.warn("Missing slug in path", { request_id: requestId });
		return c.text("Not found", 404);
	}
	if (c.req.method !== "GET") {
		log.warn("Blocked non-GET request", {
			method: c.req.method,
			request_id: requestId,
		});
		return c.text("Method not allowed", 405);
	}

	// Create Convex client using environment variable
	const convex = createConvexClient(c.env.CONVEX_URL);

	log.info("Looking up redirect in Redis", { request_id: requestId });
	const redisResult = await getUrlFromRedis(
		c,
		log.child({ component: "redis" }),
	);

	if (!redisResult?.url) {
		log.warn("Slug not found", { request_id: requestId });
		return c.notFound();
	}

	const redisValue = redisResult.redisValue;
	const decision = await decideRedirect({
		redisValue,
		readHeader: (name) => c.req.header(name) ?? undefined,
	});

	if (decision.kind === "blocked") {
		log.warn("Cannot redirect slug", {
			reason: decision.reason,
			expires_at: redisValue.expires_at ?? null,
			is_active: redisValue.is_active ?? null,
			request_id: requestId,
		});
		return c.notFound();
	}

	const finalUrl = decision.destination;
	const variantId = decision.variantId;
	const response = buildClientRedirectResponse(finalUrl);
	const redirectLatency = Date.now() - start;

	log.info("Redirecting to destination", {
		source: "redis",
		destination: finalUrl.toString(),
		variantId,
		latency_ms: redirectLatency,
		status: 302,
		request_id: requestId,
	});

	c.executionCtx.waitUntil(
		(async () => {
			try {
				const event = await buildAnalyticsInput(
					c,
					finalUrl.toString(),
					slug,
					redirectLatency,
					redisValue,
					variantId,
				);
				const tasks: Promise<unknown>[] = [];
				if (c.env.ANALYTICS_ENDPOINT && c.env.ANALYTICS_TOKEN) {
					log.info("Sending analytics (cache miss)", {
						source: "redis",
						request_id: event.request_id,
					});
					tasks.push(
						sendAnalyticsEvent({
							endpoint: c.env.ANALYTICS_ENDPOINT,
							token: c.env.ANALYTICS_TOKEN,
							event,
						}).then(drainOrCancel),
					);
				}
				if (c.env.API_SECRET && c.env.INGEST_ENDPOINT) {
					log.info("Sending analytics to new endpoint (cache miss)", {
						source: "redis",
						request_id: event.request_id,
					});
					tasks.push(
						sendAnalyticsEvent({
							endpoint: c.env.INGEST_ENDPOINT,
							token: c.env.API_SECRET,
							event,
						}).then(drainOrCancel),
					);
				}

				const { link_id: linkId } = redisValue;

				if (linkId && redisValue.is_active && !event.is_bot) {
					const clickEvent = {
						linkSlug: slug,
						occurredAt: Date.now(),
						country: event.country || "Unknown",
						city: event.city ?? undefined,
						deviceType: event.device_type || "desktop",
						browser: event.browser || "Unknown",
						os: event.os || "Unknown",
						referer: event.referer ?? undefined,
					};
					tasks.push(recordClickInConvex(c, linkId, convex, clickEvent));
				}

				if (tasks.length) await Promise.allSettled(tasks);
			} catch (error) {
				log.error("Failed to send analytics (cache miss)", {
					source: "redis",
					error: String(error),
				});
			}
		})(),
	);

	return response;
});

export default app;
