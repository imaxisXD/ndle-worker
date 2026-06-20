import type { RedisValueObject } from "./types";

type RedirectBlockReason =
	| "missing destination"
	| "link is turned off"
	| "link has expired";

function getRedirectBlockReason(
	redisValue: RedisValueObject | null | undefined,
	now = Date.now(),
): RedirectBlockReason | undefined {
	if (!redisValue?.destination) {
		return "missing destination";
	}
	if (redisValue.is_active === false) {
		return "link is turned off";
	}
	if (
		typeof redisValue.expires_at === "number" &&
		redisValue.expires_at <= now
	) {
		return "link has expired";
	}
}

export { getRedirectBlockReason };
export type { RedirectBlockReason };
