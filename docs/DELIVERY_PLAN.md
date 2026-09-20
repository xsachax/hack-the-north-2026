# Flash Flood delivery plan

Owner: coordinating agent in the Browserbase project foundation session.
Repository: `xsachax/hack-the-north-2026`. Tracking issue: #1.
Started: 2026-09-19.

## 1. Product contract

Flash Flood lets an authorized tester enter a website, describe objectives and evaluation criteria, choose predefined or custom personas, and watch independent cloud browsers attempt scoped tasks. Each persona gets a category, path or explicitly selected subdomain, not an instruction to crawl an entire website.

The starting experience is a centered prompt with optional configuration. The backend comes first; a later visual pass can refine character art and animation. The live wall must show real browser activity and truthful lifecycle states, not simulated progress. Detailed logs and reports must remain accessible after a run.

Done means a fresh checkout can run the application and worker, create a real multi-persona Browserbase run, observe it live, cancel it, inspect persisted evidence and grouped reports, and rerun a scoped task. It also means regression CI and operational documentation work without personal machine state.

Not a promise: testing every possible browser behavior, detecting every vulnerability, predicting conversion, or proving globally shortest reproductions. Feature support must be explicit. Infrastructure errors, inaccessible targets and budget exhaustion are not target-site bugs or success.

### Remaining #8 integration; hosted acceptance deferred

The native-policy baseline (#22) and bounded public HTTP broker (#23,
`eb0ac1b31a554f99f5615a40f25bbb5467b2b2eb`) are merged prerequisites, not public
product acceptance. Checkpoint #24 is merged at
`ccb57a7929c37b9329e1aee0b9305af4c256ed66`. This integration preserves its
durable worker contracts, explicit immutable API opt-in, UI capability gates
and private resource reconciliation while replacing unsafe SDK cleanup. After
the merge of #25 and explicit authorization for genuine testing, the implemented
public path is a hosted-validation candidate. Operator enablement remains
default-off; source readiness never substitutes for native session attestation.
Unversioned historical website requests never become executable retroactively.

The initial public surface is fresh-profile, read-only HTTP navigation/assets,
not every website channel or the controlled advanced workflows. Native policy
is the deny boundary; interception supplies only supported functionality.
Checkpoint completion requires consolidated unit/build/API/worker/browser/Linux/
container regressions and focused review. A genuine external objective, hosted
native conformance, correct usage and independently confirmed closure remain
requirements of the **public-execution acceptance plan**, not claims of local tests.
Native-only or synthetic routing success cannot satisfy #8. The native factory
now integrates metadata-only connection and an exclusive SDK worker: actual
thread exit settles inner retries before listener/CDP retirement. It preserves
branded one-key/session attribution without invoking SDK browser close methods.
The socket-monitor prototype is not a production lifecycle dependency. No merge
authority is implied by testing, and this integration must not close #1/#8/#16.

The owner subsequently authorized repeated genuine tests with a 100-hour total
ceiling. Provider usage must be reconciled before allocation; retain historical
accounting and conservatively carry the complete former 1,800-second reservation
allowance rather than resetting it. The first batch retains a smaller 1,800-second
non-refundable reservation cap. Source/package/harness/archive/ledger receipts
remain bound to each invocation. Default proof concurrency is one, maximum two,
TTL <=300 seconds, with no automatic allocation retry. Credentials and operator
flags alone are still not authorization.

The follow-up product ceiling is eight agents, with conservative concurrency
defaults retained. This does not raise the separate proof concurrency or lifetime
spending ceiling. The guarded public integration command now prepares an offline
plan from the existing authoritative worker ledger, binds both harness and clean
package inputs, and has an approval-gated Browserbase/API/worker/wall/report
runner. Its source gate now permits the opt-in candidate. No hosted goal has been accepted and
no OpenAI key is needed by the current one-key Gateway path.

## 2. Architecture and invariants

| Layer | Responsibility | Invariants |
| --- | --- | --- |
| Next.js application | Prompt, persona editor, live wall, logs, reports and HTTP API | No Browserbase credentials in client code; no paid work during rendering |
| Shared contracts | Runtime-validated personas, objectives, scope, runs, attempts, events, evidence, findings | One canonical representation across API, worker and UI |
| Durable storage | SQLite runs/jobs/events and private filesystem artifacts | Transactional transitions, restart recovery, monotonic event IDs, owner-scoped reads |
| Node worker | Lease jobs, launch persona attempts, enforce concurrency and quotas | Cancellation and cleanup work after errors; no duplicate paid launches |
| Browser driver | Stagehand v4 primitives, Browserbase lifecycle and browser/CDP evidence | Fresh sessions by default; explicit capabilities and target scope |
| Persona loop | Observe, decide, act, record, evaluate objective/progress | Goal-driven, bounded, no hidden DOM omniscience claims or invented success |
| Findings pipeline | Classify, group, aggregate, replay, export and compare | Every finding cites evidence; counts have denominators |
| Delivery/operations | CI, integration coverage, release runbook and deployment | No automatic paid tests on untrusted PRs; no secrets/artifacts in public logs |

Use a persistent Node deployment with a separate worker and a mounted data directory, not a short-lived serverless handler for agent loops. SQLite is the initial single-host database. Scale-out/distributed deployment is outside the first release.

### Target and action safety

- Require an explicit authorization acknowledgement before launch.
- Accept HTTP(S) targets only; validate hosts, DNS results, redirects, paths and configured subdomains. Block credentials in URLs, private/loopback/link-local/cloud-metadata destinations and unsafe protocols by default.
- Controlled local demo fixtures may use a narrowly configured development exception; this must not weaken production validation.
- Enforce scope on navigation and agent tools, not only in a model prompt. Browserbase's top-level domain restriction does not secure subresource traffic by itself.
- Treat page text as untrusted input. Do not let it alter objectives, tool policy, evidence storage, credentials or scope.
- No exploit payloads, destructive mutations, actual purchases, account deletion, authentication bypass or tests against unauthorized systems.
- Custom personas are validated data, not code or unrestricted system prompts.
- Paid launch endpoints need owner/session isolation, CSRF/origin defenses, rate limits, admission control and deployment access controls.

### Execution and spending

The user has authorized 100 Browserbase hours for the project. Keep a durable ledger of reserved and consumed browser seconds; the application cap must never exceed that allocation. Start with three concurrent sessions until actual account limits are confirmed. Reserve at least ten hours for final rehearsal and unexpected retries.

Agents pursue their objectives rather than sweeping a whole site. They can terminate with verified success, genuine persona abandonment, cancellation, scoped blockage, detected failure, or an explicit safety-limit/stall outcome. Separate persona patience from infrastructure time/step/token ceilings. There is no unbounded loop or automatic paid retry storm.

Report Browserbase duration and available model usage metrics. A browser-hour allowance is not a guarantee of free Model Gateway tokens. Default to a supported economical gateway model; do not equate the user's coding-agent subscription with downstream inference credits.

## 3. Sequential delivery layers

Each layer is one child session and one PR, except layer 00, which lands the existing foundation from the coordinator's current branch. Start the next implementation layer only after the previous one is merged. Children may use focused subagents for independently scoped work, but should not duplicate investigation.

| Layer | Deliverable | Dependencies | Required acceptance evidence |
| --- | --- | --- | --- |
| 00 | Flash Flood identity, existing foundation, this plan, CI and contribution gates | Existing empty main branch | Offline checks/build; existing real Browserbase smoke; no credentials in tracked files or client output |
| 01 | Validated domain model, custom persona contracts, SQLite repository, owner isolation, scoped run API and artifact policy | 00 | Schema boundaries; DB round trips and migrations; ownership failures; URL/scope/DNS cases; idempotent create/cancel contracts |
| 02 | Controlled demo store and deterministic browser fixtures | 01 | Six individually switchable planted problems; fixture reset; expected broken/fixed assertions; fake checkout only; demo permissions/path documented |
| 03 | Single-persona browser driver, gateway decision loop, objective evaluation and evidence collection | 02 | One real scoped persona reaches a fixture objective; one hits a planted bug; cancellation/error cleanup; supported browser capability tests; no invented outcomes |
| 04 | Durable job orchestrator, concurrency, restart/cancel recovery, spending ledger and resumable live events | 03 | Multiple personas in parallel; cap respected across workers; forced-restart and lease tests; disconnect/reconnect with no event gaps; budget reservation/release tests |
| 04b | Pluggable controlled-site drivers and arbitrary user-criterion evaluation on two controlled sites (#11) | 04 | Generalized execution without weakening public-egress gate #8 |
| 05 | Simple launch flow, predefined/custom persona selection, live browser wall and detailed interaction log | 04b | Real API-to-worker-to-wall flow; mobile/desktop rendering; queued vs active states; keyboard-accessible controls; cancelled and failed journeys |
| 06 | Per-agent reports, evidence-backed issue grouping, recordings and exports | 05 | Fixture failure signatures; deduplication without false merging; group rates with denominators; protected evidence/replay access; persistence after reload |
| 07 | Context reuse, human takeover, scoped rerun/comparison and reproducible test export | 06 | Context exclusivity; agent pauses during human control; safe handback; fixed bug disappears on rerun; generated reproduction replays the same failure |
| 08 | End-to-end hardening, capability audit, regression CI, deployment and release rehearsal | 07 | Full acceptance matrix; offline E2E CI; capped real multi-persona rehearsal; security review/remediation; clean installation; operational runbook |

A layer may be split if its diff cannot be reviewed confidently, but no layer is skipped or marked complete because a UI mock exists. Scope changes require a recorded reason, user-visible impact and updated acceptance criteria.

## 4. Browser capability matrix

Track implementation and tests per capability rather than advertising "all dev tools."
Enabled means implemented on the registered controlled sites, not public-target
support or an unqualified live acceptance claim. Layer07 provider proof remains
separately recorded in the accountability ledger.

| Capability | State | Verification/constraints |
| --- | --- | --- |
| Scoped navigation, links, back, scrolling | Enabled | Registered store/board only; path and transport guards; new pages denied |
| Mouse, phone-sized viewport, keyboard/focus | Enabled, bounded actions | Viewport sizing is not full device emulation or a general accessibility audit |
| Forms, validation, literal input | Enabled with synthetic fixture data | No real financial/destructive submissions; general clipboard workflows unsupported |
| Tabs/frames; dialogs | Tabs/frames unsupported; bounded dialog handling enabled | New-page/child-frame attempts explicitly blocked; no broad multi-tab capability |
| Console, exceptions, request status/timing | Enabled diagnostic evidence | A bare HTTP/console error is not a functional bug |
| CDP, screenshots, visible candidate grounding | Enabled | Gateway sees DOM plus screenshot, not screenshot-only input |
| Cookies/storage and Browserbase contexts | Explicit returning-state workflow enabled | Owner/exact-scope holds; fresh default; 10-second eligibility is not provider save acknowledgment |
| Downloads/uploads | Unsupported task actions | Protected evidence downloads are separate from website file workflows |
| Network throttling/offline emulation | Unsupported | Controlled delayed fixture responses are not network emulation |
| Browser recordings and live views | Enabled with explicit availability states | Owner/consent-protected HLS subset; exact operator CDN allowlist; account-gated fallback |
| Human takeover | Managed acknowledged exclusivity enabled | Bounded grants/window, drained agent work, fresh handback; interval markers, not detailed human actions or provider-wide revocation |
| Scoped rerun/comparison | Enabled | Immutable selected snapshots, exact criterion/scope/version, confirming coverage; absence is not a fix |
| Regression export/reduction | Controlled second-coupon only | Grounded finite actions, independent failure oracle, fresh reserved candidates, shortest found not global minimum |
| Arbitrary authorized public websites | Hosted-validation candidate; operator default off | Genuine hosted acceptance remains unproved regardless of #8's GitHub state; no unsafe opt-out or fixture substitution |

One-key Gateway persona decisions are proven through Stagehand v4's constrained
structured extraction. The implemented input is DOM plus viewport screenshot,
not screenshot-only/strictly viewport-only perception. That limitation remains
visible rather than being claimed solved by grounded action candidates. See the
[implementation/test capability audit](CAPABILITIES.md) for exact coverage.

## 5. Quality and review protocol

For every PR:

1. Link the delivery issue and relevant bug issues; include scope, design rationale, operational impact and test evidence.
2. Add regression tests with each behavior change. Use deterministic fake drivers for exhaustive lifecycle/loop/queue coverage and a controlled app for browser E2E.
3. Run lint, typecheck, unit/integration tests and production build. Add offline browser E2E to ordinary CI when the user flow exists.
4. Perform a rubber-duck review: explain the state machine, failure path, cancellation race, evidence trust boundary and one rejected alternative. Record this briefly in the PR.
5. Independently review substantial diffs for correctness. Request a dedicated security review for the safety/launch/evidence surfaces before release.
6. Resolve findings in the same PR, rerun affected tests, and wait for GitHub checks on the exact head commit.
7. Merge only when required checks pass and acceptance evidence exists. The user has authorized merges. Never bypass failed checks or branch protections.
8. Update this ledger with issue/PR references, results, known limits and the next layer. Start the next child from current main, not a stale worktree.

Regular CI never needs a live Browserbase key. Real-browser paid checks are explicitly dispatched on trusted code, with concurrency and elapsed-time limits, no public evidence uploads and reliable cleanup.

## 6. Final acceptance matrix

- A new visitor can enter an authorized URL, a category/path objective and evaluation criteria; defaults are useful without advanced configuration.
- Predefined personas and a saved custom persona both run; invalid custom input is rejected visibly.
- At least three personas can run concurrently when account quota permits; extra jobs queue honestly.
- The wall follows actual interactions. Each step records actor, time, URL, action, brief in-character commentary, screenshot/evidence references and outcome.
- Reconnecting the page preserves progress and logs. Restarting a worker does not duplicate launches or lose terminal states.
- Cancellation stops decisions and releases the remote browser. Timeouts, credit failure and navigation blockage have distinct reportable outcomes.
- Phone-sized viewport, keyboard-only and ordinary desktop behavior have controlled-fixture coverage. The originally planned slow-network behavior is **not implemented**; delayed fixture responses are not throttling or device emulation.
- Each of the six planted store problems has a deterministic regression test and an explicit found/not-found result in rehearsal. Never claim six found unless all six have evidence.
- Findings group repeated observations and show occurrence counts against actual attempts, while preserving per-agent reports and recordings.
- Human takeover does not race the agent. Returning-user contexts do not run concurrently.
- A scoped rerun compares stable finding signatures and distinguishes fixed, recurring and untested findings.
- A generated test reproduces a confirmed issue against the fixture. Reduction is bounded and reports the shortest path found, not an unproved global minimum.
- Private targets, cross-owner run/evidence access, CSRF, untrusted page instructions and public credential exposure have negative tests.
- Clean install, database initialization, app/worker startup, CI and container deployment are documented and rehearsed.

### Layer08 actual acceptance status

| Surface | Actual evidence | Status / remaining boundary |
| --- | --- | --- |
| Clean Node install and single-host container | Fresh locked installation/build, real supervisor HTTPS owner restart and paid worker; hosted nonroot/read-only image, private volume, CDP scratch, probes, graceful stop, migration and web-only backup restore | Verified; operator's external HTTPS/storage/provider installation still needs its own acceptance |
| Offline CI and failure matrix | 2,044 tests, 103 Chromium tests, HTTP/SSE and HTTPS preflights; missing credentials/quota/network, crash/unknown create, stale lease, cancelled inference, replay processing and ownership negatives traced in CI.md | Verified offline; does not claim each fault was recreated against a paid provider |
| Personas and criteria | Fresh two-persona cloud run with cited legacy coupon milestone; custom persona and structural/semantic board paths have actual browser regressions and attributed prior cloud proof | Verified within stated scopes; not fresh arbitrary semantic evaluation in layer08 |
| Actual wall, reports, private media | Two overlapping rendered cloud views, persisted steps/commentary/citations; genuine-owner HLS advanced and decoded 135 frames | Verified; peak2 here, historical layer04 peak3 is separate evidence |
| Cancellation and fixed comparison | Active session cancelled, selected immutable rerun succeeded with positive milestone and `confirmed_fixed` | Verified across four exact newly closed sessions |
| Contexts, takeover, reproduction/reduction | Layer07 remote/local evidence retained; final offline suites remain green | Historical proof plus current regressions, no new layer08 context/reduction allocations |
| Private backup, cleanup and accounting | Ten inspected PNGs and 218.88-second played/inspected local video; 1,200 lifetime reserved / 253.520 actual seconds, all four new sessions independently COMPLETED | Verified; backup includes honest idle/resize gaps, not continuous remote footage |
| Browser completeness | Tabs/subframes/uploads/throttling and general accessibility evaluation remain unsupported | Explicit limitation, not silently counted as implemented |
| Arbitrary authorized public website | Native Chrome proxy/privacy candidate now has maintained offline sentinel probes; actual remote enforcement, broker and public objective remain unproved | **Blocked by #8; overall #1/#16 release acceptance remains incomplete** |

## 7. Accountability ledger

| Layer | State | Issue / PR | Evidence / blockers |
| --- | --- | --- | --- |
| 00 | Merged | PR #2 | Foundation merged at `5080b1e`: 30 offline tests, production build, real Gateway smoke, completed remote session, desktop/mobile layout checks |
| 01 | Merged | Issue #3 / PR #5 | Merged at `b1264b0`: canonical contracts, private SQLite migrations/recovery, owner-scoped offline APIs, CSRF/origin/access-code gate, persisted limits and reusable URL/DNS/scope policy. 420 offline tests, lint/types, production build and built-app HTTP smoke passed; zero cloud calls. Layer 02 carries the later test-only persisted-corruption regression from `12f1225` (421-test baseline). See docs/API.md for limitations. |
| 02 | Merged | Issue #4 / PR #7 | Controlled gift store, six independent broken/fixed fixtures and tab-local reset/isolation. 439 offline tests, lint/types, production build, HTTP smoke and 18 Chromium E2E tests pass (36/36 repeated). Independent review found no significant issues. See docs/DEMO.md for fixture signatures, goal/scope handoff and cloud reachability. No deployment or paid calls in this layer. |
| 03 | Merged | Issue #6 / PR #10 | Merged at `8c8ee71`: typed driver/loop, one-key DOM+screenshot Gateway decisions, observed criterion checks, private artifacts, abort/cleanup and explicit bounded integration CLI. 773 offline tests, lint/types, build, HTTP smoke and 38 Chromium E2E tests pass. Real fixed success and planted coupon failure each took seven actions/decisions; all seven sessions including failed prototypes/retries remotely COMPLETED. Actual 350.240 browser seconds; conservative reservation 1,320 seconds. See docs/EXECUTION.md. Arbitrary-target execution remains disabled pending release blocker #8; fixture-only proof does not satisfy the full public-URL product requirement. |
| 04 | Merged | Issue #9 / PR #15 | Merged at `250447c`: durable Node worker, fenced claims, shared concurrency/budgets, bounded metadata recovery/quarantine, no-retry allocation, cancellation, protected demo admission, owner SSE and private evidence/session mapping. 1078 offline tests, lint/types/build, HTTP smoke and 38 Chromium E2E pass. Fixed success and planted coupon failure each proved twice with overlap; final cancellation-only corrective check clean. All seven sessions remotely closed, peak3; 364.272 actual seconds / 1680 conservative reserved (including two failed cleanup acceptances). Coordinator accounting fixes cover proven non-allocation refunds and monotonic per-session partial recovery charges. See docs/WORKER.md for root causes, exact accounting and limitations. |
| 04b | Merged | Issue #11 / PR #17 | Merged at `50b97e1`: reusable scoped driver/transport registry, custom structural and grounded semantic criteria, shared inference budget, explicit controlled admission and durable snapshots/results; two structurally different sites proven through the actual worker. 1,290 offline tests, lint/types/build, HTTP/SSE smoke and 48 Chromium E2E pass. Real custom board journey: four actions, grounded negative then positive with independent fixture oracle. Two sessions including rejected SDK-schema/taxonomy acceptance: both remotely COMPLETED, 124.158 actual / 600 cumulative reserved seconds of the 1,200-second cap, peak1; available 56,337 prompt / 4,690 completion tokens. See WORKER.md for the complete ledger and corrective evidence. Public-egress gate #8 remains enforced and separate; semantic judgment is heuristic, not deterministic proof. |
| 05 | Merged | Issue #12 / PR #18 | Merged at `b360daf`: original centered launch, explicit controlled/blocked website modes, custom persona CRUD, canonical per-assignment limits/criteria, durable pending-key recovery and owner-protected live wall. 1,341 unit/API tests, lint/types/build, actual HTTP/SSE smoke and 65 Chromium E2E pass; focused review findings fixed and cleared. First paid UI-originated two-persona proof passed: eight persisted actions, actual rendered Browserbase viewports, exact wall/log/terminal matching, both correlated sessions independently remotely COMPLETED. 92.838 actual / 600 lifetime reserved seconds of the 1,800-second cap, peak2, TTL300; 36,240 prompt / 2,207 completion tokens. Private desktop/mobile screenshots inspected, owned processes/locks stopped, zero unsettled launches. See WORKER.md for exact accounting; tracked project actual is now 943.908 seconds. #8 stays open. |
| 06 | Merged | Issue #13 / PR #19 | Merged at `321cd46`: deterministic persisted-source reports, private canonical finding-v2 identities, explicit attempt/persona cohorts, protected artifacts/HLS and safe exports. 1,636 unit/API + 86 Chromium tests, lint/types/build, real HTTP/SSE and authentic offline restart/resume pass. Coordinator's redaction-dependent identity finding fixed with versioned cache invalidation and cross-attempt regressions. Genuine-owner report/evidence/export and decoded HLS playback passed before that offline-only signature correction. Including the first harness failure: 40.766 actual / 600 lifetime reserved seconds of the 1,200 cap, both exact remote sessions COMPLETED, all owned processes/locks/credentials removed. Tracked project actual 984.674s; next external baseline 985. #8 remains enforced; REPORTS.md defines the layer07 comparison API. |
| 07 | Merged | Issue #14 / PR #20 | Merged at `4cd9dfc`. Owner/exact-scope contexts, drained acknowledged takeover/handback, immutable fresh reruns with coverage-honest comparisons, and finite controlled coupon regression/reduction. 1,958 unit/API + 103 Chromium tests, lint/types/verified build, HTTP/SSE and HTTPS restart preflight pass; focused correctness findings fixed and re-reviewed. Actual generated test fails broken/passes fixed; production outbox/restart executes three fresh local reduction candidates with zero model calls. Final paid save/returning/fresh contrast, actual human UI control/no-overlap/fresh handback, immutable comparison and eight-image inspection pass; genuine-owner read-only resume confirms the exact cumulative seven sessions COMPLETED. Including two rejected proof invocations: 107.099 actual / 2,100 lifetime reserved seconds of 3,600 cap, peak1, TTL300; 8,523 prompt / 570 completion tokens. All three contexts have confirmed provider deletion, all proof credentials/processes/locks removed. Tracked project actual 1,091.773s; next conservative external baseline1,092. See ADVANCED_WORKFLOWS.md for full ledger, failures and limits. #8 remains open/enforced. |
| 08 | Implemented; PR review; release blocked | Issue #16 / PR #21, refs #1/#8 | Clean Node and actual hosted nonroot/read-only container/private-volume/CDP-scratch/backup-quarantine validation; 2,044 unit/API + 103 Chromium tests, lint/types/build, HTTP/SSE and HTTPS preflights. Dedicated security and independent/coordinator corrections cleared. Reviewed runtime `a5de2ba` passed real two-persona second-coupon failure, active cancellation, selected fixed comparison and genuine-owner decoded HLS (135 frames). Ten private PNGs and 218.88-second backup WebM inspected; exact four new sessions independently COMPLETED, peak2, TTL300. Layer08: 253.520 actual / 1,200 lifetime reserved seconds of 3,600 cap; 125,058 prompt / 7,102 completion tokens available. Initial CLI entry failure allocated nothing and was corrected with an actual-command network-disabled regression. Project actual 1,345.293s; next baseline1,346. No further provider/model calls. Overall #16 release acceptance and #1/#8 remain open for the external no-bypass public-target decision; coordinator alone merges after final exact-head checks. |

The coordinator keeps session todos and child-session notifications in addition to this versioned ledger. Child sessions report changed files, checks, live-call usage, PR URL, unresolved issues and the exact next dependency. Long-running work is not considered complete when a child merely becomes idle.

### #8 follow-up: native-policy feasibility

The maintained MV3 policy and independent full-Chromium tests investigate an
alternative to externally hosted mandatory proxy infrastructure. Native Chrome
settings supply the proposed fail-closed connection boundary; a future worker
HTTP broker would supply functionality, not enforcement. Actual local Chromium
145.0.7632.6 positive/negative TCP/UDP controls are recorded in
[EXECUTION.md](EXECUTION.md#native-browser-policy-candidate-offline-phase-a).
No provider resources, model calls, public execution capability or renewed
spending allocation are implied. Full remote enforcement and a genuine scoped
public objective remain required; this follow-up references, not closes, #8.

PR #22's implementation revision `be1c18f` passed the full hosted check and
container jobs, nine native-channel browser tests, and the isolated Linux
private/link-local/IPv6/same-process DNS-change test. Local validation includes
2,065 unit/API tests, the preserved 103-test E2E baseline, production build and
HTTP/SSE smoke. The first namespace bootstrap (`96137d4`) failed before probes;
the accepted short private scratch path resolved it. Known-private-value scans
cover source and client build output. Security review found no reachable
vulnerability in the candidate; the identified worker-evidence gap was fixed,
and the native per-origin override guard has a reproduced UDP counterexample.
Coordinator final-head review/CI and merge remain separate from this evidence.
The standalone public HTTP transport is now a separate coordinated workstream;
neither piece independently enables the factory or satisfies #8.
