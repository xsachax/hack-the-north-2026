# Flash Flood delivery plan

Owner: coordinating agent in the Browserbase project foundation session.
Repository: `xsachax/hack-the-north-2026`. Tracking issue: #1.
Started: 2026-09-19.

## 1. Product contract

Flash Flood lets an authorized tester enter a website, describe objectives and evaluation criteria, choose predefined or custom personas, and watch independent cloud browsers attempt scoped tasks. Each persona gets a category, path or explicitly selected subdomain, not an instruction to crawl an entire website.

The starting experience is a centered prompt with optional configuration. The backend comes first; a later visual pass can refine character art and animation. The live wall must show real browser activity and truthful lifecycle states, not simulated progress. Detailed logs and reports must remain accessible after a run.

Done means a fresh checkout can run the application and worker, create a real multi-persona Browserbase run, observe it live, cancel it, inspect persisted evidence and grouped reports, and rerun a scoped task. It also means regression CI and operational documentation work without personal machine state.

Not a promise: testing every possible browser behavior, detecting every vulnerability, predicting conversion, or proving globally shortest reproductions. Feature support must be explicit. Infrastructure errors, inaccessible targets and budget exhaustion are not target-site bugs or success.

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
| 05 | Simple launch flow, predefined/custom persona selection, live browser wall and detailed interaction log | 04 | Real API-to-worker-to-wall flow; mobile/desktop rendering; queued vs active states; keyboard-accessible controls; cancelled and failed journeys |
| 06 | Per-agent reports, evidence-backed issue grouping, recordings and exports | 05 | Fixture failure signatures; deduplication without false merging; group rates with denominators; protected evidence/replay access; persistence after reload |
| 07 | Context reuse, human takeover, scoped rerun/comparison and reproducible test export | 06 | Context exclusivity; agent pauses during human control; safe handback; fixed bug disappears on rerun; generated reproduction replays the same failure |
| 08 | End-to-end hardening, capability audit, regression CI, deployment and release rehearsal | 07 | Full acceptance matrix; offline E2E CI; capped real multi-persona rehearsal; security review/remediation; clean installation; operational runbook |

A layer may be split if its diff cannot be reviewed confidently, but no layer is skipped or marked complete because a UI mock exists. Scope changes require a recorded reason, user-visible impact and updated acceptance criteria.

## 4. Browser capability matrix

Track implementation and tests per capability rather than advertising "all dev tools." The foundation currently implements cloud session launch, viewport sizing, Stagehand observe/act/extract, private live-view links, recording enablement and cleanup only.

| Capability | Intended use | Verification/constraints |
| --- | --- | --- |
| Navigation, links, back/forward, scrolling | Scoped task exploration | Path/subdomain policy; redirect and popup tests |
| Mouse, touch-sized viewport, keyboard/focus | Different interaction styles and accessibility checks | Viewport changes alone are not full mobile-device emulation |
| Forms, validation, typos, clipboard | Non-destructive input behavior | Fake data; no real financial/destructive submissions |
| Tabs, frames, dialogs | Realistic page interactions | Attach evidence listeners to new pages; dialog policy and bounded popups |
| Console, uncaught exceptions, network status/failures/timing | Bug and performance evidence | Preserve timestamps/context; expected 4xx is not automatically a bug |
| CDP, screenshots, visible-page inspection | Browser diagnostics and observation | Only supported SDK methods; screenshots are not proof of screenshot-only model input |
| Cookies/storage and Browserbase contexts | Returning-user scenarios | Fresh by default; context lock, ownership and persistence delay |
| Downloads/uploads | Fixture-backed browser flows | Private size-limited artifact paths and safe test files |
| Network throttling and offline behavior | Slow-connection persona | Feature-detect; restore settings; record actual applied capabilities |
| Browser recordings and live views | Evidence and live wall | Backend-protected access; release sessions; replay readiness handling |
| Human takeover | Judge comparison | Exclusive control and explicit actor attribution |

Screenshot-only/viewport-only decision grounding and general persona decisions through the one-key Gateway must be proven against Stagehand v4. If the gateway supports only page-conditioned extraction, implement a constrained structured decision path and document exactly what it sees. Do not invent an unsupported API or silently require another provider key.

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
- Mobile, keyboard-only, slow-network and ordinary desktop behavior are demonstrated on controlled fixtures.
- Each of the six planted store problems has a deterministic regression test and an explicit found/not-found result in rehearsal. Never claim six found unless all six have evidence.
- Findings group repeated observations and show occurrence counts against actual attempts, while preserving per-agent reports and recordings.
- Human takeover does not race the agent. Returning-user contexts do not run concurrently.
- A scoped rerun compares stable finding signatures and distinguishes fixed, recurring and untested findings.
- A generated test reproduces a confirmed issue against the fixture. Reduction is bounded and reports the shortest path found, not an unproved global minimum.
- Private targets, cross-owner run/evidence access, CSRF, untrusted page instructions and public credential exposure have negative tests.
- Clean install, database initialization, app/worker startup, CI and container deployment are documented and rehearsed.

## 7. Accountability ledger

| Layer | State | Issue / PR | Evidence / blockers |
| --- | --- | --- | --- |
| 00 | Merged | PR #2 | Foundation merged at `5080b1e`: 30 offline tests, production build, real Gateway smoke, completed remote session, desktop/mobile layout checks |
| 01 | In review | Issue #3 / PR #5 | Canonical contracts, private SQLite migrations/recovery, owner-scoped offline APIs, CSRF/origin/access-code gate, persisted limits and reusable URL/DNS/scope policy. 420 offline tests, lint/types, production build and built-app HTTP smoke pass; zero cloud calls. See docs/API.md for worker/network enforcement and identity limitations. |
| 02 | Pending | Pending | Depends on 01 |
| 03 | Pending | Pending | Gateway decision/viewport prototype is a gating technical risk |
| 04 | Pending | Pending | Must prove leases, cancellation and budget accounting |
| 05 | Pending | Pending | Backend functionality before visual polish |
| 06 | Pending | Pending | Evidence-backed classification, not claims based on model text alone |
| 07 | Pending | Pending | Bounded replay cost and exclusive human/context ownership |
| 08 | Pending | Pending | No release declaration until acceptance matrix is exercised |

The coordinator keeps session todos and child-session notifications in addition to this versioned ledger. Child sessions report changed files, checks, live-call usage, PR URL, unresolved issues and the exact next dependency. Long-running work is not considered complete when a child merely becomes idle.
