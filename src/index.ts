import { type Context, Hono } from "hono";
import { normalizeAnalyticsEvent } from "./analytics";
import { parseQueuedClick } from "./click-envelope";
import {
	buildAnalyticsInput,
	buildClientRedirectResponse,
	buildNoContentResponse,
	getBooleanEnv,
} from "./helper";
import { checkLinkDomain } from "./link-domain";
import { createRequestLogger } from "./log";
import { checkOperations } from "./operations";
import { consumeQueue } from "./queue-handler";
import { decideRedirect } from "./redirect-decision";
import { linkStore, sendClick, spoolClick } from "./redirect-tracking";
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
		const redisValue = await linkStore(c.env).json.get<RedisValueObject>(slug);
		if (!redisValue) return c.notFound();
		const domainDecision = checkLinkDomain({
			host: new URL(c.req.url).hostname,
			domain: redisValue.domain,
			shortLinkHosts: c.env.SHORT_LINK_HOSTS,
		});
		if (domainDecision === "denied") {
			// Indistinguishable from a missing link, and never tracked.
			log.info("Link cannot be opened", {
				reason: "link is not served on this domain",
			});
			return c.notFound();
		}
		if (domainDecision === "legacy") {
			log.info("Link record has no domain binding yet", {
				reason: "legacy_domain_projection",
			});
		}
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
		// Analytics never decides whether a visitor reaches the destination.
		// Normally the queue accepts the click before the redirect is sent; if
		// it cannot within a short wait, the click is kept after the response.
		let clickQueued: boolean | null = null;
		if (trackingEnabled) {
			try {
				const click = parseQueuedClick({
					version: 1,
					event: normalizeAnalyticsEvent(
						await buildAnalyticsInput(
							c,
							decision.destination.toString(),
							slug,
							Date.now() - start,
							redisValue,
							decision.variantId,
							requestId,
						),
					),
				});
				clickQueued = await sendClick(c.env.CLICK_EVENTS, click);
				if (!clickQueued) runAfterResponse(c, spoolClick(c.env, click, log));
			} catch (error) {
				// A link record that cannot produce a valid event still redirects.
				clickQueued = false;
				log.error("Click could not be recorded for this redirect", { error });
			}
		}
		log.info("Redirect ready", {
			status: 302,
			latency_ms: Date.now() - start,
			tracking_enabled: trackingEnabled,
			click_queued: clickQueued,
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

function runAfterResponse(
	c: Context<{ Bindings: Bindings }>,
	work: Promise<void>,
) {
	try {
		c.executionCtx.waitUntil(work);
	} catch {
		// Local test requests have no execution context.
		void work;
	}
}

export default {
	fetch: app.fetch,
	queue: consumeQueue,
	async scheduled(_controller, env) {
		await checkOperations(env);
	},
} satisfies ExportedHandler<Bindings>;
