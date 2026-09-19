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

## Native-policy Linux namespace acceptance

The dedicated native-policy job is independent of the application and container
gates. It evaluates the native Chromium extension hypothesis with owned local
listeners, not Playwright request interception. It requires Linux and fails
rather than skipping when namespaces, IPv6, DNS, or browser dependencies are
unavailable. macOS lint/type checks are not Linux acceptance evidence.

### Installation and invocation

Use the repository's Node 22 runtime (at least 22.18), locked Playwright 1.58.2,
and Ubuntu `iproute2`, `util-linux`, and `procps`. Install the **full Chromium
build**: the ordinary e2e `--only-shell` installation is insufficient for
extension loading.

```sh
umask 077
mkdir -p data/ci-scratch
export TMPDIR="$PWD/data/ci-scratch"
npm ci --no-audit --no-fund
sudo apt-get update
sudo apt-get install -y iproute2 util-linux procps
npx --no-install playwright install --with-deps chromium
CI=true node node_modules/tsx/dist/cli.mjs scripts/native-policy-linux.ts --ci-sudo
```

The explicit CI-only switch requires passwordless `sudo --non-interactive`.
It creates network, mount, and PID namespaces with `unshare`, then launches
Playwright as the original invoking UID/GID, not host root. The default local
Linux mode instead uses `unshare --user --map-root-user`:

```sh
node node_modules/tsx/dist/cli.mjs scripts/native-policy-linux.ts
```

Both modes invoke `playwright.native-policy-linux.config.ts` with one worker
and no retries. Directly invoking that configuration is unsupported: the test
requires the launcher's namespace identity information and isolated resolver.
No Docker daemon, provider credentials, environment-secret files, external
target probes, host interfaces, routes, or firewall changes are needed.
Dependency/browser provisioning uses package mirrors; the acceptance run has
only namespace-local loopback and no external interface.

### Public transport namespace acceptance

The same verified launcher has one additional **fixed**, allowlisted suite:

```sh
CI=true node node_modules/tsx/dist/cli.mjs scripts/native-policy-linux.ts --ci-sudo --public-transport
# Local Linux, when unprivileged namespaces are available:
node node_modules/tsx/dist/cli.mjs scripts/native-policy-linux.ts --public-transport
```

This selects `vitest.public-transport-linux.config.ts`, not an arbitrary elevated
command. It adds `93.184.216.34/32`, `2606:4700:4700::1111/128` and the wrong-SAN
control `2606:4700:4700::1112/128` **only inside
the already verified private namespace**; the ordinary native suite's aliases and
command are unchanged. Namespace-local HTTP/80, HTTPS/443 and UDP DNS/53 run after
the UID/GID drop. The existing namespace-only low-port sysctl permits those owned
listeners. No interface, firewall, route, resolver or Docker setting on the shared
host is changed. This suite needs OpenSSL but no browser and uses no provider key.

`tests/network-fixtures.ts` shares the existing isolation assertions and TTL-zero
owned DNS responder with the native browser suite. The production broker has no
test DNS/transport hook. A public answer flips immediately after serialization:
the first actual connection must remain pinned to the public alias, while the
second request must reject private DNS with unchanged private connection counters.
Positive controls first connect to every private/link-local/IPv6 sentinel so a
broken route cannot masquerade as enforcement. Mixed answers, public IPv6 and IP
literals, private redirect rejection and in-flight read cancellation are covered.

Ephemeral owned TLS material remains in mode-0700 namespace scratch. Fresh
unprivileged Node children test an untrusted CA failure, explicit local CA trust
via `NODE_EXTRA_CA_CERTS`, hostname SNI, IPv4/IPv6 SANs, a wrong-hostname failure
and a reachable IPv6 alias absent from the IP SANs. The independent IP control and broker both require OpenSSL-backed
X509 IP SAN matching, avoiding the Node 22.23 legacy matcher's IPv6/IDNA regression;
CA-chain verification remains on. No CA is installed into the host
trust store, and no TLS bypass or mocked socket is used. The suite fails rather
than skipping when isolation, IPv6, port binding or DNS is unavailable. The
credential-free CI `native-policy` job runs both suites sequentially and uploads
neither keys nor artifacts. Synthetic aliases prove real socket pinning and
classification, not external network connectivity or combined browser/provider
execution; public jobs remain blocked.

### Startup, isolation, and bounded cleanup

Before executing any network setup, the launcher verifies that both its
network and mount namespace identities differ from the parent's recorded
identities and that loopback is the namespace's only interface. It makes
mount propagation private, brings up loopback, and assigns exactly
`10.77.0.1/32`, `169.254.77.1/32`, and `fd00::1/128` there. IPv6 loopback `::1`
must also be usable. There is no attempt to repair or reconfigure host
networking if any prerequisite fails.

A mode-0700 scratch directory in the checkout contains the resolver file,
private browser profiles, and browser temporary files. The private mount
namespace bind-mounts that same owned directory at the existing `/mnt` as a
short browser scratch alias, verifying identical device/inode identity. The host's `/mnt`
is neither modified nor used as backing storage; namespace teardown removes
the alias. `/run` is deliberately not overlaid because `/etc/resolv.conf`
can be a symlink into it. This avoids Chromium's Linux process-singleton Unix socket
exceeding the 108-byte `sockaddr_un.sun_path` limit when `TMPDIR` contains the
long hosted checkout path. The launcher checks the expected short socket
path length and logs only its length and process/user IDs. Chromium stderr
logging is enabled to retain useful startup diagnostics without changing any
network policy or sandbox flags.

The first hosted namespace attempt at commit `96137d4` died during Chromium
startup with `SIGTRAP`, before browser probes ran; its checkout-backed temporary
path would produce a 131-byte process-singleton socket path. Crashpad's missing CPU-frequency
sysfs messages were not evidence that CPU scaling caused the crash. The
short namespace-private `/mnt` alias addresses that concrete path-length hazard.
With that change, commit `be1c18f` successfully started Chromium and completed
the namespace acceptance on hosted Linux. This resolves the observed startup
failure but does not independently prove that path length was its sole cause.

`/etc/resolv.conf` is
bind-mounted in the private mount namespace to use only `127.0.0.1`; its
host contents are never edited. The network-namespaced
`net.ipv4.ip_unprivileged_port_start=0` setting permits the unprivileged test
process to bind its local UDP DNS listener on port 53. The test independently
rechecks namespace identities and the resolver contents before binding.

Each namespace setup command has a 10-second timeout. Browser launch is
bounded at 15 seconds, initial extension-worker discovery at 10 seconds,
navigation at 5 seconds, and each trusted browser cache-control click at
3 seconds. The test has a 120-second timeout and the Playwright
run a 150-second global timeout; the inner runner and outer launcher add
180- and 210-second hard-stop bounds. The PID namespace and
`unshare --kill-child=SIGKILL` contain surviving descendants when the namespace
runner exits. Normal `finally` cleanup closes browser contexts, removes
profiles, destroys tracked accepted sockets, closes HTTP/DNS servers, and
removes the scratch directory. Namespace teardown removes its addresses,
mounts, and namespaced sysctl changes. Abrupt termination of the outer launcher
can still leave checkout scratch files; an ephemeral CI runner is the final
cleanup boundary, not proof that JavaScript `finally` ran after a job kill.

### Listener, policy, and DNS guarantees

The fixture binds HTTP servers specifically to `10.77.0.1`, `169.254.77.1`,
`::1`, and `fd00::1`, using one shared dynamically allocated destination port.
Each address must pass a real Chromium positive control: after clearing only
the proxy setting through the extension's trusted service worker, navigation
must return HTTP 200, the correct address-specific body, and an increased TCP
connection count. The cleared proxy readback must no longer be extension
controlled and must be in direct or system mode.

The deny proxy is **not** one of those destination listeners. Before every
browser launch and after every blocked lane, an independent check verifies
that the HTTP, HTTPS, and SOCKS5 fallback configurations all reference
`127.0.0.1:65534`, successfully binds and closes that exact TCP endpoint, and
requires a subsequent native TCP connection attempt to fail with
`ECONNREFUSED` within two seconds. A functioning endpoint, bind conflict, or
timeout fails the test. This check never records proxy-port activity as
destination-listener traffic.

Every browser starts with a fresh persistent profile and waits for the
extension's `ready: true`, `fault: null` state plus proxy/privacy readback:
the fixed proxy, `disable_non_proxied_udp`, and disabled network prediction
must all be controlled by the extension. Each enabled-policy lane performs
two rounds of navigations to all four literal addresses and the controlled
DNS name. Each must fail with `ERR_PROXY_CONNECTION_FAILED`. The test then
rechecks policy and the closed proxy, requiring **zero additional accepted TCP
connections and zero HTTP requests** at every destination sentinel. It uses
no CDP interception, request routing, `route.abort`, or simulated responses.

The local UDP DNS responder returns TTL-zero A records for exactly
`owned-rebind.test`, first pointing to `10.77.0.1`, then to `169.254.77.1`.
It returns no AAAA data for that name and NXDOMAIN for other names. Two
separate Chromium processes are launched once: one positive-control browser
with the proxy cleared, and one browser retaining its native policy. **Both
stay alive, with the same profiles, contexts, and target pages, across the DNS
answer flip.** No browser restart is used to clear resolver state.

In each phase the fixture explicitly destroys and awaits closure of its
accepted TCP sockets; HTTP responses also carry `Connection: close` and
`Cache-Control: no-store`. The trusted harness visits
`chrome://net-internals/#sockets` and clicks `#sockets-view-flush-button`,
then visits `chrome://net-internals/#dns` and clicks `#dns-view-clear-cache`
in each existing browser. These actual DOM controls were inspected and
successfully clicked locally in the pinned full Chromium build
145.0.7632.6. Missing controls, failed clicks, or navigation failures fail the
acceptance test; there is no silent fallback, skipped assertion, resolver
mapping, or new security-relaxing browser flag.

After each cache clear the positive-control page navigates to the **exact
same URL**, `http://owned-rebind.test:<port>/same-process-rebind`. Each
navigation must produce a new observed A response containing the current
owned IP, an increased connection count at that IP's sentinel, HTTP 200, and
the correct address-specific body. Thus a successful run proves real
same-process resolution to both owned listeners on new TCP connections,
not merely successful cache-button clicks or different fresh profiles.
After the control finishes, its fixture sockets are closed again. The
still-policy-enabled browser attempts that identical URL twice in each
phase, as well as the literal address controls, and must leave all destination
connection and request counters unchanged.

This covers **same-process, harness-forced DNS answer changes on
navigation**, with an independently retained native-policy process denying
that hostname before and after the answer switch. The blocked proxy can
reject before resolving the destination, so blocked lanes are deliberately
not required to query DNS or consume its current answer. Do not describe
them as observing a rebinding response under policy. The test does not prove
unassisted TTL expiry, malicious-page access to privileged cache controls,
same-document fetch rebinding, retained HTTP/2 connections, or a transition
from an initially permitted public address to a denied private address.
Both DNS answers are deliberately owned and private; no public or provider
destination is probed. Local macOS inspection validates the internal-page
control mechanism only; the `be1c18f` hosted runs documented below supply the actual
Linux DNS and namespace acceptance for this scenario.

This focused lane covers HTTP navigation, repeated proxy failure, those four
owned addresses, and forced same-process DNS answer changes only. It does not
establish HTTPS/TLS or QUIC coverage, WebRTC/STUN/TURN transport behavior,
workers/subresource behavior, IPv6 link-local scope-ID handling, every address
representation, UDP/TCP DNS fallback, provider execution, or deployment
isolation. Privacy readback is configuration evidence, not a substitute for
transport-specific tests. The separate native-policy suite owns additional
browser-surface tests; neither suite alone proves a complete production
network sandbox or safe provider rollout.

### Hosted acceptance evidence

On 2026-09-19, both push and PR `native-policy` jobs passed at `be1c18f`.
The [push job 105923619650](https://github.com/xsachax/hack-the-north-2026/actions/runs/35453119450/job/105923619650)
reported all nine standard native-policy tests passing in 44.9 seconds, then
Linux Chromium **145.0.7632.6** exercising same-process DNS phases
`10.77.0.1` and `169.254.77.1`. The namespace test passed in 3 seconds
(4.3 seconds total for its Playwright run). The PR
[run 35453120781](https://github.com/xsachax/hack-the-north-2026/actions/runs/35453120781)
also completed `check`, `native-policy`, and `container` successfully.
This is actual hosted Linux evidence for that commit, not an inference from
macOS static checks or local inspection. Later source changes need their own
exact-head acceptance; the behavioral limits above still apply.

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
