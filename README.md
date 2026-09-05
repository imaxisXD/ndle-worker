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

## Operational email alerts

The production scheduled handler checks NDLE every five minutes, separately
from redirects and click delivery. Development has no schedule and alerts are
disabled. Set `RESEND_API_KEY`, `OPS_ALERT_FROM` and `OPS_ALERT_TO` with Wrangler
secrets; use a sending-only key restricted to the verified NDLE sender domain.
`OPS_ALERTS_ENABLED=false` disables checks without changing redirects.

Email is sent when the main queue's oldest reported event is over five minutes
old, its backlog exceeds 10,000 messages or 100 MB, or the failed-click queue
contains any message. Checks also cover ingest readiness and detailed component
health, any failed ingest job, more than 1,000 waiting ingest jobs, monitoring
readiness, and a missing/invalid backup or a latest backup older than 26 hours.
The backup check reads only the latest manifest and the referenced object's
metadata; checksum verification remains the database owner's backup duty.

Each source has its own 12-second deadline. A source failure or timeout becomes
an unavailable alert while the other checks finish. HTTP requests have their
own ten-second timeout and cannot follow redirects. No event bodies, owner data
or credentials are included in email or alert logs.

Healthy checks send no email. A stable issue set, recipient and sender use the
same provider idempotency key within a UTC hour, avoiding duplicate mail on
retries and overlapping runs. Persistent problems remind at most once per hour;
a changed set can send another alert. Resend retains these keys for
[24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys). Provider
rejection fails the scheduled run and is logged; acceptance is not proof that
the recipient read the message. Observe Cron executions and provider delivery
status after deployment. A failure of the alert provider or Cloudflare itself
still requires an independent external check.

Queue age is based on Cloudflare's reported oldest timestamp. A small backlog
without that timestamp cannot establish its age. Ingest's detailed endpoint
does not expose the oldest internal job's age, and monitoring readiness does
not establish per-link delivery freshness; those thresholds are not claimed by
these checks. Existing failed monitoring jobs are retained for separate review.

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
