import "server-only";
import nextEnv from "@next/env";
import Browserbase from "@browserbasehq/sdk";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { managedCapabilitiesSchema, managedResultSchema, managedRunSchema } from "../src/lib/managed-contracts";
import { readPrivateJson, writePrivateJson } from "./advanced-proof";
import { verifyPublicProofClosure } from "./public-goal";
import { openPublicProofLedger, publicProofHash } from "./public-proof";
import { withReleaseLock, type ReleaseRuntime } from "./release-integration";
import { packagedManagedDeployment } from "./release-runtime";
import {
  assertManagedGoalEvidence, assertManagedProofAllocation, assertManagedProofApproval, assertManagedProofLedgerBinding,
  assertManagedProofSettled,
  consumeManagedProofApproval, managedProofId, managedProofPlanSchema, prepareManagedProof,
  readManagedInvocationInventory, readManagedProofLedger, verifyManagedProofInputs,
  type ManagedProofLedger,
} from "./managed-proof";

type ClosureProvider = Pick<Browserbase, "agents" | "sessions" | "extensions">;
const terminal = new Set(["COMPLETED", "FAILED", "STOPPED", "TIMED_OUT"]);
const dateTime = z.iso.datetime({ offset: true });

/** Independent exact-ID reads, separate from the worker's terminal/result claims. */
export async function verifyManagedProofClosure(provider: ClosureProvider, projectId: string,
  ledger: ManagedProofLedger, expectedAgent?: { runId: string; agentId: string }, signal?: AbortSignal) {
  assertManagedProofSettled(ledger);
  const native = await verifyPublicProofClosure(provider, projectId, ledger.native, signal);
  const managed = [];
  for (const attempt of ledger.attempts) {
    signal?.throwIfAborted();
    if (!attempt.provider_run_id) continue;
    const run = await provider.agents.runs.retrieve(attempt.provider_run_id);
    signal?.throwIfAborted();
    if (run.agentId !== attempt.provider_agent_id || run.task !== attempt.provider_task) {
      throw new Error("managed_pinned_dispatch_identity_mismatch");
    }
    const task = z.object({
      correlationToken: z.literal(attempt.correlation_token), goal: z.literal(z.string().parse(attempt.goal)),
      criteria: z.array(z.string()), persona: z.unknown(), targetUrl: z.string(),
      declaredScope: z.object({ origin: z.string(), allowedSubdomains: z.array(z.string()), pathPrefixes: z.array(z.string()) }),
    }).parse(JSON.parse(run.task.slice(run.task.lastIndexOf("\n") + 1)));
    const scope = JSON.parse(z.string().parse(ledger.runs.find((row) => row.id === attempt.run_id)?.scope));
    const persona = JSON.parse(z.string().parse(attempt.persona));
    if (run.runId !== attempt.provider_run_id || !terminal.has(run.status) ||
      (run.sessionId ?? null) !== attempt.provider_session_id ||
      task.targetUrl !== scope.targetUrl || publicProofHash(task.persona) !== publicProofHash(persona) ||
      task.declaredScope.origin !== new URL(scope.targetUrl).origin ||
      publicProofHash(task.declaredScope.allowedSubdomains) !== publicProofHash(scope.allowedSubdomains) ||
      publicProofHash(task.declaredScope.pathPrefixes) !== publicProofHash(scope.pathPrefixes) ||
      publicProofHash(task.criteria) !== publicProofHash(JSON.parse(z.string().parse(attempt.criteria))) ||
      expectedAgent?.runId === run.runId && run.agentId !== expectedAgent.agentId) {
      throw new Error("managed_independent_run_closure_unconfirmed");
    }
    let session = null;
    let actualBrowserSeconds = 0;
    if (attempt.provider_session_id) {
      session = await provider.sessions.retrieve(attempt.provider_session_id);
      signal?.throwIfAborted();
      const startedAt = Date.parse(dateTime.parse(session.startedAt)), endedAt = Date.parse(dateTime.parse(session.endedAt));
      actualBrowserSeconds = (endedAt - startedAt) / 1000;
      if (session.id !== attempt.provider_session_id || session.projectId !== projectId ||
        session.status !== "COMPLETED" || endedAt > Date.now() || actualBrowserSeconds < 0 ||
        attempt.consumed_seconds < Math.ceil(actualBrowserSeconds) ||
        attempt.actual_browser_seconds === null || Math.abs(attempt.actual_browser_seconds - actualBrowserSeconds) > 0.001) {
        throw new Error("managed_independent_session_closure_unconfirmed");
      }
    } else if (attempt.actual_browser_seconds !== 0) throw new Error("managed_session_identity_unconfirmed");
    managed.push({ attemptId: attempt.id, run, session, actualBrowserSeconds });
  }
  return { native, managed };
}

export function assertManagedBrowserEvidence(input: { sessionId: string; logs: unknown; replay: unknown }) {
  const logs = z.array(z.object({
    sessionId: z.literal(input.sessionId), method: z.string(), pageId: z.number(),
  }).passthrough()).min(1).parse(input.logs);
  const replay = z.object({
    pageCount: z.int().positive(),
    pages: z.array(z.object({
      pageId: z.string().min(1), startTimeMs: z.number().finite(), endTimeMs: z.number().finite(),
      url: z.string().min(1),
    })).min(1),
  }).parse(input.replay);
  if (!logs.some((log) => /^(?:Page\.(?:navigate|captureScreenshot)|Input\.dispatchMouseEvent|Runtime\.evaluate)$/.test(log.method)) ||
    replay.pageCount !== replay.pages.length ||
    replay.pages.some((page) => page.endTimeMs <= page.startTimeMs)) throw new Error("managed_independent_browser_evidence_missing");
  return { browserProtocolEvents: logs.length, recordingPages: replay.pageCount };
}

export function extractManagedGoalScreenshot(sessionId: string, input: unknown) {
  const logs = z.array(z.object({
    sessionId: z.literal(sessionId), pageId: z.number(), method: z.string(),
    request: z.object({ params: z.record(z.string(), z.unknown()) }).passthrough().optional(),
    response: z.object({ result: z.record(z.string(), z.unknown()) }).passthrough().optional(),
  }).passthrough()).parse(input);
  const fields = (value: unknown) => z.record(z.string(), z.unknown()).safeParse(value).data;
  const finalUrl = "https://www.iana.org/domains/reserved";
  const confirmedPages = new Set<number>();
  let screenshot: { bytes: Buffer; format: "png" | "jpg"; pageId: number; logIndex: number } | undefined;
  for (const [logIndex, log] of logs.entries()) {
    const params = log.request?.params;
    const result = log.response?.result;
    let observedUrl: unknown;
    if (log.method === "Page.navigate") {
      confirmedPages.delete(log.pageId);
      if (typeof result?.frameId === "string" && !result.errorText) observedUrl = params?.url;
    } else if (log.method === "Page.getFrameTree") {
      observedUrl = fields(fields(result?.frameTree)?.frame)?.url;
    } else if (log.method === "Page.getNavigationHistory" && Array.isArray(result?.entries) &&
      typeof result.currentIndex === "number" && Number.isInteger(result.currentIndex)) {
      observedUrl = fields(result.entries[result.currentIndex])?.url;
    } else if (log.method === "Runtime.evaluate" && typeof params?.expression === "string" &&
      /^(?:window\.|document\.)?location\.href;?$/.test(params.expression.trim())) {
      observedUrl = fields(result?.result)?.value;
    }
    if (observedUrl !== undefined) {
      if (observedUrl === finalUrl) confirmedPages.add(log.pageId);
      else confirmedPages.delete(log.pageId);
    }
    if (log.method !== "Page.captureScreenshot" || !confirmedPages.has(log.pageId) ||
      typeof result?.data !== "string" || result.data.length > 12 * 1024 * 1024) continue;
    const bytes = Buffer.from(result.data, "base64");
    if (bytes.length < 32 || bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== result.data) continue;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 &&
      bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
    if (png || jpeg) screenshot = { bytes, format: png ? "png" : "jpg", pageId: log.pageId, logIndex };
  }
  if (!screenshot || !confirmedPages.has(screenshot.pageId)) throw new Error("managed_goal_browser_pixels_missing");
  return { ...screenshot, finalUrl, sha256: createHash("sha256").update(screenshot.bytes).digest("hex") };
}

function safeFailure(error: unknown): string {
  return error instanceof Error && /^managed_[a-z_]+$/.test(error.message) ? error.message : "managed_proof_failed";
}

export async function runManagedProof(planPath: string, approvalPath: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const plan = managedProofPlanSchema.parse(await readPrivateJson(resolve(planPath), 65536));
  const approval = await readPrivateJson(resolve(approvalPath));
  assertManagedProofApproval(approval, plan);
  await verifyManagedProofInputs(plan);
  const providerConfig = z.strictObject({ apiKey: z.string().trim().min(1), projectId: z.uuid() }).parse({
    apiKey: process.env.BROWSERBASE_API_KEY, projectId: process.env.BROWSERBASE_PROJECT_ID,
  });
  if (providerConfig.projectId !== plan.projectId || process.env.DEBUG === "true") throw new Error("managed_provider_configuration_rejected");
  return withReleaseLock(plan.dataDir, async () => {
    const db = await openPublicProofLedger(plan.dataDir);
    let runtime: ReleaseRuntime | undefined;
    let ownerRequest: ((path: string, body?: unknown, key?: string) => Promise<unknown>) | undefined;
    let submission: { ownerId: string; key: string } | undefined;
    let runId: string | undefined, agentId: string | undefined;
    let provider: Browserbase | undefined;
    let directory: string | undefined;
    let phase = "local-binding", accepted = false, goalEvidence = false;
    let agentCreation: "not_attempted" | "unknown" | "returned" = "not_attempted";
    let agentDeleted = false, cleanupUncertain = false, identityUncertain = false;
    let finalLedger: ManagedProofLedger | undefined;
    let closure: Awaited<ReturnType<typeof verifyManagedProofClosure>> | undefined;
    const failures: string[] = [];
    try {
      const before = readManagedProofLedger(db);
      assertManagedProofLedgerBinding(plan, before);
      if ((await readManagedInvocationInventory(plan.dataDir)).fingerprint !== plan.invocationDigest) {
        throw new Error("managed_approved_ledger_changed");
      }
      assertManagedProofApproval(approval, plan);
      signal.throwIfAborted();
      const invocationId = randomUUID();
      directory = join(plan.dataDir, `managed-proof-${invocationId}`);
      await mkdir(directory, { mode: 0o700 });
      await writePrivateJson(join(directory, "invocation.json"), {
        version: 1, plan, planDigest: publicProofHash(plan), phase, accepted: false, issue8Acceptance: false,
      });
      await consumeManagedProofApproval(plan.dataDir, plan, approval, invocationId);
      // No provider SDK object or provider read exists before durable single-use consumption.
      provider = new Browserbase({ apiKey: providerConfig.apiKey, maxRetries: 0, timeout: 10000 });
      phase = "prior-independent-closure";
      closure = await verifyManagedProofClosure(provider, plan.projectId, before, undefined, signal);
      await writePrivateJson(join(directory, "prior-closure.json"), closure);
      signal.throwIfAborted();
      assertManagedProofApproval(approval, plan);
      assertManagedProofLedgerBinding(plan, readManagedProofLedger(db));
      phase = "temporary-agent-create";
      await writePrivateJson(join(directory, "agent-intent.json"), {
        phase, planDigest: publicProofHash(plan), agent: plan.agent, accountingIntentSeconds: plan.plannedReservations,
        runAllocationNotYetReserved: true, unknownOutcomeBlocksNextProof: true,
      });
      agentCreation = "unknown";
      const created = await provider.agents.create({
        name: plan.agent.name, systemPrompt: plan.agent.systemPrompt, resultSchema: z.toJSONSchema(managedResultSchema),
      });
      agentId = managedProofId.parse(created.agentId);
      await writePrivateJson(join(directory, "agent-created.json"), { agentId, response: created });
      agentCreation = "returned";
      signal.throwIfAborted();
      const reviewed = await provider.agents.retrieve(agentId);
      if (reviewed.agentId !== agentId || reviewed.name !== plan.agent.name ||
        reviewed.systemPrompt !== plan.agent.systemPrompt ||
        publicProofHash(reviewed.resultSchema) !== plan.agent.resultSchemaDigest) throw new Error("managed_agent_review_mismatch");
      await writePrivateJson(join(directory, "agent-reviewed.json"), reviewed);
      phase = "packaged-runtime";
      const accessCode = randomBytes(32).toString("hex");
      runtime = await packagedManagedDeployment(plan.packageDir, {
        ...providerConfig, agentId, allowedOrigins: plan.allowedOrigins, localUiBrowser: plan.localUiBrowser,
      }, plan.policy).start({ directory, dataDir: plan.dataDir, accessCode, policy: plan.policy, offline: false, signal });
      const context = await runtime.browser.newContext({ ignoreHTTPSErrors: true });
      const response = await context.request.post(`${runtime.origin}/api/v1/session`, {
        data: { accessCode }, headers: { Origin: runtime.origin }, maxRedirects: 0, maxRetries: 0, timeout: 10000,
      });
      if (!response.ok()) throw new Error("managed_owner_session_failed");
      const owner = z.object({ data: z.object({ ownerId: z.uuid(), csrfToken: z.string().min(1) }) })
        .parse(await response.json()).data;
      const origin = runtime.origin;
      ownerRequest = async (path, body, key) => {
        const result = await context.request.fetch(`${origin}/api/v1/${path}`, {
          method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { data: body }),
          headers: { Origin: origin, "X-CSRF-Token": owner.csrfToken, ...(key ? { "Idempotency-Key": key } : {}) },
          maxRedirects: 0, maxRetries: 0, timeout: 10000,
        });
        if (!result.ok()) throw new Error("managed_owner_api_failed");
        return z.object({ data: z.unknown() }).parse(await result.json()).data;
      };
      await verifyManagedProofInputs(plan);
      assertManagedProofApproval(approval, plan);
      assertManagedProofLedgerBinding(plan, readManagedProofLedger(db));
      signal.throwIfAborted();
      await runtime.startWorker();
      const capability = managedCapabilitiesSchema.parse(await ownerRequest("managed-capabilities"));
      if (!capability.enabled || publicProofHash(capability.allowedOrigins) !== publicProofHash(plan.allowedOrigins)) {
        throw new Error("managed_admission_unavailable");
      }
      z.object({ controlledRunsEnabled: z.literal(false), publicExecutionEnabled: z.literal(false) })
        .parse(await ownerRequest("capabilities"));
      phase = "one-managed-submission";
      const key = randomUUID();
      await writePrivateJson(join(directory, "submission.json"), { ownerId: owner.ownerId, key, request: plan.request });
      signal.throwIfAborted();
      assertManagedProofApproval(approval, plan);
      submission = { ownerId: owner.ownerId, key };
      const run = managedRunSchema.parse(await ownerRequest("managed-runs", plan.request, key));
      runId = run.id;
      if (run.attempts.length !== 1) throw new Error("managed_submission_mismatch");
      const page = await context.newPage();
      // Capture the actual local owner wall, never call it a remote-site screenshot.
      await page.goto(`${origin}/managed/${runId}`, { waitUntil: "domcontentloaded" });
      const deadline = Date.now() + (plan.policy.sessionSeconds + 60) * 1000;
      phase = "managed-goal";
      let finished = false;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const current = managedRunSchema.parse(await ownerRequest(`managed-runs/${runId}`));
        if (!["queued", "running"].includes(current.status)) { finished = true; break; }
        await delay(500, undefined, { signal });
      }
      if (!finished) throw new Error("managed_goal_deadline_no_retry");
      await runtime.stopWorker();
      phase = "independent-evidence";
      // Preserve the exact endpoint report, including failure/inconclusive results, before assessment.
      const report = managedRunSchema.parse(await ownerRequest(`managed-runs/${runId}/report`));
      await writePrivateJson(join(directory, "report.json"), report);
      finalLedger = readManagedProofLedger(db);
      const allocation = assertManagedProofAllocation(before, finalLedger, plan, report);
      closure = await verifyManagedProofClosure(provider, plan.projectId, finalLedger, {
        agentId, runId: allocation.provider_run_id!,
      }, signal);
      const providerRun = closure.managed.find((item) => item.attemptId === allocation.id)?.run;
      if (providerRun?.status !== "COMPLETED") throw new Error("managed_provider_not_completed");
      await writePrivateJson(join(directory, "closure.json"), closure);
      const logs = await provider.sessions.logs.list(allocation.provider_session_id!);
      await writePrivateJson(join(directory, "session-logs.json"), logs);
      const replay = await provider.sessions.replays.retrieve(allocation.provider_session_id!);
      await writePrivateJson(join(directory, "recording-metadata.json"), replay);
      const independentBrowser = assertManagedBrowserEvidence({ sessionId: allocation.provider_session_id!, logs, replay });
      const goalPixels = extractManagedGoalScreenshot(allocation.provider_session_id!, logs);
      const goalImageFile = `browser-goal.${goalPixels.format}`;
      const goalImage = await open(join(directory, goalImageFile), "wx", 0o600);
      try { await goalImage.writeFile(goalPixels.bytes); await goalImage.sync(); } finally { await goalImage.close(); }
      await page.reload({ waitUntil: "domcontentloaded" });
      const wall = page.locator(`[data-testid="managed-run-wall"][data-run-id="${runId}"][data-run-loaded="true"]`);
      await wall.waitFor({ timeout: 15000 });
      const card = wall.locator(`[data-testid="managed-attempt"][data-attempt-id="${allocation.id}"]`);
      await card.waitFor({ timeout: 15000 });
      if (await wall.getAttribute("data-run-status") !== report.status ||
        await wall.getByTestId("managed-attempt").count() !== 1 ||
        await card.getAttribute("data-run-id") !== runId ||
        await card.getAttribute("data-persona-id") !== report.attempts[0].persona.id ||
        await card.getAttribute("data-status") !== report.attempts[0].status ||
        await card.getAttribute("data-cleanup-status") !== report.attempts[0].cleanup) {
        throw new Error("managed_wall_identity_mismatch");
      }
      const displayed = await card.getByTestId("managed-progress-event")
        .evaluateAll((rows) => rows.map((row) => ({
          sequence: Number(row.getAttribute("data-event-sequence")),
          kind: row.getAttribute("data-event-kind"),
          text: row.querySelector('[data-testid="managed-progress-text"]')?.textContent ?? "",
        })));
      if (Number(await card.getByTestId("managed-progress").getAttribute("data-progress-count")) !== report.attempts[0].progress.length ||
        displayed.length !== report.attempts[0].progress.length || displayed.some((row, index) =>
        row.sequence !== report.attempts[0].progress[index].sequence ||
        row.kind !== report.attempts[0].progress[index].kind ||
        row.text !== report.attempts[0].progress[index].text)) throw new Error("managed_wall_progress_mismatch");
      const result = card.getByTestId("managed-result");
      if (await result.getAttribute("data-has-result") !== "true" || !report.attempts[0].result) {
        throw new Error("managed_wall_result_mismatch");
      }
      const renderedResult = {
        summary: await result.getByTestId("managed-result-summary").textContent(),
        finalUrl: await result.getByTestId("managed-result-final-url").textContent(),
        criteria: await result.getByTestId("managed-result-criterion").evaluateAll((rows) => rows.map((row) => ({
          criterion: row.querySelector('[data-testid="managed-result-criterion-text"]')?.textContent,
          status: row.getAttribute("data-criterion-status"),
          observation: row.querySelector('[data-testid="managed-result-observation"]')?.textContent,
        }))),
        limitations: await result.getByTestId("managed-result-limitation").allTextContents(),
      };
      if (publicProofHash(renderedResult) !== publicProofHash(report.attempts[0].result)) {
        throw new Error("managed_wall_result_mismatch");
      }
      const image = await page.screenshot({ fullPage: true, animations: "disabled" });
      const imageFile = await open(join(directory, "owner-managed-wall.png"), "wx", 0o600);
      try { await imageFile.writeFile(image); await imageFile.sync(); } finally { await imageFile.close(); }
      await writePrivateJson(join(directory, "evidence-labels.json"), {
        ownerUiScreenshot: { kind: "local-owner-wall", sha256: publicProofHash(image.toString("base64")), bytes: image.length },
        independentBrowser, recording: "Browserbase exact-session API metadata; media URLs were not fetched",
        browserScreenshot: { kind: "actual-browserbase-cdp-capture", file: goalImageFile, sha256: goalPixels.sha256,
          bytes: goalPixels.bytes.length, pageId: goalPixels.pageId, logIndex: goalPixels.logIndex,
          observedBrowserUrl: goalPixels.finalUrl, headingVisualInspectionRequired: true },
        localUiBrowser: plan.localUiBrowser,
        goalResult: "Model-authored managed goal evidence, not independently verified criterion truth",
        issue8Acceptance: false,
      });
      assertManagedGoalEvidence(report, plan);
      goalEvidence = true;
      phase = "verified-goal-awaiting-cleanup";
    } catch (error) {
      const failure = safeFailure(error);
      failures.push(failure);
      if (failure === "managed_prior_invocation_requires_manual_reconciliation") {
        identityUncertain = true;
        cleanupUncertain = true;
      }
    } finally {
      if (submission && !runId) {
        try {
          await runtime?.stopWorker();
          const saved = db.prepare("SELECT id,request_hash FROM managed_runs WHERE owner_id=? AND idempotency_key=?")
            .get(submission.ownerId, submission.key);
          if (saved) {
            if (saved.request_hash !== publicProofHash(plan.request)) throw new Error("managed_submission_identity_mismatch");
            runId = z.uuid().parse(saved.id);
          }
        } catch { failures.push("managed_submission_identity_unconfirmed"); identityUncertain = true; }
      }
      if (!goalEvidence && runId && ownerRequest) {
        try { await ownerRequest(`managed-runs/${runId}/cancel`, {}); }
        catch { failures.push("managed_cancel_unconfirmed"); cleanupUncertain = true; }
      }
      try { await runtime?.close(); }
      catch { failures.push("managed_runtime_cleanup_unconfirmed"); cleanupUncertain = true; }
      try {
        finalLedger = readManagedProofLedger(db);
        if (provider) closure = await verifyManagedProofClosure(provider, plan.projectId, finalLedger);
      } catch { failures.push("managed_final_closure_unconfirmed"); cleanupUncertain = true; }
      if (agentCreation === "unknown") { identityUncertain = true; cleanupUncertain = true; }
      if (agentId && provider && directory && !cleanupUncertain && !identityUncertain) {
        try {
          // The temporary agent is removed only after every related run/session is independently closed.
          const related = await provider.agents.runs.list({ agentId, limit: 100 });
          const known = finalLedger!.attempts.filter((attempt) => attempt.run_id === runId);
          if (related.nextCursor || related.data.length !== known.filter((attempt) => attempt.provider_run_id).length ||
            related.data.some((run) => run.agentId !== agentId || !terminal.has(run.status) ||
              !closure?.managed.some((item) => item.run.runId === run.runId &&
                item.run.agentId === agentId && (item.session?.status === "COMPLETED" || !run.sessionId)))) {
            throw new Error("managed_related_runs_unconfirmed");
          }
          await writePrivateJson(join(directory, "agent-delete-intent.json"), { agentId, related });
          await provider.agents.delete(agentId);
          let absent = false;
          try { await provider.agents.retrieve(agentId); }
          catch (error) { if (error instanceof Browserbase.APIError && error.status === 404) absent = true; else throw error; }
          if (!absent) throw new Error("managed_agent_deletion_unconfirmed");
          await writePrivateJson(join(directory, "agent-deleted.json"), { agentId, exactRetrieveStatus: 404, confirmedAt: Date.now() });
          agentDeleted = true;
        } catch { failures.push("managed_agent_cleanup_unconfirmed"); cleanupUncertain = true; }
      }
      accepted = goalEvidence && failures.length === 0 && agentDeleted && !cleanupUncertain && !identityUncertain;
      if (accepted) phase = "accepted-managed-goal-evidence";
      try {
        if (!directory) {
          directory = join(plan.dataDir, `managed-proof-${randomUUID()}`);
          await mkdir(directory, { mode: 0o700 });
          await writePrivateJson(join(directory, "invocation.json"), {
            version: 1, planDigest: publicProofHash(plan), phase, accepted: false, issue8Acceptance: false,
          });
        }
        await writePrivateJson(join(directory, "final.json"), {
          version: 1, planDigest: publicProofHash(plan), accepted, phase, failures,
          managedGoalEvidence: goalEvidence, issue8Acceptance: false, publicSiteAcceptance: false,
          agentCreation, agentId: agentId ?? null, agentDeleted, runId: runId ?? null,
          identityUncertain, cleanupUncertain, ledger: finalLedger ?? null, closure: closure ?? null,
          cumulativeReservedSeconds: finalLedger?.reservedSeconds ?? null,
          cumulativeConsumedSeconds: finalLedger?.consumedSeconds ?? null,
          cumulativeActualBrowserSeconds: finalLedger?.actualBrowserSeconds ?? null,
          unknownActualAttempts: finalLedger?.unknownActualAttempts ?? null,
        });
      } finally { db.close(); }
    }
    return {
      phase: "managed-goal-evidence", accepted, managedGoalEvidence: accepted, issue8Acceptance: false,
      errorCode: failures[0] ?? null, cleanupUncertain, identityUncertain,
      cumulativeReservedSeconds: finalLedger?.reservedSeconds ?? null,
      cumulativeConsumedSeconds: finalLedger?.consumedSeconds ?? null,
      cumulativeActualBrowserSeconds: finalLedger?.actualBrowserSeconds ?? null,
      unknownActualAttempts: finalLedger?.unknownActualAttempts ?? null,
    };
  });
}

export async function managedIntegration(args: readonly string[], signal: AbortSignal) {
  if (args.length === 1 && args[0] === "--offline-preflight") {
    const { managedOfflinePreflight } = await import("./managed-offline");
    return managedOfflinePreflight();
  }
  if (args.length === 3 && args[0] === "--prepare-plan") return prepareManagedProof(args[1], args[2]);
  if (args.length === 3 && args[0] === "--confirm-paid") {
    nextEnv.loadEnvConfig(process.cwd());
    return runManagedProof(args[1], args[2], signal);
  }
  throw new Error("managed_explicit_mode_required");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  managedIntegration(process.argv.slice(2), controller.signal).then((receipt) => {
    console.log(JSON.stringify(receipt));
    if (receipt.phase !== "managed-offline-preflight" && "accepted" in receipt && !receipt.accepted) process.exitCode = 1;
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ phase: "managed-proof", accepted: false, errorCode: safeFailure(error) }));
    process.exitCode = 1;
  }).finally(() => { process.off("SIGINT", abort); process.off("SIGTERM", abort); });
}
