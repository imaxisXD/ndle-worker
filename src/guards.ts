export type HeaderReader = (name: string) => string | undefined;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readClientIp(readHeader: HeaderReader): string {
	return readHeader("cf-connecting-ip") ?? readHeader("x-forwarded-for") ?? "";
}

/** Normalize common boolean env var strings to boolean with a default. */
export function getBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	const normalized = value.trim().toLowerCase();
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
	return true;
}
