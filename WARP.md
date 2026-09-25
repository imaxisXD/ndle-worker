# WARP.md

This file guides agents working on the NDLE redirect worker. See `README.md` for
setup, checks, and deployment commands.

## Request flow

- `src/index.ts` defines the Hono routes and reads each short-link record from
  Upstash Redis. Missing records return 404, as do records that
  `src/link-domain.ts` does not allow on the request's custom domain.
- `src/redirect-decision.ts` checks link status and expiry, validates the
  destination, selects any A/B variant, and adds missing UTM parameters. Blocked
  links and invalid destinations return 404 from the route.
- `src/ab-testing.ts` selects variants. Preserve existing deterministic assignment
  keys during cleanup because changing them can move visitors between variants.
- `src/helper.ts` builds the 302 response and click data. Redirect responses use
  `Cache-Control: no-store`; there is no redirect cache.
- Tracked redirects queue a click event through `src/redirect-tracking.ts`, which
  never blocks the redirect on analytics: a slow or failed queue send is retried
  and then archived for replay after the response. Only a failed link lookup
  answers 503. `src/click-delivery.ts` sends each queue
  batch to ingest's batch route (falling back to per-event `/ingest` on a 404),
  then records eligible human clicks in Convex. `src/convex-api.ts` holds the
  reference to the single Convex mutation used by this service.

## Configuration and validation

`wrangler.jsonc` contains routes and settings for production (default) and
`dev`. `src/types.ts` combines the generated Cloudflare bindings with application
secrets and settings. Keep those declarations aligned when changing configuration.

Use `pnpm test` for the Bun tests, `pnpm typecheck` for TypeScript, and
`pnpm exec biome check src` for lint and formatting checks. `pnpm deploy:dry-run`
bundles without deploying. Only run `pnpm deploy:dev` or `pnpm deploy:prod` when
deployment is requested. Reuse an existing development server instead of starting
a second one.
