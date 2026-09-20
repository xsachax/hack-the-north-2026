# Flash Flood

User testing before you have users. A crowd of AI personas uses an authorized web app in real Browserbase browsers, with a live wall and evidence-backed bug and friction reports.

**Current phase: functional launch, owner-only live wall and persisted evidence reports, not the full MVP.** Enter a goal, choose a scoped target and select predefined or saved custom personas. The Next.js interface uses the canonical schemas, private SQLite persistence and owner-scoped APIs. The [worker runbook](docs/WORKER.md) covers separate app/worker startup, transactional quotas, fenced leases, crash reconciliation, cancellation, spending and resumable events. The [execution reference](docs/EXECUTION.md) describes the Browserbase/Stagehand Gateway loop and the distinction between structural checks and evidence-grounded semantic judgment. **Arbitrary-target execution remains disabled pending proven browser egress enforcement (#8).** The website mode saves an explicitly blocked intended request; the separate controlled-demo mode can queue paid work. No browser is launched inside an HTTP handler or during rendering.

## What works now

The new **Managed Agents MVP** is at `/managed`. It uses Browserbase's Agents
API, a separate owner-authorized queue and the same aggregate eight-agent
ceiling. It is default-off and restricted to operator-approved public origins.
Unlike the native path, Browserbase controls the tools: scope/read-only prompts
are **not network enforcement**, and there is no API-enforced model-call or
browser-time cap. See the [managed worker setup](docs/WORKER.md#managed-agents-worker-separate-mvp).
Genuine managed hosted evidence is still pending; this alternative does not
claim to satisfy the hardened arbitrary-target requirements of #8.

Native-path status after the third genuine public attempt on 2026-09-20; **public-URL MVP
acceptance has not passed**. PRs #25, #26 and #27 are merged.

| Surface | Actual state |
| --- | --- |
| Launch UI, scoped goals, criteria and personas | Implemented; owner API and browser regressions pass. New admissions are capped at eight agents. |
| Durable worker, live wall, reports and private evidence | Implemented and exercised on controlled sites; this is not proof for arbitrary public sites. |
| Real Browserbase upload, allocation and independent cleanup | Verified for three public-path attempts. All sessions closed and extensions deleted; 4.744 actual browser-seconds, 900 lifetime-reserved seconds counted. |
| Genuine public-site goal, model decisions and screenshot evidence | **Not working yet.** All three attempts stopped before observation, actions or inference. |
| Current hosted blocker | Browserbase reports Chrome `153.0.8010.53`; native validation covers `145.0.7632.6`. The third session also failed the trusted blank/extension bootstrap check. Neither restriction has been bypassed. |

`ENABLE_PUBLIC_RUNS` is still false by default. Enabling it selects a guarded
validation candidate, not a demonstrated working service. Historical blocked
requests never become paid jobs after enablement. See the [exact hosted
results](docs/EXECUTION.md#first-hosted-attempt-after-26).

The synthetic gift store at `/demo` supports browse/cart/fake checkout. Configure six independent broken/fixed variants and reset tab-local state at `/demo-fixtures`, outside the shopping flow. See the [fixture matrix and next-layer handoff](docs/DEMO.md) for deterministic setup, scoped objectives, evidence distinctions and authorized cloud reachability. No real purchases, accounts or payments.

A second, structurally different controlled site at `/project-board` supports
synthetic project creation. The same scoped driver and loop accept custom
personas, objectives and criteria through `/api/v1/controlled-runs`; this is an
explicit operator-gated registry, not a workaround for customer URL admission.
Natural-language results are heuristic judgments with checked observation
citations, not deterministic proof or calibrated confidence statistics.

The [delivery plan](docs/DELIVERY_PLAN.md) defines the architecture, sequential PR layers, acceptance gates, capability matrix and accountability ledger for the end-to-end build.

Layer04b (issue #11 / PR #17) and layer05 (issue #12 / PR #18) are merged.
Layer06 (issue #13 / PR #19) is merged with [owner-only reports and evidence](docs/REPORTS.md).
Layer07 adds [advanced controlled workflows](docs/ADVANCED_WORKFLOWS.md):
explicit private contexts, acknowledged managed takeover, immutable scoped
reruns/comparison, and supported coupon regression export/bounded reduction;
none of these changes declares that public-target gate #8 is solved.
The [capability audit](docs/CAPABILITIES.md) maps supported behavior to actual
implementation and regression coverage, and distinguishes cloud evidence from
offline fixture checks.
The [deployment runbook](docs/DEPLOYMENT.md) covers the private single-host
app/worker package, runtime secrets, probes, backups and rollback. The
[release rehearsal](docs/REHEARSAL.md) has a separate non-replenishing budget and
private recording/inspection gate. Shipping hardening does not clear #8 or
complete the original public-website release.

## Launch and watch

Surfer badges use the supplied eight-color idle/working sprites. A working loop
reflects a persisted running attempt, not proof of goal progress; stopped and
queued sessions stay idle. Reduced-motion preferences select static artwork.
Create a persona or customize a copy to start from **Security and privacy**,
**UX and usability**, or **Networking and perceived latency** templates.
Edit its character, reading style, patience, quirks and concerns, then set its
own goal and criteria. These specialties guide attention, not tool permissions:
security review is passive, and loading observations are not packet analysis,
throttling or a calibrated performance benchmark. Saved profiles are owner-only;
existing attempts keep their original persona snapshots.

Open `/`, unlock with the deployment access code if required, then choose **Your
website** or **Controlled demo** explicitly. Expand scope and criteria to narrow
navigation and add structural assertions or heuristic semantic checks. Each
selected persona can override the shared objective, criteria and bounded execution
limits. Custom profiles can be created, edited, deleted and selected; existing
attempts retain immutable snapshots. No provider key is entered in the browser.

The durable launch key and canonical pending request are kept together in this
tab's session storage before submission, bound to its owner. After an uncertain
reply or refresh, **Reconcile saved launch** replays the same request; it never
automatically retries a paid submission. Input is retained after validation or
transient errors. Access codes and live-view URLs are never stored there.
An owner-cookie change blocks replay instead of silently creating another run.
Closing the tab clears this local recovery record; check your saved runs before
starting another request. Anonymous owner cookies are not recoverable accounts.

`/runs/:id` reloads persisted attempts, events, summaries and authorized session
metadata. Open up to three live viewers; a queued attempt shows a placeholder,
not fabricated footage. Viewers are read-only until an explicit takeover
request is drained and acknowledged by the worker. Interactive grants are
bounded; handback resumes from a fresh observation, not a stale decision.
The wall follows resumable ordered events and keeps checking unresolved cleanup
after a terminal outcome. Cancellation intent is not proof of release;
infrastructure failure, recovery, quarantine and uncertain cleanup remain visible.
Criterion results retain all five states. **Reports & evidence** opens
`/runs/:id/reports`, with per-agent criteria, cited timelines, grouped findings
and explicit tested/not-tested cohorts. Reveal private screenshots deliberately:
their pixels are not redacted. JSON/Markdown exports retain evidence references,
not embedded private media or provider URLs. Recording availability and supported
playback limitations are explicit; see [recording integration](docs/REPLAY.md).

## Local development

Requires Node.js 22.18+ (22.x) and npm. `.nvmrc` pins the rehearsed runtime;
`.npmrc` rejects unsupported Node engines rather than silently installing on
an incompatible runtime.

```sh
nvm use
npm ci
npm run dev
# No .env.local or Browserbase key is needed for the offline API.
```

For the optional, paid cloud smoke only:

```sh
cp .env.example .env.local
chmod 600 .env.local
# Edit .env.local and add your Browserbase key.
```

If `.env.local` already exists, keep it rather than copying over it. Open http://127.0.0.1:3000. The app binds to loopback by default. `/api/health` is a liveness endpoint; it does not contact Browserbase. Safe capability booleans and operator ceilings are configuration, not proof of connectivity or a running worker. Controlled admission also requires `ENABLE_DEMO_RUNS=true`, a strong access code, and a separately confirmed worker; see [startup](docs/WORKER.md#clean-startup).

```sh
npm run check              # Lint, types, offline tests; no Browserbase credits
npm run build              # Production build; no Browserbase credits
npm run test:http          # Built-app offline HTTP smoke (run build first)
npx playwright install chromium --only-shell # One-time offline E2E browser setup
npm run test:e2e           # Production-server demo regressions (run build first)
npm run browserbase:smoke  # Paid, explicit integration check
# Paid persona fixture check: see docs/EXECUTION.md for the loopback fixture server.
npm run persona:integration -- --confirm-paid --scenario=fixed
# Durable app+worker startup and explicitly capped three-session acceptance:
# See docs/WORKER.md before enabling ENABLE_DEMO_RUNS.
npm run worker -- --confirm-paid
npm run worker:integration -- --confirm-paid
# Separate one-browser, cumulative-20-minute controlled-site proof:
npm run controlled:integration -- --confirm-paid
# UI-originated, two-persona proof; separate persistent lifetime 1,800-second cap:
npm run ui:integration -- --confirm-paid
# Same HTTPS/UI admission path, separate test-only storage, no cloud or worker:
npm run ui:integration -- --offline-preflight
# Owner-authenticated report/evidence proof; separate non-refundable 1,200-second cap:
npm run report:integration -- --offline-preflight
# Only after offline gates and explicit operator authorization:
npm run report:integration -- --confirm-paid
# Advanced HTTPS owner/UI/restart rehearsal, with zero provider operations:
npm run advanced:integration -- --offline-preflight
# Requires a fresh source-bound private gate/review approval; see advanced runbook:
npm run advanced:integration -- --confirm-paid
```

The `browserbase:smoke` command creates **one browser**, requests a maximum **120-second session lifetime**, and calls `extract` and `observe` once each through Model Gateway. It reads the heading on `example.com`, replays one observed click with `act`, verifies the IANA destination, and saves a screenshot, token metrics, and session references under `data/smoke/<run-id>/`. Browserbase/provider-internal retries may still occur; these are operational limits, not a dollar-spend guarantee. Each AI operation has a 30-second timeout.

The integration attempts to release Stagehand and the browser after success or failure. Cleanup failures remain failures. Browserbase's remote session timeout is the backstop if the process dies. Successful smoke reports are only written after cleanup completes. Live URLs are saved privately, not printed; the dashboard session link opens the recording inspector after completion.

## Credentials and evidence

- `BROWSERBASE_API_KEY` belongs in `.env.local` for development and the protected `paid-browserbase` **environment secret** for hosted paid workflows, never source code or a `NEXT_PUBLIC_*` variable. Follow the [operator protection and migration prerequisites](docs/CI.md#paid-workflows-are-a-separate-operator-decision) first; the existing repository-scoped key has not been moved or environment-protected by this PR.
- `.env.local` is ignored and should have permissions `600`. `.env.example` contains placeholders only.
- GitHub secrets cannot be read back. A local process or deployed worker needs its own securely supplied environment variable.
- Rotate any key pasted into chat. Update both the local environment and GitHub secret when rotating.
- `data/`, `artifacts/`, and Stagehand caches are ignored. Screenshots, live-view URLs, recordings, and browser logs can expose user data or browser access; do not commit or publish them.
- Regular CI uses no secrets and makes no cloud calls. The paid smoke workflow is manual, requires explicit confirmation, and never uploads evidence as public Actions artifacts. Workflows become available after they are pushed (manual dispatch normally requires the workflow on the default branch).
- Owner cookies, CSRF/exact-origin defenses, persisted admission limits and a strong access-code gate protect demo admission. This is not named-account authentication or a complete public multi-tenant service; see [identity and deployment limitations](docs/API.md#deployment-and-identity). Workers share durable spending/concurrency reservations. Live-view links are access-bearing and returned only through an owner-authorized endpoint.

Only after the protected environment, independent reviewers and branch policy
are configured and verified, provision its secret without including the value
in a shell command. Deliberately migrate/rotate/remove the old repository secret
only after auditing its other consumers; this command does not do that:

```sh
gh secret set BROWSERBASE_API_KEY --repo xsachax/hack-the-north-2026 --env paid-browserbase
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSERBASE_API_KEY` | Required for cloud smoke | Server-only credential |
| `BROWSERBASE_PROJECT_ID` | Inferred by Browserbase | Optional UUID to choose a project |
| `BROWSERBASE_REPLAY_ORIGINS` | Empty (embedded replay unsupported) | Server-only comma-separated exact HTTPS media origins explicitly approved by the operator; provider-selected provenance is not proof of CDN ownership; no wildcards or user-supplied destinations |
| `STAGEHAND_MODEL` | `google/gemini-2.5-flash` | Supported configuration: this model, `openai/gpt-5`, or `anthropic/claude-sonnet-4-6` |
| `MAX_CONCURRENT_SESSIONS` | `3` | Durable shared global cap, 1..12; does not increase account quota |
| `MAX_STEPS_PER_PERSONA` | `12` (worker: `14`) | Safety ceiling, 1..30, separate from persona patience |
| `SESSION_TIMEOUT_SECONDS` | `120` (worker: `240`) | Browser lifetime/reservation, 60..300 seconds; smoke further caps at 120 |
| `DATA_DIR` | `./data` | Local, private evidence storage |
| `APP_ORIGIN` | `http://127.0.0.1:3000` | Exact API origin; production requires HTTPS, with no trailing slash |
| `FLASH_FLOOD_ACCESS_CODE` | None in local development | Production API requires a high-entropy secret of at least 32 characters for owner/session admission |
| `ENABLE_DEMO_RUNS` | `false` | Opt-in fixture admission; requires access code even in development and a separately confirmed worker |

See [worker policy](docs/WORKER.md#durable-policy-and-spending) for owner caps,
90-hour development maximum, protected 10-hour final reserve, the prior 363-second
rounded-up external baseline, heartbeat and graceful-shutdown settings. The
separate layer07 advanced rehearsal preserves its historical **985-second external
baseline** and a non-replenishing **3,600-second new-reservation cap**; never
reuse the historical 363-second baseline for that rehearsal.
The accepted [layer08 release rehearsal](docs/WORKER.md#layer08-release-rehearsal)
preserves its approved 1,092 baseline and 3,600-second lifetime reservation cap.
Tracked project actual is now **1,345.293 seconds**; fresh later work in this
project must account for at least 1,346 seconds of prior usage. Existing proof
policies and ledgers are immutable, not reset to regain budget.

## Layout

```text
src/app/              Next.js dashboard, isolated demo store, health and owner APIs
src/lib/              Configuration, personas, canonical runtime domain/scope schemas
src/server/           SQLite repository/migrations, safe APIs, target policy, cloud smoke
scripts/              Offline HTTP smoke and explicit paid Browserbase smoke
tests/e2e/            Deterministic offline Chromium demo regressions
.github/workflows/    Offline CI and opt-in cloud smoke
```

The application and separate orchestrator use Node/TypeScript. Keep long-running persona loops in a dedicated worker, not a short-lived serverless request. SQLite uses Node 22.18+ (22.x) `node:sqlite`, which needs no flag on this runtime but remains experimental and emits a warning. Mount `DATA_DIR` on a private persistent local volume shared by app/workers on a single host; ephemeral/serverless disks, network filesystems and distributed replicas are unsupported. The directory/database use `700`/`600` permissions. Migrations, WAL recovery, transaction ordering and owner isolation are covered offline. See the [storage contract](docs/API.md#state-storage-and-internal-worker-boundary) and [crash runbook](docs/WORKER.md#crash-windows-cancellation-and-recovery). Unknown remote launch outcomes retain capacity and money rather than automatically retrying paid work.

## Verified API choices and remaining questions

- [Stagehand v4](https://docs.stagehand.dev/v4/migrations/v3): use `Stagehand.create` and `{ data, metadata }` result envelopes. The durable execution path explicitly allocates through SDK `sessions.create` with retries disabled, then uses `browserbase.connect`; the foundation smoke still uses `browserbase.launch`. v4 removed `agent()`; implement the persona loop explicitly. Close both Stagehand and its separately owned browser. See the worker runbook for the pinned extension archive dependency.
- [Model Gateway](https://docs.browserbase.com/platform/model-gateway/overview): a Browserbase-hosted session plus a model **without** a provider `apiKey` routes inference through Browserbase. Layer03 proves structured persona decisions with `extract(..., {screenshot:true})`, using DOM plus screenshot input. No second key or invented generic chat endpoint is used.
- Stagehand launch and SDK `sessions.create` name the session-lifetime option `api_timeout`, serialized as REST `timeout`. This is separate from the SDK HTTP request timeout.
- Zod is pinned to Stagehand's exact version to avoid expensive/incompatible cross-version schema type comparisons.
- [Metadata](https://docs.browserbase.com/platform/browser/core-features/session-metadata): use `userMetadata`, under 512 characters. Sessions are tagged with run and persona IDs.
- [Live views](https://docs.browserbase.com/platform/browser/observability/session-live-view): `sessions.debug(id).debuggerFullscreenUrl`; use URL search parameters to set `navbar=false`. Treat live links as access-bearing data. Many-view performance and account concurrency need a real demo rehearsal.
- [Recordings](https://docs.browserbase.com/platform/browser/observability/session-replay): pinned SDK 2.20 supports HLS replay metadata and per-page playlists. The [protected adapter](docs/REPLAY.md) rewrites media to owner/consent-checked same-origin paths; keys and signed URLs stay server-side. Missing verified CDN configuration is explicitly unsupported, with an operator-dashboard fallback. Deprecated rrweb recording retrieval is not used.
- [Computer use](https://docs.stagehand.dev/v3/best-practices/computer-use): screenshot-based CUA exists in v3, but its agent API is gone in v4. Standard `act`/`observe` are DOM-based. Layer03 constrains actions to measured visible candidates, but Stagehand extraction still sees DOM as well as screenshots; no screenshot-only/human-realism claim.
- Account credits, concurrency, Gateway availability and screenshot-agent support need confirmation with Browserbase before an unattended crowd run.

## MVP direction

The controlled demo store has six independently switchable planted problems and deterministic browser regressions. The bounded persona loop supports measured actions, short in-character commentary, patience, stalls, private screenshots and observed criterion checks. Autonomous coverage is limited to the explicitly recorded integration scenarios, not all six problems. Layer04b adds reusable controlled-site execution/evaluation (#11), layer05 adds its real launch flow and live wall (#12), and layer06 adds persisted evidence-backed reports (#13). HTTP 4xx responses alone are not confirmed bugs.

The minimum complete demo is the store, crowd wall and grouped evidence report.
Advanced controls are documented separately with their supported surfaces:
context persistence is not a readiness guarantee, takeover is managed-app
exclusivity, comparison needs confirming coverage, and automatic reproduction
currently supports only the controlled second-coupon failure. The bounded
reducer re-checks that exact predicate in fresh sessions and reports the
shortest path found, not a globally shortest reproduction.

Use only targets you own or have permission to test. Keep the security-minded persona non-destructive; no exploit attempts, real purchases or deletions. Use fake credentials/data in the planted-bug store. Do not claim synthetic personas predict conversion rates or replace real user testing.
