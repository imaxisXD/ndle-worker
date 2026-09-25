import { expect, test } from "bun:test";
import { ingestWriteSecret, opsSecret } from "./ingest-auth";

test("scoped ingest secrets are preferred over API_SECRET", () => {
	const env = {
		API_SECRET: "shared",
		INGEST_WRITE_SECRET: "write",
		OPS_SECRET: "ops",
	};
	expect(ingestWriteSecret(env)).toBe("write");
	expect(opsSecret(env)).toBe("ops");
});

test("an unset or empty scoped secret falls back to API_SECRET", () => {
	expect(ingestWriteSecret({ API_SECRET: "shared", OPS_SECRET: "ops" })).toBe(
		"shared",
	);
	expect(
		opsSecret({ API_SECRET: "shared", INGEST_WRITE_SECRET: "write" }),
	).toBe("shared");
	expect(
		ingestWriteSecret({ API_SECRET: "shared", INGEST_WRITE_SECRET: "" }),
	).toBe("shared");
	expect(opsSecret({ API_SECRET: "shared", OPS_SECRET: "" })).toBe("shared");
});

test("one scope's secret never authorizes the other scope", () => {
	expect(ingestWriteSecret({ OPS_SECRET: "ops" })).toBeUndefined();
	expect(opsSecret({ INGEST_WRITE_SECRET: "write" })).toBeUndefined();
	expect(ingestWriteSecret({ API_SECRET: "" })).toBeUndefined();
	expect(opsSecret({})).toBeUndefined();
});
