# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

Project overview
- Runtime: Cloudflare Workers (TypeScript)
- Web framework: Hono
- Purpose: URL redirection based on a slug, backed by Upstash Redis, with edge caching via the Cloudflare Cache API.

Commands
- Install dependencies:
  - npm install
- Start local development (wrangler dev):
  - npm run dev
- Deploy to Cloudflare (minified):
  - npm run deploy
- Generate/sync Cloudflare types (keeps CloudflareBindings up to date):
  - npm run cf-typegen

Notes
- Build: There is no separate build script; Wrangler handles building/bundling for dev and deploy.
- Linting: No linter is configured in this repo.
- Tests: No test runner or tests are present. Single-test execution is not applicable.

Architecture and structure
- Entry point: src/index.ts exports a Hono app instance (default export). All request handling is implemented here.
- Bindings and configuration:
  - The worker expects two environment bindings for Upstash Redis: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
  - src/index.ts defines a local Bindings type with these keys and instantiates Hono as Hono<{ Bindings: Bindings }>().
  - Types for the Cloudflare runtime/bindings can be generated into worker-configuration.d.ts (npm run cf-typegen). tsconfig.json includes this file via compilerOptions.types. If you prefer, you can switch the app to Hono<{ Bindings: CloudflareBindings }>() after generating types and aligning your bindings.
  - There is no wrangler.toml committed; configure bindings/secrets in your Cloudflare environment (or via Wrangler) so Redis.fromEnv(c.env) can resolve credentials at runtime.
- Request routing and flow (src/index.ts):
  - Route: GET '/:websiteSlug'
    - Validates slug param and method; returns 404 for missing slug and 405 for non-GET.
    - Caching layer: opens named cache 'redirects'.
      - Cache key derivation: makeCacheKeyFromContext(c) builds a key = <origin><normalized-pathname> (lowercased origin, path without trailing slashes, '/' if empty).
      - On cache hit: the intended behavior is to short-circuit and issue a 301 redirect to the cached URL.
    - Backend lookup: getUrlFromRedis(c) resolves the slug to a URL using Upstash Redis via Redis.fromEnv(c.env).
      - On hit: respond with a 301 redirect.
      - Background cache fill: uses c.executionCtx.waitUntil(...) with caches.put to persist the redirect mapping for subsequent requests.
- Key helpers (src/index.ts):
  - makeCacheKeyFromContext(c: Context): returns a deterministic key used for cache lookups based on request origin + path.
  - checkCacheAndReturnElseSave(c: Context, cache: Cache): checks the cache and, if present, returns an immediate redirect response.
  - getUrlFromRedis(c: Context): resolves the slug to a target URL via Upstash Redis and returns it as a URL object.

Important implementation details for future changes
- Hono typing: If you add or change environment bindings, keep the Hono app generic aligned. You can either continue with the local Bindings type used by src/index.ts, or adopt CloudflareBindings (run npm run cf-typegen and update Hono<{ Bindings: CloudflareBindings }>()).
- Cache behavior: The cache key uses origin + path; changing hostname behavior (e.g., support for multiple domains) will change cache locality. Consider normalization/variation needs before modifying.
- Async background work: Cache writes are intentionally deferred with executionCtx.waitUntil to avoid adding latency to the redirect path.

Caveats in current flow
- The cache short-circuit helper is invoked but its return value is not used. To leverage it, await and return it when present: const cached = await checkCacheAndReturnElseSave(c, cache); if (cached) return cached.
- In the background cache fill, cacheRequest is referenced but not defined in that scope. Construct a Request with the same cache key used earlier before calling cache.put.

Tooling/config
- package.json scripts:
  - dev: wrangler dev
  - deploy: wrangler deploy --minify
  - cf-typegen: wrangler types --env-interface CloudflareBindings
- tsconfig.json highlights:
  - moduleResolution: Bundler, lib: [ESNext, WebWorker]
  - types: ['./worker-configuration.d.ts'] so Cloudflare runtime types and bindings are available
  - jsx: react-jsx with jsxImportSource: 'hono/jsx' (ready for JSX responses if needed)

Repository signals not present
- No wrangler.toml, CI workflows, linter configuration, or tests are included in this folder.
