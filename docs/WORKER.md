# Durable worker runbook (layer 04)

The separate Node process executes only explicitly admitted registered controlled sites.
`POST /api/v1/runs` still admits scoped website requests, but a worker terminates
them as `blocked` with `blocked_unsupported`, without allocating a browser.
Release gate #8 remains open. There is no public-URL fallback or target-validation
exception. Layer 04b (#11) adds custom structural and evidence-grounded semantic
criteria for the store and project board before the layer 05 wall. Natural-language
evaluation is a recorded heuristic, not a deterministic outcome oracle.

## Clean startup

Use Node 22.18+ (22.x), `npm ci`, and `npm run build`. Provision `.env.local`
privately (mode 600), or supply environment variables through the process manager.
The app and every worker must share one **persistent local** `DATA_DIR` volume on
one host. SQLite WAL, foreign keys, `synchronous=FULL`, five-second busy timeout
and transactional migrations apply to every connection. Do not use NFS,
ephemeral/serverless volumes or independent copies of this database. Keep the
directory 700 and files 600; use SQLite-aware backups or stop all processes first.

```sh
# Shared server-only configuration (supply secrets privately, not in shell history):
# DATA_DIR=/private/persistent/flash-flood
# BROWSERBASE_API_KEY=...
# FLASH_FLOOD_ACCESS_CODE=... (random, >=32 characters)
# ENABLE_DEMO_RUNS=true
# APP_ORIGIN=https://your-authorized-app.example
# FIXTURE_PORT=4321
npm run start -- --port 4321
# Separate terminal/process; explicitly enables spending for admitted demo jobs:
npm run worker -- --confirm-paid
```

For local API development use `npm run dev` on port 3000,
`APP_ORIGIN=http://127.0.0.1:3000`, and `FIXTURE_PORT=3000`; still set a strong
access code before enabling demo admission. The production command requires the
documented HTTPS reverse proxy preserving Host and Origin. The worker talks only
to the configured literal loopback fixture port; do not point it at untrusted
content. Run a second identical worker command to share the durable queue.
No cloud call runs in a Next request handler. Enabling demo admission can spend
credits once an explicitly confirmed worker is running.

Bootstrap an owner, then submit `/api/v1/demo-runs` as documented in API.md.
The twelve predefined personas and owned custom profiles share immutable
goal/criteria snapshots. The legacy demo route accepts only `fixed` and `second-coupon` scenarios and the
two listed deterministic criteria. The separate `/api/v1/controlled-runs` route
accepts registered sites and custom criteria; see the canonical examples in
[API.md](API.md). Other fixture flags and loopback transport ports are not
caller-controlled.

## Durable policy and spending

The first worker stores its validated policy in SQLite. Other workers must match
it exactly or fail closed. Stop all workers before a deliberate operator policy
migration; there is no HTTP policy-edit endpoint. Do not create a fresh database
or delete the ledger to reset spending. External/manual harnesses do not share
this ledger; stop them during worker operation and include their usage in the
external baseline.

| Environment variable | Worker default | Bound / meaning |
| --- | --- | --- |
| `MAX_CONCURRENT_SESSIONS` | 3 | Shared global occupied slots, 1..12; does not increase provider quota |
| `MAX_OWNER_SESSIONS` | 3 | Shared per-owner occupied slots, 1..12 |
| `DEVELOPMENT_BUDGET_SECONDS` | 324000 | At most 90 hours of the project's 100-hour allowance; protects at least 10 hours for final rehearsal |
| `EXTERNAL_BASELINE_SECONDS` | 363 | At least 363; rounds prior foundation + layer03 actual 362.640 seconds upward |
| `OWNER_BUDGET_SECONDS` | 3600 | Lifetime owner budget, at most development maximum |
| `LIFETIME_RESERVATION_LIMIT_SECONDS` | 324000 | Additional non-refundable cumulative launch-reservation ceiling |
| `SESSION_TIMEOUT_SECONDS` | 240 | 60..300 remote TTL and per-launch reservation |
| `MAX_STEPS_PER_PERSONA` | 14 | 1..30 safety ceiling, independent of persona patience |
| `MAX_MODEL_CALLS_PER_PERSONA` | 14 | 1..30 shared application-call ceiling for decisions and semantic verification, including failed calls; no automatic model retries by worker |
| `WORKER_LEASE_MS` | 30000 | 5000..120000; heartbeat/cancel poll every 500ms or less |
| `WORKER_RECOVERY_LIMIT` | 6 | 1..10 bounded attempts before quarantine |
| `WORKER_SHUTDOWN_MS` | 60000 | 10000..120000 graceful deadline, then process exits with durable recovery required |
| `FIXTURE_PORT` | 4321 | Trusted loopback Next fixture source; no public tunnel |
| `ENABLE_DEMO_RUNS` | false | Required for demo/registered-site API admission and ordinary paid worker CLI |

Explicit environment settings override worker defaults; `.env.example` keeps
the existing shorter 120-second timeout and 12-step setting. For coupon journeys
use 240 seconds and 14 steps/model calls as in the bounded rehearsal.

`BEGIN IMMEDIATE` checks global/per-owner occupancy and money, reserves the full
remote TTL, stores one unique launch correlation token, transitions the attempt,
and acquires a generation-fenced lease **before** allocation. Two processes
cannot both claim a queued job. Reservations include failed/uncertain startups.
Actual browser seconds are stored with their precision; committed consumption
rounds up to whole seconds. Confirmed terminal remote status permits unused
reservation refund. Missing terminal duration consumes the entire reservation.
Observed overruns increase consumption beyond the original reservation and
block future admissions rather than being truncated. Model counters, elapsed
time and remote diagnostics are retained privately; they are not invoices or
proof of free Gateway usage.

Verified per-session charges are persisted even when the overall recovery is
unconfirmed (for example, a known session reports 400 seconds while metadata
listing fails). A migration adds idempotent, monotonic observations keyed by
job/session: retries cannot double-count, disjoint partial lists accumulate,
and an omitted previously running session prevents settlement. Missing duration
for a discovered session is conservatively charged its full TTL; that charge
does not decrease on later retries, while exact available actual duration is
tracked separately. Unconfirmed recovery never refunds the outstanding
reservation or frees capacity, but known overruns immediately constrain
new admissions.

## Crash windows, cancellation and recovery

The protocol is **not exactly-once across the network**. Intent can commit before
an HTTP launch that succeeds remotely but whose reply is lost. A new lease holder
never calls launch again for that attempt: it searches Browserbase metadata for
the original token, verifies matches, requests release, and retrieves final
status. An early known ID is durably saved before Stagehand setup; private
live/replay references update that same record. Lost/stale hooks cannot overwrite
the new lease holder. A matched session is not a resumed persona: the interrupted
attempt ends as infrastructure failure after reconciliation.

Allocation uses a dedicated SDK client with `maxRetries:0` and explicit
`sessions.create`, then the supported `browserbase.connect` attachment API.
Stagehand 4.1.0's convenience `browserbase.launch` internally retries creation
and is deliberately not used by this execution path. A per-client fake-fetch
regression exercises the actual SDK transport: a lost creation response and
HTTP 500 each produce exactly one session-creation POST. There is no global
fetch patch. Extension upload/deletion uses public SDK APIs, but the archive
`@browserbasehq/stagehand/dist/assets/stagehand-extension.zip` is a **pinned
4.1.0 internal package artifact**, not a stable public contract. Upgrade only
after rechecking packaging, attachment/late-timeout cleanup and Gateway
compatibility. Recovery searches metadata even when an early session ID is
known, verifies identity and accounts/releases all bounded matching sessions.

An empty metadata list is **not proof no browser was created**. Provider errors,
missing IDs, nonterminal release, and delayed metadata keep the reservation and
slot occupied. Backoff is exponential (2 seconds through 60 seconds), capped by
the configured recovery count. Exhaustion marks the attempt infrastructure
failed and quarantines its launch; unknown slots and money remain held.
Remote TTL is a backstop, not sufficient local proof to refund an unknown launch.

There is one distinct safe no-browser case: the trusted live cloud factory can
return explicit `allocationAttempted:false` after admission rejection or
cancellation/failure before the creation call (including during extension
upload). The flag flips synchronously immediately before dispatching the
single creation POST. Under the current lease, and only without contradictory
session/usage evidence, that proof settles zero browser cost and releases the
slot/reservation without a remote query. Missing flags, crashes, attempted
requests with lost replies and empty metadata remain **unknown**, not proof of
zero allocation. Local failure before invoking the factory is likewise known
not to allocate; genuine extension/cleanup failures still retain their failure
outcome even when browser capacity is safely released.

For a quarantined job, inspect the private SQLite `launches`/`jobs` rows and the
provider console. Use its job UUID, with the same policy/data configuration:

```sh
npm run worker:reconcile -- --confirm-release <job-uuid>
```

This operator command claims **only** that quarantined job and reconciles its
original correlation token; it never launches a browser or runs queued work.
Positive terminal proof can settle retained costs/slots without rewriting the
already terminal outcome or duplicating lifecycle events. Unconfirmed results
retain reservations and can be picked up by the bounded ordinary recovery loop.
Never manually mark an unknown session closed just because its lease expired.

Queued cancellation is immediate. Running cancellation persists intent, cancels
queued peers and aborts pending model/driver work on the next poll or synchronous
dispatch guard. Every driver action guard rechecks the durable generation,
expiry and cancellation after asynchronous eligibility checks. Already
dispatched network/browser work cannot be recalled atomically; cleanup is
awaited and its failure is not labelled clean cancellation. If cancellation
commits before finish, it wins over non-infrastructure outcomes. If completion
commits first, later cancellation does not rewrite it.

The Gateway adapter fences new decisions and drains its existing extraction RPC
before SDK metrics/close (maximum 40 seconds, covering the 25-second extraction
deadline plus SDK grace). It does not dispatch a new action after cancellation.
Teardown telemetry has a dedicated cancellation-permitted sink: it still checks
the current lease before/after the file write and inside the registration
transaction. Ordinary observation/action sinks remain cancellation-fenced.
Metrics, drain, evidence-write, SDK teardown and release errors retain fixed
`cleanupErrors`/`cleanupDiagnostics`; arbitrary errors are not reclassified as
expected cancellation or hidden because the remote browser eventually closed.

`SIGINT`/`SIGTERM` stops claims, aborts active loops and waits for cleanup.
A grace-deadline exit/crash leaves durable leases/intent for another worker.
Kill only a specific known worker PID, never by process name. Restarting does
not erase running attempts or blindly start new browsers.

## Events and private evidence

Only the execution function's **returned result** finalizes an attempt. Its
`finished` hook is not durable completion; a later reporting error can change
the returned result. Started/finished polling never fabricates lifecycle events.
Fenced observation/decision/action records link to owner-scoped evidence IDs;
immutable screenshots/JSON/telemetry and original terminal/cleanup/usage
summaries stay in private storage. Generic event payloads never contain SDK
session IDs, live/replay URLs or artifact storage keys. Model commentary is
bounded/redacted and still untrusted display text.

SSE is `/api/v1/runs/:id/events/stream`, with owner cookies/origin checks,
exclusive monotonic cursors and reconnect. Use JSON event pagination for older
history. The wall obtains live-view metadata only from the protected
`/runs/:id/sessions` route; no API key or CDP URL is returned. Live-view URLs are
access-bearing: never persist them in analytics, public logs or shared reports.
Protected evidence download and replay delivery remain later-layer work.

## Verification and paid rehearsal

Ordinary CI runs `npm run check`, build, HTTP smoke and Chromium E2E with no paid
credentials. SQLite process tests compete on one actual WAL database, kill a
specific process after intent commit, expire its lease and check recovery/fencing.
Fake adapters/time cover cancellation, partial starts, final-hook divergence,
quota refunds/overruns, unknown metadata and private-event isolation.
The repository/config suite includes a 120-job capped-owner backlog followed by
an eligible third owner: capacity filtering happens before the bounded queue
page, so quarantined owners cannot indefinitely hide unrelated runnable work.

After offline gates, an explicitly authorized operator may run:

```sh
npm run worker:integration -- --confirm-paid
```

The harness owns a built Next server on free port 4321 and two worker child
processes. It checks provider project concurrency/usage, queues three owner/API
fixture runs (including a custom persona), waits for overlap, cancels one and
requires fixed success/broken target failure for the others. It requests at most
240 seconds per session, global concurrency three, and a **persistent lifetime
1800-second reservation cap** under `DATA_DIR/worker-rehearsal`; failed runs count.
It shuts down only its own processes, checks all correlated remote sessions and
writes private evidence/proof. Public output contains aggregate status/usage only.
No ordinary CI/manual automatic workflow invokes this command.

### Live accounting (2026-09-19)

The first three-session rehearsal confirmed overlapping browsers and provider
project concurrency 25 (the application still capped at three). Fixed coupons
completed in seven actions/decisions, and the broken coupon fixture produced
confirmed `target_failed` in seven. Cancellation interrupted the first model
call, but Stagehand cleanup timed out; its original `cancelled` outcome was
correctly overridden by `infrastructure_failed`, not presented as clean success.
All three sessions were independently verified remotely `COMPLETED`.

| Attempt | Durable outcome | Actual browser seconds | Conservative reservation |
| --- | --- | --- | --- |
| Fixed coupons | succeeded | 83.875 | 240 |
| Broken coupons | target_failed | 83.847 | 240 |
| Cancellation during model call | infrastructure_failed (cleanup timeout) | 13.658 | 240 |

Subtotal: **181.380 actual seconds / 720 reserved seconds**, including the failed
cancellation acceptance. This first run was not a clean cancellation acceptance.
Private session references, remote timestamps, evidence and durable manifests
remain under the ignored private data directory.

A second full rehearsal after adding bounded active-RPC draining again proved
the two objective outcomes and remote cleanup, but cancellation retained one
cleanup error. It was not relabelled successful:

| Attempt | Durable outcome | Actual browser seconds | Conservative reservation |
| --- | --- | --- | --- |
| Fixed coupons, repeat | succeeded | 74.010 | 240 |
| Broken coupons, repeat | target_failed | 76.568 | 240 |
| Cancellation, repeat | infrastructure_failed (cleanup error) | 15.943 | 240 |

Cumulative at that point: **347.901 actual seconds / 1440 reserved seconds**; all
six sessions remotely `COMPLETED`. The remaining check was cancellation cleanup,
not another objective/parallel proof. The harness supports
`--confirm-paid --cancel-only` for a one-session corrective check against the
**same persistent cumulative ledger**; it does not reset budget or require a
second concurrent browser for that focused check.

The remaining error was reproduced offline: driver teardown flushed buffered
telemetry through the ordinary sink, which correctly rejected cancelled work
and produced `telemetry_write_failed`. The fix did not swallow that error; it
gave teardown evidence the separate lease-fenced authorization described above.
The regression orders normal-sink rejection, cleanup-evidence persistence,
remote close, then terminal cancellation; expiry during writing still rejects.

The final one-session corrective check **passed**: `cancelled`, zero actions,
one interrupted model decision, clean SDK/browser cleanup and `COMPLETED`
remote status, **16.371 actual seconds / 240 reserved**. Its durable event order
was `run.created`, `attempt.started`, initial evidence/observation,
`run.cancel_requested`, teardown `evidence.recorded`, `attempt.finished`,
`run.finished`. There were **zero action events after cancellation**.

Final layer04 accounting: **7 sessions, all independently reconfirmed remotely
closed; 364.272 actual browser seconds; 1680 conservatively reserved seconds
(28 minutes, below the 30-minute cap); peak concurrency 3**. SQLite consumed
367 whole seconds and released 1313 reserved seconds. Available metrics totaled
160839 prompt / 9718 completion tokens; partial/failed calls may have unavailable
metrics, so these are not an invoice. The prior external actual baseline remains
362.640 seconds (rounded up to 363 in the worker ledger).
Private durable evidence contains 153 evidence records and 91 step records.
No fixture server, worker or tunnel was left running.

Final offline gates: **1078 tests**, lint/types, production build, real HTTP
demo/cancel/SSE resume/owner smoke and **38 Chromium E2E tests**. Independent
review found and prompted the allocation-retry and capped-owner fairness fixes;
a focused allocation follow-up found no remaining significant issues. Public
target gate #8 and controlled-site generalization #11 remain open.

Coordinator review additionally identified two accounting edge cases: explicit
pre-allocation cancellation could unnecessarily quarantine a slot, and a failed
metadata query could discard a known 400-second charge. The no-allocation proof
and per-session observation migration above fix both. Regressions exercise the
real pre-aborted cloud factory plus repository, three pre-allocation cancellations
followed by another claim, contradictory/stale proof rejection, the 400-second
charge against an 863-second development budget (including baseline), partial
list unions, repeated observations and omitted outstanding sessions. These
corrections were verified offline only; no additional paid sessions were run.

One push CI run exposed a timing assumption in the existing scripted coupon +
completion E2E brain: it requested checkout while the real delivery-summary
request still disabled that control. A deterministic 2500ms response delay
reproduced the infrastructure failure after seven actions. The test brain now
waits only for the known hydration/delivery-pending states, without advancing
its scripted action or hiding unexpected missing controls. The forced-delay
regression requires an actual wait and passed six repeated runs; the full
38-test suite passed afterward. Production execution code and live evidence
were unchanged by this test-only correction.

### Rubber-duck review

The rejected shortcut was resetting expired leases to queued: it would spend
twice after a lost launch reply. Instead the lease moves control, not permission
to allocate another browser. A unique correlation is persisted before allocation;
missing provider evidence consumes capacity rather than proving absence.
SQLite transactions serialize caps/cancel/finish; driver guards fence stale
dispatch; already-sent operations remain an explicitly documented network race.
Only positive remote terminal proof refunds money. Private evidence and event
identity use separate schemas; SSE reads never manufacture execution progress.

## Layer04b controlled-site rehearsal

Issue #11 / PR #17 builds on merged layer04 PR #15 without weakening #8.

After the offline gates, `npm run controlled:integration -- --confirm-paid`
runs one custom persona through owner admission and the real durable worker on
the registered project board. It starts on the empty projects list, asks for
`Garden planning` in the `Design` category, and requires both the structural
name assertion and a cited semantic category judgment. Acceptance also checks
a prior grounded negative/inconclusive semantic observation and verifies that
decision/evaluation counts sum to the shared call total. It owns its loopback fixture server on port 4322
and one worker, not a public tunnel. The fixed persistent ledger is
`DATA_DIR/controlled-rehearsal`, with a private exclusive integration lock,
one concurrent session, a 300-second per-session reservation/remote TTL, and a
**1,200-second cumulative non-refundable reservation cap**, including failed
attempts. At most four paid allocations fit; do not delete the ledger or change
`DATA_DIR` to evade the cap. A stale lock requires remote reconciliation before
an operator removes that exact file.
This development harness requires `DATA_DIR` to resolve inside the current
worktree, preventing accidental use of another checkout's ledger. Normal
deployment workers still support the private persistent-volume configuration
above. Keep the same rehearsal ledger for every retry; a different checkout
does not grant another spending authorization.

The external prior project ledger is **726.912 actual browser seconds**:
12.400 foundation, 350.240 layer03 and 364.272 layer04. This harness reserves
**727 seconds** as the conservative external baseline. External historical
reservations are not reset or refunded by this new ledger; the 1,200-second
authorization limits this layer's additional cumulative reservations.
Gateway calls are separately chargeable. Application operation counts and
available Gateway token metrics are evidence, not an invoice; provider-internal
retries and failed-call token usage may be unavailable.

The harness records durable results and independent remote cleanup proof
privately, emits aggregate usage only, and stops its own app/worker processes.
Failed proof remains failure even when the remote browser eventually closes.
No session references, live-view URLs or screenshots belong in public PR logs.

The harness has its own deterministic board oracle: the negative observation
must show the known empty list; the positive cited observation must show the
saved `Garden planning`/`Design` pair and exactly one stored project. A model
that incorrectly says `met` while citing a real `Research` project does not
pass acceptance. This harness-specific oracle does not replace semantic
evaluation in general execution. Cleanup acceptance also requires exactly one
remote session, matching the persisted private session reference, rather than
merely one launch-correlation query; every discovered session is still released.

### Layer04b live ledger

The first attempt created the requested `Garden planning` project in `Design`
in four browser actions, but both semantic verification calls failed. It was
**not accepted**: the initial SDK response failed schema generation; the final
response had its provenance URL rewritten to an empty string by Stagehand's
URL-field extraction transform. Independent inspection of the completed
session's private RPC logs and pinned SDK source established the cause without
another browser allocation. The wire schema now uses a bounded plain string,
with strict URL/equality validation retained locally.

That first stored outcome was `gave_up` after a model `done`, with an inconclusive
semantic check. This exposed a separate taxonomy bug: verifier infrastructure
errors must not be presented as persona abandonment. The loop now terminates
those errors as `infrastructure_failed`, retaining an inconclusive check,
charged call and explicit verification failure. The historical result remains
immutable and is recorded here as a failed infrastructure acceptance, not
evidence of friction on the board.

| Attempt | Acceptance | Actual browser seconds | Conservative reservation | Application calls |
| --- | --- | --- | --- | --- |
| Initial board journey | Rejected: semantic SDK schema failure and incorrect abandonment taxonomy | 62.490 | 300 | 5 decisions + 2 evaluations = 7 |
| Corrected board journey | Accepted: custom persona, four actions, independently verified saved name/category, grounded negative then positive | 61.668 | 300 | 4 decisions + 2 evaluations = 6 |

Both sessions were independently re-retrieved and verified `COMPLETED`.
**Layer04b totals: 124.158 actual browser seconds; 600 cumulative reserved
seconds of the 1,200-second cap; peak concurrency one.** The durable ledger
consumed 125 whole seconds and released 475. The successful session used
28,137 prompt / 2,576 completion tokens; cumulative available metrics are
**56,337 prompt / 4,690 completion tokens**, with nine decisions and four
evaluations, no application retries. Failed-call metrics may be incomplete and
are not a provider invoice.

The successful history contains semantic `not_met` on the known empty list,
`not_observed` on unrelated form observations, then `met` on the saved project
list. Both evaluated verdicts have two validated citations and heuristic
confidence 0.9; this is not a calibrated accuracy estimate. The final screenshot
references map to owner evidence. The independent oracle confirms the exact
project name, separate `Category: Design` block and exactly one project, so
the model cannot pass rehearsal merely by citing a similar name or wrong category.

Including the separate external actual ledger, project usage recorded through
this layer is **851.070 actual seconds** (726.912 prior + 124.158 here). Historical
reservations remain separate; this does not refund or reset them. No browser,
worker, fixture listener or integration lock was left running. Private provider
logs, session references and evidence remain in the ignored rehearsal directory.

Final offline gates: **1,290 unit/API tests, lint/types, production build,
built-app HTTP/SSE smoke and 48 Chromium E2E tests**. Both structurally different
sites run custom personas/novel criteria through the actual scoped driver,
loop and durable worker offline. No paid store replay was needed in this layer.
Independent review prompted exact rendered-text/line-break fixes, historical
snapshot compatibility, conservative cache removal, independent acceptance
oracles and exact-session cleanup proof. Additional regressions exclude
hidden/clipped text from semantic evidence and distinguish verifier infrastructure
errors from persona abandonment. Public-target gate #8 remains open.
