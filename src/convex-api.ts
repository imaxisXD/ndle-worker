import { makeFunctionReference } from "convex/server";

export const recordClick = makeFunctionReference<
	"mutation",
	{
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
	},
	unknown
>("urlAnalytics:mutateUrlAnalytics");
