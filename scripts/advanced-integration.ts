/**
 * Layer07's fail-closed orchestration boundary. No mode is implicit.
 *
 * Offline: npx tsx scripts/advanced-integration.ts --offline-preflight
 * Paid:    npx tsx scripts/advanced-integration.ts --confirm-paid
 * Readback:npx tsx scripts/advanced-integration.ts --resume ORIGINAL-UUID
 *
 * The coordinator must write private approval.json after its offline gates and
 * review, using the exact sourceDigest in offline-preflight.json. A successful
 * preflight is not authorization and this script never manufactures approval.
 *
 * Paid execution reserves three attempts, with no automatic browser retry.
 * Private images require a coordinator inspection receipt before --resume can
 * declare success. Reproduction is not silently added to this browser budget.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:https";
import { createServer as portProbe } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { WorkerRepository } from "../src/server/worker/repository";
import { takeoverStatusSchema } from "../src/lib/takeover-contracts";
import { contextListSchema } from "../src/lib/context-contracts";
import { runComparisonSchema, rerunResponseSchema } from "../src/lib/rerun-contracts";
import { runReportSchema } from "../src/lib/report-contracts";
import { eventSchema } from "../src/lib/contracts";
import { z } from "zod";
import nextEnv from "@next/env";
import { readConfig } from "../src/lib/config";
import { advancedSourceDigest, assertAdvancedBuild } from "./advanced-build";
import { advancedCancellation, advancedRefreshWatchdog, closeAdvancedObserversAfterWorker, guardAdvancedResume } from "./advanced-lifecycle";
export { advancedSourceDigest } from "./advanced-build";
import {
  ADVANCED_RESUME_TTL_MS, advancedLedgerSchema, advancedPhases, advancedPolicy, approvedAdvancedProof,
  assertAdvancedOperation, assertAdvancedStoredPolicy, assertPrivateDirectory, canReserveAdvanced, exactAdvancedClosure,
  exactAdvancedLedger, exactAdvancedImageInspection, ledgerDigest, loadAdvancedResume, observedPeakConcurrency, parseAdvancedArgs,
  readAdvancedLedger, readPrivateJson, removeAdvancedResume, saveAdvancedResume, verifyAdvancedResume,
  writePrivateJson, captureAdvancedPreference, immutableParent, returningMarkerContrast, validAdvancedHumanGrant,
  auditAdvancedExecution, noAdvancedDispatchOverlap, type AdvancedDispatchAudit,
  readAdvancedContextInventory, contextInventoryDigest, advancedContextsRetired, successfulAdvancedClosure,
  type AdvancedLedger, type AdvancedResumeState, type ClosedAdvancedSession, type MarkerObservation,
} from "./advanced-proof";

const root = resolve("data/advanced-rehearsal");
const port = 4327;
const tlsPort = 4328;
const origin = "https://127.0.0.1:4328";
const terminal = new Set(["COMPLETED", "ERROR", "TIMED_OUT"]);
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export function loadAdvancedConfig() {
  nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  if (process.env.DEBUG === "true") throw new Error("advanced_debug_forbidden");
  const config = readConfig(process.env);
  if (!config.BROWSERBASE_PROJECT_ID) throw new Error("advanced_explicit_project_required");
  return { ...config, BROWSERBASE_PROJECT_ID: config.BROWSERBASE_PROJECT_ID };
}

export const ADVANCED_REVIEW_REQUIREMENTS = Object.freeze([
  "Inspect every private desktop/mobile and actual saved/returning/fresh marker PNG.",
  "Write original UUID/image-inspection.json with version:1, inspectedAt and an exact images array.",
  "Each image entry contains file, sha256, inspected:true; use pending-proof.json as the inventory.",
  "Reproduction is separate and not needed for this non-destructive preference journey; no reproduction claim is made.",
]);
export const ADVANCED_DISPATCH_AUDIT_MIGRATION = `
  CREATE TABLE IF NOT EXISTS advanced_dispatch_audit(
    id INTEGER PRIMARY KEY AUTOINCREMENT, invocation_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    operation TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, started_phase TEXT NOT NULL
  )`;

type Image = { file: string; sha256: string };
type LocalRuntime = {
  page: Page; context: BrowserContext;
  retainObserver(browser: Browser): void;
  startWorker(): Promise<void>; close(): Promise<void>; stopWorker(): Promise<void>;
};

async function stopOwned(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const terminate = setTimeout(() => child.kill("SIGKILL"), 65000);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("advanced_owned_process_did_not_stop")), 70000);
    })]);
  } finally { clearTimeout(terminate); clearTimeout(deadline); }
}

async function waitFor(condition: () => boolean | Promise<boolean>, milliseconds: number, signal?: AbortSignal, interval = 200) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    if (await condition()) return;
    await delay(interval, undefined, { signal });
  }
  throw new Error("advanced_bounded_wait_expired");
}

async function startLocalRuntime(
  directory: string, dataDir: string, accessCode: string, provider: { apiKey: string; projectId?: string },
  offline: boolean, signal: AbortSignal,
): Promise<LocalRuntime> {
  signal.throwIfAborted();
  for (const value of [port, tlsPort]) {
    const probe = portProbe();
    await new Promise<void>((done, reject) => {
      probe.once("error", reject);
      probe.listen(value, "127.0.0.1", () => probe.close((error) => error ? reject(error) : done()));
    });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, DATA_DIR: dataDir,
    FLASH_FLOOD_ACCESS_CODE: accessCode, ENABLE_DEMO_RUNS: "true", DEBUG: "false", NEXT_TELEMETRY_DISABLED: "1",
    BROWSERBASE_API_KEY: provider.apiKey, BROWSERBASE_PROJECT_ID: provider.projectId,
    MAX_CONCURRENT_SESSIONS: "3", MAX_OWNER_SESSIONS: "3", SESSION_TIMEOUT_SECONDS: "300",
    MAX_STEPS_PER_PERSONA: "20", MAX_MODEL_CALLS_PER_PERSONA: "28", EXTERNAL_BASELINE_SECONDS: "985",
    DEVELOPMENT_BUDGET_SECONDS: "4585", OWNER_BUDGET_SECONDS: "3600", LIFETIME_RESERVATION_LIMIT_SECONDS: "3600",
    WORKER_LEASE_MS: "30000", WORKER_RECOVERY_LIMIT: "6", FIXTURE_PORT: String(port),
    ADVANCED_WORKER_INVOCATION: directory.split("/").at(-1),
  };
  let web: ChildProcess | undefined, worker: ChildProcess | undefined, proxy: Server | undefined, browser: Browser | undefined;
  const observers = new Set<Browser>();
  const child = (args: string[]) => {
    const process = spawn(globalThis.process.execPath, args, { env, stdio: "ignore" });
    const ready = new Promise<void>((done, reject) => { process.once("spawn", done); process.once("error", reject); });
    return { process, ready };
  };
  const stopWorker = async () => { if (worker) { await stopOwned(worker); worker = undefined; } };
  let closing: Promise<void> | undefined;
  let abortListener: (() => void) | undefined;
  const closeAll = async () => {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    let failed = false;
    try { await closeAdvancedObserversAfterWorker(stopWorker, observers); } catch { failed = true; }
    try { await browser?.close(); } catch { failed = true; }
    try {
      if (proxy) { proxy.closeAllConnections(); await new Promise<void>((done) => proxy!.close(() => done())); }
    } catch { failed = true; }
    try { if (web) await stopOwned(web); } catch { failed = true; }
    if (failed) throw new Error("advanced_owned_cleanup_failed");
  };
  const close = () => closing ??= closeAll();
  try {
    const owned = child(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)]);
    web = owned.process;
    await owned.ready;
    await writePrivateJson(join(directory, `owned-web-${randomUUID()}.json`), { pid: web.pid });
    await waitFor(async () => {
      if (web!.exitCode !== null) throw new Error("advanced_owned_web_exited");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/project-board`, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        return response.ok;
      } catch { return false; }
    }, 30000, signal);
    signal.throwIfAborted();
    const key = join(directory, "localhost-key.pem"), cert = join(directory, "localhost-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore", timeout: 20000 });
    await Promise.all([chmod(key, 0o600), chmod(cert, 0o600)]);
    proxy = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
      if (incoming.headers.host !== new URL(origin).host) { outgoing.writeHead(421); outgoing.end(); return; }
      const upstream = request({ hostname: "127.0.0.1", port, path: incoming.url, method: incoming.method,
        headers: { ...incoming.headers, "x-forwarded-proto": "https", "x-forwarded-host": new URL(origin).host },
      }, (response) => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); });
      upstream.setTimeout(20000, () => upstream.destroy());
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.on("aborted", () => upstream.destroy());
      outgoing.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    });
    await new Promise<void>((done, reject) => { proxy!.once("error", reject); proxy!.listen(tlsPort, "127.0.0.1", done); });
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    abortListener = () => {
      // The same cleanup promise is awaited by the owning finally block.
      void close().catch(() => {});
    };
    signal.addEventListener("abort", abortListener, { once: true });
    signal.throwIfAborted();
    return { page, context, close, stopWorker, retainObserver: (observer) => { observers.add(observer); }, startWorker: async () => {
      signal.throwIfAborted();
      if (offline || worker) throw new Error("advanced_worker_start_forbidden");
      const ownedWorker = child(["--import", "tsx", "--input-type=module", "--eval",
        "import('./scripts/advanced-integration.ts').then(m=>m.runAdvancedOwnedWorker()).catch(()=>{process.exitCode=1})"]);
      worker = ownedWorker.process;
      await ownedWorker.ready;
      await writePrivateJson(join(directory, "owned-worker.json"), { pid: ownedWorker.process.pid });
      signal.throwIfAborted();
    } };
  } catch (error) { await close(); throw error; }
}

/** Paid child entry, never executed merely by importing this module. */
export async function runAdvancedOwnedWorker(): Promise<void> {
  const invocationId = z.uuid().parse(process.env.ADVANCED_WORKER_INVOCATION);
  if (process.env.ENABLE_DEMO_RUNS !== "true" || resolve(process.env.DATA_DIR ?? "") !== root) {
    throw new Error("advanced_owned_worker_confirmation_missing");
  }
  await assertPrivateDirectory(join(root, invocationId));
  if (!approvedAdvancedProof(await readPrivateJson(join(root, "approval.json")), await advancedSourceDigest())) {
    throw new Error("advanced_owned_worker_approval_missing");
  }
  await assertAdvancedBuild(await advancedSourceDigest());
  const [{ readConfig }, { readWorkerPolicy }, { WorkerRepository }, { DurableWorker, productionDependencies }] = await Promise.all([
    import("../src/lib/config"), import("../src/server/worker/config"), import("../src/server/worker/repository"),
    import("../src/server/worker/runtime"),
  ]);
  const policy = readWorkerPolicy(process.env);
  const config = { ...readConfig(process.env), SESSION_TIMEOUT_SECONDS: policy.sessionSeconds };
  const repository = new WorkerRepository(root, policy);
  const db = new DatabaseSync(join(root, "flash-flood.sqlite"));
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { controller.abort(); deadline ??= setTimeout(() => process.exit(1), 60000); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    assertAdvancedStoredPolicy(db);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(ADVANCED_DISPATCH_AUDIT_MIGRATION);
    const dependencies = productionDependencies(config);
    const launch = dependencies.launch;
    dependencies.launch = async (options) => {
      const execution = await launch(options);
      try {
        const attemptId = z.uuid().parse(db.prepare(`SELECT j.attempt_id FROM launches l JOIN jobs j ON j.id=l.job_id
          WHERE l.correlation_token=? AND j.run_id=?`).get(options.correlationToken!, options.runId)?.attempt_id);
        const audited = auditAdvancedExecution(execution, (operation) => {
          const phase = db.prepare("SELECT phase FROM takeover_controls WHERE attempt_id=?").get(attemptId)?.phase ?? "agent";
          const result = db.prepare(`INSERT INTO advanced_dispatch_audit
            (invocation_id,attempt_id,operation,started_at,started_phase) VALUES(?,?,?,?,?)`)
            .run(invocationId, attemptId, operation, Date.now(), z.string().parse(phase));
          return () => { db.prepare("UPDATE advanced_dispatch_audit SET ended_at=? WHERE id=?").run(Date.now(), result.lastInsertRowid); };
        });
        return { ...execution, ...audited };
      } catch {
        const cleanup = await execution.driver.close().catch(() => ({ status: "failed" as const, errors: ["advanced_audit_cleanup_failed"] }));
        const { CloudStartupError } = await import("../src/server/execution/cloud");
        throw new CloudStartupError(cleanup, execution.usage, "advanced_audit_setup");
      }
    };
    await new DurableWorker(repository, dependencies, port).run(controller.signal);
  } finally {
    clearTimeout(deadline); process.off("SIGINT", stop); process.off("SIGTERM", stop);
    db.close(); repository.close();
  }
}

async function uiOwner(runtime: LocalRuntime, accessCode: string) {
  await runtime.page.goto(origin, { waitUntil: "domcontentloaded" });
  await runtime.page.getByLabel("Workspace access code", { exact: true }).fill(accessCode);
  const [response] = await Promise.all([
    runtime.page.waitForResponse((response) => response.url() === `${origin}/api/v1/session` && response.request().method() === "POST"),
    runtime.page.getByRole("button", { name: "Unlock workspace", exact: true }).click(),
  ]);
  if (!response.ok()) throw new Error("advanced_ui_owner_rejected");
  const session = z.object({ data: z.object({ ownerId: z.uuid(), csrfToken: z.string() }) }).parse(await response.json()).data;
  const cookie = (await runtime.context.cookies(origin)).find((item) => item.name === "__Host-ff_owner" &&
    item.httpOnly && item.secure && item.sameSite === "Strict" && item.path === "/")?.value;
  if (!cookie) throw new Error("advanced_genuine_owner_cookie_missing");
  return { ...session, cookie, createdAt: Date.now() };
}

function ownerApi(runtime: LocalRuntime, csrf: string) {
  return async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await runtime.context.request.fetch(`${origin}/api/v1/${path}`, {
      method, ...(body === undefined ? {} : { data: body }), timeout: 10000, maxRedirects: 0,
      headers: { Origin: origin, "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() },
    });
    if (!response.ok()) throw new Error(`advanced_owner_api_${response.status()}`);
    return z.object({ data: z.unknown() }).parse(await response.json()).data;
  };
}

const goal = "Open Returning-user demo preference using its details summary and read the synthetic preference status. Do not click Remember this demo visit, do not change settings or projects, and do not create or edit anything. Stop once the preference status is visible.";
const criteria = [{ id: "preference-visible", kind: "visible_text", semantics: "current",
  description: "The synthetic preference status is visible.", text: "Synthetic preference:", match: "contains" }];

async function launchViaUi(runtime: LocalRuntime, browserState: "save" | string): Promise<string> {
  const page = runtime.page;
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Controlled demo", exact: true }).click();
  await page.getByLabel("Controlled site").selectOption("project-board");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("What should the crowd try?").fill(goal);
  for (let step = 0; step < 2; step++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  const assignment = page.locator("details.persona-config").first();
  await assignment.locator("summary").first().click();
  await assignment.getByText("Override canonical criteria JSON", { exact: true }).click();
  await assignment.locator("textarea.code-input").fill(JSON.stringify(criteria));
  await assignment.getByText("Browser state: fresh", { exact: true }).click();
  await assignment.getByLabel("State for this assignment").selectOption(browserState);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("region", { name: "Review setup", exact: true }).waitFor();
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${origin}/api/v1/controlled-runs` && response.request().method() === "POST"),
    page.getByRole("button", { name: "Launch 1 persona", exact: true }).click(),
  ]);
  if (!response.ok()) throw new Error("advanced_ui_launch_failed_no_retry");
  return z.object({ data: z.object({ id: z.uuid() }) }).parse(await response.json()).data.id;
}

async function image(directory: string, images: Image[], file: string, bytes: Buffer) {
  if (!/^[a-z0-9-]+\.png$/.test(file) || bytes.length < 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("advanced_invalid_image");
  const handle = await open(join(directory, file), "wx", 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  images.push({ file, sha256: sha(bytes) });
}

async function captureLayouts(runtime: LocalRuntime, directory: string, images: Image[], runId: string) {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }],
  ] as const) {
    await runtime.page.setViewportSize(viewport);
    for (const [surface, suffix] of [["wall", ""], ["report", "/reports"]] as const) {
      await runtime.page.goto(`${origin}/runs/${runId}${suffix}`, { waitUntil: "domcontentloaded" });
      await (surface === "report" ? runtime.page.getByRole("heading", { name: "Agent reports", exact: true })
        : runtime.page.locator(".wall-card").first()).waitFor({ state: "visible" });
      await image(directory, images, `${name}-${surface}.png`, await runtime.page.screenshot({ fullPage: true, timeout: 10000 }));
    }
  }
}

export function ownerSessionBinding(db: DatabaseSync, owner: string, cookie: string, runId: string, attemptId: string, controllerId: string): string {
    if (db.prepare("SELECT id FROM owners WHERE session_hash=? AND expires_at>?").get(sha(cookie), Date.now())?.id !== owner) {
      throw new Error("advanced_cdp_owner_not_authenticated");
    }

    const row = db.prepare(`SELECT b.session_id FROM browser_session_bindings b JOIN launches l ON l.job_id=b.job_id
      JOIN jobs j ON j.id=l.job_id JOIN runs r ON r.id=j.run_id JOIN attempts a ON a.id=j.attempt_id
      JOIN takeover_controls c ON c.attempt_id=a.id
      WHERE r.owner_id=? AND r.id=? AND j.attempt_id=? AND j.status='leased'
      AND j.lease_expires_at>? AND j.cancel_requested_at IS NULL AND r.cancel_requested_at IS NULL
      AND a.status='running' AND l.state='active'
      AND c.phase='human' AND c.controller_id=? AND c.deadline>? AND c.lease_generation=j.lease_generation
      AND json_extract(l.session_reference,'$.sessionId')=b.session_id`)
      .get(owner, runId, attemptId, new Date().toISOString(), controllerId, Date.now());
    return z.uuid().parse(row?.session_id);
  }

function ownedEvents(db: DatabaseSync, owner: string, runId: string) {
  return db.prepare(`SELECT e.event FROM events e JOIN runs r ON r.id=e.run_id
    WHERE r.owner_id=? AND r.id=? ORDER BY e.sequence`).all(owner, runId)
    .map((row) => eventSchema.parse(JSON.parse(z.string().parse(row.event))));
}

  async function takeoverAndRemember(
    runtime: LocalRuntime, repository: WorkerRepository, db: DatabaseSync,
    owner: Awaited<ReturnType<typeof uiOwner>>, runId: string, apiKey: string,
    directory: string, images: Image[], signal: AbortSignal,
  ) {
    const attempt = repository.attempts(owner.ownerId, runId)[0];
    if (!attempt || repository.attempts(owner.ownerId, runId).length !== 1) throw new Error("advanced_assignment_count");
    const api = ownerApi(runtime, owner.csrfToken);
    const controllerId = randomUUID();
    const path = `attempts/${attempt.id}/takeover`;
    let current = takeoverStatusSchema.parse(await api(`${path}?controllerId=${controllerId}`));
    await waitFor(async () => {
      if (!["queued", "running"].includes(repository.getRun(owner.ownerId, runId).status)) {
        throw new Error("advanced_takeover_missed_no_browser_retry");
      }
      const row = db.prepare(`SELECT state,session_reference FROM launches l JOIN jobs j ON j.id=l.job_id
        WHERE j.attempt_id=?`).get(attempt.id);
      if (row?.state !== "active" || !row.session_reference) return false;
      current = takeoverStatusSchema.parse(await api(`${path}?controllerId=${controllerId}`));
      return current.phase === "agent";
    }, 90000, signal);
    await api(path, { action: "request", expectedVersion: current.version, controllerId });
    await waitFor(async () => {
      current = takeoverStatusSchema.parse(await api(`${path}?controllerId=${controllerId}`));
      if (current.phase === "closed") throw new Error("advanced_takeover_closed_before_ack");
      return current.phase === "human" && current.controllerId === controllerId && !!current.interactiveUrl;
    }, 60000, signal, 500);
    const ack = ownedEvents(db, owner.ownerId, runId).findLast((event) =>
      event.attemptId === attempt.id && event.kind === "attempt.control" && event.data.controlPhase === "human");
    if (!ack) throw new Error("advanced_durable_human_ack_missing");
    let remote: Browser | undefined, guardFailure = false, closed = false;
    let expiresMonotonic = 0;
    const assertControl = async () => {
      signal.throwIfAborted();
      if (guardFailure || closed) throw new Error("advanced_human_control_lost");
      const started = performance.now();
      const status = takeoverStatusSchema.parse(await api(`${path}?controllerId=${controllerId}`));
      if (!validAdvancedHumanGrant(status, attempt.id, controllerId, started, performance.now())) {
        guardFailure = true;
        throw new Error("advanced_acknowledged_grant_expired");
      }
      current = status;
      expiresMonotonic = started + status.validForMs!;
      ownerSessionBinding(db, owner.ownerId, owner.cookie, runId, attempt.id, controllerId);
      if (db.prepare("SELECT count(*) n FROM advanced_dispatch_audit WHERE attempt_id=? AND ended_at IS NULL").get(attempt.id)?.n !== 0) {
        guardFailure = true;
        throw new Error("advanced_agent_operation_still_inflight");
      }
    };
    await assertControl();
    // A monotonic watchdog disconnects the independent CDP observer if its
    // acknowledged owner grant is lost, delayed or not refreshed in time.
    const watchdog = advancedRefreshWatchdog(
      assertControl,
      () => performance.now() >= expiresMonotonic || guardFailure,
      async () => {
        guardFailure = true;
        await remote?.close();
      },
    );
    let capture: Awaited<ReturnType<typeof captureAdvancedPreference>>;
    try {
      const sessionId = ownerSessionBinding(db, owner.ownerId, owner.cookie, runId, attempt.id, controllerId);
      await writePrivateJson(join(directory, "before-human-attach.json"), {
        ownerId: owner.ownerId, runId, attemptId: attempt.id, sessionId, acknowledgedSequence: ack.sequence,
        ledger: readAdvancedLedger(db), attachmentCreatesNoSession: true,
      });
      const { chromium } = await import("playwright-core");
      const url = new URL("wss://connect.browserbase.com");
      url.searchParams.set("apiKey", apiKey);
      url.searchParams.set("sessionId", sessionId);
      remote = await chromium.connectOverCDP(url.href, { timeout: 10000 });
      runtime.retainObserver(remote);
      await assertControl();
      const pages = remote.contexts().flatMap((context) => context.pages()).filter((page) => {
        try { return new URL(page.url()).origin === "https://board.flash-flood.invalid"; } catch { return false; }
      });
      if (pages.length !== 1) throw new Error("advanced_controlled_remote_page_not_exact");
      capture = await captureAdvancedPreference(pages[0], "save", assertControl);
      await image(directory, images, "saved-human-marker.png", capture.screenshot);
      await assertControl();
    } finally {
      try { await watchdog.stop(); } finally { closed = true; }
      // keepAlive:false ends the shared provider session on CDP disconnect.
      // Stop human commands now, but retain this passive attachment until worker cleanup.
    }
    if (guardFailure) throw new Error("advanced_human_control_lost");
    current = takeoverStatusSchema.parse(await api(`${path}?controllerId=${controllerId}`));
    if (current.phase !== "human" || current.controllerId !== controllerId) throw new Error("advanced_handback_owner_lost");
    await api(path, { action: "handback", expectedVersion: current.version, controllerId });
    await waitFor(() => {
      const events = ownedEvents(db, owner.ownerId, runId);
      const handed = events.find((event) => event.sequence > ack.sequence && event.kind === "attempt.control" && event.data.controlPhase === "handback");
      const observed = !!handed && events.some((event) => event.sequence > handed.sequence && event.kind === "attempt.observation");
      if (!observed && !["queued", "running"].includes(repository.getRun(owner.ownerId, runId).status)) {
        throw new Error("advanced_handback_failed_no_retry");
      }
      return observed;
    }, 90000, signal);
    const events = ownedEvents(db, owner.ownerId, runId).filter((event) => event.attemptId === attempt.id);
    const handed = events.find((event) => event.sequence > ack.sequence && event.kind === "attempt.control" && event.data.controlPhase === "handback")!;
    const agentResumed = events.find((event) => event.sequence > handed.sequence && event.kind === "attempt.control" && event.data.controlPhase === "agent");
    const observed = events.find((event) => event.sequence > handed.sequence && event.kind === "attempt.observation");
    if (!agentResumed || !observed || observed.sequence <= agentResumed.sequence ||
      events.some((event) => event.sequence > ack.sequence && event.sequence < agentResumed.sequence &&
        /dispatch|attempt\.(decision|action|observation)/.test(event.kind)) ||
      events.some((event) => event.sequence < observed.sequence && event.kind === "attempt.observation" &&
        event.data.evidenceId === observed.data.evidenceId)) {
      throw new Error("advanced_human_interval_dispatch_or_stale_observation");
    }
    const intervals = db.prepare("SELECT started_at,ended_at,end_reason FROM takeover_intervals WHERE attempt_id=? ORDER BY version").all(attempt.id);
    if (intervals.length !== 1 || intervals[0].end_reason !== "handback" || !intervals[0].ended_at) {
      throw new Error("advanced_durable_human_interval_not_closed");
    }
    const dispatchAudit = db.prepare(`SELECT operation,started_at startedAt,ended_at endedAt,started_phase startedPhase
      FROM advanced_dispatch_audit WHERE attempt_id=? ORDER BY id`).all(attempt.id) as AdvancedDispatchAudit[];
    if (!noAdvancedDispatchOverlap(dispatchAudit, z.number().parse(intervals[0].started_at), z.number().parse(intervals[0].ended_at))) {
      throw new Error("advanced_agent_dispatch_overlaps_human_interval");
    }
    await writePrivateJson(join(directory, "human-control.json"), {
      runId, attemptId: attempt.id, acknowledgedSequence: ack.sequence, handbackSequence: handed.sequence,
      resumedSequence: agentResumed.sequence, freshObservationSequence: observed.sequence, intervals,
      actualUiClick: "Remember this demo visit", independentStorageValue: capture!.storageValue,
      humanCommandsStoppedBeforeHandback: true, watchdogDrainedBeforeHandback: true,
      passiveCdpRetainedUntilWorkerCleanup: true,
      noAgentDispatchDuringAcknowledgedInterval: true, dispatchAudit,
      dispatchAuditBoundary: "Actual driver/brain method entry-through-settlement, including transport quiescence; not provider-wide wire tracing.",
      events, humanKeystrokesRecorded: false,
    });
  }

  async function observedMarker(
    repository: WorkerRepository, db: DatabaseSync, owner: string, runId: string,
    mode: MarkerObservation["mode"], directory: string, images: Image[],
  ): Promise<MarkerObservation> {
    const source = repository.reportSource(owner, runId);
    if (source.attempts.length !== 1) throw new Error("advanced_marker_attempt_count");
    const attempt = source.attempts[0];
    const wanted = mode === "fresh" ? "fresh" : "remembered";
    const steps = db.prepare("SELECT evidence_id FROM attempt_steps WHERE attempt_id=? AND kind='observation' ORDER BY ordinal DESC").all(attempt.id);
    for (const step of steps) {
      const entry = source.evidence.find((entry) => entry.metadata.id === step.evidence_id);
      if (!entry) continue;
      const path = join(root, "execution", runId, attempt.id, z.string().regex(/^[a-f0-9]{64}$/).parse(entry.storageKey));
      const value = z.object({ observation: z.object({
        textBlocks: z.array(z.string()), screenshotKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      }) }).parse(JSON.parse(await readFile(path, "utf8"))).observation;
      if (!value.textBlocks.some((text) => text.includes(`Synthetic preference: ${wanted}`)) || !value.screenshotKey) continue;
      if (!source.evidence.some((item) => item.storageKey === value.screenshotKey && item.metadata.kind === "screenshot")) {
        throw new Error("advanced_observation_screenshot_unregistered");
      }
      const pixels = await readFile(join(root, "execution", runId, attempt.id, value.screenshotKey));
      await image(directory, images, `${mode}-worker-marker.png`, pixels);
      const context = db.prepare("SELECT context_id FROM context_selections WHERE attempt_id=?").get(attempt.id);
      return { runId, attemptId: attempt.id, mode, contextId: context ? z.uuid().parse(context.context_id) : null,
        textBlocks: value.textBlocks, screenshotSha256: sha(pixels), screenshotBytes: pixels.length, manualStorageSeeded: false };
    }
    throw new Error("advanced_actual_worker_marker_not_observed");
  }

  function immutableRunSource(db: DatabaseSync, runId: string) {
    return {
      run: db.prepare("SELECT scope,status,updated_at,next_sequence FROM runs WHERE id=?").get(runId),
      attempts: db.prepare("SELECT id,snapshot,status FROM attempts WHERE run_id=? ORDER BY id").all(runId),
      events: db.prepare("SELECT sequence,event FROM events WHERE run_id=? ORDER BY sequence").all(runId),
    };
  }

async function privateRoot(): Promise<void> {
  execFileSync("git", ["check-ignore", "--quiet", "data/advanced-rehearsal/integration.lock"], { stdio: "ignore" });
  // Validate an existing parent before mkdir can follow it. Never chmod an
  // unexpected existing directory into looking safe.
  const parent = resolve("data");
  try {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("advanced_unsafe_data_parent");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(parent, { mode: 0o700 });
  }
  try { await mkdir(root, { mode: 0o700 }); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await assertPrivateDirectory(root);
}

async function openReadOnlyLedger(): Promise<DatabaseSync> {
  const path = join(root, "flash-flood.sqlite");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
    (process.getuid && info.uid !== process.getuid())) throw new Error("advanced_unsafe_database");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    assertAdvancedStoredPolicy(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Only GET/list/retrieve APIs: unlike cloud-recovery this never requests release. */
export async function retrieveAdvancedClosure(
  ledger: AdvancedLedger, configuration: { apiKey: string; projectId: string }, signal?: AbortSignal,
): Promise<ClosedAdvancedSession[]> {
  advancedLedgerSchema.parse(ledger);
  z.uuid().parse(configuration.projectId);
  if (ledger.launches.length > 12) throw new Error("advanced_readback_call_cap");
  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const client = new Browserbase({ apiKey: configuration.apiKey, maxRetries: 0, timeout: 10000 });
  const output: ClosedAdvancedSession[] = [];
  for (const launch of ledger.launches) {
    signal?.throwIfAborted();
    if (!launch.sessionId) throw new Error("advanced_unknown_allocation_no_retry");
    // One exact metadata listing and one independent retrieval per correlated
    // launch, bounded by twelve lifetime reservations. No automatic read retry.
    const listed = await client.sessions.list({ q: `user_metadata['correlationToken']:'${launch.correlationToken}'` }, { signal });
    if (!Array.isArray(listed) || listed.length !== 1 || listed[0].id !== launch.sessionId ||
      listed[0].projectId !== configuration.projectId ||
      listed[0].userMetadata?.correlationToken !== launch.correlationToken) {
      throw new Error("advanced_remote_set_not_exact");
    }
    const session = await client.sessions.retrieve(launch.sessionId, { signal });
    if (session.id !== launch.sessionId || session.projectId !== configuration.projectId ||
      session.userMetadata?.correlationToken !== launch.correlationToken || !terminal.has(session.status) || !session.endedAt) {
      throw new Error("advanced_remote_not_closed");
    }
    const startedAt = Date.parse(session.startedAt);
    const endedAt = Date.parse(session.endedAt);
    output.push({ correlationToken: launch.correlationToken, sessionId: session.id,
      status: session.status, startedAt, endedAt, actualBrowserSeconds: (endedAt - startedAt) / 1000 });
  }
  if (!exactAdvancedClosure(ledger, output)) throw new Error("advanced_closure_evidence_incomplete");
  return output;
}

async function offlinePreflight(directory: string, invocationId: string, sourceDigest: string, signal: AbortSignal) {
  assertAdvancedOperation("offline", "local-ui");
  const { WorkerRepository } = await import("../src/server/worker/repository");
  const data = join(directory, "offline-data");
  await mkdir(data, { mode: 0o700 });
  const accessCode = randomBytes(32).toString("hex");
  const repository = new WorkerRepository(data, advancedPolicy);
  const db = new DatabaseSync(join(data, "flash-flood.sqlite"), { readOnly: true });
  let runtime: LocalRuntime | undefined;
  try {
    const fake = { apiKey: "offline-no-provider-access", projectId: "00000000-0000-4000-8000-000000000001" };
    runtime = await startLocalRuntime(directory, data, accessCode, fake, true, signal);
    const owner = await uiOwner(runtime, accessCode);
    const api = ownerApi(runtime, owner.csrfToken);
    const runId = await launchViaUi(runtime, "save");
    const before = readAdvancedLedger(db);
    if (before.reservedSeconds !== 0 || before.launches.length) throw new Error("advanced_offline_allocated");
    // Queue cancellation is the injected no-browser terminal outcome. No fake
    // succeeded attempt, remote session, worker, or resource adapter is created.
    await api(`runs/${runId}/cancel`, {});
    if (repository.getRun(owner.ownerId, runId).status !== "cancelled") throw new Error("advanced_offline_cancel_failed");
    const state: AdvancedResumeState = {
      version: 1, mode: "offline-test", invocationId, ownerId: owner.ownerId, ownerCookie: owner.cookie, runIds: [runId],
      createdAt: owner.createdAt, expiresAt: owner.createdAt + ADVANCED_RESUME_TTL_MS,
      reservedSeconds: 0, ledgerDigest: ledgerDigest(before),
    };
    await saveAdvancedResume(root, state);
    await runtime.close(); runtime = undefined;
    const loaded = await loadAdvancedResume(root, invocationId, "offline-test");
    verifyAdvancedResume(db, loaded, readAdvancedLedger(db));
    runtime = await startLocalRuntime(directory, data, randomBytes(32).toString("hex"), fake, true, signal);
    await runtime.context.addCookies([{ name: "__Host-ff_owner", value: loaded.ownerCookie,
      url: origin, secure: true, httpOnly: true, sameSite: "Strict", expires: loaded.expiresAt / 1000 }]);
    const resumed = await runtime.context.request.post(`${origin}/api/v1/session`, {
      data: {}, headers: { Origin: origin }, timeout: 10000, maxRedirects: 0,
    });
    const resumedOwner = z.object({ data: z.object({ ownerId: z.uuid() }) }).parse(await resumed.json()).data.ownerId;
    if (!resumed.ok() || resumedOwner !== owner.ownerId || resumed.headers()["set-cookie"] ||
      !exactAdvancedLedger(before, readAdvancedLedger(db))) throw new Error("advanced_offline_resume_failed");
    const images: Image[] = [];
    await captureLayouts(runtime, directory, images, runId);
    const report = runReportSchema.parse(await ownerApi(runtime, owner.csrfToken)(`runs/${runId}/reports`));
    if (report.status !== "cancelled" || report.agents.some((agent) => agent.criteria.some((criterion) => criterion.status === "met"))) {
      throw new Error("advanced_offline_report_implies_execution");
    }
    // An injected local driver exercises the exact grounded candidate path on
    // real Chromium, without a worker claim, cloud allocation or model adapter.
    await runtime.page.setViewportSize({ width: 1440, height: 1000 });
    await runtime.page.goto(`${origin}/project-board`, { waitUntil: "domcontentloaded" });
    await runtime.page.getByText("Returning-user demo preference", { exact: true }).scrollIntoViewIfNeeded();
    const { ScopedBrowserDriver } = await import("../src/server/execution/driver");
    let localPixels: Buffer | undefined;
    const jsonReceipt = async (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      return { key: sha(bytes), kind: "json" as const, bytes: bytes.length, sha256: sha(bytes) };
    };
    const driver = new ScopedBrowserDriver({
      page: runtime.page, scope: { allowedOrigins: [origin], navigationPaths: ["/project-board"] },
      networkErrors: [], close: async () => ({ status: "closed", errors: [] }),
      artifacts: {
        screenshot: async (bytes) => {
          localPixels = Buffer.from(bytes);
          return { key: sha(bytes), kind: "screenshot", bytes: bytes.length, sha256: sha(bytes) };
        },
        json: jsonReceipt, telemetry: jsonReceipt,
      },
    });
    try {
      const signal = AbortSignal.timeout(15000);
      const initial = await driver.observe(signal);
      const summary = initial.candidates.find((item) => item.label === "Returning-user demo preference" && item.kind === "button");
      if (!summary) throw new Error("advanced_summary_not_grounded_by_driver");
      await driver.act({ actor: "agent", action: "click", candidateId: summary.id, value: null,
        commentary: "Open the synthetic preference details." }, signal);
      const observed = await driver.observe(signal);
      if (!observed.textBlocks?.some((text) => text.includes("Synthetic preference: fresh")) ||
        await runtime.page.evaluate(() => localStorage.getItem("flash-flood.synthetic-preference.v1")) !== null || !localPixels) {
        throw new Error("advanced_offline_actual_marker_missing");
      }
      await image(directory, images, "offline-driver-marker.png", localPixels);
    } finally { await driver.close(); }
    if (!exactAdvancedLedger(before, readAdvancedLedger(db))) throw new Error("advanced_offline_driver_allocated");
    await writePrivateJson(join(directory, "offline-preflight.json"), {
      version: 1, sourceDigest, policy: advancedPolicy, phases: advancedPhases,
      preflightPassed: true, paidProofPassed: false, noProviderCalls: true, noWorkerStarted: true,
      genuineOwnerReadback: true, realHttpsUi: true, originalOwnerAfterServerRestart: true, images, injectedLocalDriverPassed: true,
      reservedSeconds: readAdvancedLedger(db).reservedSeconds, imageInspectionRequired: true,
      notice: "Real local HTTPS owner/UI/restart and queued cancellation only. No cloud persistence, takeover or paid proof claimed.",
    });
    console.log(JSON.stringify({ mode: "offline-preflight", passed: true, paidProofPassed: false, providerCalls: 0 }));
  } finally {
    try { await runtime?.close(); } finally {
      await removeAdvancedResume(root, invocationId);
      db.close();
      repository.close();
    }
  }
}

async function resumeReadback(directory: string, invocationId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const state = await loadAdvancedResume(root, invocationId);
  const db = await openReadOnlyLedger();
  let verified = false;
  try {
    const before = readAdvancedLedger(db);
    const resources = readAdvancedContextInventory(db);
    const resourceDigest = contextInventoryDigest(resources);
    try { verifyAdvancedResume(db, state, before); } catch {
      await removeAdvancedResume(root, invocationId);
      throw new Error("advanced_resume_identity_or_ledger_mismatch");
    }
    assertAdvancedOperation("resume", "readback");
    await writePrivateJson(join(directory, "resume-ledger-before.json"), before);
    await writePrivateJson(join(directory, "resume-contexts-before.json"), resources);
    // No worker, app process, owner creation, run creation, cancellation,
    // recovery/release or context mutation is imported on this branch.
    const config = loadAdvancedConfig();
    assertAdvancedOperation("resume", "provider-read");
    const closure = await retrieveAdvancedClosure(before, {
      apiKey: config.BROWSERBASE_API_KEY, projectId: config.BROWSERBASE_PROJECT_ID,
    }, signal);
    const after = readAdvancedLedger(db);
    if (!exactAdvancedLedger(before, after)) throw new Error("advanced_resume_ledger_mutated");
    const peakConcurrency = observedPeakConcurrency(closure);
    await writePrivateJson(join(directory, "resume-readback.json"), {
      readbackPassed: true, paidProofPassed: false, expected: before, sessions: closure, peakConcurrency,
      actualBrowserSeconds: closure.reduce((sum, session) => sum + session.actualBrowserSeconds, 0),
      modelUsage: before.launches.map(({ attemptId, usage }) => ({ attemptId, usage })),
      failedAttempts: before.launches.filter((launch) => {
        const status = db.prepare("SELECT status FROM attempts WHERE id=?").get(launch.attemptId)?.status;
        return status !== "succeeded";
      }).map(({ attemptId }) => attemptId),
      contexts: resources, contextsRetired: advancedContextsRetired(resources),
      notice: "Durations and reported token counters are diagnostic observations, not an invoice. Readback alone is not advanced proof.",
    });
    if (peakConcurrency > advancedPolicy.globalConcurrency || closure.some((entry) => entry.actualBrowserSeconds > 300)) {
      throw new Error("advanced_remote_limits_exceeded");
    }
    if (!successfulAdvancedClosure(before, closure)) throw new Error("advanced_provider_completion_not_successful");
    if (!advancedContextsRetired(resources)) throw new Error("advanced_retained_context_resources");
    verified = true;
    const original = join(root, invocationId);
    const pending = await readPrivateJson(join(original, "pending-proof.json"), 256 * 1024).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (pending === null) {
      console.log(JSON.stringify({ mode: "resume", readbackPassed: true, paidProofPassed: false,
        reason: "original_functional_proof_incomplete" }));
      process.exitCode = 2;
      return;
    }
    const proof = z.object({
      version: z.literal(1), invocationId: z.uuid(), ownerId: z.uuid(), runIds: z.array(z.uuid()).length(3),
      sourceDigest: z.string(), functionalPassed: z.literal(true), contextRetired: z.literal(true),
      createdAt: z.number(), ledgerDigest: z.string(),
      contextInventoryDigest: z.string(),
      images: z.array(z.strictObject({ file: z.string().regex(/^[a-z0-9-]+\.png$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).length(8),
    }).parse(pending);
    if (proof.invocationId !== invocationId || proof.ownerId !== state.ownerId ||
      !immutableParent(proof.runIds, state.runIds) || proof.ledgerDigest !== ledgerDigest(before) ||
      proof.createdAt !== state.createdAt || proof.sourceDigest !== await advancedSourceDigest() ||
      proof.contextInventoryDigest !== resourceDigest) {
      throw new Error("advanced_pending_proof_mismatch");
    }
    const receipt = await readPrivateJson(join(original, "image-inspection.json")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!exactAdvancedImageInspection(receipt, invocationId, proof.images, state.createdAt)) {
      console.log(JSON.stringify({ mode: "resume", readbackPassed: true, paidProofPassed: false,
        reason: "private_image_inspection_required" }));
      process.exitCode = 2;
      return;
    }
    z.object({ passed: z.literal(true) }).parse(await readPrivateJson(join(original, "owned-cleanup.json")));
    for (const entry of proof.images) {
      const path = join(original, entry.file);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
        info.size > 8 * 1024 * 1024 || sha(await readFile(path)) !== entry.sha256) {
        throw new Error("advanced_inspected_image_changed");
      }
    }
    for (const runId of state.runIds) {
      if (db.prepare("SELECT status FROM runs WHERE id=? AND owner_id=?").get(runId, state.ownerId)?.status !== "succeeded") {
        throw new Error("advanced_resume_run_no_longer_final");
      }
    }
    verifyAdvancedResume(db, state, readAdvancedLedger(db));
    if (resourceDigest !== contextInventoryDigest(readAdvancedContextInventory(db))) {
      throw new Error("advanced_resume_context_inventory_mutated");
    }
    await writePrivateJson(join(original, "proof-complete.json"), {
      paidProofPassed: true, exactReadbackPassed: true, imageInspectionPassed: true, completedAt: Date.now(),
      reservedSeconds: before.reservedSeconds, peakConcurrency,
      actualBrowserSeconds: closure.reduce((sum, entry) => sum + entry.actualBrowserSeconds, 0),
      contexts: resources, contextsRetired: true, contextInventoryDigest: resourceDigest,
      notice: "Observed durations and tokens are not an invoice; synthetic preference only, no private credentials seeded.",
    });
    await removeAdvancedResume(root, invocationId);
    console.log(JSON.stringify({ mode: "resume", paidProofPassed: true, reservedSeconds: before.reservedSeconds, peakConcurrency }));
    process.exitCode = 0;
  } finally {
    db.close();
    if (Date.now() >= state.expiresAt) await removeAdvancedResume(root, invocationId);
    if (!verified) process.exitCode = 1;
  }
}

async function paidAdmission(directory: string, invocationId: string, sourceDigest: string, signal: AbortSignal) {
  const approval = await readPrivateJson(join(root, "approval.json"));
  if (!approvedAdvancedProof(approval, sourceDigest)) throw new Error("advanced_offline_gates_and_review_required");
  let ledger: AdvancedLedger = { version: 1, baselineSeconds: 985, reservedSeconds: 0, launches: [] };
  let db: DatabaseSync | undefined;
  let repository: WorkerRepository | undefined, runtime: LocalRuntime | undefined;
  let owner: Awaited<ReturnType<typeof uiOwner>> | undefined;
  const runIds: string[] = [], images: Image[] = [];
  let contextId: string | undefined, phase = "prior-ledger", functionalPassed = false;
  let closure: ClosedAdvancedSession[] = [], currentLedger: AdvancedLedger | undefined;
  let config: ReturnType<typeof loadAdvancedConfig> | undefined;
  let usageBefore: number | undefined, usageAfter: number | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    try { db = await openReadOnlyLedger(); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const sentinel = await lstat(join(root, "paid-ledger-established.json")).catch(() => null);
      if (sentinel) throw new Error("advanced_persistent_ledger_missing");
    }
    if (db) ledger = readAdvancedLedger(db);
    await writePrivateJson(join(directory, "ledger-before.json"), ledger);
    if (db) {
      const resources = readAdvancedContextInventory(db);
      await writePrivateJson(join(directory, "contexts-before.json"), resources);
      if (!advancedContextsRetired(resources)) throw new Error("advanced_prior_contexts_require_operator_reconciliation");
    }
    if (!canReserveAdvanced(ledger.reservedSeconds, 3)) throw new Error("advanced_nonrefundable_lifetime_cap");
    if (db && (db.prepare("SELECT count(*) n FROM jobs WHERE status IN ('queued','leased')").get()?.n !== 0 ||
      db.prepare("SELECT count(*) n FROM launches WHERE state!='settled'").get()?.n !== 0)) {
      throw new Error("advanced_prior_ledger_requires_operator_reconciliation");
    }
    if (db?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reproductions'").get() &&
      db.prepare("SELECT count(*) n FROM reproductions WHERE status IN ('queued','running')").get()?.n !== 0) {
      throw new Error("advanced_prior_reproduction_queue_requires_operator_reconciliation");
    }
    const [{ inspectProject }, { WorkerRepository }] = await Promise.all([
      import("../src/server/worker/cloud-recovery"),
      import("../src/server/worker/repository"),
    ]);
    config = loadAdvancedConfig();
    phase = "prior-exact-closure";
    if (ledger.launches.length) {
      const prior = await retrieveAdvancedClosure(ledger, { apiKey: config.BROWSERBASE_API_KEY, projectId: config.BROWSERBASE_PROJECT_ID });
      await writePrivateJson(join(directory, "prior-exact-closure.json"), { ledger, sessions: prior });
      if (!successfulAdvancedClosure(ledger, prior)) throw new Error("advanced_prior_provider_completion_not_successful");
    }
    const project = await inspectProject(config);
    usageBefore = project.browserMinutes;
    if (project.concurrency < 1) throw new Error("advanced_project_has_no_capacity");
    db?.close(); db = undefined;
    if (!await lstat(join(root, "paid-ledger-established.json")).catch(() => null)) {
      await writePrivateJson(join(root, "paid-ledger-established.json"), { version: 1, establishedAt: Date.now(), policy: advancedPolicy });
    }
    repository = new WorkerRepository(root, advancedPolicy);
    db = new DatabaseSync(join(root, "flash-flood.sqlite"), { readOnly: true });
    assertAdvancedStoredPolicy(db);
    if (!exactAdvancedLedger(ledger, readAdvancedLedger(db))) throw new Error("advanced_preallocation_ledger_changed");
    const accessCode = randomBytes(32).toString("hex");
    runtime = await startLocalRuntime(directory, root, accessCode, {
      apiKey: config.BROWSERBASE_API_KEY, projectId: config.BROWSERBASE_PROJECT_ID,
    }, false, controller.signal);
    owner = await uiOwner(runtime, accessCode);
    expiryTimer = setTimeout(() => controller.abort(), ADVANCED_RESUME_TTL_MS);
    const api = ownerApi(runtime, owner.csrfToken);
    const reserveBefore = async (name: string, attemptsRemaining: number) => {
      controller.signal.throwIfAborted();
      if (Date.now() + 390000 >= owner!.createdAt + ADVANCED_RESUME_TTL_MS) {
        throw new Error("advanced_original_credential_deadline_too_close");
      }
      const snapshot = readAdvancedLedger(db!);
      if (!canReserveAdvanced(snapshot.reservedSeconds, attemptsRemaining)) throw new Error("advanced_nonrefundable_lifetime_cap");
      await writePrivateJson(join(directory, `before-${name}.json`), {
        ledger: snapshot, admittingAttempts: 1, remainingPlanAttempts: attemptsRemaining,
        noBrowserRetries: true, failedReservationsRemainCharged: true,
      });
    };
    const terminalRun = async (runId: string) => {
      await waitFor(() => !["queued", "running"].includes(repository!.getRun(owner!.ownerId, runId).status), 380000, controller.signal);
      await waitFor(() => db!.prepare(`SELECT count(*) n FROM launches l JOIN jobs j ON j.id=l.job_id
        WHERE j.run_id=? AND l.state!='settled'`).get(runId)?.n === 0, 60000, controller.signal);
      const report = runReportSchema.parse(await api(`runs/${runId}/reports`));
      await writePrivateJson(join(directory, `report-${runIds.indexOf(runId) + 1}.json`), report);
      if (report.status !== "succeeded" || report.finality !== "final" || report.agents.length !== 1 ||
        report.agents[0].cleanup !== "closed") throw new Error("advanced_attempt_not_successful_no_retry");
    };
    phase = "owner-ui-save-context";
    await reserveBefore("save", 3);
    const savedRun = await launchViaUi(runtime, "save");
    runIds.push(savedRun);
    if (repository.attempts(owner.ownerId, savedRun).length !== 1) throw new Error("advanced_assignment_count");
    const savedAttempt = repository.attempts(owner.ownerId, savedRun)[0];
    contextId = z.uuid().parse(db.prepare("SELECT context_id FROM context_selections WHERE attempt_id=?").get(savedAttempt.id)?.context_id);
    await writePrivateJson(join(directory, "saved-run-plan.json"), { ownerId: owner.ownerId, runId: savedRun, contextId, goal, criteria });
    // The script's acknowledged controller is exclusive; do not leave another
    // managed viewer polling/granting control while the separate CDP observer runs.
    await runtime.page.goto("about:blank");
    await runtime.startWorker();
    phase = "acknowledged-human-ui-click";
    await takeoverAndRemember(runtime, repository, db, owner, savedRun, config.BROWSERBASE_API_KEY, directory, images, controller.signal);
    phase = "saved-context-closed";
    await terminalRun(savedRun);
    const savedMarker = await observedMarker(repository, db, owner.ownerId, savedRun, "save", directory, images);
    await waitFor(async () => {
      const entry = contextListSchema.parse(await api("contexts")).items.find((item) => item.id === contextId);
      if (entry && ["quarantined", "creation_unknown", "deletion_unknown", "revoked"].includes(entry.status)) {
        throw new Error("advanced_context_not_reusable");
      }
      return !!entry && !entry.revoked && entry.availableAfter !== null &&
        Date.parse(entry.availableAfter) <= Date.now() && ["requested", "delay_elapsed_unverified"].includes(entry.persistence) &&
        ["available", "persisting"].includes(entry.status);
    }, 30000, controller.signal, 500);
    phase = "returning-marker-observation";
    await reserveBefore("returning", 2);
    const returningRun = await launchViaUi(runtime, contextId);
    runIds.push(returningRun);
    const returningAttempt = repository.attempts(owner.ownerId, returningRun)[0];
    if (returningAttempt.browserState?.mode !== "returning" || returningAttempt.browserState.persist !== false ||
      returningAttempt.browserState.contextId !== contextId) throw new Error("advanced_returning_selection_not_readonly");
    await runtime.page.goto("about:blank");
    await terminalRun(returningRun);
    const returningMarker = await observedMarker(repository, db, owner.ownerId, returningRun, "returning", directory, images);
    phase = "immutable-fresh-rerun";
    const beforeParent = immutableRunSource(db, returningRun);
    await reserveBefore("fresh-rerun", 1);
    await runtime.page.goto(`${origin}/runs/${returningRun}/reports`, { waitUntil: "domcontentloaded" });
    await runtime.page.getByLabel(`${returningAttempt.persona.name} · ${returningAttempt.goal}`, { exact: true }).check();
    await runtime.page.getByLabel("I authorize this fresh scoped rerun.", { exact: true }).check();
    const [rerunResponse] = await Promise.all([
      runtime.page.waitForResponse((response) => response.url() === `${origin}/api/v1/runs/${returningRun}/reruns` &&
        response.request().method() === "POST"),
      runtime.page.getByRole("button", { name: "Rerun selected attempts", exact: true }).click(),
    ]);
    if (!rerunResponse.ok()) throw new Error("advanced_ui_rerun_failed_no_retry");
    const rerun = rerunResponseSchema.parse(z.object({ data: z.unknown() }).parse(await rerunResponse.json()).data);
    if (!rerun.created) throw new Error("advanced_unexpected_existing_rerun");
    const freshRun = rerun.run.id;
    runIds.push(freshRun);
    const freshAttempt = repository.attempts(owner.ownerId, freshRun)[0];
    if (!freshAttempt || freshAttempt.browserState && freshAttempt.browserState.mode !== "fresh" ||
      !immutableParent(returningAttempt.persona, freshAttempt.persona) ||
      !immutableParent(returningAttempt.goal, freshAttempt.goal) ||
      !immutableParent(returningAttempt.criteria, freshAttempt.criteria) ||
      !immutableParent(returningAttempt.limits, freshAttempt.limits) ||
      !immutableParent(repository.getRun(owner.ownerId, returningRun).scope, rerun.run.scope)) {
      throw new Error("advanced_rerun_inheritance_mismatch");
    }
    await runtime.page.goto("about:blank");
    await terminalRun(freshRun);
    const freshMarker = await observedMarker(repository, db, owner.ownerId, freshRun, "fresh", directory, images);
    if (!returningMarkerContrast(savedMarker, returningMarker, freshMarker)) throw new Error("advanced_saved_returning_fresh_contrast_failed");
    await writePrivateJson(join(directory, "context-marker-proof.json"), {
      saved: savedMarker, returning: returningMarker, fresh: freshMarker,
      actualContentsObserved: true, providerPersistenceConfirmed: false, returningStorageManuallySeeded: false,
    });
    const comparison = runComparisonSchema.parse(await api(`runs/${returningRun}/comparisons/${freshRun}`));
    if (comparison.parentRunId !== returningRun || comparison.childRunId !== freshRun || comparison.context !== "fresh" ||
      !comparison.comparable || comparison.pairs.length !== 1 ||
      comparison.pairs[0].parentAttemptId !== returningAttempt.id || comparison.pairs[0].childAttemptId !== freshAttempt.id ||
      comparison.pairs[0].parentHumanAssisted || comparison.pairs[0].childHumanAssisted ||
      !comparison.pairs[0].comparable || comparison.pairs[0].criteria.length !== criteria.length ||
      comparison.pairs[0].criteria.some((criterion) => !criterion.tested || !criterion.confirmedMet) ||
      !immutableParent(beforeParent, immutableRunSource(db, returningRun))) {
      throw new Error("advanced_immutable_comparison_failed");
    }
    await writePrivateJson(join(directory, "comparison-proof.json"), {
      comparison, parentBefore: beforeParent, parentAfter: immutableRunSource(db, returningRun),
      humanAssistedSaveExcluded: true,
    });
    phase = "desktop-mobile-image-capture";
    await captureLayouts(runtime, directory, images, freshRun);
    phase = "context-retirement";
    await api(`contexts/${contextId}`, undefined, "DELETE");
    await waitFor(async () => contextListSchema.parse(await api("contexts")).items
      .some((entry) => entry.id === contextId && entry.status === "deleted" && entry.revoked), 60000, controller.signal, 500);
    functionalPassed = true;
    phase = "all-correlated-sessions-closed";
    await runtime.stopWorker();
    currentLedger = readAdvancedLedger(db);
    if (currentLedger.reservedSeconds !== ledger.reservedSeconds + 900 ||
      currentLedger.launches.length !== ledger.launches.length + 3) throw new Error("advanced_unexpected_allocation_set");
    closure = await retrieveAdvancedClosure(currentLedger, { apiKey: config.BROWSERBASE_API_KEY, projectId: config.BROWSERBASE_PROJECT_ID });
    await writePrivateJson(join(directory, "remote-closure.json"), { expected: currentLedger, sessions: closure });
    const resources = readAdvancedContextInventory(db);
    await writePrivateJson(join(directory, "context-resources.json"), resources);
    if (!successfulAdvancedClosure(currentLedger, closure)) throw new Error("advanced_provider_completion_not_successful");
    if (!advancedContextsRetired(resources)) throw new Error("advanced_retained_context_resources");
    usageAfter = (await inspectProject(config)).browserMinutes;
    if (!exactAdvancedLedger(currentLedger, readAdvancedLedger(db)) ||
      observedPeakConcurrency(closure) > 3 || closure.some((entry) => entry.actualBrowserSeconds > 300)) {
      throw new Error("advanced_final_ledger_or_remote_limits_changed");
    }
    await writePrivateJson(join(directory, "pending-proof.json"), {
      version: 1, invocationId, sourceDigest, functionalPassed: true, paidProofPassed: false,
      ownerId: owner.ownerId, runIds, images, createdAt: owner.createdAt,
      expiresAt: owner.createdAt + ADVANCED_RESUME_TTL_MS, ledgerDigest: ledgerDigest(currentLedger),
      expected: currentLedger, sessions: closure, peakConcurrency: observedPeakConcurrency(closure),
      usageBeforeMinutes: usageBefore, usageAfterMinutes: usageAfter,
      actualBrowserSeconds: closure.reduce((sum, entry) => sum + entry.actualBrowserSeconds, 0),
      modelUsage: currentLedger.launches.map(({ attemptId, usage }) => ({ attemptId, usage })),
      contextRetired: true, reproduction: { status: "not_required", reason: "No failure reproduction is claimed for the preference observation journey." },
      contextInventoryDigest: contextInventoryDigest(resources),
      inspectionRequirements: ADVANCED_REVIEW_REQUIREMENTS,
      notice: "Actual durations/token counters are not an invoice. Image inspection and exact authenticated resume readback are still required.",
    });
    process.exitCode = 2;
    console.log(JSON.stringify({ mode: "paid", functionalPassed: true, paidProofPassed: false,
      needs: "private_image_inspection_then_resume", newReservedSeconds: 900 }));
  } catch (error) {
    await writePrivateJson(join(directory, "failure.json"), {
      phase, functionalPassed: false, paidProofPassed: false, runIds,
      contextRetirementRequired: db ? !advancedContextsRetired(readAdvancedContextInventory(db)) : false,
      reason: error instanceof Error && /^advanced_[a-z0-9_]+$/.test(error.message) ? error.message : "advanced_phase_failed",
      browserRetryAttempted: false,
    });
    throw error;
  } finally {
    // Stop only this invocation's worker before recording the resume fingerprint.
    // Cleanup never resets reservations or starts a replacement browser.
    let cleanupFailed = false;
    try { await runtime?.close(); } catch { cleanupFailed = true; }
    await writePrivateJson(join(directory, "owned-cleanup.json"), {
      passed: !cleanupFailed, onlyOwnedProcessesStopped: true,
      retainedObserversDisconnectedAfterWorker: !cleanupFailed,
    });
    if (db && owner && runIds.length) {
      currentLedger = readAdvancedLedger(db);
      await writePrivateJson(join(directory, "ledger-after.json"), currentLedger);
      const resources = readAdvancedContextInventory(db);
      await writePrivateJson(join(directory, "contexts-after.json"), {
        inventory: resources, retired: advancedContextsRetired(resources), digest: contextInventoryDigest(resources),
      });
      if (Date.now() < owner.createdAt + ADVANCED_RESUME_TTL_MS) {
        await saveAdvancedResume(root, {
          version: 1, mode: "paid", invocationId, ownerId: owner.ownerId, ownerCookie: owner.cookie, runIds,
          createdAt: owner.createdAt, expiresAt: owner.createdAt + ADVANCED_RESUME_TTL_MS,
          reservedSeconds: currentLedger.reservedSeconds, ledgerDigest: ledgerDigest(currentLedger),
        });
      }
      if (!functionalPassed) {
        // Failed attempts are independently retrieved too, when all IDs are
        // known; an unknown allocation remains an explicit failed closure.
        if (config?.BROWSERBASE_PROJECT_ID) {
          try {
            const failedClosure = await retrieveAdvancedClosure(currentLedger, {
              apiKey: config.BROWSERBASE_API_KEY, projectId: config.BROWSERBASE_PROJECT_ID,
            });
            await writePrivateJson(join(directory, "failure-closure.json"), {
              sessions: failedClosure, expected: currentLedger, paidProofPassed: false,
            });
          } catch {
            await writePrivateJson(join(directory, "failure-closure.json"), {
              confirmed: false, expected: currentLedger, paidProofPassed: false,
              reason: "Independent closure unavailable; no release/retry/adoption was attempted.",
            });
          }
        }
      }
    }
    db?.close(); repository?.close();
    if (owner && Date.now() >= owner.createdAt + ADVANCED_RESUME_TTL_MS) await removeAdvancedResume(root, invocationId);
    clearTimeout(expiryTimer);
    signal.removeEventListener("abort", abort);
    if (cleanupFailed) throw new Error("advanced_owned_cleanup_failed");
  }
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseAdvancedArgs(args);
  process.umask(0o077);
  const cancellation = advancedCancellation();
  const invocationId = randomUUID();
  const directory = join(root, invocationId);
  try {
    await privateRoot();
    const lockPath = join(root, "integration.lock");
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const identity = await lock.stat();
    let failure: unknown;
    try {
      await lock.writeFile(JSON.stringify({ invocationId, pid: process.pid }));
      await lock.sync();
      await mkdir(directory, { mode: 0o700 });
      await writePrivateJson(join(directory, "invocation.json"), {
        mode: parsed.mode, startedAt: Date.now(), policy: advancedPolicy,
        resumedInvocation: parsed.invocationId ?? null,
      });
      cancellation.signal.throwIfAborted();
      if (parsed.mode === "resume") await resumeReadback(directory, parsed.invocationId!, cancellation.signal);
      else {
        const sourceDigest = await advancedSourceDigest();
        await assertAdvancedBuild(sourceDigest);
        cancellation.signal.throwIfAborted();
        if (parsed.mode === "offline") await offlinePreflight(directory, invocationId, sourceDigest, cancellation.signal);
        else await paidAdmission(directory, invocationId, sourceDigest, cancellation.signal);
      }
    } catch (error) {
      failure = error;
    } finally {
      await lock.close();
      const current = await lstat(lockPath).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (current && current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
    }
    // Release the exclusive invocation lock before waiting, so authenticated
    // read-only resume can consume the credential while this guard stays alive.
    if (parsed.mode === "paid") {
      const credential = await lstat(join(directory, "owner-resume.json")).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (credential) {
        console.log(JSON.stringify({ mode: "paid", credentialGuard: true, paidProofPassed: false,
          needs: failure ? "failure_readback_or_original_expiry" : "private_image_inspection_then_resume" }));
        await guardAdvancedResume(root, invocationId, cancellation.signal);
      }
    }
    cancellation.signal.throwIfAborted();
    if (failure !== undefined) throw failure;
  } finally {
    cancellation.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Never print SDK errors, credentials, private URLs, run/session identifiers
    // or arbitrary parser diagnostics.
    const message = error instanceof Error && /^advanced_[a-z0-9_]+$/.test(error.message)
      ? error.message : "advanced_harness_failed";
    console.error(JSON.stringify({ passed: false, reason: message }));
    process.exitCode = 1;
  });
}
