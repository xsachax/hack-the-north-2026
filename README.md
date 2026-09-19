# Flash Flood

User testing before you have users. A crowd of AI personas uses an authorized web app in real Browserbase browsers, with a live wall and evidence-backed bug and friction reports.

**Current phase: durable backend, controlled fixtures and a single-persona execution engine, not the full MVP.** This repository includes a Next.js dashboard preview, twelve persona profiles, canonical runtime schemas, private SQLite persistence and owner-scoped APIs. The [execution reference](docs/EXECUTION.md) covers the bounded Browserbase/Stagehand Gateway loop, private evidence, cancellation, typed worker hooks and explicit paid fixture integration. **Arbitrary-target execution remains disabled pending proven browser egress enforcement.** The UI does not start sessions or display fabricated results. The [API reference](docs/API.md) covers bootstrap, persona CRUD, scoped run creation/cancellation, events and private evidence references. No API endpoint launches paid browsers.

The synthetic gift store at `/demo` supports browse/cart/fake checkout. Configure six independent broken/fixed variants and reset tab-local state at `/demo-fixtures`, outside the shopping flow. See the [fixture matrix and next-layer handoff](docs/DEMO.md) for deterministic setup, scoped objectives, evidence distinctions and authorized cloud reachability. No real purchases, accounts or payments.

The [delivery plan](docs/DELIVERY_PLAN.md) defines the architecture, sequential PR layers, acceptance gates, capability matrix and accountability ledger for the end-to-end build.

## Local development

Requires Node.js 22.18+ (22.x) and npm.

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

If `.env.local` already exists, keep it rather than copying over it. Open http://127.0.0.1:3000. The app binds to loopback by default. `/api/health` is a liveness endpoint; it does not contact Browserbase. The dashboard shows configuration validity, not proof that credentials work.

```sh
npm run check              # Lint, types, offline tests; no Browserbase credits
npm run build              # Production build; no Browserbase credits
npm run test:http          # Built-app offline HTTP smoke (run build first)
npx playwright install chromium --only-shell # One-time offline E2E browser setup
npm run test:e2e           # Production-server demo regressions (run build first)
npm run browserbase:smoke  # Paid, explicit integration check
# Paid persona fixture check: see docs/EXECUTION.md for the loopback fixture server.
npm run persona:integration -- --confirm-paid --scenario=fixed
```

The `browserbase:smoke` command creates **one browser**, requests a maximum **120-second session lifetime**, and calls `extract` and `observe` once each through Model Gateway. It reads the heading on `example.com`, replays one observed click with `act`, verifies the IANA destination, and saves a screenshot, token metrics, and session references under `data/smoke/<run-id>/`. Browserbase/provider-internal retries may still occur; these are operational limits, not a dollar-spend guarantee. Each AI operation has a 30-second timeout.

The integration attempts to release Stagehand and the browser after success or failure. Cleanup failures remain failures. Browserbase's remote session timeout is the backstop if the process dies. Successful smoke reports are only written after cleanup completes. Live URLs are saved privately, not printed; the dashboard session link opens the recording inspector after completion.

## Credentials and evidence

- `BROWSERBASE_API_KEY` belongs in `.env.local` for development and GitHub **Actions secrets** for the manual workflow, never source code or a `NEXT_PUBLIC_*` variable.
- `.env.local` is ignored and should have permissions `600`. `.env.example` contains placeholders only.
- GitHub secrets cannot be read back. A local process or deployed worker needs its own securely supplied environment variable.
- Rotate any key pasted into chat. Update both the local environment and GitHub secret when rotating.
- `data/`, `artifacts/`, and Stagehand caches are ignored. Screenshots, live-view URLs, recordings, and browser logs can expose user data or browser access; do not commit or publish them.
- Regular CI uses no secrets and makes no cloud calls. The paid smoke workflow is manual, requires explicit confirmation, and never uploads evidence as public Actions artifacts. Workflows become available after they are pushed (manual dispatch normally requires the workflow on the default branch).
- Owner cookies, CSRF/exact-origin defenses, persisted admission limits and a production access-code gate now protect offline APIs. This is not named-account authentication or a complete public multi-tenant service; see [identity and deployment limitations](docs/API.md#deployment-and-identity). Paid endpoints and worker spending control do not exist yet.

To set or rotate the GitHub secret without including its value in a shell command:

```sh
gh secret set BROWSERBASE_API_KEY --repo xsachax/hack-the-north-2026
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSERBASE_API_KEY` | Required for cloud smoke | Server-only credential |
| `BROWSERBASE_PROJECT_ID` | Inferred by Browserbase | Optional UUID to choose a project |
| `STAGEHAND_MODEL` | `google/gemini-2.5-flash` | Supported configuration: this model, `openai/gpt-5`, or `anthropic/claude-sonnet-4-6` |
| `MAX_CONCURRENT_SESSIONS` | `3` | Future orchestrator cap, validated between 1 and 12; does not increase account quota |
| `MAX_STEPS_PER_PERSONA` | `12` | Future run cap, validated between 1 and 30 |
| `SESSION_TIMEOUT_SECONDS` | `120` | Browser lifetime, 60-300 seconds; smoke further caps at 120 |
| `DATA_DIR` | `./data` | Local, private evidence storage |
| `APP_ORIGIN` | `http://127.0.0.1:3000` | Exact API origin; production requires HTTPS, with no trailing slash |
| `FLASH_FLOOD_ACCESS_CODE` | None in local development | Production API requires a high-entropy secret of at least 32 characters for owner/session admission |

## Layout

```text
src/app/              Next.js dashboard, isolated demo store, health and owner APIs
src/lib/              Configuration, personas, canonical runtime domain/scope schemas
src/server/           SQLite repository/migrations, safe APIs, target policy, cloud smoke
scripts/              Offline HTTP smoke and explicit paid Browserbase smoke
tests/e2e/            Deterministic offline Chromium demo regressions
.github/workflows/    Offline CI and opt-in cloud smoke
```

The application and future orchestrator use Node/TypeScript. Keep long-running persona loops in a dedicated worker, not a short-lived serverless request. SQLite uses Node 22.18+ (22.x) `node:sqlite`, which needs no flag on this runtime but remains experimental and emits a warning. Mount `DATA_DIR` on a private persistent local volume on a single host; ephemeral/serverless disks, network filesystems and distributed replicas are unsupported. The directory/database use `700`/`600` permissions. Migrations, WAL recovery, transaction ordering and owner isolation are covered offline. See the [storage contract](docs/API.md#state-storage-and-internal-worker-boundary) before backing up or adding workers. Durable event pagination exists; SSE, worker leases/recovery and spending enforcement are still future layers.

## Verified API choices and remaining questions

- [Stagehand v4](https://docs.stagehand.dev/v4/migrations/v3): use `browserbase.launch`, `Stagehand.create`, and `{ data, metadata }` result envelopes. v4 removed `agent()`; implement the persona loop explicitly. Close both Stagehand and its separately owned browser.
- [Model Gateway](https://docs.browserbase.com/platform/model-gateway/overview): a Browserbase-hosted session plus a model **without** a provider `apiKey` routes inference through Browserbase. Layer03 proves structured persona decisions with `extract(..., {screenshot:true})`, using DOM plus screenshot input. No second key or invented generic chat endpoint is used.
- SDK 2.20 names the session-lifetime option `api_timeout` and serializes it as REST `timeout`. Do not confuse it with an HTTP request timeout.
- Zod is pinned to Stagehand's exact version to avoid expensive/incompatible cross-version schema type comparisons.
- [Metadata](https://docs.browserbase.com/platform/browser/core-features/session-metadata): use `userMetadata`, under 512 characters. Sessions are tagged with run and persona IDs.
- [Live views](https://docs.browserbase.com/platform/browser/observability/session-live-view): `sessions.debug(id).debuggerFullscreenUrl`; use URL search parameters to set `navbar=false`. Treat live links as access-bearing data. Many-view performance and account concurrency need a real demo rehearsal.
- [Recordings](https://docs.browserbase.com/platform/browser/observability/session-replay): enable recording; use the dashboard inspector now. Future embedded replay uses `sessions.replays` through an authorized backend, never a browser-side API key. MP4 assembly is a separate asynchronous API.
- [Computer use](https://docs.stagehand.dev/v3/best-practices/computer-use): screenshot-based CUA exists in v3, but its agent API is gone in v4. Standard `act`/`observe` are DOM-based. Layer03 constrains actions to measured visible candidates, but Stagehand extraction still sees DOM as well as screenshots; no screenshot-only/human-realism claim.
- Account credits, concurrency, Gateway availability and screenshot-agent support need confirmation with Browserbase before an unattended crowd run.

## MVP direction

The controlled demo store has six independently switchable planted problems and deterministic browser regressions. The bounded persona loop now supports measured actions, short in-character commentary, patience, stalls, private screenshots and observed criterion checks. Autonomous coverage is limited to the explicitly recorded integration scenarios, not all six problems. Next: durable orchestration, cancellation/restart reconciliation and spending reservations, then the live wall and evidence-backed grouped reports. HTTP 4xx responses alone are not confirmed bugs.

The minimum complete demo is the store, crowd wall and grouped evidence report. Human takeover, reproduction minimization/test generation and rerun comparison follow. A reproduction reducer must re-check the same failure signature in fresh sessions; never promise globally shortest steps without proving them.

Use only targets you own or have permission to test. Keep the security-minded persona non-destructive; no exploit attempts, real purchases or deletions. Use fake credentials/data in the planted-bug store. Do not claim synthetic personas predict conversion rates or replace real user testing.
