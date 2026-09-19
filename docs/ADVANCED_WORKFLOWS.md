# Advanced controlled workflows (layer 07)

These controls operate on actual owner-scoped runs, worker jobs and registered
evidence. They do not enable arbitrary websites: release gate #8 remains open.
Fresh browser state is the default on launch, rerun and every reproduction
candidate. See [CONTEXTS.md](CONTEXTS.md) for explicit returning-user selection,
provider persistence uncertainty, exclusive holds and retirement.

## Exclusive managed human control

Open a live viewer, then explicitly request control. A successful request is
**not** acknowledgment that the agent paused. The durable phases are:

`agent -> requested -> quiescing -> human -> handback -> resuming -> agent`

The current worker drains already-dispatched browser and inference work before
acknowledging `human`. An in-flight decision invalidated by the request is
discarded, but its attempted inference still consumes the shared model budget.
No new agent decision, evaluation or action is dispatched during acknowledged
human control. Handback waits for outstanding managed viewer grants to expire;
the agent then takes a fresh observation instead of replaying its stale decision.

Only the requesting tab's random controller identifier can receive an
interactive viewer grant. Other tabs remain read-only. Grants last at most
1.5 seconds and must be renewed while control remains acknowledged; managed
iframe pointer and keyboard interaction are disabled when authorization expires.
Frame availability or a frame load event is never a pause acknowledgment.
The human window is at most 60 seconds. Browser TTL, occupancy and spending
continue throughout the pause; there is no indefinitely paid paused browser.
Cancellation, worker lease loss and owner expiry revoke managed control.

Commands require the owner cookie, exact Origin, CSRF token, durable
`Idempotency-Key`, controller identifier and expected state version. Duplicate
commands return current safe state rather than replaying an old interactive
grant. A competing tab or stale state version cannot seize control.

The application records fixed actor-attributed phase events and human intervals,
not human keystrokes or a detailed human action trace. Page content remains
untrusted; passwords and raw typed secrets must not enter these markers.
Screenshots and provider recordings can still contain sensitive pixels and
retain their separate owner/consent protections.

**Trust boundary:** this is exclusive control inside the managed application,
not provider-wide access revocation. A trusted operator using an external
Browserbase dashboard or retaining a provider control link operates outside
this boundary. No provider support for revoking all copied links or for mobile
keyboard behavior is claimed.

## Immutable scoped reruns and comparisons

From a settled report, select source attempts and explicitly authorize a fresh
rerun. The child copies immutable persona snapshots, goals, full criteria,
navigation scope and execution limits. Editing/deleting today's persona profile
does not rewrite either attempt. Contexts, live URLs and provider references are
not inherited. The supported explicit scenario change switches the controlled
store between `second-coupon` and `fixed`; it does not permit arbitrary scope
expansion or a different website.

Rerun admission retains the durable same-body idempotency contract. The report
UI saves its nonsensitive canonical pending request and key, bound to the
current owner, so lost replies/reloads reconcile one child rather than silently
paying for another. A changed owner cannot replay the saved request.

Comparison requires actual parent/child lineage and compatible `report-v1`,
`finding-v2` and `criterion-v1` contracts. Full criterion definitions, including
current/milestone semantics, and exact navigation scope must agree. Private
original normalized page/control identities determine hashes; redacted display
text is not identity. Unknown-page signatures remain attempt-specific.

Results distinguish `persists`, `confirmed_fixed`, `not_observed`,
`not_comparable` and `new`. Group absence alone is **not** a fix.
Positive comparable tested coverage is required; cancelled, infrastructure,
inconclusive, unsupported, unobserved, settling and unknown-cleanup outcomes do
not confirm resolution. Human-assisted attempts are identified and are not
clean automated repair proof. Eligible, tested and not-tested cohorts remain
visible, with all five criterion states. A criterion unmet, a trusted verified
fixture defect, a diagnostic, a performance signal and subjective friction
remain separate categories.

## Supported regression export and bounded reduction

The implemented automatic workflow is intentionally narrow: the controlled
store's second-coupon defect, grounded in recorded actions and independently
checked with `second-coupon-error-and-missing-discount-v1`. It is not a general
website recorder, a model-generated arbitrary script or a replay of human
actions. Its finite vocabulary is applying the public synthetic `SAVE10` and
`COZY5` coupons and bounded waits.

Preparation reads registered private action/observation artifacts and rejects
missing, ambiguous, unsupported, human or destructive histories. Secret-
dependent setup is explicitly non-replayable; it never substitutes a fake
value or creates a passing TODO assertion. Public exports contain only a
validated finite recipe and fixed repository helper import, not arbitrary
selectors, source URLs, raw typed values, cookies, API keys, provider IDs or
signed links. JSON serialization handles code-string escaping; no model string
is evaluated.

Unsettled source attempts return a retryable conflict without consuming their
one lifetime workflow record. The inherited scope must allow both fixed setup
pages before preparation can queue a candidate. The current loader also
conservatively refuses every attempt in a source run containing any acknowledged
human interval; it does not pretend to reconstruct missing human actions.

The owner explicitly authorizes reduction before its durable outbox can queue
paid work. Production caps are **three candidates, 90 total charged steps,
zero model calls, 240 seconds cumulative execution allowance and at most
60 seconds per candidate**, additionally bounded by normal worker TTL/policy.
The browser reservation ceiling is three times the persisted session TTL
(at most 900 seconds). These are ceilings, not a promise to use every candidate.
The status response exposes the actual saved limits and charged totals.
The 240-second wall deadline includes queueing, startup and cleanup; each
candidate additionally has its TTL-derived deadline. Its separate replay timer
starts after startup and is clamped to remaining time with cleanup headroom.
The inherited worker/attempt step cap includes all three setup actions and is
checked before candidate browser reservation and again by the runner.

Each candidate gets a fresh immutable child attempt and a normal fenced worker
job. Its full browser reservation commits before dispatch. Failed/unknown
attempts count, and refunds never replenish cumulative workflow or worker
lifetime caps. Cancellation, uncertain environments and uncertain remote
closure stop the workflow. Restart recovers the same outbox and candidate/job
association rather than allocating a replacement for an unknown launch.
The runner performs only fixed controlled fixture setup and supported coupon
steps; it invokes no persona inference or purchase operation.

A bounded deletion search reports the **shortest path found**, never global
minimality. A candidate qualifies only through the same independent failure
predicate, not merely any exception. The generated test includes fresh controlled
fixture reset/seed and the expected fixed behavior assertion. Save it at its
documented repository path, then run the same test with:

```sh
FF_REPRO_VARIANT=broken npx playwright test tests/e2e/coupon-regression.spec.ts
FF_REPRO_VARIANT=fixed npx playwright test tests/e2e/coupon-regression.spec.ts
```

The first must fail with the specific coupon failure; the second must pass.
This executes the real local Chromium fixture without a provider key or public
target network access. Other planted problems and general action histories
remain unsupported, not silently relabelled reproduced.

## Operations and evidence

Use the normal [worker startup and recovery policy](WORKER.md). Context holds,
takeover phases, rerun lineage, reproduction outboxes and their job mappings
live in the same single-host WAL/FULL SQLite database. Keep private artifacts
and that database together; do not delete ledgers to reset caps.

Ordinary tests are offline. Provider-backed context restoration and live
takeover require separate explicitly capped acceptance; local browser tests
alone are not proof that Browserbase saved a profile. No live acceptance is
implied by this capability description. The delivery ledger records actual
proof, failed acceptances, cumulative reservations and independent closure.

### Explicit advanced rehearsal

`npm run advanced:integration -- --offline-preflight` exercises the real HTTPS
owner UI, durable queued admission/cancellation, unchanged owner identity after
local server restart and actual grounded local-driver preference observation.
It starts no worker and performs no provider operations. Results and image
inventories live privately beneath ignored `data/advanced-rehearsal/`.

Paid mode is separate: `npm run advanced:integration -- --confirm-paid`.
It refuses missing, expired or source-mismatched `approval.json`. Only the
coordinator may write that private receipt after actual lint/types/tests/build,
offline preflight and independent review pass for its source digest. Approval
expires after 15 minutes; rerun offline gates after substantive changes rather
than copying an old digest. The harness never manufactures approval.
The fingerprint covers executable configuration, public assets, browser tests
and CI inputs as well as application code. `npm run build` wraps the real Next
build, rejects source changes during compilation and records a source/output
receipt. The harness verifies actual build and linked dependency bytes before
starting; a stale `.next` tree cannot stand in for the approved source. This
verification requires a Git checkout; ordinary application serving does not.

The planned invocation is three 300-second sessions, sequentially saving and
observing a controlled nonsensitive preference through acknowledged human UI
control/handback, explicitly returning, and creating a fresh immutable rerun.
Its durable lifetime new-reservation ceiling is 3,600 seconds, with the prior
985 seconds reported separately. Maximum concurrency is three; failures count
and refunds do not reset the lifetime ceiling. No automatic paid retries or
extra reproduction browsers are added to this journey.

Actual adapter-operation intervals are audited against durable human-control
intervals. An absence of action events is not used as proof that no inference
or browser operation was still in flight. Final acceptance additionally requires
provider closure readback for the exact correlated persisted set, observed
state contrast, context retirement and private desktop/mobile image inspection.
The public console emits fixed outcomes/counts, never provider IDs or URLs.
`ERROR` and `TIMED_OUT` remain terminal, accountable failure evidence, but never
satisfy successful proof: every correlated session must independently report
`COMPLETED`. A separate cumulative context/operation inventory includes prior
failed invocations. Retained contexts, unknown creation/deletion or outstanding
holds block another paid invocation and clean completion until reconciled.

After inspecting every listed private PNG, the coordinator writes the exact
hashed `image-inspection.json` receipt in the original invocation directory,
then runs `npm run advanced:integration -- --resume ORIGINAL-UUID`. Resume starts
no worker or application process: it verifies the original genuine owner cookie
against its persisted owner binding, performs read-only final provider
verification, and checks unchanged browser and context inventories. It cannot
create/cancel a run,
allocate a browser, mutate a context or rewrite ownership. The mode-600 owner
credential in its mode-700 UUID directory is bounded to 8 KiB, rejects symlinks,
retains its original nonrenewing 15-minute expiry, and is removed after success
or expiry. After paid browser/local-server cleanup, the original command releases
its invocation lock but remains alive as an attached, bounded credential guard.
Run read-only resume separately while that guard waits; it exits when the
credential is consumed, or deletes it at the original deadline if abandoned.
SIGINT/SIGTERM also removes it. No detached daemon, new browser or provider
operation is used by the guard. Forced process termination or host failure cannot
execute cleanup; reconcile and remove any remaining private file before
continuing. Expired credentials cannot be renewed to manufacture acceptance.
Common signal handling unwinds offline/resume work, stops only owned subprocesses
and removes the owned lock rather than leaving a listener after interruption.

### Layer07 acceptance record

The reviewed implementation passed 1,958 unit/API tests, 103 Chromium tests,
lint, type checking, the verified production build, actual HTTP/SSE checks and
the HTTPS owner/restart preflight. Independent focused reviews covered contexts,
takeover, rerun/comparison, reproduction and the capped proof harness. Findings
were corrected and re-reviewed before provider admission.

The real offline production-path check runs a broken source through the normal
worker and private artifact writer, prepares reproduction through the owner API,
restarts the repository, and executes three fresh candidate browsers through the
durable outbox and reservations. Candidates use zero model calls. A fresh,
immutable fixed child uses the same criterion and scope and independently
confirms the repair; all five local browsers close. The identical generated
regression fails the broken coupon predicate and passes the fixed fixture.
This is actual local Chromium evidence, not a claim of paid reproduction or
support for other failure/action types.

Before the first provider allocation, one harness invocation exposed a
`@next/env` dynamic-import interoperability error; two diagnostic reproductions
disabled every SDK request. Static configuration loading and an actual-process
regression corrected it. A subsequent admission correctly rejected a missing
explicit project ID. All stopped with zero browser reservations and zero
resource mutations. Separately authorized configuration discovery performed
one bounded, no-retry, read-only project-list request, found exactly one project,
and saved its ID only in ignored mode-600 local configuration.

The first allocated attempt reached acknowledged human control, changed the
synthetic preference through real browser UI, and recorded handback. It then
failed infrastructure acceptance: the proof harness disconnected its extra CDP
attachment before the worker resumed. With `keepAlive:false`, Browserbase ends
the shared session on disconnect. Independent readback confirmed that exact
session `COMPLETED`, with **10.990 actual browser seconds, 300 lifetime reserved
seconds and zero model calls**. No returning or fresh-rerun browser was launched.
The context was correctly quarantined rather than falsely declared reusable.

The corrected harness ends simulated-human command authority on handback while
retaining the passive owned attachment until worker settlement/cleanup. It does
not enable keep-alive or change production TTL. Cleanup ordering, including
worker/observer failures, has regressions and independent review.
The watchdog also drains any outstanding authorization refresh before handback,
including a deferred failure response; no late refresh can disconnect a browser
that has already resumed. Human-control receipts distinguish command authority,
passive connection lifetime and post-worker disconnection confirmation.
After a fresh independent `COMPLETED` read, explicitly authorized operator
cleanup verified the original genuine owner, revoked the failed context through
the normal service and received provider deletion confirmation. Its operation
ledger remains immutable; the uncertain saved state was never reused.
The 300-second charge remains in the cumulative ledger. The private original
credential was removed and the failed invocation's attached guardian exited.
Provider deletion acknowledgment is not a claim of immediate physical erasure
from provider backups.

The next three-session proof was also rejected, not retried automatically.
Save/human handback completed, and persisted DOM state distinguished remembered
from fresh, but returning/fresh screenshots were identical: the native
disclosure remained collapsed while the driver's rectangle-only visibility
check exposed its hidden text and controls. This was a generic observation bug,
not a persistence failure. The correction uses native rendered visibility before
existing viewport/clipping checks and grounds the visible native summary.
Real Chromium regressions first failed, then passed for closed/open/closed
disclosures (both wrapped and direct text), nested open content under a closed
ancestor, skipped rendering, hidden input values, exact/contains criteria and
bounded evaluator input. The actual text node, not merely its visible parent
container, must belong to the first summary subtree when a disclosure is closed.
The proof does not force the disclosure open or weaken screenshot comparison.

Independent readback confirmed all three sessions `COMPLETED`: save **18.881s**,
returning **9.849s**, fresh **9.711s**. All had zero available model token usage.
The second context was owner-revoked and provider deletion confirmed without a
replacement browser. Both failed proof invocations remain in the cumulative
ledger: **four sessions, 49.431 actual seconds, 1,200 lifetime reserved seconds,
two context creations and two confirmed deletions**. The three returned success
outcomes are not accepted as visible-text proof because of the discovered bug.

The final functional proof passed without another implementation change:

| Allocation | Purpose / acceptance | Actual browser seconds | Lifetime reservation |
| --- | --- | ---: | ---: |
| 1 | Rejected: CDP disconnection interrupted handback | 10.990 | 300 |
| 2 | Save succeeded; whole invocation rejected by later screenshot contrast | 18.881 | 300 |
| 3 | Rejected visible-state evidence from collapsed returning disclosure | 9.849 | 300 |
| 4 | Rejected visible-state evidence from collapsed fresh disclosure | 9.711 | 300 |
| 5 | Saved remembered marker; acknowledged real UI control and fresh handback | 18.979 | 300 |
| 6 | Same-owner/exact-scope returning context; agent opened disclosure; remembered pixels | 20.945 | 300 |
| 7 | Immutable fresh rerun; agent opened disclosure; fresh pixels and compatible comparison | 17.744 | 300 |
| **Total** | **Exact seven-session set independently COMPLETED** | **107.099** | **2,100 / 3,600 cap** |

The final human interval lasted 6.956 seconds and ended by explicit handback.
Actual adapter entry-to-settlement auditing confirmed no agent operation
overlap; the resumed agent obtained a new observation. The returning and fresh
agents each performed a grounded disclosure click rather than reading hidden
DOM. Original parent snapshots/events remained unchanged; the comparison had
one compatible, actually tested, confirmed-met criterion. The human-assisted
save was excluded from automated repair comparison.

Available metrics total **8,523 prompt tokens and 570 completion tokens**
(zero reported reasoning tokens), using `google/gemini-2.5-flash`; these are
usage counters, not an invoice. Peak observed concurrency was one, below the
limit of three; every session reserved a 300-second TTL. The prior conservative
985-second external baseline was separate and never replenished. Adding this
layer's actual usage to 984.674 prior tracked seconds gives **1,091.773 tracked
project seconds**, with **1,092** as the next conservative external baseline.
The provider project counter moved from 25 to 28 browser minutes during the
final three-session invocation; it is not substituted for exact durations.

All **three context creations** have **three confirmed provider deletions**;
the cumulative inventory contains no active holds, retained remote IDs or
unknown creation/deletion operations. The earlier uncertain session-settlement
record is preserved rather than rewritten. The observed localStorage restoration
does not turn the provider's unacknowledged persistence delay into a readiness
guarantee, and does not imply sessionStorage restoration.

All eight private original PNGs were visually inspected: four actual marker
captures plus desktop/mobile wall and report pages. No blocking layout,
overflow or privacy problem was found. Minor presentation limitations remain:
settled walls retain their last-action commentary, and reproduction eligibility
copy is conditional rather than tailored to every ineligible report.
The original owner's nonrenewing credential then passed the separate
**read-only resume**, with `paidProofPassed:true`, exact independent `COMPLETED`
readback and unchanged session/context inventories. Resume made no allocation
or resource mutation. Every proof credential, owned worker/server and invocation
lock was removed; the attached guardian exited. Initial paid mode's exit code
2 denotes its deliberate inspection/resume handoff, not the final result.
