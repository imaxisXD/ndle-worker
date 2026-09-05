import { parseQueuedClick } from "./click-envelope";
import { createLogger } from "./log";
import type { Bindings } from "./types";

export const failedClickPrefix = "failed-clicks/v1/";
export const unresolvedClickPrefix = `${failedClickPrefix}unresolved/`;

type StoredBody =
	| { encoding: "json"; data: string }
	| { encoding: "bytes"; data: string }
	| { encoding: "undefined"; data: "" };

export type FailedClickArchive = {
	version: 1;
	source: {
		queue: string;
		messageId: string;
		sentAt: string;
		attempts: number;
	};
	archivedAt: string;
	reason: "delivery_failed" | "invalid_event";
	eventId: string | null;
	body: StoredBody;
	bodySha256: string;
};

export function failedClickKeys(queue: string, messageId: string) {
	if (
		typeof queue !== "string" ||
		typeof messageId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(queue) ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(messageId)
	) {
		throw new Error("Failed click has an invalid queue or message ID");
	}
	const name = `${queue}/${messageId}.json`;
	return {
		archive: `${failedClickPrefix}archive/${name}`,
		unresolved: `${unresolvedClickPrefix}${name}`,
	};
}

// Queue producers use JSON. Retain any malformed JSON, plus text/byte messages
// from manual API sends. Refuse lossy conversion of unsupported structured data.
function encodeBody(value: unknown): StoredBody {
	if (value === undefined) return { encoding: "undefined", data: "" };
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return { encoding: "bytes", data: btoa(binary) };
	}
	const data = JSON.stringify(value, function (key, item) {
		const original = this[key];
		if (
			original === undefined ||
			typeof original === "bigint" ||
			typeof original === "function" ||
			typeof original === "symbol" ||
			(typeof original === "number" &&
				(!Number.isFinite(original) || Object.is(original, -0))) ||
			(original !== null &&
				typeof original === "object" &&
				!Array.isArray(original) &&
				Object.getPrototypeOf(original) !== Object.prototype)
		)
			throw new Error(
				"Failed click cannot be archived without changing its body",
			);
		return item;
	});
	return { encoding: "json", data };
}

export function decodeFailedBody(body: StoredBody): unknown {
	if (body.encoding === "json") return JSON.parse(body.data);
	if (body.encoding === "undefined") return undefined;
	if (body.encoding === "bytes")
		return Uint8Array.from(atob(body.data), (character) =>
			character.charCodeAt(0),
		).buffer;
	throw new Error("Failed click has an unknown body encoding");
}

export async function bodyHash(body: StoredBody): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(body)),
	);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function readFailedArchive(
	bucket: R2Bucket,
	key: string,
): Promise<FailedClickArchive> {
	const object = await bucket.get(key);
	if (!object || object.size > 1_048_576)
		throw new Error("Failed click archive is missing or too large");
	const archive = await object.json<FailedClickArchive>();
	if (
		archive.version !== 1 ||
		!archive.source ||
		!archive.body ||
		typeof archive.body.data !== "string" ||
		archive.bodySha256 !== (await bodyHash(archive.body))
	) {
		throw new Error("Failed click archive failed its integrity check");
	}
	if (
		failedClickKeys(archive.source.queue, archive.source.messageId).archive !==
		key
	)
		throw new Error("Failed click archive does not match its source");
	return archive;
}

export async function archiveFailedClick(
	message: Message<unknown>,
	queue: string,
	bucket: R2Bucket,
	reason: FailedClickArchive["reason"],
): Promise<string> {
	const keys = failedClickKeys(queue, message.id);
	const body = encodeBody(message.body);
	const bodySha256 = await bodyHash(body);
	let eventId: string | null = null;
	try {
		eventId = parseQueuedClick(message.body).event.idempotency_key;
	} catch {
		/* Malformed bodies still need preservation. */
	}
	const archive: FailedClickArchive = {
		version: 1,
		source: {
			queue,
			messageId: message.id,
			sentAt: message.timestamp.toISOString(),
			attempts: message.attempts,
		},
		archivedAt: new Date().toISOString(),
		reason,
		eventId,
		body,
		bodySha256,
	};
	await bucket.put(keys.archive, JSON.stringify(archive), {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/json" },
	});
	// A repeated queue delivery has a new attempt count. Only stable identity and
	// body participate in equality; never overwrite the first archived metadata.
	const stored = await readFailedArchive(bucket, keys.archive);
	if (
		stored.bodySha256 !== bodySha256 ||
		stored.source.sentAt !== archive.source.sentAt
	) {
		throw new Error("Failed click ID already has a different archived message");
	}
	const pointer = JSON.stringify({
		version: 1,
		archiveKey: keys.archive,
		bodySha256,
	});
	await bucket.put(keys.unresolved, pointer, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/json" },
	});
	const unresolved = await bucket.get(keys.unresolved);
	if (!unresolved || (await unresolved.text()) !== pointer)
		throw new Error("Failed click investigation marker was not verified");
	// A late delivery after manual resolution recreates this marker. This is
	// deliberately conservative: resolved receipts never suppress a new warning.
	return keys.archive;
}

export async function consumeFailedClicks(
	batch: MessageBatch<unknown>,
	env: Bindings,
): Promise<void> {
	const log = createLogger(env.LOG_LEVEL, {
		component: "failed_click_archive",
		queue: batch.queue,
	});
	await Promise.all(
		batch.messages.map(async (message) => {
			try {
				const key = await archiveFailedClick(
					message,
					batch.queue,
					env.FAILED_CLICK_ARCHIVES,
					"delivery_failed",
				);
				message.ack();
				log.error("Failed click archived; investigation is required", {
					message_id: message.id,
					archive_key: key,
				});
			} catch (error) {
				log.error("Failed click archive will be retried", {
					message_id: message.id,
					error,
				});
				// With 100 configured retries, the retry limit cannot exhaust before the
				// queue's 14-day retention period. Long R2 outages still require response.
				message.retry({
					delaySeconds: Math.min(
						43_200,
						60 * 2 ** Math.min(message.attempts, 10),
					),
				});
			}
		}),
	);
}
