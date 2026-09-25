import type { Bindings } from "./types";

type IngestSecrets = Partial<
	Pick<Bindings, "API_SECRET" | "INGEST_WRITE_SECRET" | "OPS_SECRET">
>;

// Each scoped secret falls back to the legacy shared API_SECRET, so a deploy
// without the new secrets keeps working until ingest stops accepting it.

/** Bearer secret for ingest `POST /ingest`. */
export function ingestWriteSecret(env: IngestSecrets): string | undefined {
	return env.INGEST_WRITE_SECRET || env.API_SECRET || undefined;
}

/** Bearer secret for ingest health details and `/internal/*` operator routes. */
export function opsSecret(env: IngestSecrets): string | undefined {
	return env.OPS_SECRET || env.API_SECRET || undefined;
}
