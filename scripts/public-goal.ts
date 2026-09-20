import "server-only";
import Browserbase from "@browserbasehq/sdk";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { runSchema, eventSchema } from "../src/lib/contracts";
import { runReportSchema } from "../src/lib/report-contracts";
import { configSchema } from "../src/lib/config";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../src/server/public-execution-readiness";
import { assertReleaseBuild, releaseSourceDigest } from "../src/server/deployment/build";
import { buildComposedExtension } from "../src/server/execution/composed-extension";
import { readPrivateJson, writePrivateJson } from "./advanced-proof";
import { withReleaseLock, type ReleaseRuntime } from "./release-integration";
import { packagedPublicDeployment } from "./release-runtime";
import { publicHarnessDigest } from "./public-proof-source";
import {
  assertPublicProofApproval, assertPublicProofSettled, assertNativeOnlyProofInventory, openPublicProofLedger,
  publicProofPlanSchema, publicProofHash, readPublicProofLedger, type PublicProofPlan, type PublicProofLedger,
} from "./public-proof";

async function verifyInputs(plan: PublicProofPlan) {
  if (await releaseSourceDigest() !== plan.sourceDigest ||
    await releaseSourceDigest(plan.packageDir) !== plan.sourceDigest ||
    await assertReleaseBuild(plan.packageDir) !== plan.packageDigest ||
    await assertReleaseBuild() !== plan.harnessPackageDigest ||
    await publicHarnessDigest() !== plan.harnessDigest ||
    (await buildComposedExtension()).sha256 !== plan.archiveDigest) throw new Error("public_approved_inputs_changed");
}

type RemoteSession = Pick<Awaited<ReturnType<Browserbase["sessions"]["retrieve"]>>,
  "id" | "projectId" | "userMetadata" | "status" | "startedAt" | "endedAt">;
type ClosureProvider = {
  sessions: { retrieve(id: string): PromiseLike<RemoteSession> };
  extensions: { retrieve(id: string): PromiseLike<unknown> };
};
/** Independent exact-ID reads only: this verifier cannot release or retry resources. */
export async function verifyPublicProofClosure(provider: ClosureProvider, projectId: string, ledger: PublicProofLedger, signal?: AbortSignal) {
  signal?.throwIfAborted();
  assertPublicProofSettled(ledger);
  const sessions: { sessionId: string; actualBrowserSeconds: number; startedAt: string; endedAt: string }[] = [];
  for (const launch of ledger.launches) {
    signal?.throwIfAborted();
    if (launch.sessionId) {
      const remote = await provider.sessions.retrieve(launch.sessionId);
      signal?.throwIfAborted();
      if (remote.id !== launch.sessionId || remote.projectId !== projectId ||
        remote.userMetadata?.correlationToken !== launch.correlationToken ||
        remote.status !== "COMPLETED" || !remote.endedAt) throw new Error("public_independent_closure_unconfirmed");
      const actualBrowserSeconds = (Date.parse(remote.endedAt) - Date.parse(remote.startedAt)) / 1000;
      if (!Number.isFinite(actualBrowserSeconds) || actualBrowserSeconds < 0 || actualBrowserSeconds > ledger.policy.sessionSeconds ||
        launch.consumedSeconds < Math.ceil(actualBrowserSeconds) ||
        Date.parse(remote.endedAt) > Date.now()) throw new Error("public_remote_usage_rejected");
      sessions.push({ sessionId: remote.id, startedAt: remote.startedAt, endedAt: remote.endedAt, actualBrowserSeconds });
    }
    if (launch.resource?.extensionId) {
      signal?.throwIfAborted();
      let deleted = false;
      try { await provider.extensions.retrieve(launch.resource.extensionId); }
      catch (error) {
        if (!(error instanceof Browserbase.APIError && error.status === 404)) throw new Error("public_extension_readback_failed");
        deleted = true;
      }
      if (!deleted) throw new Error("public_extension_not_deleted");
      signal?.throwIfAborted();
    }
  }
  return sessions;
}

export async function runPublicGoal(planPath: string, approvalPath: string, signal: AbortSignal) {
  // Deliberately no approval/environment override for the source checkpoint.
  if (!PUBLIC_EXECUTION_IMPLEMENTATION_READY) throw new Error("public_checkpoint_disabled");
  signal.throwIfAborted();
  const plan = publicProofPlanSchema.parse(await readPrivateJson(resolve(planPath), 65536));
  const approval = await readPrivateJson(resolve(approvalPath));
  assertPublicProofApproval(approval, plan);
  await verifyInputs(plan);
  signal.throwIfAborted();
  const config = configSchema.parse({ ...process.env, ENABLE_PUBLIC_RUNS: "true" });
  if (config.BROWSERBASE_PROJECT_ID !== plan.projectId || process.env.DEBUG === "true") {
    throw new Error("public_provider_configuration_rejected");
  }
  return withReleaseLock(plan.dataDir, async () => {
    const db = await openPublicProofLedger(plan.dataDir);
    let runtime: ReleaseRuntime | undefined;
    let runId: string | undefined;
    let submission: { ownerId: string; key: string } | undefined;
    let request: ((path: string, body?: unknown, key?: string) => Promise<unknown>) | undefined;
    let accepted = false;
    let directory: string | undefined;
    let provider: Browserbase | undefined;
    let phase = "prior-ledger";
    const failures: string[] = [];
    try {
      assertNativeOnlyProofInventory(db);
      const before = readPublicProofLedger(db);
      assertPublicProofSettled(before);
      if (before.fingerprint !== plan.ledgerDigest) throw new Error("public_approved_ledger_changed");
      assertPublicProofApproval(approval, plan);
      signal.throwIfAborted();
      // Consume the approval before any provider operation; a failed invocation is never retried automatically.
      await writePrivateJson(join(plan.dataDir, `public-proof-${publicProofHash(plan)}.used.json`), {
        planDigest: publicProofHash(plan), startedAt: new Date().toISOString(),
      });
      phase = "prior-provider-readback";
      provider = new Browserbase({ apiKey: config.BROWSERBASE_API_KEY, maxRetries: 0, timeout: 10000 });
      const previousClosure = await verifyPublicProofClosure(provider, plan.projectId, before, signal);
      signal.throwIfAborted();
      directory = join(plan.dataDir, `public-goal-${randomUUID()}`);
      await mkdir(directory, { mode: 0o700 });
      await writePrivateJson(join(directory, "invocation.json"), { plan, previousClosure, publicSiteAcceptance: false });
      const accessCode = randomBytes(32).toString("hex");
      const deployment = packagedPublicDeployment(plan.packageDir, {
        apiKey: config.BROWSERBASE_API_KEY, projectId: plan.projectId,
      }, plan.policy);
      phase = "packaged-startup";
      runtime = await deployment.start({
        directory, dataDir: plan.dataDir, accessCode, policy: plan.policy, offline: false, signal,
      });
      const context = await runtime.browser.newContext({ ignoreHTTPSErrors: true });
      const origin = runtime.origin;
      const response = await context.request.post(`${origin}/api/v1/session`, {
        data: { accessCode }, headers: { Origin: origin }, maxRedirects: 0, maxRetries: 0, timeout: 10000,
      });
      if (!response.ok()) throw new Error("public_owner_session_failed");
      const owner = z.object({ data: z.object({ csrfToken: z.string().min(1), ownerId: z.uuid() }) }).parse(await response.json()).data;
      signal.throwIfAborted();
      request = async (path, body, key) => {
        const result = await context.request.fetch(`${origin}/api/v1/${path}`, {
          method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { data: body }),
          headers: { Origin: origin, "X-CSRF-Token": owner.csrfToken, ...(key ? { "Idempotency-Key": key } : {}) },
          maxRedirects: 0, maxRetries: 0, timeout: 10000,
        });
        if (!result.ok()) throw new Error("public_owner_api_failed");
        return z.object({ data: z.unknown() }).parse(await result.json()).data;
      };
      await verifyInputs(plan);
      signal.throwIfAborted();
      assertPublicProofApproval(approval, plan);
      assertNativeOnlyProofInventory(db);
      if (readPublicProofLedger(db).fingerprint !== plan.ledgerDigest) throw new Error("public_ledger_changed_before_worker");
      phase = "public-worker";
      await runtime.startWorker();
      signal.throwIfAborted();
      const capabilities = z.object({ publicExecutionEnabled: z.literal(true), controlledRunsEnabled: z.literal(false) })
        .parse(await request("capabilities"));
      if (!capabilities.publicExecutionEnabled) throw new Error("public_admission_unavailable");
      const key = randomUUID();
      phase = "public-submission";
      await writePrivateJson(join(directory, "submission.json"), { ownerId: owner.ownerId, idempotencyKey: key, request: plan.request });
      signal.throwIfAborted();
      submission = { ownerId: owner.ownerId, key };
      const run = runSchema.parse(await request("runs", plan.request, key));
      runId = run.id;
      signal.throwIfAborted();
      if (run.executionMode !== "public-readonly") throw new Error("public_execution_mode_mismatch");
      const same = runSchema.parse(await request("runs", plan.request, key));
      if (same.id !== run.id) throw new Error("public_idempotency_failed");
      const page = await context.newPage();
      await page.goto(`${origin}/runs/${run.id}`, { waitUntil: "domcontentloaded" });
      await page.locator(".wall-card").first().waitFor({ state: "visible", timeout: 15000 });
      const end = Date.now() + (plan.policy.sessionSeconds * plan.request.assignments.length + 90) * 1000;
      phase = "public-goal";
      let terminal = false;
      while (Date.now() < end) {
        signal.throwIfAborted();
        const current = runSchema.parse(await request(`runs/${run.id}`));
        if (!["queued", "running"].includes(current.status)) { terminal = true; break; }
        await delay(500, undefined, { signal });
      }
      if (!terminal) throw new Error("public_goal_deadline_no_retry");
      await runtime.stopWorker();
      phase = "acceptance-readback";
      const after = readPublicProofLedger(db);
      const newLaunches = after.launches.filter((launch) => !before.launches.some((old) => old.jobId === launch.jobId));
      if (newLaunches.length !== plan.request.assignments.length ||
        newLaunches.some((launch) => launch.runId !== run.id || launch.reservedSeconds !== plan.policy.sessionSeconds ||
          launch.resource?.archiveSha256 !== plan.archiveDigest) ||
        after.reservedSeconds !== before.reservedSeconds + plan.plannedReservations) {
        throw new Error("public_launch_accounting_mismatch");
      }
      const closure = await verifyPublicProofClosure(provider, plan.projectId, after);
      const report = runReportSchema.parse(await request(`runs/${run.id}/reports`));
      if (report.status !== "succeeded" || report.finality !== "final" || report.agents.length !== plan.request.assignments.length ||
        report.agents.some((agent) => agent.cleanup !== "closed" || agent.launchState !== "settled" ||
          agent.modelCalls < 1 || agent.steps < 1 || !agent.evidence.some((item) => item.kind === "screenshot" && item.state === "available") ||
          agent.criteria.some((criterion) => criterion.status !== "met" || !criterion.citations.length ||
            criterion.citations.some((citation) => citation.state !== "available" || !citation.evidenceIds.length)))) {
        throw new Error("public_goal_not_proved");
      }
      for (const launch of newLaunches) {
        const usage = z.object({ modelMetrics: z.object({ totalPromptTokens: z.number().positive(),
          totalCompletionTokens: z.number().positive() }), gatewayDispatches: z.number().positive() })
          .parse(JSON.parse(z.string().parse(db.prepare("SELECT usage FROM launches WHERE job_id=?").get(launch.jobId)?.usage)));
        if (!usage.gatewayDispatches) throw new Error("public_gateway_evidence_missing");
      }
      for (const evidence of report.agents.flatMap((agent) => agent.evidence).filter((item) => item.state === "available")) {
        const detail = z.object({ runId: z.literal(run.id) }).parse(await request(`evidence/${evidence.id}/detail`));
        if (detail.runId !== run.id) throw new Error("public_evidence_owner_mismatch");
        if (evidence.kind === "screenshot") {
          const pixels = await context.request.get(`${origin}/api/v1/evidence/${evidence.id}/content`, {
            maxRedirects: 0, maxRetries: 0, timeout: 10000,
          });
          const bytes = await pixels.body();
          if (!pixels.ok() || pixels.headers()["content-type"] !== "image/png" || bytes.length > 8 * 1024 * 1024 ||
            !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw new Error("public_private_screenshot_readback_failed");
          }
          const file = await open(join(directory, `evidence-${evidence.id}.png`), "wx", 0o600);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        }
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      const events = db.prepare("SELECT event FROM events WHERE run_id=? ORDER BY sequence").all(run.id)
        .map((row) => eventSchema.parse(JSON.parse(z.string().parse(row.event)))).slice(-200);
      const last = events.at(-1);
      if (!last || !events.some((event) => event.kind === "attempt.action")) throw new Error("public_progress_missing");
      await page.locator(`[data-event-sequence="${last.sequence}"]`).waitFor({ timeout: 15000 });
      const sequences = await page.locator(".wall-log li").evaluateAll((rows) =>
        rows.map((row) => Number(row.getAttribute("data-event-sequence"))));
      if (JSON.stringify(sequences) !== JSON.stringify(events.map((event) => event.sequence))) throw new Error("public_wall_event_mismatch");
      await runtime.close();
      phase = "accepted";
      await writePrivateJson(join(directory, "accepted.json"), {
        version: 1, planDigest: publicProofHash(plan), runId, publicSiteAcceptance: true, report,
        ledgerDigest: after.fingerprint, reservedSeconds: after.reservedSeconds, closure,
      });
      accepted = true;
      return { phase: "public-goal", accepted: true, allocatedSessions: newLaunches.length,
        cumulativeReservedSeconds: after.reservedSeconds,
        cumulativeActualBrowserSeconds: closure.reduce((sum, session) => sum + session.actualBrowserSeconds, 0) };
    } finally {
      if (!accepted && submission && !runId) {
        // Settle the server handling the ambiguous POST before looking up its commit.
        try { await runtime?.stopWorker(); } catch { failures.push("submission_server_unsettled"); }
        try {
          const saved = db.prepare(`SELECT id,request_hash FROM runs WHERE owner_id=? AND idempotency_key=?`)
            .get(submission.ownerId, submission.key);
          if (saved) {
            if (saved.request_hash !== publicProofHash(plan.request)) throw new Error("public_submission_identity_mismatch");
            runId = z.uuid().parse(saved.id);
          }
        } catch { failures.push("submission_identity_unconfirmed"); }
      }
      if (!accepted && runId && request) {
        try { await request(`runs/${runId}/cancel`, {}); } catch { failures.push("cancel_unconfirmed"); }
      }
      try { await runtime?.close(); } catch { failures.push("runtime_cleanup_unconfirmed"); }
      let failureClosure: Awaited<ReturnType<typeof verifyPublicProofClosure>> | undefined;
      if (!accepted && directory && provider) {
        try { failureClosure = await verifyPublicProofClosure(provider, plan.projectId, readPublicProofLedger(db)); }
        catch { failures.push("independent_closure_unconfirmed"); }
      }
      try {
        if (directory) await writePrivateJson(join(directory, "final-ledger.json"), {
          accepted, phase, failures, failureClosure, ledger: readPublicProofLedger(db),
        });
      } finally { db.close(); }
      if (failures.length) throw new Error(`public_proof_cleanup_failed:${failures.join(",")}`);
    }
  });
}
