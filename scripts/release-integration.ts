import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { z } from "zod";
import nextEnv from "@next/env";
import { demoCriteria } from "../src/lib/demo-run";
import { eventSchema } from "../src/lib/contracts";
import { runReportSchema, type RunReport } from "../src/lib/report-contracts";
import { rerunResponseSchema, runComparisonSchema } from "../src/lib/rerun-contracts";
import type { WorkerRepository } from "../src/server/worker/repository";
import { assertPrivateDirectory, readPrivateJson, writePrivateJson } from "./advanced-proof";
import { readReleaseCurrentOwnerMedia } from "./release-media";
import { captureReleaseLiveViewers } from "./release-viewer";
import {
  approvedRelease, asAdvancedReadback, assertExactAssetInventory, assertReleaseDataIgnored, assertReleasePolicy,
  canReserveRelease, confirmedReleaseComparison, confirmedReleaseDefect, exactReleaseClosure,
  exactReleaseInspection, inventoryReleaseAsset, parseReleaseArgs, readReleaseLedger, releaseLedgerDigest,
  releasePlan, releasePolicy, releaseSourceDigest, releaseLedgerSchema, sealReleaseAsset, type PrivateAsset,
} from "./release-proof";

export const releaseRoot = resolve("data/release-rehearsal");
let failureStage = "arguments";

/** The packaged runner owns only its children/proxy/browser; it may not allocate directly. */
export type ReleaseRuntime = {
  browser: Browser; origin: string;
  startWorker(): Promise<void>;
  stopWorker(): Promise<void>;
  close(): Promise<void>;
};
export type ReleaseDeployment = {
  verifyPackage(): Promise<string>;
  start(input: {
    directory: string; dataDir: string; accessCode: string; policy: typeof releasePolicy;
    offline: boolean; signal: AbortSignal;
  }): Promise<ReleaseRuntime>;
};

export const RELEASE_INTEGRATION_REQUIREMENTS = [
  "Use the actual clean packaged Node supervisor, including its pinned tsx loader and normal repository worker.",
  "verifyPackage must hash and validate the runnable package against its source-bound build receipt.",
  "Bind web upstream and HTTPS proxy only to loopback; pass the exact HTTPS APP_ORIGIN, dataDir and releasePolicy.",
  "startWorker must launch the normal repository worker, never a custom allocator; startWorker is forbidden offline.",
  "Suppress child output; stopWorker must await active cleanup; close must stop only owned children and remove TLS credentials.",
  "Use the real provider/Gateway configuration only after approval. Never install dependencies from this harness.",
  "Pass parent-supplied BROWSERBASE_REPLAY_ORIGINS from .env.local exactly; never discover prior worktrees or widen origins.",
] as const;

async function privateRoot() {
  await assertReleaseDataIgnored();
  await mkdir("data", { recursive: true, mode: 0o700 });
  await mkdir(releaseRoot, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  await assertPrivateDirectory(releaseRoot);
}

export async function withReleaseLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await assertPrivateDirectory(root);
  const path = join(root, "integration.lock");
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const identity = await handle.stat();
  try { return await work(); } finally {
    await handle.close();
    // Never remove a lock substituted by a different process.
    const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await current.stat();
      if (actual.ino === identity.ino && actual.dev === identity.dev) await unlink(path);
      else throw new Error("release_lock_replaced");
    } finally { await current.close(); }
  }
}

  export async function releaseCleanup(steps: readonly (() => Promise<void>)[]): Promise<void> {
    const errors: unknown[] = [];
    for (const step of steps) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "release_owned_cleanup_failed");
  }

  async function waitFor(test: () => Promise<boolean> | boolean, signal: AbortSignal, ms = 330000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      signal.throwIfAborted();
      if (await test()) return;
      await delay(200, undefined, { signal });
    }
    throw new Error("release_bounded_wait_expired_no_retry");
  }

  const goal = "Add one ceramic mug to the cart. Apply SAVE10 then COZY5 using the visible coupon field and button. " +
    "Verify both advertised coupons and the CA$21.60 total, then stop on the cart. Do not check out or buy anything. " +
    "If applying a coupon produces a visible error, stop and report it; do not retry.";
  export const releaseAssignments = ["bargain-hunter", "careful-first-timer"].map((personaId) => ({
    personaId, goal, criteria: [demoCriteria[0]],
  }));

  function api(context: BrowserContext, origin: string, csrf: string) {
    return async (path: string, body?: unknown) => {
      const response = await context.request.fetch(`${origin}/api/v1/${path}`, {
        method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { data: body }),
        timeout: 10000, maxRedirects: 0, maxRetries: 0,
        headers: { Origin: origin, "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() },
      });
      if (!response.ok()) throw new Error("release_authenticated_api_failed_no_retry");
      return z.object({ data: z.unknown() }).parse(await response.json()).data;
    };
  }

  async function owner(context: BrowserContext, origin: string, accessCode: string) {
    const response = await context.request.post(`${origin}/api/v1/session`, {
      data: { accessCode }, headers: { Origin: origin }, maxRedirects: 0, maxRetries: 0, timeout: 10000,
    });
    if (!response.ok()) throw new Error("release_https_owner_failed");
    const session = z.object({ data: z.object({ ownerId: z.uuid(), csrfToken: z.string().min(1) }) })
      .parse(await response.json()).data;
    const cookie = (await context.cookies(origin)).find((item) => item.name === "__Host-ff_owner" &&
      item.secure && item.httpOnly && item.sameSite === "Strict" && item.path === "/");
    if (!cookie) throw new Error("release_secure_owner_cookie_missing");
    return session;
  }

  async function capture(page: Page, directory: string, name: string) {
    const bytes = await page.screenshot({ fullPage: true, timeout: 10000 });
    const file = await open(join(directory, `${name}.png`), "wx", 0o600);
    try { await file.writeFile(bytes); } finally { await file.close(); }
  }

  async function wallReadback(page: Page, origin: string, runId: string, db: DatabaseSync) {
    await page.goto(`${origin}/runs/${runId}`, { waitUntil: "domcontentloaded" });
    await page.locator(".wall-card").first().waitFor({ state: "visible" });
    const events = db.prepare("SELECT event FROM events WHERE run_id=? ORDER BY sequence").all(runId)
      .map((row) => eventSchema.parse(JSON.parse(z.string().parse(row.event)))).slice(-200);
    await waitFor(async () => {
      const rows = await page.locator(".wall-log li").allTextContents();
      return rows.length === events.length;
    }, new AbortController().signal, 10000);
    const rows = await page.locator(".wall-log li").evaluateAll((elements) => elements.map((element) => ({
      text: element.textContent ?? "", timestamp: element.querySelector("time")?.getAttribute("dateTime"),
      sequence: Number(element.getAttribute("data-event-sequence")),
    })));
    if (!events.length || rows.length !== events.length || !events.every((event, index) =>
      rows[index].timestamp === event.timestamp && rows[index].sequence === event.sequence &&
      rows[index].text.includes(event.kind.replaceAll("_", " ").replaceAll(".", " · ")) &&
      (!event.data.action || rows[index].text.includes(event.data.action)) &&
      (!event.data.commentary || rows[index].text.includes(event.data.commentary)) &&
      (!event.data.pageUrl || rows[index].text.includes(event.data.pageUrl)))) {
      throw new Error("release_wall_persisted_events_mismatch");
    }
  }

  async function reportReadback(request: ReturnType<typeof api>,
    report: RunReport, directory: string) {
    for (const agent of report.agents) {
      if (agent.finality !== "final" || agent.launchState !== "settled" || agent.cleanup !== "closed") {
        throw new Error("release_report_unsettled");
      }
      for (const criterion of agent.criteria) {
        if (["met", "not_met"].includes(criterion.status) && !criterion.citations.length) {
          throw new Error("release_criterion_missing_citation");
        }
        for (const citation of criterion.citations) {
          if (citation.state !== "available" || !citation.evidenceIds.length ||
            !citation.evidenceIds.every((id) => agent.evidence.some((entry) => entry.id === id && entry.state === "available"))) {
            throw new Error("release_criterion_evidence_unavailable");
          }
        }
      }
    }
    // Reading all detail endpoints proves owner-scoped registered references, not just report labels.
    for (const entry of report.agents.flatMap((agent) => agent.evidence)) {
      if (entry.state !== "available") throw new Error("release_report_evidence_unavailable");
      const detail = await request(`evidence/${entry.id}/detail`);
      if (!detail || typeof detail !== "object" || !("runId" in detail) || detail.runId !== report.runId) {
        throw new Error("release_report_evidence_wrong_run");
      }
    }
    await writePrivateJson(join(directory, `report-${report.runId}.json`), report);
  }

  async function assertRealGateway(db: DatabaseSync, runId: string) {
    const rows = db.prepare(`SELECT l.usage,l.summary FROM launches l JOIN jobs j ON j.id=l.job_id
      JOIN attempts a ON a.id=j.attempt_id WHERE j.run_id=?`).all(runId);
    if (!rows.length || rows.some((row) => {
      const summary = JSON.parse(z.string().parse(row.summary));
      const usage = JSON.parse(z.string().parse(row.usage));
      const operations = summary.modelOperations;
      return !(summary.modelCalls > 0 && summary.modelCalls <= 28 && operations?.decision > 0 &&
        operations.total === summary.modelCalls && operations.total === operations.decision + operations.evaluation + operations.retry &&
        usage.modelMetrics && Object.values(usage.modelMetrics).some((value) => typeof value === "number" && value > 0));
    })) throw new Error("release_real_gateway_counters_missing");
  }

  export async function releaseOfflinePreflight(): Promise<void> {
    await privateRoot();
    await withReleaseLock(releaseRoot, async () => {
      const directory = join(releaseRoot, randomUUID());
      await mkdir(directory, { mode: 0o700 });
      const { WorkerRepository } = await import("../src/server/worker/repository");
      const repository = new WorkerRepository(directory, releasePolicy);
      const db = new DatabaseSync(join(directory, "flash-flood.sqlite"));
      try {
        assertReleasePolicy(db);
        const session = repository.createSession();
        const run = repository.createDemoRun(session.ownerId, randomUUID(), {
          authorizationAcknowledged: true, scenario: "second-coupon", assignments: releaseAssignments,
        }).run;
        repository.cancelRun(session.ownerId, run.id);
        const ledger = readReleaseLedger(db);
        if (ledger.reservedSeconds !== 0 || ledger.launches.length ||
          repository.attempts(session.ownerId, run.id).some((attempt) => attempt.status !== "cancelled")) {
          throw new Error("release_offline_must_not_allocate");
        }
        await writePrivateJson(join(directory, "offline-preflight.json"), {
          version: 1, sourceDigest: await releaseSourceDigest(), policy: releasePolicy, plan: releasePlan,
          providerCalls: 0, modelCalls: 0, reservations: 0, acceptance: false,
          scope: "Real repository queue/cancel and policy; packaged HTTPS/UI gates are separate.",
          integrationRequirements: RELEASE_INTEGRATION_REQUIREMENTS,
        });
      } finally { db.close(); repository.close(); }
    });
  }

  /** No default adapter: the parent must integrate and review the clean packaged runner. */
  export async function runReleaseRehearsal(deployment: ReleaseDeployment,
    provider: { apiKey: string; projectId: string }, signal = new AbortController().signal): Promise<void> {
    await privateRoot();
    await withReleaseLock(releaseRoot, async () => {
      const sourceDigest = await releaseSourceDigest();
      const packageDigest = await deployment.verifyPackage();
      const { WorkerRepository } = await import("../src/server/worker/repository");
      const repository: WorkerRepository = new WorkerRepository(releaseRoot, releasePolicy);
      const db = new DatabaseSync(join(releaseRoot, "flash-flood.sqlite"));
      let runtime: ReleaseRuntime | undefined, context: BrowserContext | undefined;
      let ownerApi: ReturnType<typeof api> | undefined;
      let ownerId: string | undefined;
      let directory: string | undefined;
      const runIds: string[] = [];
      const oldUmask = process.umask(0o077);
      let acceptance = false;
      try {
        assertReleasePolicy(db);
        const before = readReleaseLedger(db);
        if (!approvedRelease(await readPrivateJson(join(releaseRoot, "approval.json")),
          sourceDigest, packageDigest, releaseLedgerDigest(before))) throw new Error("release_source_bound_approval_required");
        if (!canReserveRelease(before.reservedSeconds, 4)) throw new Error("release_four_session_plan_exceeds_lifetime_cap");
        if (db.prepare("SELECT count(*) n FROM jobs WHERE status IN ('queued','leased')").get()?.n !== 0) {
          throw new Error("release_prior_work_not_settled");
        }
        const { retrieveAdvancedClosure } = await import("./advanced-integration");
        if (before.launches.length && !exactReleaseClosure(before,
          await retrieveAdvancedClosure(asAdvancedReadback(before), provider, signal))) {
          throw new Error("release_prior_cumulative_closure_failed");
        }
        const invocationId = randomUUID();
        directory = join(releaseRoot, invocationId);
        await mkdir(directory, { mode: 0o700 });
        await writePrivateJson(join(directory, "plan.json"), { sourceDigest, packageDigest, before, plan: releasePlan });
        const accessCode = randomBytes(32).toString("hex");
        runtime = await deployment.start({ directory, dataDir: releaseRoot, accessCode, policy: releasePolicy, offline: false, signal });
        const originUrl = new URL(runtime.origin);
        if (originUrl.protocol !== "https:" || originUrl.hostname !== "127.0.0.1" ||
          runtime.origin !== originUrl.origin || originUrl.username || originUrl.password ||
          originUrl.pathname !== "/" || originUrl.search || originUrl.hash) {
          throw new Error("release_actual_loopback_https_required");
        }
        context = await runtime.browser.newContext({ ignoreHTTPSErrors: true,
          viewport: { width: 1440, height: 1000 }, recordVideo: { dir: directory, size: { width: 1440, height: 1000 } } });
        const session = await owner(context, runtime.origin, accessCode);
        ownerId = session.ownerId;
        ownerApi = api(context, runtime.origin, session.csrfToken);
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const request = ownerApi;
        const admit = async (scenario: "fixed" | "second-coupon", count: 1 | 2) => {
          if (!canReserveRelease(readReleaseLedger(db).reservedSeconds, count)) throw new Error("release_lifetime_cap");
          const run = z.object({ id: z.uuid() }).parse(await request("demo-runs", {
            authorizationAcknowledged: true, scenario, assignments: releaseAssignments.slice(0, count),
          }));
          runIds.push(run.id);
          return run.id;
        };
        const finish = async (runId: string) => {
          await waitFor(() => {
            const launches = readReleaseLedger(db).launches.filter((item) => item.runId === runId);
            return launches.length === repository.attempts(session.ownerId, runId).length &&
              launches.every((item) => item.state === "settled" && ["completed", "cancelled"].includes(item.jobStatus));
          }, signal);
          await runtime!.stopWorker();
          const report = runReportSchema.parse(await request(`runs/${runId}/reports`));
          await reportReadback(request, report, directory!);
          await wallReadback(page, runtime!.origin, runId, db);
          return report;
        };
        await runtime.startWorker();
        failureStage = "broken-multi-persona";
        const brokenId = await admit("second-coupon", 2);
        await page.goto(`${runtime.origin}/runs/${brokenId}`, { waitUntil: "domcontentloaded" });
        await captureReleaseLiveViewers({
          page, context, origin: runtime.origin, directory, dataDir: releaseRoot, ownerId: session.ownerId,
          runId: brokenId, repository, db, signal,
        });
        const broken = await finish(brokenId);
        await assertRealGateway(db, brokenId);
        const selected = confirmedReleaseDefect(broken);
        if (!selected) throw new Error("release_planted_secondcoupon_not_confirmed_no_retry");
        await capture(page, directory, "broken-wall-desktop");
        await page.goto(`${runtime.origin}/runs/${brokenId}/reports`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Agent reports", exact: true }).waitFor();
        await capture(page, directory, "broken-report-desktop");
        await page.setViewportSize({ width: 390, height: 844 });
        await capture(page, directory, "broken-report-mobile");
        await page.setViewportSize({ width: 1440, height: 1000 });

        failureStage = "active-cancellation";
        await runtime.startWorker();
        const cancelId = await admit("fixed", 1);
        await waitFor(() => {
          const launches = readReleaseLedger(db).launches.filter((item) => item.runId === cancelId);
          if (launches.some((item) => item.state === "settled")) throw new Error("release_active_cancellation_missed_no_retry");
          return launches.length === 1 && launches[0].state === "active" && !!launches[0].sessionId;
        }, signal, 90000);
        await request(`runs/${cancelId}/cancel`, {});
        const cancelled = await finish(cancelId);
        if (cancelled.status !== "cancelled" || cancelled.agents.length !== 1 ||
          cancelled.agents[0].status !== "cancelled") throw new Error("release_active_cancellation_not_proved");
        await capture(page, directory, "cancelled-wall-desktop");

        failureStage = "selected-fixed-rerun";
        if (!canReserveRelease(readReleaseLedger(db).reservedSeconds)) throw new Error("release_lifetime_cap");
        await runtime.startWorker();
        const rerun = rerunResponseSchema.parse(await request(`runs/${brokenId}/reruns`, {
          authorizationAcknowledged: true, attemptIds: [selected], scenario: "fixed",
        }));
        if (!rerun.created) throw new Error("release_rerun_not_new");
        runIds.push(rerun.run.id);
        const fixed = await finish(rerun.run.id);
        await assertRealGateway(db, rerun.run.id);
        const comparison = runComparisonSchema.parse(await request(`runs/${brokenId}/comparisons/${rerun.run.id}`));
        const parentAfter = runReportSchema.parse(await request(`runs/${brokenId}/reports`));
        if (!confirmedReleaseComparison(broken, fixed, comparison, selected, parentAfter)) {
          throw new Error("release_positive_fix_or_immutable_lineage_not_proved");
        }
        await writePrivateJson(join(directory, "comparison.json"), { comparison, parentBefore: broken, parentAfter });
        await page.goto(`${runtime.origin}/runs/${rerun.run.id}/reports`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Agent reports", exact: true }).waitFor();
        await capture(page, directory, "fixed-report-desktop");
        failureStage = "current-owner-media";
        await readReleaseCurrentOwnerMedia({
          page, context, origin: runtime.origin, directory, ownerId: session.ownerId,
          runId: fixed.runId, attemptId: fixed.agents[0].attemptId, repository, db, signal,
        });
        const after = readReleaseLedger(db);
        if (after.reservedSeconds !== before.reservedSeconds + 1200 ||
          after.launches.length !== before.launches.length + 4 ||
          after.launches.filter((item) => !before.launches.some((old) => old.jobId === item.jobId))
            .some((item) => !runIds.includes(item.runId))) throw new Error("release_unplanned_reservation");
        acceptance = true;
      } finally {
        try {
          await releaseCleanup([
            async () => {
              if (!acceptance && ownerApi) {
                const failures: unknown[] = [];
                const ownedRuns = ownerId ? db.prepare("SELECT id FROM runs WHERE owner_id=?").all(ownerId)
                  .map((row) => z.uuid().parse(row.id)) : runIds;
                for (const id of ownedRuns) {
                  try { await ownerApi(`runs/${id}/cancel`, {}); } catch (error) {
                    failures.push(error);
                    // A lost admission/cancel response must not leave this invocation's queue behind.
                    if (ownerId) repository.cancelRun(ownerId, id);
                  }
                }
                if (failures.length) throw new AggregateError(failures, "release_owned_cancel_failed");
              }
            },
            async () => { await runtime?.stopWorker(); },
            async () => {
              if (!directory) return;
              const ledger = readReleaseLedger(db);
              const { retrieveAdvancedClosure } = await import("./advanced-integration");
              // A fresh GET/list reread of the entire cumulative set, including failures and reducer jobs.
              // Do not reuse worker release responses or only inspect this invocation.
              const sessions = await retrieveAdvancedClosure(asAdvancedReadback(ledger), provider);
              const reread = readReleaseLedger(db);
              const exact = releaseLedgerDigest(ledger) === releaseLedgerDigest(reread) && exactReleaseClosure(reread, sessions);
              await writePrivateJson(join(directory, "closure.json"), { ledger: reread, sessions, exact });
              if (!exact) throw new Error("release_exact_cumulative_completed_closure_failed");
            },
            async () => { await context?.close(); },
            async () => { await runtime?.close(); },
            async () => {
              if (!directory) return;
              const inventory: PrivateAsset[] = [];
              for (const file of (await readdir(directory)).filter((name) => /\.(webm|png)$/.test(name))) {
                await sealReleaseAsset(directory, file);
                inventory.push(await inventoryReleaseAsset(directory, file));
              }
              if (!inventory.some((item) => item.kind === "video")) throw new Error("release_private_local_video_missing");
              await writePrivateJson(join(directory, "pending-inspection.json"), {
                version: 1, invocationId: directory.split("/").at(-1), sourceDigest, capturedAt: Date.now(),
                functionalChecksPassed: acceptance, acceptance: false, inventory,
                notice: "Parent must privately inspect every image/video and write inspection.json. No six-bug or new reduction claim.",
              });
            },
          ]);
          if (directory) await writePrivateJson(join(directory, "cleanup.json"), {
            version: 1, ownedResourcesClosed: true, rawOwnerCredentialsPersisted: false,
          });
        } finally { db.close(); repository.close(); process.umask(oldUmask); }
      }
    });
  }

  /** Offline file-only review finalization; cannot create an owner, worker, run, context or provider client. */
  export async function finalizeReleaseInspection(invocationId: string): Promise<void> {
    z.uuid().parse(invocationId);
    const directory = join(releaseRoot, invocationId);
    const pending = z.object({
      sourceDigest: z.string(), capturedAt: z.number(), functionalChecksPassed: z.literal(true),
      inventory: z.array(z.object({ file: z.string(), sha256: z.string(), bytes: z.number(), kind: z.enum(["image", "video"]) })),
    }).parse(await readPrivateJson(join(directory, "pending-inspection.json"), 65536));
    if (pending.sourceDigest !== await releaseSourceDigest()) throw new Error("release_review_source_changed");
    await assertExactAssetInventory(directory, pending.inventory);
    const closure = z.object({ exact: z.literal(true), ledger: releaseLedgerSchema,
      sessions: z.array(z.object({
        correlationToken: z.uuid(), sessionId: z.uuid(), status: z.literal("COMPLETED"),
        startedAt: z.number(), endedAt: z.number(), actualBrowserSeconds: z.number(),
      })),
    }).parse(await readPrivateJson(join(directory, "closure.json"), 131072));
    const db = new DatabaseSync(join(releaseRoot, "flash-flood.sqlite"), { readOnly: true });
    try {
      assertReleasePolicy(db);
      if (!exactReleaseClosure(closure.ledger, closure.sessions) ||
        releaseLedgerDigest(readReleaseLedger(db)) !== releaseLedgerDigest(closure.ledger)) {
        throw new Error("release_review_cumulative_ledger_changed");
      }
    } finally { db.close(); }
    z.object({ ownedResourcesClosed: z.literal(true), rawOwnerCredentialsPersisted: z.literal(false) })
      .parse(await readPrivateJson(join(directory, "cleanup.json")));
    const media = z.object({
      status: z.enum(["processing", "unavailable", "expired", "unsupported", "ready"]),
      playbackVerified: z.boolean(), allocationDuringReadback: z.literal(false),
    }).parse(await readPrivateJson(join(directory, "media-readback.json"), 65536));
    if (media.status === "ready" && !media.playbackVerified) throw new Error("release_review_playback_unproved");
    if (!closure.exact || !exactReleaseInspection(await readPrivateJson(join(directory, "inspection.json")),
      pending.inventory, invocationId, pending.sourceDigest, pending.capturedAt)) throw new Error("release_parent_inspection_required");
    await writePrivateJson(join(directory, "reviewed-proof.json"), {
      version: 1, acceptance: true, sourceDigest: pending.sourceDigest, inspectedAssets: pending.inventory,
      currentOwnerMedia: media,
      scope: "One planted secondcoupon defect, active cancellation, selected positive fixed rerun; no all-six-bug claim.",
    });
  }

  export async function main(args = process.argv.slice(2)): Promise<void> {
    const mode = parseReleaseArgs(args);
    if (mode === "paid") {
      if (!process.env.RELEASE_PACKAGE_DIR) throw new Error("release_packaged_runner_directory_required");
      failureStage = "configuration";
      nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
      if (process.env.DEBUG === "true") throw new Error("release_provider_debug_forbidden");
      const provider = z.object({
        apiKey: z.string().min(1), projectId: z.uuid(), replayOrigins: z.string().min(1),
      }).parse({
        apiKey: process.env.BROWSERBASE_API_KEY, projectId: process.env.BROWSERBASE_PROJECT_ID,
        replayOrigins: process.env.BROWSERBASE_REPLAY_ORIGINS,
      });
      const { packagedReleaseDeployment, assertPackagePath } = await import("./release-runtime");
      failureStage = "package-validation";
      const packageDirectory = await assertPackagePath(process.env.RELEASE_PACKAGE_DIR);
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        failureStage = "approval-and-runtime";
        await runReleaseRehearsal(packagedReleaseDeployment(packageDirectory, provider), provider, controller.signal);
      }
      finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
      console.log("Release functional proof finished; private inspection is required. No further paid calls.");
      return;
    }
    await releaseOfflinePreflight();
    console.log("Release offline preflight passed; zero provider/model calls. Live acceptance remains gated.");
  }
  if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    void main().catch(async (error: unknown) => {
      process.exitCode = 1;
      try {
        await privateRoot();
        const kind = (value: unknown) => value instanceof TypeError ? "TypeError"
          : value instanceof AggregateError ? "AggregateError" : value instanceof Error ? "Error" : "non_error";
        await writePrivateJson(join(releaseRoot, `failure-${randomUUID()}.json`), {
          failedAt: Date.now(), stage: failureStage, kind: kind(error),
          missingPath: error instanceof Error && "code" in error && error.code === "ENOENT",
          causes: error instanceof AggregateError ? error.errors.slice(0, 12).map(kind) : [],
        });
      } catch {
        console.error("Release private failure diagnostic could not be written.");
      }
      console.error("Release rehearsal failed closed; inspect private evidence locally.");
    });
  }
