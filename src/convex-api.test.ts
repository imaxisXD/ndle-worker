import { expect, mock, test } from "bun:test";
import { mutateRecordClick, recordClickMutationPath } from "./convex-api";

const baseArgs = {
	sharedSecret: "secret-123",
	urlId: "link-1",
	urlStatusCode: 0,
	urlStatusMessage: "",
	requestId: "req-1",
	clickEvent: {
		linkSlug: "demo",
		occurredAt: 1_700_000_000_000,
		country: "IN",
		city: undefined,
		deviceType: "desktop",
		browser: "Chrome",
		os: "macOS",
		referer: undefined,
	},
};

test("posts convex_encoded_json to /api/mutation, strips undefined, and returns value", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const fetchImpl = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedInit = init;
			return Response.json({
				status: "success",
				value: { outcome: "recorded" },
				logLines: [],
			});
		},
	) as unknown as typeof fetch;

	const result = await mutateRecordClick({
		convexUrl: "https://example.convex.cloud",
		args: baseArgs,
		fetchImpl,
	});

	expect(result).toEqual({ outcome: "recorded" });
	expect(capturedUrl).toBe("https://example.convex.cloud/api/mutation");
	expect(capturedInit?.method).toBe("POST");
	expect(capturedInit?.redirect).toBe("manual");
	expect(JSON.parse(String(capturedInit?.body))).toEqual({
		path: recordClickMutationPath,
		format: "convex_encoded_json",
		args: [
			{
				sharedSecret: "secret-123",
				urlId: "link-1",
				urlStatusCode: 0,
				urlStatusMessage: "",
				requestId: "req-1",
				clickEvent: {
					linkSlug: "demo",
					occurredAt: 1_700_000_000_000,
					country: "IN",
					deviceType: "desktop",
					browser: "Chrome",
					os: "macOS",
				},
			},
		],
	});
});

test("handles HTTP 560 UDF errors and HTTP 200 error payloads", async () => {
	for (const status of [560, 200]) {
		const fetchImpl = mock(async () =>
			Response.json(
				{ status: "error", errorMessage: `UDF error (${status})` },
				{ status },
			),
		) as unknown as typeof fetch;
		await expect(
			mutateRecordClick({
				convexUrl: "https://example.convex.cloud",
				args: baseArgs,
				fetchImpl,
			}),
		).rejects.toThrow(`UDF error (${status})`);
	}
});

test("cancels response body and throws on non-OK HTTP statuses", async () => {
	for (const status of [302, 500, 503]) {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{ status },
		);
		const fetchImpl = mock(async () => response) as unknown as typeof fetch;
		await expect(
			mutateRecordClick({
				convexUrl: "https://example.convex.cloud",
				args: baseArgs,
				fetchImpl,
			}),
		).rejects.toThrow(`Convex mutation failed with status ${status}`);
		expect(cancelled).toBe(true);
	}
});

test("throws on malformed or unknown-status responses", async () => {
	for (const payload of [null, "ok", { status: "mystery" }]) {
		const fetchImpl = mock(async () =>
			Response.json(payload),
		) as unknown as typeof fetch;
		await expect(
			mutateRecordClick({
				convexUrl: "https://example.convex.cloud",
				args: baseArgs,
				fetchImpl,
			}),
		).rejects.toThrow();
	}
});
