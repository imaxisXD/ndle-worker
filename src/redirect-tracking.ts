import { Redis } from "@upstash/redis/cloudflare";
import { archiveFailedClick } from "./failed-clicks";
import type { RequestLogger } from "./log";
import type { Bindings, QueuedClick } from "./types";

type CachedRedis = { url: string; token: string; client: Redis };

let cachedLinkStore: CachedRedis | undefined;
let cachedSessionStore: CachedRedis | undefined;

const linkStoreOptions: Parameters<typeof Redis.fromEnv>[1] = {
	retry: { retries: 1, backoff: () => 50 },
	signal: () => AbortSignal.timeout(3_000),
};

const sessionStoreOptions: Parameters<typeof Redis.fromEnv>[1] = {
	retry: false,
	signal: () => AbortSignal.timeout(300),
};

function getMemoizedRedis(
	env: Bindings,
	cached: CachedRedis | undefined,
	setCached: (entry: CachedRedis) => void,
	options: Parameters<typeof Redis.fromEnv>[1],
): Redis {
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) {
		if (cached && cached.url === url && cached.token === token) {
			return cached.client;
		}
		const client = Redis.fromEnv(env, options);
		setCached({ url, token, client });
		return client;
	}
	return Redis.fromEnv(env, options);
}

// Visitors wait on the link lookup, so bound it instead of the client's
// default retries without a timeout. A first request from a new isolate can
// need well over a second to open its connection, so allow 3 s per attempt;
// a 1 s limit turned some of those into 503s.
export function linkStore(env: Bindings): Redis {
	return getMemoizedRedis(
		env,
		cachedLinkStore,
		(entry) => {
			cachedLinkStore = entry;
		},
		linkStoreOptions,
	);
}

// The first-click-of-session marker is analytics detail only.
export function sessionStore(env: Bindings): Redis {
	return getMemoizedRedis(
		env,
		cachedSessionStore,
		(entry) => {
			cachedSessionStore = entry;
		},
		sessionStoreOptions,
	);
}

/**
 * Atomically claim the first-click-of-session marker with a 30-minute TTL.
 * Analytics detail only: an unavailable store records false instead of failing.
 */
export async function claimFirstClickOfSession(
	env: Bindings,
	sessionId: string,
	slug: string,
	requestId: string,
): Promise<boolean> {
	try {
		return (
			(await sessionStore(env).set(`session:${sessionId}:${slug}`, requestId, {
				nx: true,
				ex: 1800,
			})) === "OK"
		);
	} catch {
		return false;
	}
}

const clickQueueWaitMs = 1_500;
const spoolRetryDelaysMs = [250, 1_000];

/** Resolves true once the queue accepted the click, false on error or timeout. */
export async function sendClick(
	queue: Queue<QueuedClick>,
	click: QueuedClick,
	waitMs = clickQueueWaitMs,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			queue.send(click, { contentType: "json" }).then(
				() => true,
				() => false,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), waitMs);
			}),
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Keeps a click the queue did not accept in time, after the visitor has been
 * redirected. A late original send and a retry share one event ID, so ingest
 * and Convex count it once. If the queue stays unavailable the click is kept
 * as an unresolved failed-click archive, which alerts and can be replayed.
 */
export async function spoolClick(
	env: Bindings,
	click: QueuedClick,
	log: RequestLogger,
): Promise<void> {
	for (const delay of spoolRetryDelaysMs) {
		await new Promise((resolve) => setTimeout(resolve, delay));
		if (await sendClick(env.CLICK_EVENTS, click)) {
			log.info("Delayed click accepted by the queue", {
				request_id: click.event.idempotency_key,
			});
			return;
		}
	}
	try {
		await archiveFailedClick(
			{
				id: `spool-${click.event.idempotency_key}`,
				timestamp: new Date(),
				attempts: 0,
				body: click,
			} as unknown as Message<unknown>,
			env.CLICK_EVENTS_QUEUE_NAME || "ndle-click-events",
			env.FAILED_CLICK_ARCHIVES,
			"delivery_failed",
		);
		log.error("Click queue unavailable; click archived for replay", {
			request_id: click.event.idempotency_key,
		});
	} catch (error) {
		log.error("Click could not be queued or archived", {
			request_id: click.event.idempotency_key,
			error,
		});
	}
}
