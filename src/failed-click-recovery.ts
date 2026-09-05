import { deliverClick } from "./click-delivery";
import { parseQueuedClick } from "./click-envelope";
import {
	decodeFailedBody,
	failedClickKeys,
	failedClickPrefix,
	readFailedArchive,
} from "./failed-clicks";
import type { Bindings, QueuedClick } from "./types";

export { readFailedArchive } from "./failed-clicks";

export async function replayFailedClick(
	key: string,
	bucket: R2Bucket,
	queue: Queue<QueuedClick>,
) {
	const archive = await readFailedArchive(bucket, key);
	const body = decodeFailedBody(archive.body);
	const { event } = parseQueuedClick(body);
	// Validate with the current parser but send the original envelope, preserving
	// any old version-1 fields and the captured event ID, time and ownership.
	await queue.send(body as QueuedClick, { contentType: "json" });
	return {
		eventId: event.idempotency_key,
		status: "requeued",
		unresolved: true,
	};
}

export async function resolveFailedClick(
	key: string,
	bucket: R2Bucket,
	env: Bindings,
	operator?: string,
) {
	const archive = await readFailedArchive(bucket, key);
	const { event } = parseQueuedClick(decodeFailedBody(archive.body));
	if (!event.tracking_enabled) {
		if (!operator?.trim())
			throw new Error("Record the operator resolving this disabled event");
		return recordResolution(key, bucket, archive, {
			eventId: event.idempotency_key,
			operator: operator.trim(),
			decision: "tracking_disabled",
			deliveryOutcome: "tracking_disabled",
		});
	}
	if (
		!env.INGEST_ENDPOINT ||
		!env.API_SECRET ||
		!env.CONVEX_URL ||
		!env.SHARED_SECRET
	) {
		throw new Error(
			"Set INGEST_ENDPOINT, API_SECRET, CONVEX_URL and SHARED_SECRET to verify delivery",
		);
	}
	if (
		new URL(env.INGEST_ENDPOINT).protocol !== "https:" ||
		new URL(env.CONVEX_URL).protocol !== "https:"
	) {
		throw new Error("Recovery service URLs must use HTTPS");
	}
	const receiptUrl = new URL("/internal/events/receipt", env.INGEST_ENDPOINT);
	receiptUrl.searchParams.set("idempotency_key", event.idempotency_key);
	const response = await fetch(receiptUrl, {
		headers: { Authorization: `Bearer ${env.API_SECRET}` },
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status !== 200)
		throw new Error(
			"Ingest receipt could not be verified; the failure remains unresolved",
		);
	const receipt = await response.json<{
		idempotency_key?: unknown;
		committed?: unknown;
		user_id?: unknown;
		occurred_at?: unknown;
		link_id?: unknown;
	}>();
	if (
		receipt.idempotency_key !== event.idempotency_key ||
		receipt.committed !== true ||
		receipt.user_id !== event.user_id ||
		typeof receipt.occurred_at !== "string" ||
		Date.parse(receipt.occurred_at) !== Date.parse(event.occurred_at) ||
		(receipt.link_id !== null && receipt.link_id !== event.link_id)
	) {
		throw new Error(
			"Ingest has not confirmed this event ID, owner, time and link; the failure remains unresolved",
		);
	}
	// This is an explicit operator action. The same idempotent delivery checks
	// Convex's actual result, including deleted/old links, without trusting notes.
	const outcome = await deliverClick(event, env);
	return recordResolution(key, bucket, archive, {
		eventId: event.idempotency_key,
		ingestReceipt: receipt,
		deliveryOutcome: outcome,
		...(operator ? { operator: operator.trim() } : {}),
	});
}

export async function resolveInvalidFailedClick(
	key: string,
	bucket: R2Bucket,
	decision: { operator: string; reason: string },
) {
	if (
		!decision ||
		typeof decision.operator !== "string" ||
		typeof decision.reason !== "string" ||
		!decision.operator.trim() ||
		decision.reason.trim().length < 20 ||
		decision.reason.length > 4000
	) {
		throw new Error(
			"Record the operator and a clear investigation decision of 20 to 4000 characters",
		);
	}
	const archive = await readFailedArchive(bucket, key);
	let valid = false;
	try {
		parseQueuedClick(decodeFailedBody(archive.body));
		valid = true;
	} catch {
		/* Explicit invalid-message review only. */
	}
	if (valid)
		throw new Error(
			"A valid click requires verified downstream receipts before resolution",
		);
	return recordResolution(key, bucket, archive, {
		decision: "invalid_event_reviewed",
		operator: decision.operator.trim(),
		reason: decision.reason.trim(),
	});
}

async function recordResolution(
	key: string,
	bucket: R2Bucket,
	archive: Awaited<ReturnType<typeof readFailedArchive>>,
	evidence: Record<string, unknown>,
) {
	const keys = failedClickKeys(archive.source.queue, archive.source.messageId);
	const pointer = await bucket.get(keys.unresolved);
	if (!pointer) throw new Error("This failed message has no unresolved marker");
	const marker = await pointer.json<{
		archiveKey?: unknown;
		bodySha256?: unknown;
	}>();
	if (marker.archiveKey !== key || marker.bodySha256 !== archive.bodySha256)
		throw new Error("The unresolved marker does not match this archive");
	const resolutionKey = `${failedClickPrefix}resolved/${archive.source.queue}/${archive.source.messageId}/${crypto.randomUUID()}.json`;
	const record = JSON.stringify({
		version: 1,
		archiveKey: key,
		bodySha256: archive.bodySha256,
		resolvedAt: new Date().toISOString(),
		...evidence,
	});
	await bucket.put(resolutionKey, record, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/json" },
	});
	const saved = await bucket.get(resolutionKey);
	if (!saved || (await saved.text()) !== record)
		throw new Error(
			"Resolution evidence was not stored; the failure remains unresolved",
		);
	await bucket.delete(keys.unresolved);
	if (await bucket.get(keys.unresolved))
		throw new Error("The failure was delivered again and still needs review");
	return { status: "resolved", resolutionKey, archiveKey: key };
}
