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
  };
  urlAnalytics: {
    mutateClickCount: FunctionReference<
      "mutation",
      "public",
      { sharedSecret: string; urlId: string; userId: string },
      any
    >;
  };
};
export type InternalApiType = {};
