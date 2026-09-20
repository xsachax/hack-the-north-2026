# Durable worker runbook (layer 04)

## Managed Agents worker (separate MVP)

The same `npm run worker -- --confirm-paid` command can run the separate
managed queue with `ENABLE_MANAGED_AGENTS=true`, `BROWSERBASE_API_KEY`,
`BROWSERBASE_PROJECT_ID`, `BROWSERBASE_MANAGED_AGENT_ID`,
`MANAGED_AGENT_ALLOWED_ORIGINS` (comma-separated canonical origins), and a
32-character-or-longer `FLASH_FLOOD_ACCESS_CODE`. Production additionally requires
`DEPLOYMENT_CONFIRM_PAID=true`. The example demo environment sets
`ENABLE_MANAGED_AGENTS=true`; native/public and controlled modes remain off.
Managed execution still requires all private configuration and a worker started
with `--confirm-paid`. Set `ENABLE_MANAGED_AGENTS=false` for an offline preview.

For the Browserbase landing-page demo, set
`MANAGED_AGENT_ALLOWED_ORIGINS=https://www.browserbase.com,https://browserbase.com`
on both the app and worker, then restart them. The bare domain redirects to
`www`; the onboarding selector lists only configured origins. `.env.example`
includes this demo approval and requests Managed execution, but it does not
provision credentials, start the worker or remove the owner access-code
requirement. Do not enter provider credentials into the
target URL. IANA is only an optional old read-only demo, not a required target.
The configured provider Agent's instructions must also permit the chosen target;
an Agent pinned to IANA cannot be reused unchanged for the Browserbase demo.
Reconfigure the Agent and worker together only after any unconfirmed resources
are reconciled. Preserve the authoritative ledger, retained reservations and
runtime lock; never start a fresh paid database to work around uncertain cleanup.

The reusable agent is provisioned separately; the worker never creates an agent
or retries a run-creation request. Before create it durably records the original
agent/task and dispatch marker; recovery only discovers/stops the original
operation. It never starts a replacement. Agent creation uncertainty likewise
must be reconciled, not retried.

Rejected create calls now journal private, write-once `first_create_failure`
metadata on the attempt before cancellation/deadline handling can replace the
error. It records a fixed SDK failure category, HTTP status when available,
an allowlisted/redacted provider request ID and its header name (`x-request-id`
or `request-id`), and a local `recordedAt` timestamp. No provider message, body,
stack, request headers or credentials are stored. This field is not exposed in
the run API, progress feed or UI; inspect it only through authorized private
ledger diagnostics. Recovery may replace the current `error`, never this original
record. The original lease must still be active; process death or lease loss
before journaling can still leave it missing.

The additive migration leaves historical diagnostics `NULL`: a later
`managed_recovery_unconfirmed` error cannot reconstruct the original create
response. HTTP errors (including 4xx), transport failures, exhausted inventories,
or absence of running sessions do **not** establish nonallocation or zero usage.
These diagnostics never release a reservation, reduce occupancy, reset recovery
counts or retry create. If no unique owned run/session can be identified, retain
quarantine and seek provider-side traces for the original Agent, UTC dispatch
window, exact task hash and correlation token. Keep that support handoff private
until approved for sharing. Inspection GET request IDs are not original POST IDs.
`worker:reconcile` is native-only, not a way to clear unidentified Managed creates.

Managed and native jobs share the same SQLite worker policy, global/owner
occupancy and conservative usage reservations. The total ceiling remains eight,
not eight per mode. Unknown allocations retain their reservation and slot.
Lifetime reservations are not refunded after failures or early closure.
Lease fencing and cancellation surround provider awaits; independently retrieved
Browserbase session `COMPLETED` is necessary for confirmed cleanup.

For the managed wall's live windows the worker makes one extra `sessions.debug`
metadata read per attempt. It allocates nothing and adds no browser-seconds or
reservations. It is attempted once per execution, never retried and never on
recovery claims; failure is recorded as `managed_live_view_unavailable` and does
not fail the attempt. Live-view URLs are access-bearing: never put them in logs,
PR text, analytics, reports or browser storage.

`SESSION_TIMEOUT_SECONDS` is an **operational stop deadline**, not a provider
hard TTL in managed mode. The Agents API exposes neither a hard model-call cap
nor a way to disable its built-in tools. Existing `MAX_MODEL_CALLS_PER_PERSONA`
and `MAX_STEPS_PER_PERSONA` are not managed enforcement. Provider outages or
process death can outlive the stop deadline; retained reservations prevent
replacement work, but cannot themselves stop a remote agent. Record missing
usage as unknown and reconcile it. Read-only/scope prompts are not network
confinement; only approved public sites without secrets are eligible.

### `MANAGED_ENGINE=sessions` (browser-time engine)

`MANAGED_ENGINE` defaults to `agents`; any value other than `agents` or
`sessions` stops the worker with `managed_engine_invalid`. With `sessions` the
worker logs `managed_engine_sessions` and keeps the same managed queue, runner,
store, wall and live windows, but replaces the Agents-API run with
`src/server/managed/session-provider.ts`: the worker launches one ordinary
Browserbase session per attempt (`keepAlive: false`, no proxies, provider
timeout `max(60, min(300, SESSION_TIMEOUT_SECONDS))`) and drives it with a short
Stagehand `extract`/`act` loop (default six steps, fewer when time runs out)
plus one report extraction (two when the first fails and time remains) through
Browserbase's model gateway. The loop may
also press the Tab key (three presses per tab step; no other key is ever
pressed) and run fixed read-only `page.evaluate` expressions in the target
page (Navigation Timing, and the focused element's tag, text, outline and
box-shadow); their output reaches the model as `engineFacts`. A wall-clock time
is reported only for the initial page open, never for a click. A third fixed
expression reads only the document's element and text counts: above 3,000
elements or 60,000 characters Stagehand is asked to leave the page's `<table>`
subtrees (when it has any) out of a step read, and a failed read of a page that
was never read sends the loop back to the last readable page (bounded to 10 s;
two failed reads in a row end browsing). The report is written from the loop's
notes (`stepsSoFar` and `engineFacts`); a fourth fixed expression picks a small
rendered element (`h1`, `h2`, `h3`, `p` or `a`) and Stagehand is asked to scope
the page down to it, best effort only: Stagehand reads the whole page when it
cannot resolve that element. The report is retried at most once; when no model report exists the result returns the
recorded observations and harness facts in the summary while every criterion
stays `inconclusive`. It is expected to consume browser time
plus model-gateway inference instead of Agents-API runs; gateway billing/quota
for this account is unverified until a paid run. Only the Browserbase key is
used.
`BROWSERBASE_MANAGED_AGENT_ID` is still required by admission but is only an
echoed label in this mode; no provider Agent is contacted.

Only `npm run worker` (which loads `.env.local`) honours the switch: the
packaged release runtime does not forward `MANAGED_ENGINE` and stays on the
agents engine. The scope check is exact-origin, so launch against the origin
the site actually serves (for Browserbase, `https://www.browserbase.com/` with
that origin in `MANAGED_AGENT_ALLOWED_ORIGINS`); a bare domain that redirects to
`www.` lands outside the declared scope and yields an all-inconclusive result
with no exploration. Keep `SESSION_TIMEOUT_SECONDS` at 120 or higher: exploring
stops at 55% and the report at 80% of it. An engine failure logs only
`managed_session_engine_error:<stage>:<error class>:<http status>` and shows
"The browser session failed during <stage>." on the wall; messages, keys and
URLs are never logged.

Limits, stated plainly:

- Scope and read-only behaviour remain **prompts plus best-effort checks**: a
  keyword guard on the proposed click label and a URL check after each action
  that navigates back to the last in-scope page. A click that opens a new tab
  is closed and switched back to the original tab. Neither is confinement; an
  out-of-scope page can load before the check runs, and Stagehand's `act` picks
  its own method for a click instruction. When the model says it is done before
  three actions, the loop scrolls instead (no model call) so the page is looked
  at. No model report is written from a final page outside the declared scope. Every result carries that
  limitation.
- Runs live only in the worker's memory. A worker crash mid-run cannot be
  rediscovered; the dispatched attempt stays for fenced recovery/quarantine and
  the session ends at its provider timeout. Never start a replacement.
- Cancel, deadline and shutdown reject the engine's in-flight awaits directly
  (closing the browser does not settle Stagehand calls), then close. A stop
  that lands during session launch itself still waits for launch (30 s bound)
  and can end `cleanup_required`.
- Session closure is still proved only by the independently retrieved real
  session reaching `COMPLETED`; the engine reports a terminal run status only
  after its own close attempts.
- Model calls are still reported as unknown, and `MAX_MODEL_CALLS_PER_PERSONA`
  is not enforced here either (the loop is bounded by steps and time instead).
- The wall's provider wording still says Browserbase-managed (known copy
  limitation).
- Status: offline-tested with injected fakes only. Hosted behaviour (session
  launch, Stagehand startup, gateway inference, live view) is unproved until an
  approved paid run.

The source/package/ledger-bound managed proof uses the **existing** authoritative
ledger and fresh explicit approval. Native failures already reserved 900 of the
1,800-second initial lifetime allowance. Do not start a new paid database to
avoid that balance. A managed success would demonstrate the restricted MVP, not
the hardened public-egress acceptance required by #8.
The older native-only proof harness refuses an inventory containing managed
attempts instead of omitting their reservations or resources. The managed proof
harness accounts for both histories; neither starts a replacement paid ledger.
For local UI-only regressions, `UI_TEST_BROWSER=webkit` selects the maintained
Playwright WebKit renderer after its browser dependency is installed. This
does not select a different provider execution engine. Keep the full Chromium
suite in CI; native/CDP tests still require Chromium.

## Native and controlled workers

The separate Node process preserves registered controlled-site execution and
contains a distinct, operator-gated public read-only path. Legacy/unversioned
website requests remain `blocked_unsupported` without allocating a browser;
enabling a flag cannot upgrade those stored requests. Release gate #8 remains
unproved regardless of the issue's GitHub state. There is no fixture fallback or target-validation exception.
Layer 04b (#11) adds custom structural and evidence-grounded semantic
criteria for the store and project board before the layer 05 wall. Natural-language
evaluation is a recorded heuristic, not a deterministic outcome oracle.

The genuine public factory binds the [HTTP broker](EXECUTION.md#public-http-transport-library-offline-not-enabled)
to immutable navigation/asset snapshots and the durable lease. The worker
requires both `native-public-v1` and `public-http-readonly-v1`, operator enablement
and implementation readiness; all native profile/policy checks remain mandatory.
The hosted-validation candidate sets `PUBLIC_EXECUTION_IMPLEMENTATION_READY=true`;
`ENABLE_PUBLIC_RUNS` remains false by default. A rollback to false still blocks
claims, direct factories and native recovery before provider operations. Never
requeue historical blocked jobs when enabling a new deployment. Historical tests
and the standalone broker proof are not acceptance.

The startup path distinguishes controlled and public authorization. Once source
readiness is approved, a public-only worker can start without enabling demo runs
or fetching the fixture health page. It skips queued controlled jobs rather than
spending on them, and does not pump controlled reproduction work. Deployment
still requires explicit paid confirmation. This wiring does not
override a disabled source gate; existing orphan cleanup remains separate from
authority to launch a new job.

When disabled, the same source stop suspends automatic and manual public/native reconciliation,
including restored native-resource or discovery-event rows attached to a launch.
Worker startup and `worker:reconcile` perform no provider lookup, release, or
extension deletion for those records. Known identities, pending/quarantined
state, and reservations remain unchanged; suspension is not confirmed cleanup.
The reconciliation CLI exits unsuccessfully with
`public_recovery_checkpoint_disabled_reservation_retained`. Controlled-only
reconciliation is unchanged.

`public-checkpoint.test.ts` injects the disabled source state to exercise rollback
with operator/admission flags. Public API, worker and deadline tests now use the
actual candidate source state. Passing offline tests do not establish live acceptance.

The #8 [native-policy probe](EXECUTION.md#native-browser-policy-candidate-offline-phase-a)
has both offline conformance tests and a production adapter used by the gated
public factory. Running offline probes uploads no extension and allocates no
provider browser/model work. A provider proof requires
fresh explicit user approval and a separately reviewed bounded harness; existing
API credentials do not grant that approval.

Public sessions are fresh only, with no context save/reuse or takeover. Native
resource intents and known extension/session identities are journaled before
subsequent work. Late identity discovery may append private reconciliation
evidence but never grants a stale lease authority to alter lifecycle, usage or
cleanup. Unknown allocation/upload/deletion outcomes stay quarantined; there is
no automatic browser retry.

Native SDK trace export is unsupported and locally denied, not forwarded.
Private `blockedNativeTelemetryRequests` counts these bounded policy denials,
including during startup, separately from `gatewayDispatches`. A successful local
403 denial does not consume model budget or turn the browsing goal into an
infrastructure failure. Identity/policy failures and denial-limit overflow still
fail closed; no page or offscreen export exemption exists.

The absolute public deadline starts before session-create dispatch and reserves
80 seconds of the provider TTL for Gateway drain, metrics and release/readback.
The loop receives only the remaining duration; TTL <=80 seconds is unsupported,
and TTL never exceeds 300 seconds. Native interruption is infrastructure failure,
not user cancellation or a target bug. Policy and attachments remain installed
through remote release. `COMPLETED` is required for clean live acceptance;
operational retirement of `ERROR`/`TIMED_OUT` requires two independently matched
identity/status/start/end readbacks and remains a failed outcome. Exact-ID
authenticated not-found is required to confirm extension deletion.

The native factory uses an exclusive SDK worker thread and the real Browserbase
session identity; only the parent owns provider release. It never calls branded
SDK browser close methods. After remote readback, actual thread termination
settles outstanding SDK RPCs/sockets/retries before recycling the metadata port
or detaching native/network/Playwright control. A termination failure retains
attachments and quarantines the extension. Local WSS and synthetic Gateway
regressions prove these mechanics, not hosted public execution.

The maintained worker/reconciliation commands and deployment supervisor supply
`--conditions=react-server` before imports. This resolves the server-only broker
marker, not an authorization bypass.

Layer07 adds [advanced controlled workflows](ADVANCED_WORKFLOWS.md) on this same
worker: private context creation/adoption/retirement, acknowledged exclusive
human control, immutable reruns and deterministic bounded reproduction jobs.
Context holds survive worker lease expiry; unknown remote ownership is never
released on a local timeout. Reproduction outboxes map each candidate to one
normal fresh reserved job; cleanup uncertainty stops reduction. Context
revocation and reproduction cancellation set job-level cancellation even when
the original run itself was not cancelled.

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
goal/criteria snapshots; a new run may select at most eight of them.
The legacy demo route accepts only `fixed` and `second-coupon` scenarios and the
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

The product dispatch ceiling is **eight occupied Browserbase agents globally**
across every worker sharing this database, never eight per process. Defaults
remain three; smaller global/owner limits still win. Count all non-settled launch
intents, active launches, recovery and quarantine against capacity. Recovery may
reclaim an occupied slot but must never allocate a replacement browser.

Historical worker policies may record concurrency values from nine through
twelve. They remain readable and must match verbatim when reopening; do not
silently rewrite their JSON, reservations, refunds or consumed usage. Dispatch
clamps those recorded values to eight without changing the stored policy. If an
older deployment already has more than eight occupied slots, stop new dispatch
until confirmed retirement drops it below eight; do not mark sessions settled
merely to fit the new cap. Stop all older worker binaries before upgrading so an
old dispatcher cannot bypass the new ceiling. New policy configurations use
one through eight; retaining an old value is compatibility, not permission for
additional sessions.

The new-run admission ceiling is also eight (website, controlled, demo and
reruns). Historical runs/results and exact-idempotent requests with up to twelve
assignments are preserved; only a genuinely new submission is rejected above
eight, after the old exact-key lookup.

This ceiling does not authorize paid execution. The separately bounded hosted
proof remains concurrency one, at most two new sessions, with its existing
1800-second lifetime reservation ceiling. Neither public source readiness nor
the requirement for fresh explicit digest-bound hosted approval changes.

| Environment variable | Worker default | Bound / meaning |
| --- | --- | --- |
| `MAX_CONCURRENT_SESSIONS` | 3 | Shared global occupied slots, 1..8 for new policy; historical 9..12 are dispatch-clamped, never increased provider quota |
| `MAX_OWNER_SESSIONS` | 3 | Shared per-owner occupied slots, 1..8 for new policy; never above global dispatch capacity |
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
| `ENABLE_PUBLIC_RUNS` | false | Explicit public-only admission; source readiness and per-session native attestation remain mandatory |

The worker requires `--confirm-paid` and at least one authorized execution mode.
Controlled mode additionally requires `ENABLE_DEMO_RUNS=true` and a healthy
controlled fixture source; public-only mode never grants controlled authority.
All maintained harness worker subprocesses
pass Node's `--conditions=react-server`; they retain the server-only import guard.

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
Layer06 adds protected evidence detail/downloads and report projections from
these durable records; see [REPORTS.md](REPORTS.md) and [REPLAY.md](REPLAY.md).
The recording integration binds each private provider session ID to its actual
job and rechecks the run/attempt owner on every request. Report construction
does not alter worker results, acquire leases, allocate browsers or call a model.

## Launch UI and live wall (layer 05)

The homepage now performs owner bootstrap, validates canonical scoped assignments,
and submits through the ordinary protected APIs. Website mode states the #8
execution block before submission; controlled-demo mode is an explicit separate
choice. Per-assignment step, shared model-call and duration limits are immutable
snapshots and can only reduce the operator's policy. Patience is a separate
persona behavior limit, not a fabricated completion percentage.

The owner wall loads persisted history and snapshots, then consumes resumable
SSE. Viewers are opt-in, owner-authorized Browserbase live views, bounded to three;
queued or unavailable sessions show placeholders. Viewers are visualization,
not managed takeover. Cancel intent hides the viewers immediately, while the
durable cleanup/recovery state remains visible. Terminal streams close, but
unresolved recovery and quarantine retain paced summary refreshes. No pending
remote session is represented as confirmed closed.

`npm run ui:integration -- --confirm-paid` is a separate trusted, UI-originated
rehearsal, not a CI task. It retains a persistent ledger in `data/ui-rehearsal`,
uses a **1,800-second lifetime cumulative reservation cap**, at most three
concurrent browsers and 300 seconds per remote TTL, and includes an external
baseline of **852 seconds**. Failed attempts count toward the same ceiling;
never delete the ledger to regain budget. It owns a local HTTPS proxy, app,
worker and browser, drives the actual launch form, requires rendered live-view
evidence and matching persisted steps, and independently verifies the exact
correlated remote session set. Screenshots, live URLs, identifiers, TLS material
and detailed proof stay private in ignored storage. Run only after offline
acceptance and a clean focused review; the project allowance does not increase
this layer's explicitly authorized lifetime cap.

### Layer05 UI proof (2026-09-19)

The first paid UI rehearsal passed after the full offline gate and focused review.
It originated in the real HTTPS launch form, created a custom persona alongside
the careful-first-timer preset, and traversed owner API -> durable worker ->
Browserbase / Gateway -> authorized live wall. Both personas created the scoped
synthetic Garden planning project; each recorded four decisions and four actions.
The wall's event sequences, timestamps, observed pages, actions and commentary
matched the durable records. The terminal criterion and independent persisted
board observation both confirmed the project was listed.

| Persona | Durable outcome | Actual browser seconds | Cumulative reservation |
| --- | --- | --- | --- |
| Careful first timer | succeeded; cleanup closed | 48.693 | 300 |
| Custom garden organizer | succeeded; cleanup closed | 44.145 | 300 |

**Layer05 total: 92.838 actual browser seconds / 600 lifetime reserved seconds
of the 1,800-second cap.** The durable ledger charged 94 whole seconds and
refunded 506; the non-refundable cumulative reservation remains 600. Peak
concurrency was two, below the application cap of three. Available Gateway
counters were 36,240 prompt and 2,207 completion tokens across eight decisions;
no semantic evaluation was requested by this structural-criterion rehearsal.
These counters are not a price estimate or invoice.

Both exact persisted session references were independently retrieved and
correlated with provider metadata, and each was remotely **COMPLETED**. The
remote exact-set proof passed; no launches remain unsettled and no jobs remain
queued or leased. The owned worker, app, HTTPS proxy and browser stopped, ports
4323/4324 were released, and the exclusive lock was removed. No further paid
calls were made after this proof.

Actual Browserbase canvas pixels and private iframe screenshots showed the
registered project board, not merely iframe URLs/load events. The two-view
desktop wall showed live persisted step activity, and the mobile terminal wall
showed two succeeded attempts with viewers removed. Desktop/mobile launch,
live/terminal wall, pixel diagnostics, immutable observations and exact closure
proof remain under ignored private storage; no images, session identifiers or
live URLs were published.

The previous tracked project actual was 851.070 seconds; adding this layer gives
**943.908 actual seconds** (rounded-up external baseline for later manual work:
944). This proof's own policy retained the authorized 852-second external
baseline throughout. Offline HTTPS preflights used separate test-only storage,
no worker or cloud calls, and zero reservations. Offline coverage also exercises
lost-response replay, owner changes, cancellation/recovery/quarantine, stream
gaps, same-owner reauthorization, and terminal-history summary races.

## Verification and paid rehearsal

### Layer06 report rehearsal

`npm run report:integration -- --offline-preflight` exercises the protected
report/export path without a provider call. The separately authorized
`npm run report:integration -- --confirm-paid` uses a genuine new owner session
and one controlled project-board assignment, with a 300-second TTL, at most two
concurrent browsers, a 944-second external baseline, and a **1,200-second lifetime
cumulative reservation cap** under private `data/report-rehearsal`. Failed
attempts count; refunds never replenish this cap. Do not remove the database or
ledger to regain allocation.

Fresh rehearsals save only the genuine opaque owner cookie and its run binding
in `owner-resume.json` inside the private invocation directory (mode 600,
directory 700, maximum 8 KiB, no symlinks, nonrenewing 15-minute deadline). After a
downstream failure or a pending recording, use
`npm run report:integration -- --resume <original-invocation-UUID>`.
This starts only the local app, proxy and browser: it cannot create/cancel a run,
start a worker or reserve another cloud session. It verifies the actual saved
owner session, run, settled launch, exact remote closure and unchanged lifetime
ledger before readback. It never invents or reassigns ownership.

The credential file is deleted after successful playback, or when an expired or
invalid state is read. If an operator stops with an explicit recording fallback,
remove that invocation's `owner-resume.json` immediately rather than retaining
credentials unnecessarily. The 15-minute harness deadline does not revoke the
underlying application session. Never copy this file to logs, browser storage
exports, public artifacts or CI. The offline preflight proves genuine-owner
restoration across a local app/browser restart on an isolated cancelled run,
with no worker, provider calls or reservations.

The proof must verify actual report citations, protected screenshot content,
persisted action/evidence relationships, safe exports and the exact correlated
remote session set. Recording readback has its own bounded attempts; processing
or unavailable recordings do not justify another browser allocation. Existing
closed-session artifacts can support operator-authorized provider readback, but
cannot serve as an authenticated owner proof if the original opaque owner cookie
was intentionally discarded. Never mint or reassign ownership to manufacture
that proof. All screenshots, detailed manifests, TLS material and provider
identifiers remain ignored private data, not CI uploads.

The first layer06 mission succeeded with one action and one decision, but its
downstream acceptance harness stopped before replay: it incorrectly required
`Cache-Control` to equal `no-store` instead of accepting the artifact reader's
stronger `private, no-store, max-age=0` directive set. This assertion rejected
valid production headers; that attempt did not establish byte-level screenshot
delivery. The regression now checks the actual artifact response's cache
directives, safe MIME, attachment disposition and `nosniff`; it does not weaken
the production response.

That failed rehearsal still counts: **20.548 actual browser seconds / 300
non-refundable reserved seconds**, 21 whole seconds charged and 279 released,
4,143 prompt / 275 completion tokens, zero semantic/retry calls. Its exact
persisted session set was independently remotely `COMPLETED`; all jobs and
launches settled and the owned processes/lock stopped. No recording reads were
attempted. Its owner cookie was not retained, so it cannot be repurposed as an
authenticated replay proof by modifying ownership.

### Layer06 accepted proof (2026-09-19)

After the header regression and resumable offline preflight passed, the second
mission completed the end-to-end owner API -> durable worker -> Browserbase ->
persisted report -> protected evidence/export -> protected HLS path. It opened
the project list without editing, with one decision and one action. The report
matched the actual criterion observation, step, timeline and registered evidence;
the downloaded PNG matched the persisted file byte-for-byte. Anonymous/foreign
access failed, and refresh plus desktop/mobile navigation preserved the report.

The recording was `ready` on one explicit metadata check. Keyboard-started
playback advanced from 0 to 3.898913 seconds, decoded 119 frames at 1280x900, and
produced 4,096 opaque sampled pixels with 15 distinct quantized colors. The
35,573-byte private frame capture showed the real project board. One playlist
and three media responses used only protected same-origin paths; no signed
provider URLs reached the browser. No replacement mission or resume allocation
was needed for recording readiness.

| Rehearsal | Acceptance | Actual browser seconds | Lifetime reservation | Prompt / completion tokens |
| --- | --- | --- | --- | --- |
| First | Mission succeeded; downstream header assertion failed | 20.548 | 300 | 4,143 / 275 |
| Second | Report, evidence, exports and decoded playback passed | 20.218 | 300 | 4,162 / 289 |
| Total | Both exact remote sessions independently `COMPLETED` | **40.766** | **600 of 1,200** | **8,305 / 564** |

The ledger charged 42 whole seconds and released 558; the non-refundable lifetime
reservation remains 600. There were two decision calls and zero semantic/retry
calls; reporting and replay made no inference calls. Peak browser concurrency
was one, with TTL 300. Project-wide provider counters are not an invoice.
The tracked project actual is now **984.674 seconds**; later manual layers
should use a rounded-up external baseline of 985, without changing this proof's
944-second policy.

Both exact correlated session references were reread remotely as `COMPLETED`.
There are no queued/leased jobs or unsettled launches. The app, worker, proxy and
browser stopped, ports 4325/4326 were verified released, and the lock and every
resumption credential file were removed. Private desktop/mobile report,
evidence and decoded-recording captures were inspected and remain ignored;
none were published. The separate earlier seven-read investigation allocated
zero browsers and is not counted as another mission.

The subsequent coordinator review found run-dependent display redaction in
finding hashes. `finding-v2` now hashes private immutable context, with separate
redacted presentation and private page-cohort matching; old cached projections
are invalidated. This deterministic correction was verified offline, including
unrelated typing, missing action artifacts and real cross-attempt aggregation.
The paid report/playback proof above preceded that signature-version change;
no additional browser allocation or provider read was needed.

Local acceptance passes **1,636 unit/API tests and 86 Chromium E2E tests**, lint,
types, production build, actual HTTPS/SSE/report/export smoke and the authentic
zero-allocation restart/resume preflight. Focused independent reviews cleared
the final report provenance/classification and protected recording boundaries.

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

## Layer08 release rehearsal

Issue #16 / PR #21 adds clean single-host deployment and the separately gated
[release harness](REHEARSAL.md). The real rehearsal used reviewed runtime
`a5de2ba6fb4e1fd10f7ba229bdb73b86ea17db5c` and an independently verified clean
Node package, not the developer checkout's build or a substitute worker.
Before approval, 2,044 unit/API/repository/worker tests, 103 Chromium tests,
lint/types/build, HTTP/SSE and offline HTTPS preflights passed. Both exact-head
push/PR CI jobs included actual offline Docker build/context scanning, private
volume, CDP scratch, probes, shutdown and web-only backup restore/quarantine;
GitGuardian and dedicated security/correctness/coordinator reviews passed.

The first approved command failed at configuration loading, **before any
invocation, worker, launch intent or reservation**. Its dynamic `@next/env`
default import did not match the actual tsx CommonJS loader. The correction uses
the established static import. A regression runs the maintained npm command
with fake configuration, network disabled and a missing package, proving that
the real command reaches the preallocation package boundary. Private failure
diagnostics contain fixed stage/kind fields, not error text or credentials.
After full gates and renewed exact source/package/empty-ledger approval, the
four-session plan ran once. No paid retry or replacement browser was used.

| Phase | Durable outcome and criterion evidence | Actual browser seconds | Lifetime reservation |
| --- | --- | --- | --- |
| Broken, careful first timer | `target_failed`, seven real decisions/actions; second-coupon exception, cited milestone `not_met` | 85.036 | 300 |
| Broken, bargain hunter | `target_failed`, seven real decisions/actions; same verified defect, cited milestone `not_met` | 85.024 | 300 |
| Active cancellation | `cancelled` after active provider reference; zero decisions/actions; milestone `not_observed` | 1.152 | 300 |
| Selected fixed rerun | `succeeded`, seven real decisions/actions; cited milestone `met`, exact immutable comparison `confirmed_fixed` | 82.308 | 300 |
| Total | Four independently matched `COMPLETED` sessions | **253.520** | **1,200 of 3,600** |

The actual paid worker uses Gateway `google/gemini-2.5-flash`. Three available
model metric records total **125,058 prompt / 7,102 completion tokens**; the
cancelled-before-decision session has no model metric record. Available counters
are not an invoice. This release checks the legacy coupon milestone, not fresh
general semantic evaluation; that provider evidence remains layer04b's board
proof. Only the planted second-coupon defect is verified as autonomously found.
Deterministic tests for the other five do not imply autonomous discovery.

The durable ledger charged **257 whole seconds** and released **943**; its
non-replenishing lifetime reservation remains **1,200**, not 257. Peak observed
concurrency was two, within the maximum three; each TTL was 300 seconds. The
approved external baseline stayed 1,092 throughout. Prior tracked actual
1,091.773 plus 253.520 gives **1,345.293 project seconds**; fresh later work must
use at least **1,346** as its rounded-up baseline without resetting this ledger.
The remaining 2,400 reservation seconds are unspent reserve, not permission for
additional calls. No new contexts or reduction candidates were created.

Actual owner API, persisted wall events/action commentary, two simultaneously
active rendered provider viewports, private registered observation screenshots,
report evidence and immutable fixed comparison passed. The original owner then
consented to protected HLS playback: one metadata read returned ready, playback
advanced from zero to 4.441 seconds and decoded **135 frames at 1280x900**.
One protected playlist and three protected media responses stayed same-origin;
the captured frame showed the controlled store. No signed provider URL was
published and no allocation occurred during readback.

Ten original private PNGs were opened and inspected. The 8,596,071-byte local
WebM backup played to completion: **218.88 seconds, 5,472 decoded frames,
1440x1000**. Sampled frames were inspected as well. This is an unedited local
observer recording with intentional blank idle periods after viewers are
closed and brief viewport-resize transitions; it is not a polished demo or
continuous remote browser recording. Real remote replay is the separate HLS
proof above. Exact image/video hashes were manually attested, then the file-only
finalizer validated unchanged source, inventory, ledger and cleanup. All media
remain ignored and private (files0600/directories0700), with no upload.

The complete cumulative set of four new correlated sessions was independently
listed/retrieved and matched to persisted references, each exactly `COMPLETED`.
No queued/leased jobs or unsettled launches remain. The supervisor, worker,
app, HTTPS proxy and observer browser stopped; TLS files and invocation lock
were removed. No owner credential was persisted or recreated. Prior layer07
context/takeover/reduction evidence retains its original attribution. No further
provider or model calls were made after this proof.

This accepts the controlled-site hardening/rehearsal scope, **not the original
arbitrary authorized-website release**. Issue #8 still requires the explicit
external provider/deployment enforcement decision; #1/#8 and overall #16
acceptance must not be closed or relabelled complete.
