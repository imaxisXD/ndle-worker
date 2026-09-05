import { expect, spyOn, test } from "bun:test";
import { Redis } from "@upstash/redis/cloudflare";
import app from "./index";

for (const destination of [
	"not a URL",
	"javascript:alert(1)",
	"http://127.0.0.1",
]) {
	test(`returns 404 for an invalid stored destination: ${destination}`, async () => {
		const redisLookup = spyOn(Redis, "fromEnv").mockReturnValue({
			json: { get: async () => ({ destination, is_active: true }) },
		} as unknown as Redis);

		try {
			const response = await app.request(
				"https://ndle.test/example",
				{},
				{
					CONVEX_URL: "https://example.convex.cloud",
				},
			);

			expect(response.status).toBe(404);
			expect(response.headers.get("Location")).toBeNull();
		} finally {
			redisLookup.mockRestore();
		}
	});
}
