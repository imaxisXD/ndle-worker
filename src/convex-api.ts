import { type FunctionReference, anyApi } from "convex/server";
import { type GenericId as Id } from "convex/values";

export const api: PublicApiType = anyApi as unknown as PublicApiType;
export const internal: InternalApiType = anyApi as unknown as InternalApiType;

export type PublicApiType = {
  users: {
    store: FunctionReference<"mutation", "public", Record<string, never>, any>;
  };
  urlMainFuction: {
    createUrl: FunctionReference<
      "mutation",
      "public",
      {
        expiresAt?: number;
        slugType: "random" | "human";
        trackingEnabled: boolean;
        url: string;
      },
      { docId: Id<"urls">; slug: string }
    >;
    getUserUrls: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      any
    >;
    getUserUrlsWithAnalytics: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      any
    >;
    deleteUrl: FunctionReference<
      "mutation",
      "public",
      { urlSlug: string },
      any
    >;
  };
  urlAnalytics: {
    mutateUrlAnalytics: FunctionReference<
      "mutation",
      "public",
      {
        sharedSecret: string;
        urlId: string;
        urlStatusCode: number;
        urlStatusMessage: string;
        userId: string;
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
      any
    >;
    getUrlAnalytics: FunctionReference<
      "query",
      "public",
      { urlSlug: string },
      any
    >;
  };
};
export type InternalApiType = {};
