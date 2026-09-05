# NDLE redirect worker

The Worker reads the current Redis link record, checks whether it is active and
unexpired, applies A/B and UTM rules, and returns a 302 with browser caching
disabled. Tracked redirects wait until Cloudflare Queues accepts their event.
If Redis, event preparation, or queue acceptance fails, the visitor receives a
retryable 503 instead of a redirect whose click could silently disappear.
Links with tracking disabled skip event collection and the queue.

## Click delivery contract

The producer writes `{ version: 1, event }`. The normalized event has one generated
ID used unchanged as both `request_id` and `idempotency_key`. Caller-supplied
request IDs cannot merge separate visits. The original Cloudflare ray remains in
structured logs. The event's time and first-session flag are captured once, before
queueing, and are reused on retries. Session markers use atomic `SET NX EX` with
a 30-minute lifetime. The flag is a first-observation hint, not an exact count of
people; ingestion should deduplicate session IDs when calculating visitors.

The consumer sends the event to ingest, requires its 202 acknowledgement with
`success: true`, the same `idempotency_key`, and `status: queued` or `ignored`, then
updates the Convex live view with that same event ID. Bot events remain in durable
analytics but do not update human live counts. Ingest must deduplicate IDs across
replay and acknowledge only durable queue acceptance. Convex must deduplicate
click writes and return one of `recorded`, `duplicate`, `link_deleted`,
`tracking_disabled`, or `too_old`. Unknown results are retried. A deleted link
cannot cause endless retries. Old history is retained by ingest even if Convex
rejects it outside its supported live replay window.

Each message is acknowledged only after its required deliveries finish. Failed
messages retry with increasing delay (up to one hour), then move to the configured
failed-events queue after 12 retries. There is no lossy direct-HTTP fallback. The
previous optional `ANALYTICS_ENDPOINT`/Tinybird fanout is removed; ingest is the
durable analytics authority. A new external sink must consume that retained
stream with its own deduplication and retry policy.

The destination decision and existing deterministic A/B assignment are preserved.
The legacy assignment uses an IP-derived key. Changing that to include user agent
or a cookie would move existing visitors between variants, so introduce an
explicit assignment version for new experiments before making that change.

## Provisioning and release order

Use the [coordinated production cutover](../ndle-ingest-service/docs/RECOVERY.md#coordinated-production-cutover) as the authoritative order. Provision and pause queue delivery, deploy and verify this durable producer, finish old in-flight requests, then drain/stop and rebuild ingest. Deploy the verified downstream contracts before resuming delivery. Do not stop the old backend while redirects still use the old direct-HTTP producer.

The guide contains the exact create/update, pause and resume commands, the required post-deploy pause-state check, retention/DLQ limits, and rollback gates. Rehearse on `ndle-click-events-dev` and `ndle-click-events-failed-dev` with separate credentials first. Development `INGEST_ENDPOINT` remains deliberately empty until a verified staging ingest URL is configured; never point it at production. Run the checks below before releasing, then measure queue-acceptance latency and catch-up under real traffic.

## Recovery

Inspect failed messages through the Cloudflare Queues dashboard before replay.
Fix the downstream outage or bad configuration, then publish the original message
body to its matching main queue **without changing its event ID or timestamp**.
Remove a failed message only after the new queue confirms acceptance. Replaying
an already accepted event is safe because ingest and Convex deduplicate the same
ID. For historical events older than Convex's live replay window, replay directly
to ingest's documented recovery path; do not regenerate IDs to force live counts.
Monitor both queues until delivery completes, and verify the downstream count.

Malformed payloads are retained for inspection rather than acknowledged and
forgotten. Changing a payload requires a deliberate repair that keeps the
original event ID; do not silently discard it or rewrite its ownership in this
Worker. Owner changes are resolved by each downstream authority.

## Local work and checks

Use Node.js 22 or newer, pnpm, and Bun. Local secrets go in `.dev.vars`, with only
development credentials. Reuse any existing development server for this repo.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm exec biome check src
pnpm exec wrangler types --env-interface CloudflareBindings --check
pnpm deploy:dry-run
pnpm exec wrangler deploy --env dev --dry-run
```

The checks never deploy. Tests cover queue-acceptance ordering, 503 on enqueue
failure, ignored tracking, atomic session markers, downstream failures, repeated
IDs, terminal Convex outcomes, malformed events, and redirect safety.
