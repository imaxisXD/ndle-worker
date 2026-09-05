# WARP.md

This file guides agents working on the NDLE redirect worker. See `README.md` for
setup, checks, and deployment commands.

## Request flow

- `src/index.ts` defines the Hono routes and reads each short-link record from
  Upstash Redis. Missing records return 404.
- `src/redirect-decision.ts` checks link status and expiry, validates the
  destination, selects any A/B variant, and adds missing UTM parameters. Blocked
  links and invalid destinations return 404 from the route.
- `src/ab-testing.ts` selects variants. Preserve existing deterministic assignment
  keys during cleanup because changing them can move visitors between variants.
- `src/helper.ts` builds the 302 response and click data. Redirect responses use
  `Cache-Control: no-store`; there is no redirect cache.
- Background work uses `c.executionCtx.waitUntil(...)` to send configured analytics
  requests and record eligible human clicks in Convex. `src/convex-api.ts` holds
  the reference to the single Convex mutation used by this service.

## Configuration and validation

`wrangler.jsonc` contains routes and settings for production (default) and
`dev`. `src/types.ts` combines the generated Cloudflare bindings with application
secrets and settings. Keep those declarations aligned when changing configuration.

Use `pnpm test` for the Bun tests, `pnpm typecheck` for TypeScript, and
`pnpm exec biome check src` for lint and formatting checks. `pnpm deploy:dry-run`
bundles without deploying. Only run `pnpm deploy:dev` or `pnpm deploy:prod` when
deployment is requested. Reuse an existing development server instead of starting
a second one.
