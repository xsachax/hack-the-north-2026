import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:https";
import { createServer as createPortProbe } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { z } from "zod";
import { readConfig } from "../src/lib/config";
import type { RunEvent } from "../src/lib/contracts";
import { controlledRunSchema } from "../src/lib/controlled-run";
import { sessionsResponseSchema } from "../src/lib/ui-contracts";
import { safeErrorMessage } from "../src/server/redact";
import { createCloudRecovery, inspectProject } from "../src/server/worker/cloud-recovery";
import { WorkerRepository } from "../src/server/worker/repository";
import {
  authenticatedReadonlyViewer, boardJourneyProof, canReserveUiRun, exactCompletedClosure, exactWallProof,
  probeFrame, renderedViewer, uiPolicy,
  type ExpectedLaunch, type PersistedStep, type RemoteProof, type ViewerProof, type VisualSample,
} from "./ui-proof";

const port = 4323;
const tlsPort = 4324;
const origin = `https://127.0.0.1:${tlsPort}`;
let dataDir = resolve("data/ui-rehearsal");

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 65000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function unusedPort(value: number) {
  const probe = createPortProbe();
  await new Promise<void>((done, reject) => {
    probe.once("error", reject);
    probe.listen(value, "127.0.0.1", () => probe.close((error) => error ? reject(error) : done()));
  });
}

async function startProxy(): Promise<Server> {
  const keyPath = join(dataDir, "localhost-key.pem");
  const certPath = join(dataDir, "localhost-cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", "/CN=127.0.0.1", "-keyout", keyPath, "-out", certPath,
  ], { stdio: "ignore", timeout: 20000 });
  await Promise.all([chmod(keyPath, 0o600), chmod(certPath, 0o600)]);
  const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (incoming, outgoing) => {
    // Pipe rather than collect: the wall must receive real SSE frames immediately.
    const upstream = request({
      hostname: "127.0.0.1", port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, "x-forwarded-proto": "https" },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      outgoing.flushHeaders();
      response.pipe(outgoing);
      response.on("error", () => outgoing.destroy());
    });
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(tlsPort, "127.0.0.1", done);
  });
  return server;
}

function launches(db: DatabaseSync): ExpectedLaunch[] {
  return db.prepare(`SELECT l.correlation_token,l.session_reference,j.attempt_id,j.run_id
    FROM launches l JOIN jobs j ON j.id=l.job_id ORDER BY l.rowid`).all().map((row) => ({
    correlationToken: z.uuid().parse(row.correlation_token),
    attemptId: z.uuid().parse(row.attempt_id), runId: z.uuid().parse(row.run_id),
    sessionId: row.session_reference ? z.object({ sessionId: z.uuid() }).parse(
      JSON.parse(z.string().parse(row.session_reference)),
    ).sessionId : undefined,
  }));
}

async function main() {
  const argument = process.argv.slice(2).join(" ");
  if (!["--confirm-paid", "--offline-preflight"].includes(argument)) throw new Error("explicit_mode_required");
  const offline = argument === "--offline-preflight";
  process.umask(0o077);
  if (!offline) nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  else dataDir = resolve("data/ui-preflight");
  const config = readConfig(offline ? {
    BROWSERBASE_API_KEY: "offline-preflight-not-a-real-credential",
    BROWSERBASE_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
  } : process.env);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const lockPath = join(dataDir, "integration.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const invocation = randomUUID();
  const privateDir = join(dataDir, invocation);
  const children: ChildProcess[] = [];
  let proxy: Server | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let repository: WorkerRepository | undefined;
  let db: DatabaseSync | undefined;
  let owner = "";
  let runId = "";
  let uiAccepted = false;
  let projectId = config.BROWSERBASE_PROJECT_ID;
  let beforeReserved = 0;
  let previous: ExpectedLaunch[] = [];
  const diagnostics: unknown[] = [];
  const viewerDiagnostics: unknown[] = [];
  const viewers = new Map<string, ViewerProof>();
  const secrets = [config.BROWSERBASE_API_KEY];
  const diagnosticText = (text: string) => safeErrorMessage(new Error(text), secrets);
  const savedViewers = () => [...viewers.values()].map(({ authenticatedUrl, iframeUrl, ...proof }) => ({
    ...proof, authenticatedUrlHash: createHash("sha256").update(authenticatedUrl).digest("hex"),
    iframeUrlHash: createHash("sha256").update(iframeUrl).digest("hex"),
  }));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const save = async (name: string, value: unknown) =>
    writeFile(join(privateDir, `${name}.json`), JSON.stringify(value, null, 2), { mode: 0o600 });
  const screenshot = async (name: string) => {
    const buffer = await page!.screenshot({ fullPage: true, timeout: 15000 });
    await writeFile(join(privateDir, `${name}.png`), buffer, { mode: 0o600 });
  };
  const wait = async (condition: () => Promise<boolean> | boolean, milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      if (children.some((child) => child.exitCode !== null || child.signalCode !== null)) throw new Error("owned_process_exited");
      if (await condition()) return;
      await delay(300, undefined, { signal: controller.signal });
    }
    throw new Error("bounded_ui_wait_expired");
  };
  const recover = async (expected: ExpectedLaunch[]): Promise<RemoteProof[]> => {
    if (offline) throw new Error("offline_cloud_recovery_forbidden");
    const cloud = createCloudRecovery({ ...config, BROWSERBASE_PROJECT_ID: projectId });
    const proof: RemoteProof[] = [];
    for (const launch of expected) {
      try {
        proof.push({ correlationToken: launch.correlationToken, result: await cloud.recover(launch) });
      } catch {
        proof.push({ correlationToken: launch.correlationToken, result: { confirmed: false, sessions: [] } });
      }
    }
    return proof;
  };
  try {
    await mkdir(privateDir, { mode: 0o700 });
    repository = new WorkerRepository(dataDir, uiPolicy);
    db = new DatabaseSync(join(dataDir, "flash-flood.sqlite"));
    beforeReserved = repository.accounting().reservedSeconds;
    if (!canReserveUiRun(beforeReserved)) throw new Error("lifetime_600_second_reservation_unavailable");
    previous = launches(db);
    // Never let this worker consume an earlier invocation's queued jobs or unresolved leases.
    const unfinished = db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','leased')").get();
    const unsettled = db.prepare("SELECT count(*) AS n FROM launches WHERE state!='settled'").get();
    if (unfinished?.n !== 0 || unsettled?.n !== 0) throw new Error("previous_jobs_require_operator_reconciliation");
    await Promise.all([unusedPort(port), unusedPort(tlsPort)]);
    if (!offline) {
      const project = await inspectProject(config);
      projectId = project.projectId;
      if (project.concurrency < 2) throw new Error("provider_concurrency_below_two");
      if (previous.length) {
        const priorProof = await recover(previous);
        await save("previous-closure", { expected: previous, proof: priorProof });
        if (!exactCompletedClosure(previous, priorProof)) throw new Error("previous_closure_not_proven");
      }
    } else if (previous.length || beforeReserved !== 0) {
      throw new Error("offline_preflight_must_have_no_allocations");
    }
    const accessCode = randomBytes(32).toString("hex");
    secrets.push(accessCode);
    const env: NodeJS.ProcessEnv = {
      ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, FLASH_FLOOD_ACCESS_CODE: accessCode,
      DATA_DIR: dataDir, ENABLE_DEMO_RUNS: "true", BROWSERBASE_PROJECT_ID: projectId,
      BROWSERBASE_API_KEY: config.BROWSERBASE_API_KEY, NEXT_TELEMETRY_DISABLED: "1",
      MAX_CONCURRENT_SESSIONS: "3", MAX_OWNER_SESSIONS: "3", SESSION_TIMEOUT_SECONDS: "300",
      MAX_STEPS_PER_PERSONA: "12", MAX_MODEL_CALLS_PER_PERSONA: "24",
      DEVELOPMENT_BUDGET_SECONDS: "2652", OWNER_BUDGET_SECONDS: "1800",
      EXTERNAL_BASELINE_SECONDS: "852", LIFETIME_RESERVATION_LIMIT_SECONDS: "1800",
      WORKER_LEASE_MS: "30000", WORKER_RECOVERY_LIMIT: "6", FIXTURE_PORT: String(port),
    };
    const start = async (args: string[], log: string) => {
      if (offline && log === "worker.log") throw new Error("offline_worker_launch_forbidden");
      const file = await open(join(privateDir, log), "wx", 0o600);
      try {
        const child = spawn(process.execPath, args, { env, stdio: ["ignore", file.fd, file.fd] });
        children.push(child);
        await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", reject); });
        return child;
      } finally { await file.close(); }
    };
    await start(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], "web.log");
    await wait(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/project-board`, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        return response.ok;
      } catch { return false; }
    }, 25000);
    proxy = await startProxy();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("console", (message) => {
      if (diagnostics.length < 200 && message.type() === "error") diagnostics.push({ type: "console", text: diagnosticText(message.text()) });
    });
    page.on("pageerror", (error) => { if (diagnostics.length < 200) diagnostics.push({ type: "pageerror", text: diagnosticText(error.message) }); });
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Workspace access code", { exact: true }).fill(accessCode);
    const [sessionResponse] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${origin}/api/v1/session` && response.request().method() === "POST"),
      page.getByRole("button", { name: "Unlock workspace", exact: true }).click(),
    ]);
    if (!sessionResponse.ok()) throw new Error("workspace_unlock_failed");
    owner = z.object({ data: z.object({ ownerId: z.uuid() }) }).parse(await sessionResponse.json()).data.ownerId;
    const cookies = await context.cookies(origin);
    if (!cookies.some((cookie) => cookie.secure && cookie.httpOnly)) throw new Error("secure_owner_cookie_missing");
    await page.getByRole("button", { name: "Controlled demo", exact: true }).click();
    await page.getByRole("combobox", { name: "Controlled site" }).selectOption("project-board");
    await page.getByRole("combobox", { name: "Starting path", exact: true }).selectOption("/project-board/projects");
    for (let step = 0; step < 3; step++) await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Garden organizer");
    await page.getByRole("textbox", { name: "Character" }).fill(
      "A careful volunteer creating a synthetic community garden planning project, checking its name and Design category after saving.",
    );
    const [personaResponse] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${origin}/api/v1/personas` && response.request().method() === "POST"),
      page.getByRole("button", { name: "Save persona", exact: true }).click(),
    ]);
    if (!personaResponse.ok()) throw new Error("custom_persona_save_failed");
    const customId = z.object({ data: z.object({ id: z.uuid() }) }).parse(await personaResponse.json()).data.id;
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("region", { name: "Review setup", exact: true }).waitFor();
    await page.getByRole("button", { name: "Launch 2 personas", exact: true }).waitFor();
    await screenshot("launch-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot("launch-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const [launchResponse] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${origin}/api/v1/controlled-runs` && response.request().method() === "POST"),
      page.getByRole("button", { name: "Launch 2 personas", exact: true }).click(),
    ]);
    if (!launchResponse.ok()) throw new Error("ui_launch_failed_no_retry");
    runId = z.object({ data: z.object({ id: z.uuid() }) }).parse(await launchResponse.json()).data.id;
    const submitted = controlledRunSchema.parse(launchResponse.request().postDataJSON());
    if (submitted.assignments.length !== 2 || submitted.controlledSiteId !== "project-board" ||
      !submitted.assignments.some((item) => item.personaId === "careful-first-timer") ||
      !submitted.assignments.some((item) => item.personaId === customId) ||
      submitted.assignments.some((item) => !item.criteria.some((criterion) =>
        typeof criterion !== "string" && criterion.kind === "visible_text" && criterion.text === "Garden planning"))) {
      throw new Error("launch_form_payload_mismatch");
    }
    await page.waitForURL(`${origin}/runs/${runId}`);
    await page.getByRole("heading", { name: /The live wall/ }).waitFor();
    await save("launch", { runId, owner, submitted, beforeReserved, policy: uiPolicy });
    const attempts = repository.attempts(owner, runId);
    if (attempts.length !== 2) throw new Error("persisted_persona_count_mismatch");
    if (offline) {
      if (attempts.some((attempt) => attempt.status !== "queued")) throw new Error("offline_attempt_not_queued");
      const sessions = await context.request.get(`${origin}/api/v1/runs/${runId}/sessions`);
      if (!sessions.ok() || sessionsResponseSchema.parse((await sessions.json()).data).items.length ||
        await page.locator("iframe").count()) throw new Error("offline_session_metadata_must_be_empty");
      await screenshot("wall-queued-desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot("wall-queued-mobile");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "Cancel run", exact: true }).click();
      await wait(() => repository!.getRun(owner, runId).status === "cancelled", 10000);
      await wait(async () => await page!.getByRole("button", { name: "Cancel run", exact: true }).isDisabled(), 10000);
      await screenshot("wall-cancelled-desktop");
      uiAccepted = repository.attempts(owner, runId).every((attempt) => attempt.status === "cancelled") &&
        repository.accounting().reservedSeconds === 0 && launches(db).length === 0 &&
        children.length === 1;
      await save("offline-admission", { attempts, submitted, uiAccepted, noWorkerStarted: children.length === 1 });
      return;
    }
    await start(["--conditions=react-server", "--import", "tsx", "scripts/worker.ts", "--confirm-paid"], "worker.log");
    let liveConnection = false;
    let overlap = false;
    let maxViewers = 0;
    await wait(async () => {
      liveConnection ||= await page!.getByRole("status").filter({ hasText: "Live event connection" }).count() > 0;
      const response = await context.request.get(`${origin}/api/v1/runs/${runId}/sessions`, { timeout: 10000 });
      if (!response.ok()) throw new Error("authenticated_sessions_failed");
      const sessions = sessionsResponseSchema.parse((await response.json()).data).items;
      overlap ||= sessions.filter((session) => session.available).length === 2;
      for (const attempt of attempts) {
        const session = sessions.find((item) => item.attemptId === attempt.id && item.available && item.liveViewUrl);
        if (!session || viewers.has(attempt.id)) continue;
        const card = page!.locator(`article[aria-labelledby="attempt-${attempt.id}"]`);
        const show = card.getByRole("button", { name: `Show viewer for ${attempt.persona.name}`, exact: true });
        if (await show.isEnabled().catch(() => false)) await show.click();
        const iframe = card.locator("iframe");
        if (!await iframe.count()) continue;
        await iframe.scrollIntoViewIfNeeded();
        const src = await iframe.getAttribute("src");
        const authenticatedUrl = authenticatedReadonlyViewer(attempt.id, session,
          repository!.sessionViews(owner, runId).find((item) => item.attemptId === attempt.id), src);
        if (!authenticatedUrl) {
          throw new Error("viewer_not_authenticated_repository_reference");
        }
        const element = await iframe.elementHandle();
        const root = await element?.contentFrame();
        if (!root) continue;
        const descendants = (frame: Frame): Frame[] => [frame, ...frame.childFrames().flatMap(descendants)];
        const samples: VisualSample[] = [];
        let documentReady = false;
        for (const frame of descendants(root)) {
          try {
            const probe = await probeFrame(frame);
            documentReady ||= probe.ready && probe.samples.length > 0;
            if (probe.ready) samples.push(...probe.samples);
            viewerDiagnostics.push({
              attemptId: attempt.id, ready: probe.ready, samples: probe.samples, text: diagnosticText(probe.text),
              dom: probe.dom.map((element) => ({ ...element, text: diagnosticText(element.text) })),
            });
            if (viewerDiagnostics.length > 120) viewerDiagnostics.shift();
          } catch { /* Viewer navigation may destroy an execution context; never fake readiness. */ }
        }
        const proof: ViewerProof = {
          attemptId: attempt.id, authenticatedUrl, iframeUrl: src!,
          documentReady, samples, screenshotBytes: 0,
        };
        if (renderedViewer({ ...proof, screenshotBytes: 1024 })) {
          try {
            const image = await iframe.screenshot({ timeout: 5000 });
            proof.screenshotBytes = image.length;
            await writeFile(join(privateDir, `viewer-${attempt.id}.png`), image, { mode: 0o600 });
            if (renderedViewer(proof)) viewers.set(attempt.id, proof);
          } catch { /* If the session ends before capture, visual acceptance must fail. */ }
        }
      }
      maxViewers = Math.max(maxViewers, await page!.locator("iframe").count());
      if (maxViewers > 3) throw new Error("viewer_cap_exceeded");
      if (viewers.size === 2 && !await page!.getByRole("button", { name: "Cancel run", exact: true }).isDisabled()) {
        await screenshot("wall-live-desktop");
        await page!.setViewportSize({ width: 390, height: 844 });
        await screenshot("wall-live-mobile");
        await page!.setViewportSize({ width: 1440, height: 1000 });
        return true;
      }
      if (!["queued", "running"].includes(repository!.getRun(owner, runId).status)) return true;
      return false;
    }, 310000);
    await save("viewers", { viewers: savedViewers(), diagnostics: viewerDiagnostics, liveConnection, overlap, maxViewers });
    await wait(() => !["queued", "running"].includes(repository!.getRun(owner, runId).status), 90000);
    const summaries = repository.attemptSummaries(owner, runId);
    const events: RunEvent[] = [];
    let cursor = 0;
    for (;;) {
      const batch = repository.events(owner, runId, { after: cursor, limit: 100 });
      events.push(...batch.items);
      if (batch.nextCursor === null) break;
      cursor = batch.nextCursor;
    }
    const steps: PersistedStep[] = db.prepare(`SELECT s.* FROM attempt_steps s JOIN attempts a ON a.id=s.attempt_id
      WHERE a.run_id=? ORDER BY a.rowid,s.ordinal`).all(runId).map((row) => ({
      attemptId: z.uuid().parse(row.attempt_id), ordinal: z.number().parse(row.ordinal),
      kind: z.string().parse(row.kind), evidenceId: z.uuid().parse(row.evidence_id),
    }));
    const journeys = [];
    for (const attempt of attempts) {
      const observations = [];
      const rows = db.prepare(`SELECT e.storage_key FROM attempt_steps s JOIN evidence e ON e.id=s.evidence_id
        WHERE s.attempt_id=? AND s.kind='observation' ORDER BY s.ordinal`).all(attempt.id);
      for (const row of rows) {
        const key = z.string().regex(/^[a-f0-9]{64}$/).parse(row.storage_key);
        observations.push(z.object({ observation: z.object({ textBlocks: z.array(z.string()) }) }).parse(
          JSON.parse(await readFile(join(dataDir, "execution", runId, attempt.id, key), "utf8")),
        ).observation);
      }
      journeys.push({ attemptId: attempt.id, passed: boardJourneyProof(observations), observations });
    }
    await save("board-journeys", journeys);
    if (!journeys.every((journey) => journey.passed)) throw new Error("independent_board_ground_truth_failed");
    await page.getByRole("button", { name: "Refresh persisted data", exact: true }).click();
    const readWall = () => page!.locator("[data-event-sequence]").evaluateAll((elements) => elements.map((element) => ({
      sequence: Number(element.getAttribute("data-event-sequence")), text: (element as HTMLElement).innerText,
      timestamp: element.querySelector("time")?.getAttribute("datetime") ?? null,
    })));
    await wait(async () => exactWallProof(summaries, events, steps, await readWall()), 20000);
    for (const item of summaries) {
      const card = page.locator(`article[aria-labelledby="attempt-${item.attemptId}"]`);
      await wait(async () => {
        const counters = await card.locator(".wall-counters").textContent({ timeout: 1000 }).catch(() => null);
        return !!counters && counters.includes(`${item.summary!.steps} / 12`) &&
          counters.includes(`${item.summary!.modelCalls} / 24`);
      }, 20000);
    }
    await wait(async () => await page!.locator("iframe").count() === 0 &&
      await page!.getByRole("button", { name: "Cancel run", exact: true }).isDisabled(), 10000);
    await screenshot("wall-terminal-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot("wall-terminal-mobile");
    const status = repository.getRun(owner, runId).status;
    uiAccepted = status === "succeeded" && viewers.size === 2 && [...viewers.values()].every(renderedViewer) &&
      overlap && liveConnection && maxViewers === 2 && repository.accounting().reservedSeconds === beforeReserved + 600;
    await save("durable-results", { status, summaries, events, steps, wall: await readWall(), diagnostics, uiAccepted });
  } catch (error) {
    await save("failure", { message: diagnosticText(error instanceof Error ? error.message : "unknown"), runId }).catch(() => {});
    if (owner && page) await screenshot("failure-private").catch(() => {});
  } finally {
    await save("browser-diagnostics", { diagnostics, viewerDiagnostics, viewers: savedViewers() }).catch(() => {});
    // Recover a committed launch even if navigation or the POST response was lost.
    try {
      if (repository && owner) {
        for (const run of repository.listRuns(owner, { after: 0, limit: 100 }).items) repository.cancelRun(owner, run.id);
      }
    } catch {
      uiAccepted = false;
      await save("cancel-failure", { reconciliationRequired: true }).catch(() => {});
    }
    for (const child of children.slice(1)) await stop(child).catch(() => { uiAccepted = false; });
    if (browser) await browser.close().catch(() => {});
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((done) => proxy!.close(() => done()));
    }
    if (children[0]) await stop(children[0]).catch(() => { uiAccepted = false; });
    // No allocating process remains. Inspect every launch in the persistent lifetime ledger.
    try {
      const expected = db ? launches(db) : [];
      const proof = offline ? [] : await recover(expected);
      const current = expected.filter((item) => item.runId === runId);
      const currentAttempts = repository && owner && runId ? repository.attempts(owner, runId) : [];
      const exactCurrent = current.length === 2 && currentAttempts.length === 2 &&
        currentAttempts.every((attempt) => current.some((launch) => launch.attemptId === attempt.id)) &&
        expected.length === previous.length + 2;
      const accounting = repository?.accounting();
      const status = repository && owner && runId ? repository.getRun(owner, runId).status : "not_launched";
      const summaries = repository && owner && runId ? repository.attemptSummaries(owner, runId) : [];
      const remoteAccepted = !offline && exactCompletedClosure(expected, proof);
      const passed = offline ? uiAccepted && status === "cancelled" && expected.length === 0 &&
        accounting?.reservedSeconds === 0 && summaries.length === 2 &&
        summaries.every((item) => item.launchState === "not_launched" && item.status === "cancelled") :
        uiAccepted && exactCurrent && remoteAccepted && status === "succeeded" &&
        accounting?.reservedSeconds === beforeReserved + 600 && accounting.reservedSeconds <= 1800 &&
        accounting.reservedSeconds === expected.length * 300;
      await save(offline ? "offline-proof" : "remote-proof", { expected, proof, accounting, exactCurrent, remoteAccepted, passed, baselineSeconds: 852 });
      const remote = proof.flatMap((item) => item.result.sessions);
      const actualSeconds = expected.length > 0 && remote.length === expected.length &&
        proof.every((item) => item.result.confirmed) && remote.every((item) => item.actualBrowserSeconds !== undefined)
        ? remote.reduce((sum, item) => sum + item.actualBrowserSeconds!, 0) : null;
      console.log(JSON.stringify({
        passed, mode: offline ? "offline-preflight" : "paid-proof", status, passCount: passed ? 2 : 0,
        remotelyCompleted: remote.filter((item) => item.status === "COMPLETED").length,
        actualSeconds: offline ? 0 : actualSeconds, reservedSeconds: accounting?.reservedSeconds ?? 0, baselineSeconds: 852,
        actionCount: summaries.reduce((total, item) => total + (item.summary?.steps ?? 0), 0),
        modelOperations: summaries.map((item) => item.summary?.modelOperations),
        modelMetrics: summaries.map((item) => item.usage?.modelMetrics),
      }));
      if (!passed) process.exitCode = 1;
    } finally {
      db?.close();
      repository?.close();
      await lock.close();
      await unlink(lockPath);
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}

main().catch(() => {
  console.error("ui_rehearsal_failed_inspect_private_data");
  process.exitCode = 1;
});
