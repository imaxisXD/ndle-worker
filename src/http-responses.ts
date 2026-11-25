/** Build a 302 redirect response with browser caching disabled. */
export function buildClientRedirectResponse(location: URL): Response {
	return new Response("", {
		status: 302,
		headers: new Headers({
			Location: location.toString(),
			"Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
			Pragma: "no-cache",
			Expires: "0",
			"Content-Type": "text/plain; charset=utf-8",
			// Ask for UA-CH on later requests only. Critical-CH made Chromium repeat
			// the first navigation to get these hints, which counted a click twice.
			"Accept-CH":
				"Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile, Sec-CH-UA-Full-Version-List",
		}),
	});
}

/** Build an immutable no-content response for browser asset probes. */
export function buildNoContentResponse(
	status = 204,
	cacheSeconds = 31536000,
): Response {
	return new Response(null, {
		status,
		headers: { "Cache-Control": `public, max-age=${cacheSeconds}, immutable` },
	});
}

/** Build a 503 response when the Redis link lookup is temporarily unavailable. */
export function buildUnavailableResponse(): Response {
	return new Response(
		"This link is temporarily unavailable. Please try again.",
		{
			status: 503,
			headers: {
				"Cache-Control": "no-store",
				"Retry-After": "5",
				"Content-Type": "text/plain; charset=utf-8",
			},
		},
	);
}
