import { isRecord } from "./guards";

export const recordClickMutationPath = "urlAnalytics:mutateUrlAnalytics";
const statusCodeUdfFailed = 560;

export type RecordClickArgs = {
	sharedSecret: string;
	urlId: string;
	urlStatusCode: number;
	urlStatusMessage: string;
	requestId: string;
	clickEvent?: {
		linkSlug: string;
		occurredAt: number;
		country: string;
		city?: string;
		deviceType: string;
		browser: string;
		os: string;
		referer?: string;
	};
};

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined) continue;
		out[key] = isRecord(value) ? stripUndefined(value) : value;
	}
	return out;
}

/**
 * Invoke the Convex `urlAnalytics:mutateUrlAnalytics` mutation directly over HTTP
 * without instantiating a heavyweight client per click.
 */
export async function mutateRecordClick(params: {
	convexUrl: string;
	args: RecordClickArgs;
	fetchImpl?: typeof fetch;
}): Promise<unknown> {
	const doFetch = params.fetchImpl ?? fetch;
	const response = await doFetch(new URL("/api/mutation", params.convexUrl), {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			path: recordClickMutationPath,
			format: "convex_encoded_json",
			args: [stripUndefined(params.args)],
		}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok && response.status !== statusCodeUdfFailed) {
		await response.body?.cancel();
		throw new Error(`Convex mutation failed with status ${response.status}`);
	}
	const body: unknown = await response.json();
	if (!isRecord(body)) {
		throw new Error("Convex mutation returned an invalid response");
	}
	if (body.status === "success") {
		return body.value;
	}
	if (body.status === "error") {
		throw new Error(
			typeof body.errorMessage === "string" && body.errorMessage
				? body.errorMessage
				: "Convex mutation failed",
		);
	}
	throw new Error("Convex mutation returned an unknown status");
}
