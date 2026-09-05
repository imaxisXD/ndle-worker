import { Redis } from "@upstash/redis/cloudflare";
import { Hono } from "hono";
import { normalizeAnalyticsEvent } from "./analytics";
import { parseQueuedClick } from "./click-envelope";
import {
	buildAnalyticsInput,
	buildClientRedirectResponse,
	buildNoContentResponse,
	getBooleanEnv,
} from "./helper";
import { createRequestLogger } from "./log";
import { checkOperations } from "./operations";
import { consumeQueue } from "./queue-handler";
import { decideRedirect } from "./redirect-decision";
import type { Bindings, RedisValueObject } from "./types";

export const app = new Hono<{ Bindings: Bindings }>();
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

app.get("/:websiteSlug{[A-Za-z0-9_-]+}", async (c) => {
	const start = Date.now();
	const slug = c.req.param("websiteSlug");
	const requestId = crypto.randomUUID();
	const log = createRequestLogger(c, { slug, request_id: requestId });
	if (c.req.method !== "GET") return c.text("Method not allowed", 405);
	try {
		const redisValue = await Redis.fromEnv(c.env).json.get<RedisValueObject>(
			slug,
		);
		if (!redisValue) return c.notFound();
		const decision = await decideRedirect({
			redisValue,
			readHeader: (name) => c.req.header(name),
		});
		if (decision.kind === "blocked") {
			log.info("Link cannot be opened", { reason: decision.reason });
			return c.notFound();
		}
		const trackingEnabled =
			getBooleanEnv(c.env.TRACKING_ENABLED, true) &&
			redisValue.features?.track_clicks !== false;
		if (trackingEnabled) {
			const event = normalizeAnalyticsEvent(
				await buildAnalyticsInput(
					c,
					decision.destination.toString(),
					slug,
					Date.now() - start,
					redisValue,
					decision.variantId,
					requestId,
				),
			);
			// A tracked redirect means the event has been accepted durably.
			// Do not replace this await with waitUntil or direct HTTP fanout.
			await c.env.CLICK_EVENTS.send(parseQueuedClick({ version: 1, event }), {
				contentType: "json",
			});
		}
		log.info("Redirect ready", {
			status: 302,
			latency_ms: Date.now() - start,
			tracking_enabled: trackingEnabled,
		});
		return buildClientRedirectResponse(decision.destination);
	} catch (error) {
		log.error("Link could not be opened right now", {
			error,
			latency_ms: Date.now() - start,
		});
		return new Response(
			"This link is temporarily unavailable. Please try again.",
			{
				status: 503,
				headers: {
					"Cache-Control": "no-store",
					"Retry-After": "5",
					"Content-Type": "text/plain; charset=utf-8",
				},
			},
		);
	}
});

export default {
	fetch: app.fetch,
	queue: consumeQueue,
	async scheduled(_controller, env) {
		await checkOperations(env);
	},
} satisfies ExportedHandler<Bindings>;
