# Flash Flood

User testing before you have users. A crowd of AI personas uses an authorized web app in real Browserbase browsers, with a live wall and evidence-backed bug and friction reports.

**Current phase: foundation, not the full MVP.** This repository includes a Next.js dashboard preview, twelve persona profiles, shared run/evidence types, validated configuration, a Browserbase + Stagehand integration, offline tests, and a manually triggered cloud smoke test. The UI does not start sessions or display fabricated results.

The [delivery plan](docs/DELIVERY_PLAN.md) defines the architecture, sequential PR layers, acceptance gates, capability matrix and accountability ledger for the end-to-end build.

## Local development

Requires Node.js 22.18+ (22.x) and npm.

```sh
nvm use
npm ci
cp .env.example .env.local
chmod 600 .env.local
# Edit .env.local and add your Browserbase key.
npm run dev
```

If `.env.local` already exists, keep it rather than copying over it. Open http://127.0.0.1:3000. The app binds to loopback by default. `/api/health` is a liveness endpoint; it does not contact Browserbase. The dashboard shows configuration validity, not proof that credentials work.

```sh
npm run check              # Lint, types, offline tests; no Browserbase credits
npm run build              # Production build; no Browserbase credits
npm run browserbase:smoke  # Paid, explicit integration check
```

The smoke command creates **one browser**, requests a maximum **120-second session lifetime**, and calls `extract` and `observe` once each through Model Gateway. It reads the heading on `example.com`, replays one observed click with `act`, verifies the IANA destination, and saves a screenshot, token metrics, and session references under `data/smoke/<run-id>/`. Browserbase/provider-internal retries may still occur; these are operational limits, not a dollar-spend guarantee. Each AI operation has a 30-second timeout.

The integration attempts to release Stagehand and the browser after success or failure. Cleanup failures remain failures. Browserbase's remote session timeout is the backstop if the process dies. Successful smoke reports are only written after cleanup completes. Live URLs are saved privately, not printed; the dashboard session link opens the recording inspector after completion.

## Credentials and evidence

- `BROWSERBASE_API_KEY` belongs in `.env.local` for development and GitHub **Actions secrets** for the manual workflow, never source code or a `NEXT_PUBLIC_*` variable.
- `.env.local` is ignored and should have permissions `600`. `.env.example` contains placeholders only.
- GitHub secrets cannot be read back. A local process or deployed worker needs its own securely supplied environment variable.
- Rotate any key pasted into chat. Update both the local environment and GitHub secret when rotating.
- `data/`, `artifacts/`, and Stagehand caches are ignored. Screenshots, live-view URLs, recordings, and browser logs can expose user data or browser access; do not commit or publish them.
- Regular CI uses no secrets and makes no cloud calls. The paid smoke workflow is manual, requires explicit confirmation, and never uploads evidence as public Actions artifacts. Workflows become available after they are pushed (manual dispatch normally requires the workflow on the default branch).
- This is a local development foundation, not an authenticated hosted service. Add authentication, authorization, run ownership, target validation and quotas before exposing paid run endpoints.

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

## Layout

```text
src/app/              Next.js dashboard preview and health endpoint
src/lib/              Configuration schema, twelve personas, run contracts
src/server/           Cloud-browser lifecycle and safe diagnostics
scripts/              Explicit, paid Browserbase smoke command
.github/workflows/    Offline CI and opt-in cloud smoke
```

The application and future orchestrator use Node/TypeScript. Keep long-running persona loops in a dedicated worker, not a short-lived serverless request. Local JSON evidence is sufficient for the foundation; durable run storage and live SSE events are not implemented yet.

## Verified API choices and remaining questions

- [Stagehand v4](https://docs.stagehand.dev/v4/migrations/v3): use `browserbase.launch`, `Stagehand.create`, and `{ data, metadata }` result envelopes. v4 removed `agent()`; implement the persona loop explicitly. Close both Stagehand and its separately owned browser.
- [Model Gateway](https://docs.browserbase.com/platform/model-gateway/overview): a Browserbase-hosted session plus a model **without** a provider `apiKey` routes inference through Browserbase. No second key is needed for the smoke operations. A standalone screenshot-aware persona decision call still needs a prototype; do not assume a generic OpenAI-compatible gateway endpoint.
- SDK 2.20 names the session-lifetime option `api_timeout` and serializes it as REST `timeout`. Do not confuse it with an HTTP request timeout.
- Zod is pinned to Stagehand's exact version to avoid expensive/incompatible cross-version schema type comparisons.
- [Metadata](https://docs.browserbase.com/platform/browser/core-features/session-metadata): use `userMetadata`, under 512 characters. Sessions are tagged with run and persona IDs.
- [Live views](https://docs.browserbase.com/platform/browser/observability/session-live-view): `sessions.debug(id).debuggerFullscreenUrl`; use URL search parameters to set `navbar=false`. Treat live links as access-bearing data. Many-view performance and account concurrency need a real demo rehearsal.
- [Recordings](https://docs.browserbase.com/platform/browser/observability/session-replay): enable recording; use the dashboard inspector now. Future embedded replay uses `sessions.replays` through an authorized backend, never a browser-side API key. MP4 assembly is a separate asynchronous API.
- [Computer use](https://docs.stagehand.dev/v3/best-practices/computer-use): screenshot-based CUA exists in v3, but its agent API is gone in v4. Standard `act`/`observe` are DOM-based. The foundation does **not** claim viewport-only perception; validate screenshot/visible-only decisions before claiming human realism.
- Account credits, concurrency, Gateway availability and screenshot-agent support need confirmation with Browserbase before an unattended crowd run.

## MVP direction

Build a controlled demo store with six planted problems, then a bounded persona loop with visible-page perception, short in-character observations, patience and stuck detection. Capture browser errors and failed/slow requests, persist runs and screenshots, stream steps to the live wall, and group issues with replay links. Report failures with evidence; do not equate all HTTP 4xx responses with confirmed bugs.

The minimum complete demo is the store, crowd wall and grouped evidence report. Human takeover, reproduction minimization/test generation and rerun comparison follow. A reproduction reducer must re-check the same failure signature in fresh sessions; never promise globally shortest steps without proving them.

Use only targets you own or have permission to test. Keep the security-minded persona non-destructive; no exploit attempts, real purchases or deletions. Use fake credentials/data in the planted-bug store. Do not claim synthetic personas predict conversion rates or replace real user testing.
