# CI and dependency release gates

## Credential-free required check

`.github/workflows/ci.yml` runs on pushes and ordinary `pull_request` events,
including forks. It does not use `pull_request_target`, dispatch a paid workflow,
read cloud secrets, or upload private artifacts. The `check` job has read-only
repository permissions, disables checkout credential persistence, and explicitly
empties Browserbase credentials. It uses `ubuntu-24.04`, not the moving
`ubuntu-latest` label. OS patch updates still move; this is not an immutable VM.
The application Node version comes from `.nvmrc` (22); `package.json` requires
22.18 or later within major 22 for `node:sqlite` and Stagehand.

Run these gates **sequentially**, against the same unchanged checkout:

```sh
umask 077
mkdir -p data/ci-scratch
export TMPDIR="$PWD/data/ci-scratch"
export NEXT_TELEMETRY_DISABLED=1 DEBUG=false
export BROWSERBASE_API_KEY= BROWSERBASE_PROJECT_ID= FLASH_FLOOD_ACCESS_CODE=
npm ci --no-audit --no-fund
npm audit --audit-level=high --ignore-scripts
npm run check
npm run build
npm run test:http
npx --no-install playwright install --with-deps chromium --only-shell
npm run test:e2e
npm run report:integration -- --offline-preflight
npm run advanced:integration -- --offline-preflight
npx --no-install tsx scripts/release-integration.ts --offline-preflight
npm run release:package -- data/release-package
RELEASE_PACKAGE_DIR="$PWD/data/release-package" npm run release:package-check
```

`check` is lint, Next type generation/TypeScript, then all `src/**/*.test.ts` Vitest tests,
including repository, API, durable-worker, deployment and rehearsal suites.
Vitest disables file parallelism for the SQLite/fsync suites.
Playwright uses two local
Chromium workers and zero retries. The workflow does not execute separate test
suites concurrently. Install/system package/browser download steps use the
network, but the test modes require no paid browser or model credentials.
OpenSSL and loopback ports 4317, 4325–4328 must be available.
The clean packaged Node check additionally uses 4321/4322 and 4330. It installs
the lockfile into a new private allowlisted tree and builds without `.env` files
or inherited provider credentials. It runs the real production supervisor and
HTTPS proxy twice, checks original-owner continuity across restart, confirms
disabled admission/worker startup and zero reservations, then stops owned
processes. Generated package sources remain excluded from application lint/types.

The independent `container` job runs
`node --import tsx scripts/deployment-docker-validate.ts` on Ubuntu 24.04 with
Docker available. It builds the actual image and an isolated context-audit image,
checks that private sentinel files never enter either, then exercises the
read-only nonroot container, private volume initialization, startup/readiness,
SIGTERM shutdown, persistent database row, quiescent backup and restored
web-only readiness. It also invokes the real pinned Playwright CDP client
against a local 503 stub inside the read-only container, proving its required
private temporary-directory path works without a provider allocation.
Restored backup markers must block paid startup; the gate does not claim a
snapshot contains later reservations or unresolved resource identities.
Its random project owns only its own images, containers and volumes;
there is no broad Docker pruning or daemon repair. It receives no provider
credentials and uploads no evidence. The local shared Docker daemon returned
HTTP 500, so local Node results must not be described as container execution;
the exact-head hosted job is the container acceptance gate.

`build` writes the verified production build receipt used by the advanced
preflight. Source, lockfile, test, or **workflow** edits after building invalidate
that receipt; build again instead of bypassing it. HTTP smoke launches a real
production Next server and checks actual SSE bytes; its HTTPS deployment Host
is simulated over loopback HTTP, not a TLS handshake. The report and advanced
preflights additionally use a real local HTTPS proxy, Chromium, production
cookies and genuine-owner restart/resume paths. They allocate no remote session;
local browser/fixture proof is not a paid provider proof.

The job is capped at 35 minutes, with individual gate timeouts. A newer run
cancels an obsolete run for the same ref. No cookies, database, HLS, live URLs,
screenshots, traces, or private rehearsal JSON are uploaded. `data/` is ignored;
scratch and rehearsal files stay on the ephemeral runner. For local execution,
use a clean checkout without deployment `.env*` files; do not copy private
rehearsal data into a release or public artifact.

Next 16's persistent Turbopack build cache was observed retaining local dotenv
values even though client/server bundles contained none. Build and development
filesystem caching are explicitly disabled, and the development verified-build
wrapper uses umask 077. Treat any older `.next/cache/turbopack` and development
cache as private; remove that generated cache before rescanning or sharing a
build. Release packaging never copies host `.next`, rejects dotenv inputs and
builds in an allowlisted credential-free environment. Final known-value scans
must include caches rather than silently excluding the location of a leak.
Turbopack's root is the build working directory so a nested clean package cannot
silently select the developer checkout's outer lockfile.

## Pinned Actions runtime

Both official actions run on **Node 24**, independently of the application's
Node 22 runtime. The following tag refs, release metadata and `action.yml`
runtime declarations were verified against upstream with `gh api` on
2026-09-19, rather than guessing major versions:

| Action | Verified release | Immutable workflow pin |
| --- | --- | --- |
| `actions/checkout` | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | [v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) | `820762786026740c76f36085b0efc47a31fe5020` |

This removes the former v4 actions' Node 20 deprecation path, without changing
the app's engine or silencing warnings. Upstream documents runner v2.327.1+
for Node 24 actions; use current GitHub-hosted runners. Before updating a pin:

```sh
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq .object
gh api repos/actions/setup-node/git/ref/tags/v7.0.0 --jq .object
gh api 'repos/actions/checkout/contents/action.yml?ref=3d3c42e5aac5ba805825da76410c181273ba90b1' --jq .content | base64 --decode
gh api 'repos/actions/setup-node/contents/action.yml?ref=820762786026740c76f36085b0efc47a31fe5020' --jq .content | base64 --decode
actionlint
```

## Paid workflows are a separate operator decision

The existing smoke and persona workflows are manual `workflow_dispatch` only.
Each requires the explicit paid boolean, `refs/heads/main`, and the canonical
`xsachax/hack-the-north-2026` repository. Dispatch permissions and main branch
protection define trusted code; neither workflow accepts arbitrary checkout
refs, target URLs or executable inputs. The persona scenario is a fixed choice.
They share a `paid-browserbase` concurrency group and never cancel a running
paid invocation to make room for another.

**Repository setup required:** configure the `paid-browserbase` GitHub
environment with required trusted reviewers, prevent self-review, restrict its
deployment branches to protected branches (with dispatch separately restricted
to `main`), and put the Browserbase key/project ID
there. Protect main and changes to workflows. Merely naming an environment in
YAML does not configure its review/branch protection; verify these controls
before approving any paid run. A credential-free preflight now reads the
environment rules and protected-main status and fails before paid execution
unless these settings are present. An unreadable API response fails closed.
The release read-only environment check returned HTTP 404: protection was **not
verified**, and no settings were created automatically by this development task.
Do not rely on fork secret withholding alone.

The original Browserbase key is **repository-scoped**. A workflow preflight is
not GitHub-enforced secret isolation and does not change that secret's scope:
another authorized workflow may still request a repository secret. An operator
must choose real trusted reviewers (at least one different from the dispatcher),
verify the account supports required environment review, protect main/workflow
changes, create the protected environment, securely provision its key/project
ID, and verify environment-based execution before explicitly removing or
rotating the old repository-scoped key after checking other consumers. GitHub
cannot return the old secret value. No reviewer, policy, secret migration or
secret deletion is performed by this PR. If an independent reviewer is
unavailable, these paid workflows remain disabled; do not remove the guard.

The guard uses the short-lived job `GITHUB_TOKEN`, exposed as `GH_TOKEN` only
for the read step, with repository `contents: read` and implicit metadata read,
not a personal admin token or provider key.
[Get an environment](https://docs.github.com/en/rest/deployments/environments#get-an-environment)
documents repository read access; [Get a branch](https://docs.github.com/en/rest/branches/branches#get-a-branch)
reads the protected-main flag. Verify these reads with the actual workflow token
under repository/organization policy. HTTP 403/404, unavailable `gh`/`jq`,
missing required reviewers or unprotected main stop execution; they are not
grounds to add write/admin permissions or ignore the check.

Only the paid execution step receives secrets. Dependency installation, build,
and the persona loopback fixture receive empty provider credentials; secrets
are not passed as build arguments, `NEXT_PUBLIC_*`, or client configuration.
Paid jobs disable package-manager caching rather than sharing an install cache
with credential-bearing execution. No private evidence is uploaded.

| Workflow | Per-dispatch bounds | Important limit |
| --- | --- | --- |
| Browserbase smoke | One session, provider timeout at most 120s; two explicit inference operations and one observed-action click; 3-minute execution step, 5-minute job | No durable cross-dispatch lifetime ledger; rerunning is another paid decision. |
| Persona integration | One session, 240s provider timeout; loop at most 14 steps / 14 model calls / 180s; 5-minute execution step, 10-minute job | Its 1,800s private reservation ceiling is only durable within its data directory. Fresh hosted jobs do **not** share that ledger. |

Job/step cancellation is not remote closure evidence. After timeout, interruption
or uncertain cleanup, inspect the provider and reconcile privately before
another dispatch. The shared concurrency group limits overlapping CI invocations,
not local operators or account-wide spend. A persistent deployment worker ledger
and provider-level budget remain necessary for a cross-run budget guarantee.
CI does not run paid advanced/report/reproduction modes or manufacture approval
receipts. Passing offline gates is not permission to spend.

## Dependency audit snapshot and triage

On 2026-09-19, the unchanged lockfile (v3) returned **zero reported advisories**
from both full and production-only `npm audit --json --ignore-scripts`;
`npm audit --package-lock-only --json --ignore-scripts` independently returned
the same zero-advisory result. The full report described 518 dependencies.
This is a registry advisory snapshot, not proof that every dependency is safe.
No `npm audit fix`, install, blanket upgrade, manifest or lock edit was needed
for this audit. Re-run against the final release lockfile if it changes.

CI blocks high/critical advisories and reports lower severities for triage.
Do not suppress registry/network failures as a clean audit. For each new
advisory, record its GHSA/CVE URL, affected locked path and version, severity,
fixed range, environment and reachable input before choosing a remediation:

```sh
npm audit --package-lock-only --json --ignore-scripts
npm audit --omit=dev --json --ignore-scripts
npm explain AFFECTED_PACKAGE
```

* Next/React/server request parser findings may be production reachable through
  HTTP/SSR; trace the affected route or feature, not merely package presence.
* `hls.js` is client-side recording playback. Check whether a malicious
  recording/manifest can reach the affected API despite the server's constrained
  replay proxy. Owner consent is not a general parser vulnerability mitigation.
* Browserbase SDK and Stagehand findings affect server/worker/cloud adapters.
  Offline CI alone does not exercise the remote provider transport.
* ESLint, TypeScript, Vitest/Vite/esbuild and Playwright test-only paths are
  build/development exposure, not automatically an internet-facing production
  server. Fork builds still process untrusted repository code without secrets.
* Verify reachability with actual imports, API use and deployment packaging.
  `--omit=dev` alone does not establish which modules appear in a client bundle.

The audited lock has Stagehand **4.1.0** depending on Zod **4.4.3**, matching
the direct Zod **4.4.3** dependency. Preserve the tested v4 adapter/schema
contract: do not blanket-upgrade Stagehand/Zod or force an unrelated transitive
override. For a future concrete advisory, prefer a compatible patch with an
explicit lock diff, then rerun schema/Gateway, worker and production gates.
This snapshot requires **no dependency edits**.

## Failure matrix: existing evidence and limits

These are regression locations and representative test names. Rows marked
**new release regression** were introduced in this change. On the reviewed
runtime `a5de2ba`, the consolidated local gates passed 2,044 tests and 103
Chromium tests, actual HTTP/SSE, HTTPS preflights and clean-package restart;
both exact-head hosted push/PR `check` and `container` jobs and GitGuardian
passed. Final PR-head checks must pass again after documentation finalization.
The separately authorized paid proof is recorded in WORKER.md, not attributed
to credential-free CI.

| Failure / invariant | Existing regression evidence | Boundary / gap |
| --- | --- | --- |
| SQLite durability, migration, filesystem permissions | `src/server/repository.test.ts`: “migrates a real database once, persists across reopen, and secures database/sidecar permissions”; “rolls back a partially inserted run…” | Local disk/SQLite, not host backup/restore or network filesystem certification. |
| Admission deduplication, terminal races | `src/server/repository.test.ts`: “uses owner-scoped idempotency across independent connections…”; “lets cancellation win a running finish race…” | Does not prove remote allocation exactly once. |
| Owner isolation, CSRF, proxy trust, body limits | `src/server/api.test.ts`: “rejects missing mutation Origin, cross-site requests and forged proxy headers”; “requires CSRF on every mutation…”; “times out an unending body…” | Test handlers plus actual HTTP smoke, not an external load balancer penetration test. |
| SSE replay and resource cleanup | `src/server/event-stream.test.ts`: “prefers a valid Last-Event-ID…”; “reconnects without replaying previously received logical IDs”; “does not read or poll until demanded…”; cleanup on cancel/abort and caps | Stream contract tests exercise demand/backpressure; HTTP smoke verifies terminal SSE bytes, not a long-lived adverse-network soak. |
| Actual HTTP owner/cancel/export paths | `scripts/api-smoke.ts`: production server, protected cookies/CSRF/CRUD, cancellation, Last-Event-ID precedence, foreign-owner denial and export headers | Loopback HTTP with simulated TLS proxy Host; no browser execution or remote allocation. |
| Cross-process capacity, crash recovery | `src/server/worker/repository.test.ts`: “enforces the … cap with two actual contending Node/tsx processes”; “recovers a specifically killed process after durable intent, never launching a second session” | Real local processes; provider responses simulated. |
| In-flight cancellation, lease fencing, uncertain launch | `src/server/worker/runtime.test.ts`: “cancellation aborts a pending model and awaits remote release”; “retains uncertain startup reservations and dispatches no second launch”; “does not accept evaluator results from an expired, reclaimed lease” | Does not prove a real cloud timeout/release on this CI run. |
| Bounded provider reconciliation | `src/server/worker/cloud-recovery.test.ts`: “releases and accounts correlated duplicates…”; “caps work and returned results…”; “bounds a hung SDK … request…” | Fake SDK, no actual account credentials or remote closure assertion. |
| Grounding and fixture transport restrictions | `tests/e2e/execution-driver.spec.ts`, `execution-policy.spec.ts`: ungrounded input rejection, private-listener/WebSocket/new-page/redirect denial | Actual local Chromium. Public-egress authorization issue #8 remains separate and enforced. |
| Two controlled-site worker journeys | `tests/e2e/controlled-worker.spec.ts`: “durable worker executes a custom persona's novel … goal in the actual browser” | Real local browser/worker with deterministic model seam, not semantic Gateway accuracy. |
| Lost launch reply / owner cookie | `tests/e2e/launch.spec.ts`: “double click and lost reply across refresh replay one durable launch”; “lost owner cookie never replays a saved paid request under a new owner” | Browser UI plus offline API routing; actual production HTTP is a separate gate. |
| Wall reconnect, expiry, honest cleanup | `tests/e2e/live-wall.spec.ts`: “native SSE reconnect uses the retained cursor and closes on terminal”; “owner expiry removes all private frames…”; “cancel hides frames immediately but does not claim remote closure” | Browser transport/UI fixtures, not a live remote Browserbase viewport. |
| Replay provenance, budget, private grants | `src/server/reports/replay.test.ts`: A/B session provenance through SDK wrapper, bounded hangs/ranges/streams; `tests/e2e/reports.spec.ts`: consent, failed grants, external playlist rejection | Simulated recordings/provider APIs; no actual paid HLS decoding proof in offline CI. |
| Report failure/refresh/export honesty | `tests/e2e/reports.spec.ts`: “report and evidence failures offer retry rather than invented results”; “nonfinal refresh is bounded…”; `src/server/reports/api.test.ts` | Missing report/evidence does not become success. |
| Context reuse exclusivity and revocation | `src/server/workflows/contexts.test.ts`: two-process race/death, lost create reply, expiry fencing and deletion failures; `tests/e2e/contexts.spec.ts`: restored/fresh synthetic marker | Local restored storage does not prove provider context persistence or remote erasure. |
| Takeover drain and handback | `tests/e2e/takeover.spec.ts`: “real local browser: in-flight decision drains, human edits exclusively, agent resumes fresh” | Local browser, not current remote CDP control correctness. |
| Rerun immutability and retry | `tests/e2e/reruns.spec.ts`: “actual report reruns only selected immutable assignments…”; lost reply, rate limiting, failed comparison | Does not infer target improvement from missing coverage. |
| Reproduction / restart | `tests/e2e/reproduction.spec.ts`: generated regression fails broken/passes fixed; `advanced-worker.spec.ts`: fresh browsers through durable reservations across restart | Finite controlled fixture reduction, not global shortest proof or arbitrary websites. |
| Build provenance / harness interruption | `src/server/worker/advanced-build.test.ts`: stale source/modified artifact rejection; `tests/e2e/advanced-harness.spec.ts`: SIGTERM stops servers/releases lock | A verified receipt binds files, not a signed supply-chain attestation. |
| Real HTTPS / genuine-owner report resume | `scripts/report-integration.ts --offline-preflight` | Restart/authenticated readback and unchanged zero-launch ledger; cancelled/not-observed report, no paid replay. |
| Advanced HTTPS / restart / actual UI marker | `scripts/advanced-integration.ts --offline-preflight` | Zero provider calls and `paidProofPassed: false`; no approval, remote takeover or paid context evidence. |
| Deployment fail-closed config, durable migration, shutdown (**new release regression**) | `src/server/deployment/deployment.test.ts` in the normal suite: unsafe release input rejection, future-schema rollback refusal, graceful SIGTERM and forced-shutdown failure | 45 focused deployment regressions passed. Separate hosted container gate additionally exercised the real image/runtime, not merely these assertions. |
| Release reservation plan and queue/cancel preflight (**new release regression**) | `src/server/worker/release-proof.test.ts`, `scripts/release-integration.ts --offline-preflight` | Actual SQLite policy/queued cancellation and source-bound receipt only; not HTTPS, model or provider acceptance. |
| Clean packaged supervisor and HTTPS owner restart (**new release regression**) | `npm run release:package`, `npm run release:package-check`; `src/server/worker/release-runtime.test.ts` | Fresh install/build and actual web-only supervisor, same-owner HTTPS restart, graceful process shutdown, no provider key/calls; does not itself prove paid worker cleanup. |
| Restored-snapshot budget loss (**new release regression**) | `src/server/deployment/deployment.test.ts`: actual 3,480-second snapshot followed by 120 more seconds exhausts the 3,600-second live ledger; restored snapshot cannot pass the deployed paid guard | Remote closure cannot restore missing historical reservations. Backups are quarantined for web-only recovery; paid restart requires separately reviewed compatible preservation of all history and unresolved identities. |
| Honest health endpoint (**new release regression**) | `src/app/api/health/route.test.ts`: “reports uncached process liveness without claiming worker or provider readiness” | Passed. Process liveness only, not database, worker or provider readiness. |

Outstanding release evidence must be stated separately: configured environment
review/branch protection, actual hosted CI execution, external HTTPS deployment,
backup/restore drills, account-wide budget persistence and any explicitly
authorized remote browser/Gateway proof. Do not replace these with a mocked test
count, offline success, or this audit snapshot.
