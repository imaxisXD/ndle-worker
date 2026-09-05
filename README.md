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
`success: true`, the same `idempotency_key`, and `status: queued` for tracked events, then
updates the Convex live view with that same event ID. Bot events remain in durable
analytics but do not update human live counts. Ingest must deduplicate IDs across
replay and acknowledge only durable queue acceptance. Convex must deduplicate
click writes and return one of `recorded`, `duplicate`, `link_deleted`,
`tracking_disabled`, or `too_old`. Unknown results are retried. A deleted link
cannot cause endless retries. Old history is retained by ingest even if Convex
rejects it outside its supported live replay window.

Each message is acknowledged only after its required deliveries finish. Failed
messages retry with increasing delay (up to one hour), then move to the configured
failed-events queue after 12 retries. Its separate consumer archives messages in
R2 before acknowledging them. There is no lossy direct-HTTP fallback. The
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

The failed queue is consumed separately from normal click delivery. Each message
is saved in the existing `ndle-analytics` R2 bucket through the
`FAILED_CLICK_ARCHIVES` binding. Development uses `ndle-analytics-dev`.

For an original queue name `QUEUE` and Cloudflare message ID `MESSAGE`, storage is:

- `failed-clicks/v1/archive/QUEUE/MESSAGE.json`: immutable message body, its SHA-256
  hash, event ID when valid, source queue/message ID/time, first observed attempt
  count, and archive time. JSON stores the exact decoded message, including extra
  version-1 fields; text and binary bodies are retained too. Unsupported structured
  values are never silently converted or acknowledged.
- `failed-clicks/v1/unresolved/QUEUE/MESSAGE.json`: the investigation marker.
- `failed-clicks/v1/resolved/QUEUE/MESSAGE/UUID.json`: retained resolution evidence.

Both the archive and marker must be read back and verified before acknowledgement.
A crash between writes or before acknowledgement is safe to retry: the body and
source stay unchanged even though the delivery attempt count increases. Malformed
JSON events in the main queue go directly to this archive without repeated HTTP
delivery attempts. An unknown queue fails the invocation instead of acknowledging
its messages. These keys are private operational records, not user export files;
do not add them to the archive file-access grants or an R2 expiry rule.

Before deploying this consumer, verify the ingest receipt endpoint and existing
delivery contract, then set **both queues' retention to 14 days** and read back the
settings. Rehearse with the equivalent `-dev` queue names first:

```sh
pnpm exec wrangler queues update ndle-click-events --message-retention-period-secs 1209600
pnpm exec wrangler queues update ndle-click-events-failed --message-retention-period-secs 1209600
```

The failed consumer permits 100 retries. Storage failures back off from two minutes
to twelve hours; an unexpected invocation failure defaults to twelve hours. This
keeps the retry count from exhausting before the retention period. A Cloudflare or
R2 outage lasting past queue retention can still lose an unarchived message; alerts
and intervention before that deadline remain necessary. See Cloudflare's
[retry rules](https://developers.cloudflare.com/queues/configuration/batching-retries/)
and [retention configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/).

Use the operator tool with a token permitted to read/write this R2 bucket and read
and write Queues. Supply credentials through environment variables, never command
arguments. It uses the same R2 object HTTP operations as the installed Wrangler
CLI; an OAuth login without R2 object access is insufficient. Set
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `FAILED_CLICK_BUCKET`,
`CLICK_EVENTS_QUEUE_NAME`, and `CLICK_EVENTS_FAILED_QUEUE_NAME` for one environment.
Replay additionally requires `CLICK_EVENTS_QUEUE_ID`; the tool verifies its name.
Resolve records `RECOVERY_OPERATOR`; tracked events also require `INGEST_ENDPOINT`,
`API_SECRET`, `CONVEX_URL`, and `SHARED_SECRET`.

```sh
# Substitute the exact source queue and original Cloudflare message ID from logs
# or an unresolved R2 marker. This read-only command prints metadata, not the body.
node scripts/failed-clicks.mjs inspect QUEUE MESSAGE
# Optional fourth argument writes the private archive to a new 0600 local file.
node scripts/failed-clicks.mjs inspect QUEUE MESSAGE /private/path/archive.json

# After fixing the outage, republish the unchanged envelope to the matching main queue.
node scripts/failed-clicks.mjs replay QUEUE MESSAGE

# After delivery finishes, verify its actual durable receipt and Convex outcome.
node scripts/failed-clicks.mjs resolve QUEUE MESSAGE
```

Replay does **not** clear the investigation marker. It preserves the original ID,
timestamp, owner and envelope, so repeated replay does not create new clicks.
Resolve requires ingest's authenticated `/internal/events/receipt` to confirm the
same committed ID, owner and timestamp, plus link ID while that raw row is retained.
Legacy timestamp precision differences remain unresolved for manual investigation.
It then repeats the idempotent delivery to validate the actual Convex terminal
outcome. A missing receipt, payload conflict, redirect, failed request or unknown
outcome leaves the marker in place. Events outside Convex's live window may resolve
with `too_old`; do not generate IDs to force old history into live counts.
For an immutable valid event with `tracking_enabled=false`, explicit resolve
records the operator and `tracking_disabled` decision without sending that event
to ingest or Convex. Its archive is still preserved.

Only after verified resolution evidence is stored does the tool remove that exact
marker. The original archive and resolution evidence remain. A late queue delivery
can conservatively recreate the marker and renew an alert; inspect and resolve it
again. It cannot overwrite the archived body or clear a newer failure. Source ID
and body hash are checked before removing a marker.

Malformed events cannot be blindly replayed or automatically resolved. After
investigation, an operator may use `resolve-invalid QUEUE MESSAGE DECISION.json`,
where the private JSON file contains `operator` and a clear `reason` (20–4000
characters). This records the decision without changing or deleting the source.
A valid event is refused by that path and requires the receipt checks above.
Any deliberate repair requires a separate review; this tool never invents a
corrected payload or changes ownership.

## Operational email alerts

The production scheduled handler checks NDLE every five minutes, separately
from redirects and click delivery. Development has no schedule and alerts are
disabled. Set `RESEND_API_KEY`, `OPS_ALERT_FROM` and `OPS_ALERT_TO` with Wrangler
secrets; use a sending-only key restricted to the verified NDLE sender domain.
`OPS_ALERTS_ENABLED=false` disables checks without changing redirects.

Email is sent when the main queue's oldest reported event is over five minutes
old, its backlog exceeds 10,000 messages or 100 MB, or the failed-click queue
contains any message. A bounded R2 listing also alerts while any archived failed
message is unresolved, even after the failed queue empties; an unreadable archive
raises its own alert. Checks also cover ingest readiness and detailed component
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
pnpm test:runtime
pnpm typecheck
pnpm exec biome check src
pnpm exec wrangler types --env-interface CloudflareBindings --check
pnpm deploy:dry-run
pnpm exec wrangler deploy --env dev --dry-run
```

The checks never deploy. Tests cover queue-acceptance ordering, 503 on enqueue
failure, ignored tracking, atomic session markers, downstream failures, repeated
IDs, terminal Convex outcomes, malformed events, and redirect safety. CI also runs
the actual workerd runtime with isolated R2 and intercepted HTTP: archive/write
failures, crash recovery, verified acknowledgement, exact v1 replay, downstream
deduplication, receipt mismatches, retained resolution evidence, late redelivery,
and archived-failure alerts. The runtime is stopped in `finally`; tests never
contact production services or send real email.
