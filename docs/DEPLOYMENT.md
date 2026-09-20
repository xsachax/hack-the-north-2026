# Single-host release deployment

## Boundary and prerequisites

This packaging runs **one Next application and one optional paid worker in one
container, on one host, against one local persistent volume**. Do not scale the
service or put its SQLite files on NFS/network storage. The worker's controlled
fixture transport remains literal `127.0.0.1:4321`; a separately networked worker
container is not compatible. This is controlled-fixture packaging, **not a solution
to arbitrary-site browser egress**. Issue #8 remains blocked. Do not enable
arbitrary targets or infer an egress guarantee from Docker networking.
Before reassessing that blocker, follow the official-source and provider/operator
no-bypass checklist in [Layer08 prerequisite refresh (2026-09-19)](EXECUTION.md#layer08-prerequisite-refresh-2026-09-19),
including its distinction between mandatory destination enforcement and optional
TLS path policy. See [capabilities and release limits](CAPABILITIES.md) for what
the current application does and does not demonstrate.

Required: Docker Engine with Compose v2 on a single Linux host, local durable
storage, and an independently configured HTTPS reverse proxy terminating a real
certificate. Only host loopback port 3000 is published. Route that proxy to
`http://127.0.0.1:3000`, preserve the public Host/Origin and cookies, support
streaming responses, disable buffering for SSE, and prevent direct untrusted
access to the backend. The proxy is operator infrastructure; no fictitious cloud
firewall or egress appliance is provisioned here.

`DEPLOYMENT_BIND_HOST` accepts only `0.0.0.0` (the container default) or
`127.0.0.1`. Clean local Node rehearsals must set `DEPLOYMENT_BIND_HOST=127.0.0.1`
so the private app is not exposed on host interfaces. This does not change the
worker's literal-loopback fixture transport or the loopback-only health server.

The image uses supported Node **22** (application minimum 22.18). Build and runtime
use the same Node image family, lockfile, source and Next configuration.
The credential-free `.npmrc` (`engine-strict=true`) is included in the clean
install, build/runtime image and release source digest. Never put registry tokens
in that checked-in file; private registry authentication, if ever needed, requires
a separately reviewed build-secret mechanism, not an image/context credential.
Pin the tested base-image digest and release image ID in your deployment inventory before
production promotion; `node:22-bookworm-slim` itself is a moving security-update
tag. Use `docker compose build --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:YOUR_VERIFIED_DIGEST`
to use the same pinned base in both stages. Dependencies remain Stagehand 4.1.0,
Zod 4.4.3 and Browserbase SDK 2.20.0.
The runtime intentionally retains locked dependencies including `tsx`; no
different worker dependency installation or worker-only config is used.

## Provision and build

The same package now also contains the opt-in managed Agents MVP at `/managed`.
Enable it only after reviewing the [managed policy and worker limits](WORKER.md#managed-agents-worker-separate-mvp):
set `ENABLE_MANAGED_AGENTS=true`, `BROWSERBASE_MANAGED_AGENT_ID` to a provisioned
agent in the reviewed account, `MANAGED_AGENT_ALLOWED_ORIGINS` to exact public
origins, and `DEPLOYMENT_CONFIRM_PAID=true`. Keep native/demo flags false when
only managed execution is intended. Runtime secrets remain server-only.
The reusable agent is not automatically deleted by the worker; the operator
owns its lifecycle. This mode does not enforce native network confinement or
provider-side hard TTL/model-call caps, and does not change the health endpoint's
truthful `productReleaseReady: false` / issue8 gate.

Run from the repository root. Runtime files below are git-ignored and excluded
from the allowlisted Docker build context. Do not copy `.env.local`, data, reports,
screenshots, private run outputs, keys, or the host `node_modules` into the image.
Never pass credentials as build arguments. `deployment-build.ts` rejects local
`.env` files and builds with an allowlisted, credential-free environment.

```sh
umask 077
mkdir -p deploy/secrets deploy/backups
cp deploy/runtime.env.example deploy/runtime.env
node -e "require('fs').writeFileSync('deploy/secrets/access-code', require('crypto').randomBytes(32).toString('hex')+'\n', {mode:0o600})"
: > deploy/secrets/browserbase-api-key
chmod 700 deploy/secrets deploy/backups
chmod 600 deploy/runtime.env deploy/secrets/*
# Edit deploy/runtime.env: set APP_ORIGIN to the exact public HTTPS origin.
# Leave ENABLE_DEMO_RUNS=false and DEPLOYMENT_CONFIRM_PAID=false initially.
export RELEASE_TAG=release-2026-09-19
docker compose config --quiet
docker compose build --pull
docker compose run --rm init-data
docker compose run --rm --no-deps --entrypoint node app --import tsx scripts/deployment-migrate.ts
docker compose up -d app
docker compose exec app node --import tsx scripts/deployment-health.ts startup
docker compose exec app node --import tsx scripts/deployment-health.ts readiness
docker compose exec app node --import tsx scripts/deployment-health.ts liveness
curl --fail http://127.0.0.1:3000/demo/category/home -o /dev/null
```

Compose initializes `/data/private` and `/data/backups` as UID/GID 1000, mode
0700, using a network-disabled, one-shot root initializer. The serving processes
run as 1000:1000, with all capabilities dropped, a read-only image and a private
128 MiB Next cache tmpfs and a separate 128 MiB UID1000-owned mode0700
`/tmp` tmpfs (`noexec,nosuid,nodev`). `TMPDIR=/tmp` is configured in the image
before Playwright imports. Even remote `chromium.connectOverCDP` creates a local
temporary artifact directory; disabling tsx caching alone does not support this
path. The hosted offline gate exercises the actual pinned CDP client against a
local rejection stub and verifies cleanup, without allocating a browser.
Database and sidecars are private; process umask is 077.
The runtime image sets `TSX_DISABLE_CACHE=1` for the supervisor, worker, probes
and maintenance commands, preventing the pinned tsx loader from trying to create
its disk cache under the read-only `/tmp`. Compose explicitly sets the container
app bind to `0.0.0.0`; the clean-local supervisor honors validated `127.0.0.1`.
Do not recursively chown or relax permissions to make a broken mount work.
Rootless/user-namespace hosts must map ownership appropriately. Compose's local
file-backed secrets must be readable by container UID 1000; provision them for
that mapped UID without making them world-readable. Verify this on the target
host before paid enablement. A failed secret read fails startup without dumping
the secret.

No automatic TLS provisioning is included. Before sharing the deployment, test
the **public HTTPS origin**, access-code rejection, same-origin/CSRF behavior,
streaming, and secure cookies with the configured proxy. Health is not permission
to enable spending.

## Paid enablement and limits

Offline startup needs a strong (at least 32 characters) access code and exact
HTTPS origin, but no cloud credential. To explicitly enable controlled runs:

1. Provision `deploy/secrets/browserbase-api-key` through the host's private
   secret-management procedure; never put its value in a shell command, Git, a
   build arg, issue, log, or rehearsal artifact.
2. Set `BROWSERBASE_PROJECT_ID` to the explicit authorized project UUID, and set
   **both** `ENABLE_DEMO_RUNS=true` and `DEPLOYMENT_CONFIRM_PAID=true` in
   `deploy/runtime.env`.
3. Review project billing, release evidence and the ceilings below. Recreate the
   service: `docker compose up -d --force-recreate app`. Repeat all three probes.

The supervisor passes `--confirm-paid` only after validating that gate. Secrets
are read at runtime from mounted files; ambiguous file-plus-value secrets fail.
Changing secret files requires a service recreate. Do not expose the Docker
socket, host secret paths or runtime environment to application users. Embedded
replay remains disabled unless exact approved HTTPS media origins are explicitly
configured in `BROWSERBASE_REPLAY_ORIGINS`.

| Limit | Shipped setting |
| --- | --- |
| Container | 2 CPUs, 2 GiB memory, 256 PIDs |
| Per Node heap | 768 MiB (app, worker, supervisor share container ceiling) |
| Concurrent paid sessions | 3 global / 3 per owner |
| Session / steps / model calls | 120 seconds / 12 / 14 |
| Development budget / external baseline | 324000 / 1092 seconds |
| Per-owner budget / lifetime reservation cap | 3600 / 3600 seconds |
| Lease / recovery attempts | 30000 ms / 6 |
| Worker cleanup / supervisor app cleanup | 60000 ms (+2000 force margin) / 10000 ms |
| Container stop grace | 90 seconds |
| Local logs | 3 × 10 MiB rotation |

These are ceilings, not a billing quote or proof of provider cleanup. Worker
policy is persisted in SQLite and mismatches fail rather than silently changing
historical budget accounting. Set intended policy before the **first migration**;
later changes need a separately reviewed policy migration, not database deletion.
The deployment-only baseline of 1092 seconds conservatively reflects currently
known project history; it is not permission to disregard additional prior usage.
Before first migration, new operators must supply their actual prior external
usage (at least the applicable known baseline), including other hosts and manual
runs, and review the nonrefundable 3600-second lifetime reservation cap. Never
reset a ledger, lower recorded historical usage, or create a fresh volume to
recover exhausted launch capacity. These deployment defaults do not rewrite
historical defaults in the normal worker or an existing database; a persisted
policy mismatch remains a fatal operator-review condition.
Local evidence, contexts, database and backups have no automatic disk quota or
retention deletion. Provision capacity and alerts on bytes/inodes; stop admission
before exhaustion. Set a host storage quota only after estimating retained data.

## Startup, probes and shutdown

`deployment-start.ts` validates Node/nonroot execution, runtime config, the version-2
source/build receipt, transactional app migrations, persisted worker policy,
WAL, SQLite quick-check and foreign keys. It then starts Next, waits for the local
fixture and, when enabled, waits for the real worker's `worker_ready` plus IPC
heartbeat. It never invokes a cloud smoke test to decide readiness.

The receipt hashes deterministic runnable `.next` bytes **and every installed
`node_modules` file**, including direct worker/Next dependencies not linked from
the build. Only mutable Next cache, development/diagnostic/type metadata, traces,
lock and the receipt itself are excluded. Build symlinks must resolve inside
`node_modules`; their target contents are hashed and cycles/outside targets fail.
Changing compiled output or installed dependencies invalidates approval even
when `BUILD_ID` remains unchanged. `assertReleaseBuild()` returns a SHA-256 package
fingerprint binding the verified source/config digest, build ID and runnable-byte
digest; paid-approval adapters must pin this returned fingerprint, not merely the
source digest or `BUILD_ID`. The local receipt is not an external signature:
rewriting it after a mutation creates a different fingerprint requiring new
approval. Source-only legacy receipts are rejected and require a clean rebuild.

The clean Node package and source receipt share one public-source allowlist.
It includes all JS/JSON beneath
`src/server/execution/native-policy-extension/` (including nested assets), as
does the Docker context. Changing native policy JavaScript or its manifest
invalidates the receipt even without a new `BUILD_ID`. Installed-byte hashing
also binds the pinned Stagehand `dist/assets/stagehand-extension.zip` and its
dependencies, rather than trusting package versions alone. A deterministic
composed extension is bound by its source composer, public assets, and installed
input archive; private/generated archives are not copied into the source package
or added as approval inputs. Dotenv files remain excluded.

The supervisor serves **loopback-only port 4322**, not a public health route:

* `startup`: initialization and child startup completed.
* `readiness`: startup complete, children alive, paid worker event-loop heartbeat
  younger than 15 seconds, readable expected-schema WAL database and a successful
  local fixture response. No paid browser is created by a probe.
* `liveness`: supervisor responsive and children/worker heartbeat alive after
  startup. This is not a guarantee that a remote provider session is responsive.

Use the exact `deployment-health.ts` commands above for external process checks.
The CLI prints the probe's JSON response. A successful readiness response means
`operationalReady: true` only: every response also states
`websiteExecutionEnabled: false`, `productReleaseReady: false`, and
`releaseBlockedBy: "issue8"`. Startup/liveness success never claims operational
readiness. Public website execution and the product release remain blocked
independently of successful infrastructure checks.
Compose uses readiness every 15 seconds, 5-second timeout, 90-second initial
allowance and three failures. Docker marking a container **unhealthy does not
restart it**; alert and investigate before a deliberate restart. `docker compose
logs --tail=100 app` provides bounded diagnostics; treat all operational logs as
private. Do not publish logs or `docker inspect` environment dumps.

`docker compose stop -t 90 app` sends SIGTERM through Docker's init to the
supervisor. Readiness fails immediately. The worker receives SIGTERM first; its
existing cancellation/release/reconciliation path gets up to 60 seconds while
the fixture remains available. Next is stopped afterward. Unexpected child
exit stops the whole service and exits nonzero. Forced shutdown also exits
nonzero; recovery/quarantine and existing reservations must be investigated on
restart, never erased. SIGINT uses the same path.
Next's handled SIGTERM convention (exit 143) is accepted only for the app child;
the worker must exit zero. Its own cleanup-deadline failure is never converted to
a successful supervisor shutdown.

## Upgrade, backup and rollback (local only)

Never copy a live SQLite file by itself or delete `-wal`/`-shm`. Backups require
**all app and worker writers stopped** and no other shell/repair tool holding
the volume open. Maintenance commands bypass the supervisor and must never run
concurrently with `app`. The backup confirmation is an operator assertion, not
proof that an unknown external process is stopped.

```sh
# First remove/disable proxy admission and let current work drain as appropriate.
docker compose stop -t 90 app
docker compose ps --all
# Choose a NEW local directory name every time; never overwrite a backup.
docker compose run --rm --no-deps --entrypoint node app \
  --import tsx scripts/deployment-backup.ts --confirm-stopped /data/backups/pre-upgrade-20260919
docker compose cp app:/data/backups/pre-upgrade-20260919 deploy/backups/pre-upgrade-20260919
chmod -R go-rwx deploy/backups/pre-upgrade-20260919
```

The backup command validates the schema/integrity, sets `synchronous=FULL`,
requires a successful `wal_checkpoint(TRUNCATE)`, closes SQLite, and copies the
entire quiescent data directory including artifacts/contexts. It rejects symlinks,
special files, nested destinations and overwriting a backup. A failure leaves
services stopped; preserve and inspect partial copies, do not count them as a
backup. Keep the exported backup on operator-controlled **local** protected
storage, separate from the volume, preferably on encrypted media. This does not
upload data or arrange a cloud backup. Test restoring a copy before relying on it.
Every backup includes a private `deployment-backup.json` quarantine marker with
the snapshot's reserved seconds, `paidRestartAllowed:false` and
`postSnapshotHistoryPreserved:false`. The supervisor and deployed worker reject
paid startup whenever this marker is present, regardless of its contents.
An intact snapshot is not evidence that later spending/resources never existed.

Record the image ID, source revision, lockfile, runtime policy and SQLite schema
version with the backup (never secret values). Build the new release, run the
migration command while stopped, then `docker compose up -d app` and the probes.
Migration transactions are the existing application's transactions; migration
failure is fatal. Do not reset schema versions or delete tables. An older image
must refuse a database newer than its migrations.

If rollback is needed, stop everything again. Prefer a forward fix. Otherwise
restore the **entire pre-upgrade snapshot with its matching old image**, retaining
the failed state for investigation. This discards post-backup local changes, including historical reservations.
**Both paid flags must remain false after any restore predating allocations.**
Remote closure/reconciliation does not preserve missing reservation history:
a 3,480-second snapshot followed by another 120 seconds has exhausted a
3,600-second lifetime cap, but restoring that snapshot loses those 120 seconds.
Never replenish the budget this way. Preserve the newer database, all historical
reservations (including failures/refunds), and unresolved resource identities.
Paid restart requires separately reviewed, schema-compatible preservation and
reconciliation of **all** of that history; otherwise use a forward fix.
There is no automated reconciliation or quarantine-clear command here.
Do not delete the marker merely to enable paid mode. Older images may lack the
marker guard, so the explicit web-only flags below remain mandatory.

Example, after independently verifying the snapshot and stopping app/worker:

```sh
# Root is used only for offline volume-directory replacement, never serving.
docker compose run --rm --no-deps --user 0:0 \
  --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER \
  --entrypoint /bin/sh app -ec \
  'test -d /data/backups/pre-upgrade-20260919; test ! -e /data/failed-upgrade-20260919; mv /data/private /data/failed-upgrade-20260919; cp -a /data/backups/pre-upgrade-20260919 /data/private; chown 1000:1000 /data/private; chmod 0700 /data/private'
# Set RELEASE_TAG to the recorded pre-upgrade image tag, without rebuilding it.
docker compose run --rm --no-deps --entrypoint node app --import tsx scripts/deployment-migrate.ts
# Temporary WEB-ONLY recovery: explicit overrides apply even if runtime.env was paid.
# Use an unused container name. The normal app service remains stopped.
docker compose run --detach --no-deps --service-ports \
  --name flash-flood-recovery-web-only \
  -e ENABLE_DEMO_RUNS=false -e DEPLOYMENT_CONFIRM_PAID=false app
docker exec flash-flood-recovery-web-only node --import tsx scripts/deployment-health.ts readiness
```

This restores web availability only, not historical budget completeness or
permission to allocate. Stop this named recovery container before a reviewed
forward deployment. Never substitute a paid `docker compose up` after restore.
Do not use `docker compose down -v`, volume pruning, resets or a reduced
`PRAGMA user_version` as a migration rollback.

## Retirement

Disable proxy admission first; finish cancellation and reconcile unresolved
provider sessions/reservations using the existing worker operations runbook.
Retire persisted browser contexts through the app's supported context lifecycle
before stopping the final worker; don't merely remove local context rows.
Then stop with the 90-second grace, take the final quiescent local backup, and
revoke/rotate the provider key and access code. Retain audit/evidence and backups
according to the operator's privacy policy, with explicit authorization before
deleting any volume or snapshot. `docker compose down` (without `-v`) preserves
the named volume. Verify remote retirement independently; a successful container
stop is not proof of provider deletion.

## Verification and known gap

Focused offline regressions:

```sh
node node_modules/vitest/vitest.mjs run src/server/deployment/deployment.test.ts
node node_modules/eslint/bin/eslint.js src/server/deployment scripts/deployment*.ts --max-warnings=0
```

On a functioning Docker Engine, run the bounded, **offline-only** hosted gate:

```sh
node --import tsx scripts/deployment-docker-validate.ts
```

This uses a random Compose project, image tags, volume and ephemeral host-loopback
port. It does not touch the operator's `deploy/runtime.env` or credential files.
Generated files stay mode-private under ignored `data/deployment-validation`;
a uniquely named fake root `.env` sentinel is removed afterward. Build timeout
is ten minutes, each startup is bounded to two minutes, and container stop retains
the 90-second graceful deadline. Allow a 20-minute hosted-job timeout including
build, probes and cleanup.

The gate builds the actual production Dockerfile, separately copies the actual
allowlisted build context into an audit image, and scans both context and runtime
application files for a random private-output/secret sentinel. It verifies the
nonroot UID/GID, read-only image, directory/database/sidecar modes, release receipt,
migrations, all probes and Docker's own healthy state. It requires paid flags
false, an empty provider-key file, no provider project and no paid worker process.
It exercises the actual Playwright CDP temporary-directory path against a
loopback rejection stub. Finally it sends graceful stop, requires exit zero,
makes a quiescent local backup, checks persisted data and paid quarantine, boots
that snapshot web-only, and gracefully stops it again.
Cleanup removes only its own named containers/project volume and generated image
tags; it never prunes resources or restarts/repairs the Docker daemon.

No Browserbase credential, model call, paid browser or external TLS proxy is used.
Success ends with `offline_docker_validation_pass_product_release_blocked_issue8`;
it proves offline packaging, not product release or the provider egress boundary.
Both push and pull-request container jobs passed at the paid proof's reviewed
source revision `a5de2ba6fb4e1fd10f7ba229bdb73b86ea17db5c` (Actions runs
35448737860 and 35448740431), including actual CDP scratch and web-only snapshot
quarantine. Final PR checks must still pass on its exact final head.

The authoring host has Docker CLI 28.4.0 and Compose 2.39.2, but Docker daemon
`/version` and `/info` return HTTP 500. Therefore image build, container UID/volume,
read-only filesystem and Docker signal/health behavior were not verified on that
local daemon; it was not repaired or restarted. The independent hosted execution
above supplies actual container evidence, not an inference from Compose parsing.
An operator's real HTTPS proxy, storage mount and provider configuration still
need environment-specific acceptance; no external deployment was provisioned.

Authoring evidence: Compose configuration parsed successfully; the actual
`docker build --pull -t flash-flood:validation .` attempt failed at daemon
`/_ping` with HTTP 500. All 45 packaging regressions and focused ESLint passed.
A separate allowlisted directory completed `npm ci` and the release build on
Node 22.19.0, then passed startup/readiness/liveness, fixture HTTP, SIGTERM exit
0, persistent-database reopening, a quiescent local backup and backup schema
validation. Those packaging checks made no cloud calls.
The refreshed clean-Node run also booted the restored snapshot and confirmed
future-schema startup refusal without changing the stored schema version.
The version-2 receipt was additionally checked against an actual clean production
build: modifying compiled Next JavaScript or installed Zod package bytes was
rejected with the same `BUILD_ID`; restoring those bytes recovered the approved
fingerprint. Normal startup, all probes and graceful shutdown left that
fingerprint unchanged, with the 1092/3600 deployment policy persisted.

The separately authorized layer08 rehearsal then exercised the real clean
packaged supervisor, worker and original-owner HTTPS flow with four actual cloud
sessions. Broken multi-persona evidence, active cancellation, selected fixed
comparison and current-owner decoded HLS passed. All four sessions were
independently `COMPLETED`; private recording inspection and file-only finalization
passed. [WORKER.md](WORKER.md#layer08-release-rehearsal) records exact charges and
limits. This is clean Node paid-runtime evidence, not a claim that a paid worker
was run inside the hosted offline container.

The proof preserves its approved 1,092-second baseline. Fresh later work against
this same provider project must explicitly account for the now-known
1,345.293 actual seconds (rounded-up baseline **1,346**) before initializing a
new policy. Never modify/reset an existing ledger to regain its lifetime cap.

A clean, isolated, credential-free Node 22 lockfile installation and Next build
can validate application packaging without Docker. A clean build must contain
only the Docker allowlisted source/config files, not this checkout's `.env.local`.
Run `node --import tsx scripts/deployment-build.ts` in that clean directory, then
set the documented runtime variables and execute
`DEPLOYMENT_BIND_HOST=127.0.0.1 node --import tsx scripts/deployment-start.ts` as a
nonroot user. Verify all three health commands, fixture HTTP, SIGTERM, reopening
the same data directory and the backup command. This is an alternative code-path
check, **not container validation**. No paid/cloud call is needed or authorized.
