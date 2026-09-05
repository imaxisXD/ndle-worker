# NDLE redirect worker

Cloudflare Worker for NDLE short links. Hono routes each slug to a Redis record,
checks whether the link can be used, applies A/B and UTM rules, and returns a 302
redirect with browser caching disabled. Click analytics runs after the response
through `waitUntil`.

## Local development

Use Node.js 22 or newer, pnpm, and Bun (for tests).

```sh
pnpm install
pnpm dev
```

`pnpm dev` selects the development environment in `wrangler.jsonc`. Configure
local secrets in `.dev.vars`; required runtime bindings are listed in
`src/types.ts`. Redis supplies link records, Convex receives click updates, and
configured analytics endpoints receive click events. Use development credentials
when running the worker locally. Reuse an existing dev server for this repository.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm exec biome check src
pnpm deploy:dry-run
```

Tests use local inputs and mocked Redis calls. The dry run bundles the production
configuration without deploying it. Biome configuration lives in `biome.json`.

## Deployment

```sh
pnpm deploy:dev
pnpm deploy:prod
```

Production is the default Wrangler environment; development uses `--env dev`.
Routes and public settings live in `wrangler.jsonc`; secrets are configured per
environment. `pnpm cf-typegen` regenerates `worker-configuration.d.ts` after binding
changes.
