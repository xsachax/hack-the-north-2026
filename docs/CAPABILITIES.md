# Release capability audit

This is a controlled-site implementation, **not completion of the public-website
product**. Issue #8 blocks arbitrary authorized targets and overall #1/#16
release acceptance. Configuration readiness and passing fixture tests are not
provider connectivity, a worker heartbeat, or public-site network enforcement.
The launch UI exposes these limits before paid admission.

Paths below are repository-relative. `*.test.ts` runs in the offline Vitest
suite; browser tests are under `tests/e2e/`. Historical provider evidence is
explicitly attributed to the delivery ledger rather than claimed as a new
run of every feature on the release head.

| Capability | Implementation | Actual regression / evidence and limit |
| --- | --- | --- |
| Authorized URL, scope and objective input | `src/lib/contracts.ts`, `target-scope.ts`; `src/server/target-policy.ts`, `api.ts` | `target-policy.test.ts`, `api.test.ts`, `launch.spec.ts`; validates/stores public requests but worker blocks them before allocation |
| Real controlled execution | `src/lib/controlled-sites.ts`; `src/server/execution/cloud.ts`, `fixture-network.ts` | `controlled-api.test.ts`, `cloud.test.ts`, `controlled-sites.spec.ts`, `controlled-worker.spec.ts`; store and board only; historical cloud board proof in WORKER.md |
| Predefined and saved custom personas | `src/lib/personas.ts`, `contracts.ts`; repository/API; `src/components/persona-editor.tsx` | `repository.test.ts`, `api.test.ts`, `launch.spec.ts`; immutable attempt snapshots, bounded persona data not executable prompts |
| One-key model decisions | `src/server/execution/gateway.ts`, `budget.ts`, `loop.ts` | `gateway.test.ts`, `budget.test.ts`, `loop.test.ts`; real Gateway `google/gemini-2.5-flash` evidence in EXECUTION.md/WORKER.md, no invented generic model endpoint |
| Perception and actions | `src/server/execution/driver.ts` | `execution-driver.spec.ts`, `controlled-sites.spec.ts`, `contexts.spec.ts`; DOM plus screenshot input, visible grounded actions; native visibility/disclosure checks; not screenshot-only perception |
| Navigation, click, fill, select, back, scroll, wait, keyboard | Driver's finite action switch and scope guard | `execution-driver.spec.ts`; current measured candidates, bounded keys and waits; pointer disabled for keyboard-only persona |
| Mobile and network behavior | Viewport settings in cloud factory; driver policy | Phone-sized viewport, not device emulation. No network throttling/offline emulation; a slow fixture is not a simulated connection |
| Tabs, frames, dialogs, files | Driver and fixture transport | `controlled-sites.spec.ts`, `execution-policy.spec.ts`; extra pages/frames denied, dialogs dismissed, downloads cancelled; uploads and clipboard unsupported |
| Structural criteria | `src/lib/criteria.ts`; `src/server/execution/evaluator.ts` | `evaluator.test.ts`, real controlled-site/worker browser tests; literal observed URL/text/control checks, not arbitrary selectors/code |
| Semantic criteria | Gateway/evaluator/loop | Grounded positive/negative real board evidence in WORKER.md; `evaluator.test.ts`, `gateway.test.ts`; provenance checked, entailment and confidence heuristic; semantic caching disabled |
| Criterion state and shared model budget | Criteria contracts, budget and loop | `loop.test.ts`, `budget.test.ts`; met/not_met/not_observed/inconclusive/unsupported; failures/discarded calls count with decisions and evaluations; not a token invoice |
| Console, network, performance and CDP | Driver telemetry and private artifacts | `artifacts.test.ts`, report aggregation tests; fixed bounded diagnostics/numeric counters, not arbitrary CDP or an HTTP-error-equals-bug classifier |
| Accessibility | Keyboard actions and accessible application controls | Keyboard/UI browser tests only; **no general accessibility evaluator or WCAG scanner**; report category is reserved, not generated coverage |
| Paid concurrency, budget and lifetime | `src/server/worker/repository.ts`, `runtime.ts`, `config.ts` | Worker repository/runtime/process tests; durable preallocation reservations, current-lease fencing, no retry after unknown create; historical three-session overlap in WORKER.md |
| Cancellation, restart and uncertainty | Worker, cloud recovery and loop | Worker/cloud tests, `event-stream.test.ts`, HTTP smoke; drains inference, cleanup can fail, remote uncertainty retains money/capacity; no undo of already-dispatched actions |
| Owner isolation, CSRF and access gate | `src/server/api.ts`, repository | API/report/replay/workflow negative tests; shared deployment code plus opaque seven-day owner cookie, not named accounts or recoverable identity |
| Live wall and resumable events | `src/components/run-wall.tsx`; event stream/repository | `live-wall.spec.ts`, `event-stream.test.ts`, HTTP/SSE smoke; actual ordered events and at most three viewers, no fabricated progress or footage |
| Evidence reports and grouping | `src/server/reports/service.ts`, `aggregate.ts`, `exports.ts` | Report API/aggregation/artifact tests and `reports.spec.ts`; persisted citations and explicit tested/not-tested cohorts; no conversion predictions |
| Bug discovery | Trusted store second-coupon verifier | Real planted second-coupon failure in EXECUTION.md/WORKER.md. All six fixture defects have deterministic tests, but **only second-coupon has verified autonomous discovery**; the others are not claimed found |
| Protected screenshots and exports | Artifact writer/reader and report exporters | Artifact/API negative tests; owner-only MIME/path/symlink/size bounds, text redaction and escaped downloads; screenshot pixels are sensitive, not redacted |
| HLS recording playback | `src/server/reports/replay.ts`; `src/components/recording-evidence.tsx` | Replay/API tests and `reports.spec.ts`; exact operator CDN origins, public DNS pin, TLS/no redirects, per-owner/attempt consent; layer08 genuine-owner 135-frame decoded proof on the reviewed packaged path. Historical 119-frame layer06 proof predates later identity correction |
| Returning contexts | `src/server/workflows/contexts.ts`, `context-provider.ts` | Context/API tests and `contexts.spec.ts`; layer07 real localStorage contrast, owner/exact-scope durable holds, three creations/deletions; ten-second eligibility is not provider save acknowledgment; no sessionStorage restoration claim |
| Human takeover | `src/server/workflows/takeover.ts`; loop and wall | Takeover tests and `takeover.spec.ts`; real layer07 UI control/drain/no-overlap/handback in ADVANCED_WORKFLOWS.md; bounded app-managed grants, not provider-wide link revocation or human keystroke recording |
| Immutable rerun and comparison | `src/server/workflows/rerun.ts`, `comparison.ts` | Workflow/API tests, `reruns.spec.ts`, `advanced-worker.spec.ts`; report-v1/finding-v2/criterion-v1, exact definitions/scope and confirming positive coverage; absence alone is not fixed |
| Reproduction export and reduction | `src/server/workflows/reproduction.ts`, `reproduction-runner.ts` | `reproduction.test.ts`, `reproduction.spec.ts`, `advanced-worker.spec.ts`; real generated broken-fail/fixed-pass local test and three fresh budgeted candidates; second-coupon only, zero model calls, shortest found not global minimum |
| Deployment and storage | Single-host Node, SQLite WAL/FULL, app and worker | See DEPLOYMENT.md for actual packaging validation, health, startup, migrations and rollback. No serverless/ephemeral/network-volume or horizontal-scaling claim |

## Six planted problems: discovery versus fixture correctness

The six independent switches and deterministic assertions are documented in
[DEMO.md](DEMO.md). A passing broken/fixed browser fixture regression proves the
configured synthetic behavior, not that a model independently discovered it.
Second-coupon has real autonomous failure evidence and the supported regression
oracle. All five other planted defects remain **not verified as autonomously
found**. Ordinary exceptions, unmet criteria, persona abandonment and slow
requests retain their distinct report categories.

## Release boundary

Historical layer03-07 proofs are preserved, including rejected attempts and their
costs. Layer07's accepted provider proof source fingerprint predates its final
test-only report clock synchronization; layer06 playback predates finding-v2.
Do not rewrite source attribution or recreate deleted owner credentials.
The layer08 rehearsal records its own source/build, actual owner/media proof and
non-replenishing ledger separately.
Its reviewed runtime revision is `a5de2ba`: two personas independently reached
the planted second-coupon failure, a third session was actively cancelled, and a
selected immutable fixed rerun confirmed improvement. The cited criterion states
were the supported **legacy coupon milestone** (`not_met`, `not_observed`,
`met`), not a fresh demonstration of arbitrary semantic evaluation. General
semantic provider evidence remains the explicitly attributed layer04b board
proof. Ten private screenshots and the playable local backup video were
inspected; no new context/takeover/reduction proof or all-six-defect discovery is
claimed. See [layer08 accounting](WORKER.md#layer08-release-rehearsal).

The refreshed [#8 provider/operator checklist](EXECUTION.md#layer08-prerequisite-refresh-2026-09-19)
is a required external decision. Neither this audit, a secure container nor
fixture routing establishes arbitrary-site egress enforcement.
