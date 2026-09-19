# Layer08 bounded release rehearsal

**No paid run is authorized by this document or the offline preflight.**
The harness is `scripts/release-integration.ts`; `scripts/release-runtime.ts`
drives the actual clean packaged Node supervisor. `--confirm-paid` requires an
explicit package directory and fresh source/package/ledger-bound approval.
Never substitute a mock runtime or write a successful approval for unrun gates.

## Zero-cloud commands

```sh
npx vitest run src/server/worker/release-*.test.ts
npx tsx scripts/release-integration.ts --offline-preflight
npx eslint scripts/release-*.ts src/server/worker/release-*.test.ts --max-warnings=0
```

Preflight uses the real SQLite repository for queued admission and cancellation,
but starts **no worker, provider client, Gateway request, or remote browser**.
It reports `acceptance:false`. It does not claim the HTTPS UI was exercised.
Tests fault-inject the normal worker allocation boundary; test evidence is not
cloud acceptance. Dependencies must already be installed.
The default `npm test` suite includes these release-prefixed tests.

## Proposed live plan: four sessions, no retries

1. **Broken multi-persona (2):** bargain-hunter and careful-first-timer use the
   real Gateway/normal worker to add a mug and apply SAVE10, then COZY5. Stop in
   the cart. Require the report's exact confirmed secondcoupon fixture defect
   and available evidence, not an unmet criterion alone.
2. **Active cancellation (1):** admit a fixed run, wait for its persisted active
   provider reference, then cancel via the authenticated HTTPS owner API.
   A missed cancellation is failure, not permission to launch again.
3. **Selected fixed rerun (1):** select one genuinely affected broken attempt,
   use the existing rerun API with fixed scenario, require the positive coupon
   oracle and `confirmed_fixed` comparison, fresh lineage, and unchanged parent.

Maximum new reservation for this plan: **1,200 seconds**. The persistent lifetime
cap is **3,600 newly reserved seconds**, plus **1,092 baseline seconds**
(development bound 4,692). Every prior failed/refunded/reducer reservation remains
counted; completion/refunds never replenish the lifetime cap. An invocation
needs room for all four planned reservations. The worker performs the durable
reservation before allocation; the harness does not introduce another allocator.
Global/owner concurrency is at most three, provider TTL at most 300 seconds.
No new context, takeover, or paid reduction is requested. Prior layer07 proof may
be referenced for unchanged context/takeover surfaces, with its original scope
and source compatibility reviewed honestly; it is not fresh layer08 evidence.
There is **no assertion that all six planted defects were found**.

## Clean packaged runtime and approval

Prepare a new private package directory after final source edits. This copies
only the Docker source allowlist and performs a fresh locked installation and
credential-free deployment build; existing directories are never overwritten.
The package check starts the actual supervisor twice, proves HTTPS owner
continuity and disabled paid admission, then verifies zero reservations:

```sh
npm run release:package -- data/release-package
RELEASE_PACKAGE_DIR="$PWD/data/release-package" npm run release:package-check
npm run release:integration -- --offline-preflight
```

The implemented `ReleaseDeployment` adapter:

- `verifyPackage()` verifies the source-bound packaged build and returns its
  SHA-256 digest. Bind this digest in the approval.
- `start({directory,dataDir,accessCode,policy,offline,signal})` runs the packaged
  Node entrypoint with its intentionally retained, pinned `tsx` loader. Next
  and the normal repository worker are children of the real deployment
  supervisor, not a rehearsal-specific allocator. The adapter returns the
  local Playwright browser and loopback HTTPS origin.
- `startWorker` gracefully stops the web-only supervisor and starts it in
  explicitly confirmed paid mode before admission. `stopWorker` drains and
  stops that supervisor, then restarts web-only for reports. The proxy and
  browser retain the original cookie, HTTPS origin and persistent data across
  these restarts. No fresh owner replaces the original. This exercises the
  actual production supervisor lifecycle, not just its components.
- Bind all sockets to loopback; use a real HTTPS proxy with correct APP_ORIGIN.
  Keep TLS keys private and remove them on every exit. Suppress child logs.
  Refuse worker startup offline. Await worker cleanup before closing observers.
  Stop only owned process handles; never kill by name or sweep unrelated PIDs.
- Interrupt cancellation and a bounded worker shutdown deadline are wired.
  Validate package health on an isolated clean deployment before authorization.
- Pass the exact parent-provided `BROWSERBASE_REPLAY_ORIGINS` from `.env.local`
  into the application. Never inspect prior worktrees, infer signed media hosts,
  widen the allowlist, or reuse a removed prior-owner credential.

The parent, after actual offline/lint/typecheck/tests/build/security/review gates,
must write private `data/release-rehearsal/approval.json` (mode 600, nonsymlink).
Its schema is `releaseApprovalSchema`: exact source/package/cumulative-ledger
digests, all gate booleans true, explicit `paidAuthorized:true`,
`privateMediaReadbackAuthorized:true`, `plannedSessions:4`,
and `reviewedAt`. It expires in 15 minutes. The harness never writes approval.
Approval is not permission to repeat a failed session; any new plan needs fresh
human authorization with remaining cumulative reservations disclosed.

After the coordinator's approval only:

```sh
RELEASE_PACKAGE_DIR="$PWD/data/release-package" npm run release:integration -- --confirm-paid
```

The package, source and existing cumulative ledger must still match the approved
digests. Ports 4321/4322 (package) and 4330 (private HTTPS observer) must be free.
The harness never terminates another listener to obtain them.

## Evidence, readback, and cleanup

All evidence stays under ignored `data/release-rehearsal/` (mode 700) in an
invocation UUID directory (mode 700). No owner/provider IDs, URLs, credentials,
or raw exceptions are printed by the CLI. Owner cookies exist only in memory and
the browser; there is deliberately **no owner-resume mode**, credential file,
new-owner readback fallback, or renewing resume clock.
CLI failures also create a private root `failure-UUID.json` recording only the
fixed execution stage, error kind and missing-path flag, never raw error text,
stack traces, credentials or provider URLs. This covers entry failures before an
invocation exists. The maintained paid command has an offline subprocess
regression with network disabled and a deliberately missing package; reaching
that package boundary proves the actual tsx configuration-loading path, not a
different diagnostic loader. A failed preflight is not permission to retry paid
work or renew approval.

The actual HTTPS owner cookie, owner API, normal worker/Gateway counters, wall
events, criterion citations, private evidence endpoints, reports and rerun
comparison are checked. Desktop/mobile report and wall PNGs and a local
Playwright **recordVideo WebM backup** are private mode 600; recording begins
without typing secrets into the page. Every asset is hashed and inventoried.
Video is a backup of the local observer, **not proof of remote decoded playback**.
Any unchanged remote viewer/playback proof reused from earlier layers must be
identified separately rather than inferred from this video.

After the selected fixed run, `release-media.ts` uses the **genuine current
owner's original cookie**, existing persisted session association and actual
report UI recording consent. It cannot start a worker, admit/cancel a run,
bootstrap an owner or allocate a provider session. Processing readback is bounded
to six metadata checks, at least 5.5 seconds apart, with a 90-second scheduling
deadline (each in-flight response has a 15-second timeout). Provider retry-after
is respected; if it exceeds the remaining deadline, stop without another check.
Ready media must advance time, decode nonblank frames and load only protected
same-origin playlist/segments using the existing report playback adapter.
Playback itself is bounded to 30 seconds. A private decoded frame joins the
hashed inspection inventory. Ledger/owner continuity is checked throughout.
Processing/unavailable/expired/unsupported are explicit **unverified playback**
results, not a reason to allocate another session. Final reviewed evidence
preserves this distinction; prior accepted HLS proof (one metadata read,
119 decoded frames) remains prior evidence, not current-owner playback.

After stopping the worker, the harness independently GET/lists and retrieves
**every cumulative correlated provider session**, including historical failed
attempts and reducer candidates. The exact set must match persisted references,
be `COMPLETED` (not merely terminal), fit TTL, and have peak concurrency <=3.
Missing, unknown, extra or mismatched identities fail closed. Worker release
responses are not independent closure. No automatic provider retries.

Cleanup attempts all steps even if cancellation or closure fails: owned run
cancellation, worker stop, independent closure, browser close/video flush,
owned process/proxy/TLS cleanup, file inventory, then exclusive lock release.
`cleanup.json` is written only when these steps all succeed. Unknown cleanup
or closure remains a failed rehearsal, never a fabricated success.

The parent must really open **every** private PNG and play the private WebM,
consent to private pixels, and write UUID/`inspection.json` matching
`releaseInspectionSchema` with the exact hashes, invocation/source identity,
inspection time and `inspected:true` entries. Inventory alone is not inspection.
`npm run release:finalize -- ORIGINAL-INVOCATION-UUID` is file-only, makes no cloud calls, rehashes the
exact asset set, and requires successful closure/cleanup and that parent receipt
before writing `reviewed-proof.json`. No automatic receipt generation.
