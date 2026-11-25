import { type Issue, issuePlaybooks } from "../alert-email";
import type { RequestLogger } from "../log";
import { type OperationsBindings, record, withDeadline } from "./probes";

/** Remembers the problems last emailed so a later all-clear can name them. */
const alertStateKey = "operations/alert-state.json";

export type AlertState = {
	version: 1;
	issues: Issue[];
	firstSeen: Partial<Record<Issue, number>>;
	alertedAt?: number;
};

/** Resolves null when no usable state exists; rejects when R2 can't be read. */
export async function readAlertState(env: OperationsBindings): Promise<AlertState | null> {
	const object = await env.ANALYTICS_BACKUPS.get(alertStateKey);
	if (!object || object.size > 16_384) return null;
	try {
		const value = record(await object.json());
		if (
			value.version !== 1 ||
			!Array.isArray(value.issues) ||
			!value.issues.every((issue) => typeof issue === "string" && issue in issuePlaybooks)
		)
			return null;
		const firstSeen = record(value.firstSeen ?? {});
		return {
			version: 1,
			issues: value.issues as Issue[],
			firstSeen: Object.fromEntries(
				Object.entries(firstSeen).filter(
					([issue, time]) => issue in issuePlaybooks && Number.isFinite(time),
				),
			) as AlertState["firstSeen"],
			alertedAt: typeof value.alertedAt === "number" ? value.alertedAt : undefined,
		};
	} catch {
		return null;
	}
}

export function sameFirstSeen(
	previous: AlertState | null,
	firstSeen: AlertState["firstSeen"],
): boolean {
	const before = Object.entries(previous?.firstSeen ?? {});
	return (
		before.length === Object.keys(firstSeen).length &&
		before.every(([issue, time]) => firstSeen[issue as Issue] === time)
	);
}

/**
 * Keep previously recorded `firstSeen` timestamps for any emailed issue still
 * carried in `waiting.issues`, so a subsequent all-clear keeps its duration.
 */
export function preserveWaitingFirstSeen(
	previous: AlertState | null,
	currentFirstSeen: AlertState["firstSeen"],
): AlertState["firstSeen"] {
	if (!previous?.issues.length) return currentFirstSeen;
	const merged: AlertState["firstSeen"] = { ...currentFirstSeen };
	for (const issue of previous.issues) {
		const seen = previous.firstSeen[issue];
		if (seen !== undefined && merged[issue] === undefined) {
			merged[issue] = seen;
		}
	}
	return merged;
}

export async function writeAlertState(
	env: OperationsBindings,
	state: AlertState | null,
	log: RequestLogger,
): Promise<void> {
	try {
		await withDeadline(
			async () =>
				state
					? await env.ANALYTICS_BACKUPS.put(alertStateKey, JSON.stringify(state), {
							httpMetadata: { contentType: "application/json" },
						})
					: await env.ANALYTICS_BACKUPS.delete(alertStateKey),
			10_000,
		);
	} catch (error) {
		// Emails still go out; only the all-clear summary may be missed.
		log.warn("NDLE alert state could not be saved", {
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}
