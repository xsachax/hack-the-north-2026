import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:https";
import { createServer as portProbe } from "node:net";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import nextEnv from "@next/env";
import { chromium, type APIResponse, type Browser, type Page } from "playwright-core";
import { z } from "zod";
import { readConfig } from "../src/lib/config";
import { evidenceDetailSchema, runReportSchema } from "../src/lib/report-contracts";
import { REPLAY_POLLING } from "../src/lib/replay-contracts";
import { WorkerRepository } from "../src/server/worker/repository";
import {
  assertReportOperation, canReserveReportRun, decodedReportRecording, exactReportClosure, exactReportLinks,
  exactResumeLedger, loadReportResumeState, privateDownloadHeaders, readOnlyProjectJourney, removeReportResumeState, retainReportResumeState,
  reportPolicy, REPORT_RESUME_TTL_MS, safeReportExport, saveReportResumeState, validResumeIdentity,
  type ExpectedReportLaunch, type ProjectJourneyEntry, type RecordingPlaybackProof, type ReportHarnessMode,
  type ReportLinkSource, type ReportRemoteProof, type ReportResumeState,
} from "./report-proof";

const port = 4325;
const tlsPort = 4326;
const origin = `https://127.0.0.1:${tlsPort}`;
const root = resolve("data/report-rehearsal");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function unusedPort(value: number) {
  const probe = portProbe();
  await new Promise<void>((done, reject) => {
    probe.once("error", reject);
    probe.listen(value, "127.0.0.1", () => probe.close((error) => error ? reject(error) : done()));
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 65000);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("owned_process_did_not_stop")), 70000);
    })]);
  } finally { clearTimeout(timer); clearTimeout(deadline); }
}

async function startProxy(directory: string): Promise<Server> {
  const key = join(directory, "localhost-key.pem");
  const cert = join(directory, "localhost-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore", timeout: 20000 });
  await Promise.all([chmod(key, 0o600), chmod(cert, 0o600)]);
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
    if (incoming.headers.host !== new URL(origin).host) { outgoing.writeHead(421); outgoing.end(); return; }
    const upstream = request({
      hostname: "127.0.0.1", port, method: incoming.method, path: incoming.url,
      headers: { ...incoming.headers, "x-forwarded-proto": "https", "x-forwarded-host": new URL(origin).host },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on("error", () => outgoing.destroy());
    });
    upstream.setTimeout(20000, () => upstream.destroy());
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
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

function launches(db: DatabaseSync): ExpectedReportLaunch[] {
  return db.prepare(`SELECT l.correlation_token,l.session_reference,j.attempt_id,j.run_id
    FROM launches l JOIN jobs j ON j.id=l.job_id ORDER BY l.rowid`).all().map((row) => ({
    correlationToken: z.uuid().parse(row.correlation_token), attemptId: z.uuid().parse(row.attempt_id),
    runId: z.uuid().parse(row.run_id),
    sessionId: row.session_reference ? z.object({ sessionId: z.uuid() }).parse(
      JSON.parse(z.string().parse(row.session_reference)),
    ).sessionId : undefined,
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const resume = mode === "--resume";
  if (resume ? args.length !== 2 || !z.uuid().safeParse(args[1]).success :
    args.length !== 1 || !["--offline-preflight", "--confirm-paid"].includes(mode)) throw new Error("explicit_mode_required");
  const offline = mode === "--offline-preflight";
  let readbackMode: ReportHarnessMode = resume ? "resume" : offline ? "offline" : "paid";
  process.umask(0o077);
  if (!offline) nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  if (!offline && process.env.DEBUG === "true") throw new Error("provider_debug_logging_forbidden");
  // No cloud adapter is constructed or even imported by the offline path.
  const config = readConfig(offline ? { BROWSERBASE_API_KEY: "offline-no-provider-access" } : process.env);
  execFileSync("git", ["check-ignore", "--quiet", "data/report-rehearsal/integration.lock"], { stdio: "ignore" });
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error("private_root_must_not_be_symlinked");
  if (!resume) await chmod(root, 0o700);
  const lockPath = join(root, "integration.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const invocationId = randomUUID();
  const privateDir = join(root, invocationId);
  const dataDir = offline ? join(privateDir, "offline-data") : root;
  const started = Date.now();
  const children: ChildProcess[] = [];
  let proxy: Server | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let repository: WorkerRepository | undefined;
  let db: DatabaseSync | undefined;
  let owner = "";
  let runId = "";
  let phase = "initializing";
  let accepted = false;
  let beforeReserved = 0;
  let previous: ExpectedReportLaunch[] = [];
  let resumeState: ReportResumeState | undefined;
  let resumeValidated = false;
  let offlineRestartVerified = false;
  const credentialInvocationId = resume ? args[1] : invocationId;
  let projectId = config.BROWSERBASE_PROJECT_ID;
  let usageBefore: number | null = null;
  let usageAfter: number | null = null;
  let recordingStatus = "not_requested";
  let replayReads = 0;
  let playbackVerified = false;
  let playbackProof: RecordingPlaybackProof | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const save = async (name: string, value: unknown) => writeFile(
    join(privateDir, `${name}.json`), JSON.stringify(value, null, 2), { mode: 0o600 },
  );
  const capture = async (name: string) => {
    const bytes = await page!.screenshot({ fullPage: true, timeout: 15000 });
    await writeFile(join(privateDir, `${name}.png`), bytes, { mode: 0o600 });
  };
  const wait = async (condition: () => Promise<boolean> | boolean, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      if (children.some((child) => child.exitCode !== null || child.signalCode !== null)) throw new Error("owned_process_exited");
      if (await condition()) return;
      await delay(300, undefined, { signal: controller.signal });
    }
    throw new Error("bounded_wait_expired");
  };
  const recover = async (expected: ExpectedReportLaunch[]): Promise<ReportRemoteProof[]> => {
    if (offline) throw new Error("offline_recovery_forbidden");
    const { createCloudRecovery } = await import("../src/server/worker/cloud-recovery");
    const recovery = createCloudRecovery({ ...config, BROWSERBASE_PROJECT_ID: projectId });
    const proof: ReportRemoteProof[] = [];
    for (const launch of expected) {
      let result: ReportRemoteProof["result"] = { confirmed: false, sessions: [] };
      for (let read = 0; read < 3; read++) {
        try { result = await recovery.recover(launch); } catch { result = { confirmed: false, sessions: [] }; }
        if (exactReportClosure([launch], [{ correlationToken: launch.correlationToken, result }])) break;
        if (read < 2) await delay(1000 * (read + 1));
      }
      proof.push({ correlationToken: launch.correlationToken, result });
    }
    return proof;
  };
  try {
    await mkdir(privateDir, { mode: 0o700 });
    await save("invocation", {
      mode: resume ? "resume" : offline ? "offline-preflight" : "paid-proof",
      resumedInvocation: resume ? credentialInvocationId : null,
      policy: reportPolicy, startedAt: new Date().toISOString(),
    });
    if (resume) {
      resumeState = await loadReportResumeState(root, credentialInvocationId, "paid");
      const database = await lstat(join(root, "flash-flood.sqlite"));
      if (!database.isFile() || database.isSymbolicLink()) throw new Error("resume_requires_existing_database");
    }
    repository = new WorkerRepository(dataDir, reportPolicy);
    db = new DatabaseSync(join(dataDir, "flash-flood.sqlite"));
    beforeReserved = repository.accounting().reservedSeconds;
    previous = launches(db);
    await save("ledger-before", { expected: previous, accounting: repository.accounting() });
    if (resumeState) {
      const session = repository.session(resumeState.ownerCookie);
      const row = db.prepare("SELECT id,owner_id FROM runs WHERE id=?").get(resumeState.runId);
      const ownLaunches = previous.filter((item) => item.runId === resumeState!.runId);
      if (!row || !validResumeIdentity(resumeState, session?.ownerId, {
        id: z.string().parse(row.id), ownerId: z.string().parse(row.owner_id),
      }) || ownLaunches.length !== 1 || !ownLaunches[0].sessionId ||
        beforeReserved !== resumeState.reservedBeforeRun + 300 ||
        beforeReserved !== previous.length * 300 ||
        repository.getRun(resumeState.ownerId, resumeState.runId).status !== "succeeded") {
        await removeReportResumeState(root, credentialInvocationId);
        throw new Error("resume_identity_or_ledger_mismatch");
      }
      owner = resumeState.ownerId;
      runId = resumeState.runId;
    }
    if (!offline && !resume && !canReserveReportRun(beforeReserved)) throw new Error("nonrefundable_lifetime_ceiling_reached");
    if (db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','leased')").get()?.n !== 0 ||
      db.prepare("SELECT count(*) AS n FROM launches WHERE state!='settled'").get()?.n !== 0) {
      throw new Error("prior_jobs_need_operator_reconciliation");
    }
    if (resume) resumeValidated = true;
    await Promise.all([unusedPort(port), unusedPort(tlsPort)]);
    if (!offline) {
      phase = "paid-project-inspection";
      const { inspectProject } = await import("../src/server/worker/cloud-recovery");
      const project = await inspectProject(config);
      projectId = project.projectId;
      usageBefore = project.browserMinutes;
      if (!resume && project.concurrency < reportPolicy.globalConcurrency) throw new Error("provider_concurrency_below_two");
      if (previous.length) {
        const proof = await recover(previous);
        await save("previous-closure", { expected: previous, proof });
        if (!exactReportClosure(previous, proof)) throw new Error("prior_exact_closure_not_proven");
      }
    }
    phase = "owner-bootstrap";
    const accessCode = randomBytes(32).toString("hex");
    const env: NodeJS.ProcessEnv = {
      ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, DATA_DIR: dataDir,
      FLASH_FLOOD_ACCESS_CODE: accessCode, ENABLE_DEMO_RUNS: "true", DEBUG: "false",
      BROWSERBASE_API_KEY: config.BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID: projectId,
      NEXT_TELEMETRY_DISABLED: "1", MAX_CONCURRENT_SESSIONS: "2", MAX_OWNER_SESSIONS: "2",
      SESSION_TIMEOUT_SECONDS: "300", MAX_STEPS_PER_PERSONA: "12", MAX_MODEL_CALLS_PER_PERSONA: "24",
      DEVELOPMENT_BUDGET_SECONDS: "2144", OWNER_BUDGET_SECONDS: "1200", EXTERNAL_BASELINE_SECONDS: "944",
      LIFETIME_RESERVATION_LIMIT_SECONDS: "1200", WORKER_LEASE_MS: "30000", WORKER_RECOVERY_LIMIT: "6",
      FIXTURE_PORT: String(port),
    };
    const start = async (args: string[], name: string) => {
      if (name === "worker") assertReportOperation(readbackMode, "worker");
      // Secrets/cookies must not be captured through framework or SDK debug logs.
      const child = spawn(process.execPath, args, { env, stdio: "ignore" });
      children.push(child);
      await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", reject); });
      await save(`${name}-process`, { pid: child.pid, ownedByInvocation: true });
    };
    const startWeb = async (name: string) => {
      await start(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], name);
      await wait(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/project-board`, { signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
          return response.ok;
        } catch { return false; }
      }, 25000);
      proxy = await startProxy(privateDir);
    };
    await startWeb("web");
    browser = await chromium.launch({ headless: true });
    let context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const sessionSchema = z.object({ data: z.object({ ownerId: z.uuid(), csrfToken: z.string() }) });
    const authenticateSavedOwner = async (state: ReportResumeState) => {
      if (Date.now() >= state.expiresAt || repository!.session(state.ownerCookie)?.ownerId !== state.ownerId) {
        await removeReportResumeState(root, state.invocationId);
        throw new Error("resume_owner_expired_or_invalid");
      }
      await context.addCookies([{
        name: "__Host-ff_owner", value: state.ownerCookie, url: origin,
        secure: true, httpOnly: true, sameSite: "Strict", expires: state.expiresAt / 1000,
      }]);
      // Empty bootstrap cannot mint a replacement owner: the new local server's access gate requires its code.
      const bootstrap = await context.request.post(`${origin}/api/v1/session`, {
        data: {}, headers: { Origin: origin }, timeout: 15000, maxRedirects: 0,
      });
      if (!bootstrap.ok()) {
        await removeReportResumeState(root, state.invocationId);
        throw new Error("resume_genuine_session_rejected");
      }
      const verified = sessionSchema.parse(await bootstrap.json()).data;
      if (verified.ownerId !== state.ownerId) throw new Error("resume_bootstrap_owner_changed");
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      return verified;
    };
    let session: z.infer<typeof sessionSchema>["data"];
    if (resumeState) session = await authenticateSavedOwner(resumeState);
    else {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Workspace access code", { exact: true }).fill(accessCode);
      const [sessionResponse] = await Promise.all([
        page.waitForResponse((response) => response.url() === `${origin}/api/v1/session` && response.request().method() === "POST"),
        page.getByRole("button", { name: "Unlock workspace", exact: true }).click(),
      ]);
      if (!sessionResponse.ok()) throw new Error("owner_bootstrap_failed");
      session = sessionSchema.parse(await sessionResponse.json()).data;
    }
    owner = session.ownerId;
    const cookies = await context.cookies(origin);
    if (!cookies.some((cookie) => cookie.secure && cookie.httpOnly)) throw new Error("secure_owner_cookie_missing");
    const api = async (path: string, body?: unknown) => {
      controller.signal.throwIfAborted();
      if (body !== undefined && ["resume", "offline-resume"].includes(readbackMode) &&
        !/^runs\/[a-f0-9-]+\/attempts\/[a-f0-9-]+\/replay\/authorize$/.test(path)) {
        assertReportOperation(readbackMode, "create-run");
      }
      if (body !== undefined && path === "controlled-runs") assertReportOperation(readbackMode, "create-run");
      if (body !== undefined && path.endsWith("/cancel")) assertReportOperation(readbackMode, "cancel-run");
      const response = body === undefined
        ? await context.request.get(`${origin}/api/v1/${path}`, { timeout: 15000, maxRedirects: 0 })
        : await context.request.post(`${origin}/api/v1/${path}`, {
          data: body, timeout: 15000, maxRedirects: 0,
          headers: { Origin: origin, "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID() },
        });
      if (!response.ok()) throw new Error(`report_api_${response.status()}`);
      return z.object({ data: z.unknown() }).parse(await response.json()).data;
    };
    phase = "creating-single-assignment";
    const submitted = {
      authorizationAcknowledged: true, controlledSiteId: "project-board",
      scope: { targetPath: "/project-board", pathPrefixes: ["/project-board"] },
      assignments: [{
        personaId: "careful-first-timer",
        goal: "Open the projects list using the All projects navigation link. Do not create, edit, delete, reset, or modify any projects or settings. Stop when the projects list is open.",
        criteria: [{ id: "projects-open", kind: "url", semantics: "current",
          description: "The projects list is open without editing.", path: "/project-board/projects" }],
      }],
    };
    if (!resume) {
      assertReportOperation(readbackMode, "create-run");
      runId = z.object({ id: z.uuid() }).parse(await api("controlled-runs", submitted)).id;
      await save("launch", { runId, owner, submitted, beforeReserved });
      const ownerCookie = cookies.find((cookie) => cookie.name === "__Host-ff_owner" &&
        cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict" && cookie.path === "/")?.value;
      if (!ownerCookie) throw new Error("genuine_owner_cookie_missing");
      const createdAt = Date.now();
      resumeState = {
        version: 1, invocationId, mode: offline ? "offline-test" : "paid", ownerId: owner, runId,
        ownerCookie, createdAt, expiresAt: createdAt + REPORT_RESUME_TTL_MS, reservedBeforeRun: beforeReserved,
      };
      await saveReportResumeState(root, resumeState);
    }
    if (repository.attempts(owner, runId).length !== 1) throw new Error("assignment_count_mismatch");
    if (offline) {
      await api(`runs/${runId}/cancel`, {});
      await wait(() => repository!.getRun(owner, runId).status === "cancelled", 10000);
      const beforeRestart = launches(db);
      const originalPid = children[0].pid;
      await browser.close();
      proxy!.closeAllConnections();
      await new Promise<void>((done) => proxy!.close(() => done()));
      proxy = undefined;
      await stop(children[0]);
      children.length = 0;
      readbackMode = "offline-resume";
      resumeState = await loadReportResumeState(root, invocationId, "offline-test");
      await startWeb("web-restarted");
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      session = await authenticateSavedOwner(resumeState);
      offlineRestartVerified = session.ownerId === owner && resumeState.runId === runId &&
        originalPid !== children[0].pid && repository.getRun(owner, runId).status === "cancelled" &&
        exactResumeLedger(beforeRestart, launches(db), 0, repository.accounting().reservedSeconds);
      await save("offline-authentic-resume", { passed: offlineRestartVerified, ownerUnchanged: session.ownerId === owner,
        runUnchanged: resumeState.runId === runId, localServerRestarted: originalPid !== children[0].pid,
        noWorkerOrAllocation: launches(db).length === 0 });
      if (!offlineRestartVerified) throw new Error("offline_genuine_resume_failed");
    } else if (!resume) {
      phase = "durable-worker";
      await start(["--conditions=react-server", "--import", "tsx", "scripts/worker.ts", "--confirm-paid"], "worker");
      await wait(() => !["queued", "running"].includes(repository!.getRun(owner, runId).status), 390000);
    }
    phase = "persisted-report";
    const report = runReportSchema.parse(await api(`runs/${runId}/reports`));
    const summaries = repository.attemptSummaries(owner, runId);
    await save("report", report);
    await save("summaries", summaries);
    if (!isDeepStrictEqual(JSON.parse(z.string().parse(
      db.prepare("SELECT report FROM report_snapshots WHERE run_id=?").get(runId)?.report,
    )), report)) throw new Error("persisted_snapshot_mismatch");
    const persisted = repository.reportSource(owner, runId);
    const attempt = persisted.attempts[0];
    const source: ReportLinkSource = {
      runId, attemptId: attempt.id, events: persisted.events,
      steps: db.prepare("SELECT * FROM attempt_steps WHERE attempt_id=? ORDER BY ordinal").all(attempt.id).map((row) => ({
        ordinal: z.number().parse(row.ordinal), kind: z.string().parse(row.kind),
        evidenceId: z.uuid().parse(row.evidence_id), attemptId: z.uuid().parse(row.attempt_id),
      })),
      evidence: persisted.evidence.map((entry) => ({
        id: entry.metadata.id, runId: entry.metadata.runId, attemptId: entry.metadata.attemptId,
        kind: entry.metadata.kind, storageKey: entry.storageKey,
      })), observations: [],
    };
    const journey: ProjectJourneyEntry[] = [];
    for (const step of source.steps.filter((step) => ["observation", "action"].includes(step.kind))) {
      const evidence = source.evidence.find((item) => item.id === step.evidenceId)!;
      const stored = JSON.parse(await readFile(join(dataDir, "execution", runId, attempt.id,
        z.string().regex(/^[a-f0-9]{64}$/).parse(evidence.storageKey)), "utf8"));
      if (step.kind === "action") {
        const action = z.object({ action: z.object({ action: z.string(), candidateId: z.string().nullable() }) }).parse(stored).action;
        journey.push({ kind: "action", ...action });
        continue;
      }
      const observation = z.object({ observation: z.object({
        id: z.string(), screenshotKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        checks: z.array(z.object({ criterion: z.string(), passed: z.boolean() })),
        textBlocks: z.array(z.string()).default([]),
        candidates: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string() })),
      }) }).parse(stored).observation;
      journey.push({ kind: "observation", textBlocks: observation.textBlocks, candidates: observation.candidates });
      source.observations.push({
        evidenceId: evidence.id, observationId: observation.id, screenshotKey: observation.screenshotKey, checks: observation.checks,
      });
    }
    await save("source-associations", source);
    await save("read-only-journey", { passed: readOnlyProjectJourney(journey), entries: journey });
    const linked = !offline && exactReportLinks(report, source) && readOnlyProjectJourney(journey);
    if (!offline && !linked) throw new Error("report_source_links_not_exact");
    if (offline && (report.status !== "cancelled" || report.agents.length !== 1 ||
      report.agents[0].evidence.length || report.agents[0].criteria.some((item) => item.status === "met"))) {
      throw new Error("offline_report_implies_execution");
    }
    phase = "protected-evidence-and-exports";
    const expected = launches(db);
    const privateValues = [
      config.BROWSERBASE_API_KEY, accessCode, session.csrfToken, ...cookies.map((cookie) => cookie.value),
      ...expected.flatMap((item) => [item.correlationToken, item.sessionId ?? ""]),
      ...repository.sessionViews(owner, runId).map((item) => item.liveViewUrl ?? ""),
      ...source.evidence.map((item) => item.storageKey),
    ];
    let screenshotId: string | undefined;
    if (!offline) {
      const cited = report.agents[0].criteria[0].citations.flatMap((citation) => citation.evidenceIds);
      screenshotId = report.agents[0].evidence.find((item) => item.kind === "screenshot" && cited.includes(item.id))?.id;
      if (!screenshotId) throw new Error("cited_screenshot_missing");
      for (const id of [...new Set(cited)]) {
        const detail = evidenceDetailSchema.parse(await api(`evidence/${id}/detail`));
        if (detail.runId !== runId || detail.evidence.attemptId !== attempt.id ||
          detail.evidence.id !== id || detail.evidence.state !== "available" ||
          !safeReportExport(JSON.stringify(detail), privateValues)) throw new Error("protected_detail_mismatch");
        await save(`detail-${id}`, detail);
      }
      const response = await context.request.get(`${origin}/api/v1/evidence/${screenshotId}/content`, { timeout: 15000, maxRedirects: 0 });
      await save("screenshot-response", {
        status: response.status(), contentType: response.headers()["content-type"],
        cacheControl: response.headers()["cache-control"],
        disposition: response.headers()["content-disposition"], nosniff: response.headers()["x-content-type-options"],
      });
      if (!response.ok() || !privateDownloadHeaders(response.headers(), "image/png")) throw new Error("protected_screenshot_failed");
      const pixels = await response.body();
      const entry = source.evidence.find((item) => item.id === screenshotId)!;
      const stored = await readFile(join(dataDir, "execution", runId, attempt.id, entry.storageKey));
      if (pixels.length < 1024 || !pixels.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        hash(pixels) !== hash(stored)) throw new Error("downloaded_screenshot_not_persisted_pixels");
      await writeFile(join(privateDir, "criterion-private-screenshot.png"), pixels, { mode: 0o600 });
      await save("screenshot-proof", { evidenceId: screenshotId, bytes: pixels.length, sha256: hash(pixels), exactPersistedBytes: true });
    }
    const attachment = async (response: APIResponse) => {
      const mime = response.url().endsWith("/json") ? "application/json" : "text/markdown";
      if (!response.ok() || !privateDownloadHeaders(response.headers(), mime)) throw new Error("unsafe_export_headers");
      const text = await response.text();
      if (!safeReportExport(text, privateValues)) throw new Error("unsafe_export_content");
      return text;
    };
    const exportedJson = await attachment(await context.request.get(`${origin}/api/v1/runs/${runId}/exports/json`));
    const exportedMarkdown = await attachment(await context.request.get(`${origin}/api/v1/runs/${runId}/exports/markdown`));
    const { exportPolicy, ...exported } = JSON.parse(exportedJson);
    if (!isDeepStrictEqual(exported, report) || exportPolicy?.redacted !== true ||
      !exportedMarkdown.includes(attempt.id) || (screenshotId && !exportedMarkdown.includes(screenshotId))) {
      throw new Error("exports_do_not_match_report");
    }
    await writeFile(join(privateDir, "report-export.json"), exportedJson, { mode: 0o600 });
    await writeFile(join(privateDir, "report-export.md"), exportedMarkdown, { mode: 0o600 });
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const paths = [`runs/${runId}/reports`, `runs/${runId}/exports/json`, `runs/${runId}/exports/markdown`,
        ...(screenshotId ? [`evidence/${screenshotId}/detail`, `evidence/${screenshotId}/content`] : [])];
      for (const path of paths) {
        const response = await anonymous.request.get(`${origin}/api/v1/${path}`, { timeout: 15000 });
        if (response.status() !== 401) throw new Error("anonymous_report_access_not_denied");
      }
      const foreignSession = await anonymous.request.post(`${origin}/api/v1/session`, {
        data: { accessCode }, headers: { Origin: origin }, timeout: 15000,
      });
      if (!foreignSession.ok()) throw new Error("foreign_owner_bootstrap_failed");
      for (const path of paths) {
        const response = await anonymous.request.get(`${origin}/api/v1/${path}`, { timeout: 15000 });
        if (response.status() !== 404) throw new Error("foreign_owner_report_access_not_denied");
      }
      await save("owner-isolation", { anonymousStatus: 401, foreignOwnerStatus: 404, checkedRoutes: paths.length });
    } finally { await anonymous.close(); }
    phase = "report-ui";
    await page.goto(`${origin}/runs/${runId}/reports`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Agent reports", exact: true }).waitFor();
    const [refreshed] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${origin}/api/v1/runs/${runId}/reports`),
      page.getByRole("button", { name: "Refresh report", exact: true }).click(),
    ]);
    if (!refreshed.ok() || !isDeepStrictEqual(runReportSchema.parse((await refreshed.json()).data), report)) {
      throw new Error("ui_refresh_changed_persisted_report");
    }
    await capture("report-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("report-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (screenshotId) {
      await page.goto(`${origin}/runs/${runId}/reports?attempt=${attempt.id}&evidence=${screenshotId}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Show private screenshot", exact: true }).click();
      await wait(() => page!.getByAltText("Private, unredacted evidence screenshot").evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      ).catch(() => false), 15000);
      await capture("report-evidence-desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture("report-evidence-mobile");
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    phase = "bounded-recording-readback";
    const replayProof: unknown[] = [];
    const mediaResponses: { protectedPath: string | null; status: number; playlist: boolean; media: boolean }[] = [];
    if (!offline) {
      const association = repository.recordingSession(owner, runId, attempt.id);
      const launch = expected.find((item) => item.runId === runId && item.attemptId === attempt.id);
      if (!association || association.active || !launch?.sessionId || association.sessionId !== launch.sessionId) {
        throw new Error("recording_durable_association_mismatch");
      }
      const basePath = `/api/v1/runs/${runId}/attempts/${attempt.id}/replay`;
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.protocol === "blob:" && url.origin === origin) return;
        const contentType = response.headers()["content-type"] ?? "";
        const playlist = /mpegurl/i.test(contentType);
        const media = /^video\//i.test(contentType) || response.request().resourceType() === "media";
        if (!playlist && !media) return;
        const protectedPath = url.origin === origin && !url.search && !url.hash &&
          url.pathname.startsWith(basePath) &&
          /^\/pages\/\d{1,3}\/(?:playlist|segments\/\d{1,4})$/.test(url.pathname.slice(basePath.length))
          ? url.pathname : null;
        mediaResponses.push({ protectedPath, status: response.status(), playlist, media });
      });
      await page.getByLabel("I understand that this recording may contain sensitive information.").check();
      for (let read = 0; read < 3; read++) {
        const [response] = await Promise.all([
          page.waitForResponse((response) => response.request().method() === "GET" &&
            response.url() === `${origin}/api/v1/runs/${runId}/attempts/${attempt.id}/replay`),
          page.getByRole("button", { name: "Load private recording", exact: true }).click(),
        ]);
        if (!response.ok()) throw new Error("protected_recording_read_failed");
        const replay = z.strictObject({
          status: z.enum(["processing", "unavailable", "expired", "unsupported", "ready"]),
          format: z.literal("hls"), sensitive: z.literal(true), fallback: z.literal("operator-dashboard"),
          pages: z.array(z.strictObject({
            index: z.int().min(0).max(99), startTimeMs: z.int().nonnegative(), endTimeMs: z.int().nonnegative(),
            playlistPath: z.string().max(256),
          })).max(100),
          retryAfterSeconds: z.int().min(1).max(300).optional(),
        }).parse(z.object({ data: z.unknown() }).parse(await response.json()).data);
        if ((replay.status === "ready" && replay.pages.length === 0) ||
          new Set(replay.pages.map((item) => item.index)).size !== replay.pages.length ||
          replay.pages.some((item) => item.endTimeMs < item.startTimeMs ||
            item.playlistPath !== `/api/v1/runs/${runId}/attempts/${attempt.id}/replay/pages/${item.index}/playlist`)) {
          throw new Error("recording_metadata_association_mismatch");
        }
        replayReads++;
        if (!safeReportExport(JSON.stringify(replay), privateValues)) throw new Error("unsafe_replay_metadata");
        replayProof.push(replay);
        recordingStatus = replay.status;
        if (replay.status !== "processing") break;
        if (read < 2) await delay((REPLAY_POLLING.intervalSeconds * 1000 + 500) * 2 ** read,
          undefined, { signal: controller.signal });
      }
      await page.getByRole("region", { name: "Session recording", exact: true })
        .getByRole("status").filter({ hasText: recordingStatus }).waitFor();
      await save("recording-readback", { reads: replayReads, results: replayProof, status: recordingStatus, playbackVerified: false });
      if (recordingStatus === "ready") {
        phase = "recording-playback";
        const video = page.getByLabel("Private unredacted session recording", { exact: true });
        await video.waitFor({ state: "visible" });
        await video.scrollIntoViewIfNeeded();
        const initialTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
        // Trusted keyboard input activates native controls; never autoplay or synthesize frames.
        await video.focus();
        await video.press("Space");
        await wait(async () => {
          const sample = await video.evaluate((element) => {
            const video = element as HTMLVideoElement;
            const result = {
              currentTime: video.currentTime, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
              readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
              pixelSamples: 0, opaqueSamples: 0, distinctColors: 0,
            };
            if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return result;
            try {
              const canvas = document.createElement("canvas");
              canvas.width = 64; canvas.height = 64;
              const context = canvas.getContext("2d")!;
              context.drawImage(video, 0, 0, 64, 64);
              const pixels = context.getImageData(0, 0, 64, 64).data;
              const colors = new Set<string>();
              for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index + 3] > 240) result.opaqueSamples++;
                colors.add(`${pixels[index] >> 4},${pixels[index + 1] >> 4},${pixels[index + 2] >> 4}`);
              }
              result.pixelSamples = pixels.length / 4;
              result.distinctColors = colors.size;
            } catch { /* Cross-origin or undecodable frames cannot satisfy proof. */ }
            return result;
          });
          playbackProof = {
            ...sample, initialTime, screenshotBytes: 0,
            protectedPlaylistRead: mediaResponses.some((item) => item.protectedPath && item.playlist && item.status === 200),
            protectedMediaReads: mediaResponses.filter((item) => item.protectedPath && item.media && [200, 206].includes(item.status)).length,
            onlySameOriginMedia: mediaResponses.length > 0 && mediaResponses.every((item) => item.protectedPath !== null),
          };
          return decodedReportRecording({ ...playbackProof, screenshotBytes: 1024 });
        }, 30000);
        const image = await video.screenshot({ timeout: 10000 });
        playbackProof!.screenshotBytes = image.length;
        playbackVerified = decodedReportRecording(playbackProof!);
        await writeFile(join(privateDir, "recording-private-decoded-frame.png"), image, { mode: 0o600 });
        if (!playbackVerified) throw new Error("recording_ready_but_playback_unverified");
      }
      await capture("report-recording-desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture("report-recording-mobile");
    }
    await save("recording-readback", {
      reads: replayReads, results: replayProof, status: recordingStatus,
      playbackVerified, playbackProof, mediaResponses,
      note: offline ? "Not requested: no browser allocated." :
        "Playback requires advancing time, decoded nonblank pixels, protected same-origin media, and a private frame capture. Other states are explicit fallbacks; never allocate a replacement for a recording.",
    });
    const operations = summaries[0]?.summary?.modelOperations;
    const modelAccounting = !!operations && operations.total === summaries[0]?.summary?.modelCalls &&
      operations.total === operations.decision + operations.evaluation + operations.retry && operations.decision > 0;
    accepted = offline ? offlineRestartVerified && children.length === 1 && beforeReserved === 0 && launches(db).length === 0 :
      linked && summaries.length === 1 && summaries[0].usage?.remoteStatus === "COMPLETED" &&
      summaries[0].summary?.cleanup.status === "closed" && modelAccounting &&
      repository.accounting().reservedSeconds === beforeReserved + (resume ? 0 : 300) &&
      (!resume || exactResumeLedger(previous, launches(db), beforeReserved, repository.accounting().reservedSeconds));
    await save("pipeline-proof", { accepted, linked, modelAccounting, replayReads, recordingStatus, playbackVerified, offline, phase });
  } catch (error) {
    accepted = false;
    const code = error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message) ? error.message : "unexpected_failure";
    await save("failure", { phase, code, cancelledBySignal: controller.signal.aborted, runId, reconciliationRequired: !offline }).catch(() => {});
    await save("recording-playback", { playbackVerified, playbackProof, recordingStatus, replayReads }).catch(() => {});
    if (owner && page) await capture("failure-private").catch(() => {});
  } finally {
    try {
      if (repository && owner && !["resume", "offline-resume"].includes(readbackMode)) {
        for (const run of repository.listRuns(owner, { after: 0, limit: 100 }).items) repository.cancelRun(owner, run.id);
      }
    } catch { accepted = false; }
    for (const child of children.slice(1)) await stop(child).catch(() => { accepted = false; });
    if (browser) await browser.close().catch(() => { accepted = false; });
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((done) => proxy!.close(() => done()));
    }
    if (children[0]) await stop(children[0]).catch(() => { accepted = false; });
    try {
      const expected = db ? launches(db) : [];
      await save("expected-closure-manifest", { expected, previous, runId, accounting: repository?.accounting() });
      // The worker is stopped: the exact lifetime allocation set can no longer grow.
      const proof = offline || (resume && !resumeValidated) ? [] : await recover(expected);
      const current = expected.filter((item) => item.runId === runId);
      const accounting = repository?.accounting();
      const remoteAccepted = !offline && exactReportClosure(expected, proof);
      const unchangedResumeLedger = !resume || exactResumeLedger(previous, expected, beforeReserved, accounting?.reservedSeconds ?? -1);
      const exactCurrent = current.length === 1 && expected.length === previous.length + (resume ? 0 : 1) &&
        unchangedResumeLedger &&
        repository?.attempts(owner, runId).length === 1 &&
        repository.attempts(owner, runId)[0].id === current[0].attemptId;
      if (!offline && projectId && (!resume || resumeValidated)) {
        try {
          const { inspectProject } = await import("../src/server/worker/cloud-recovery");
          usageAfter = (await inspectProject({ ...config, BROWSERBASE_PROJECT_ID: projectId })).browserMinutes;
        } catch { /* Project usage can lag or be unavailable; it is never an invoice. */ }
      }
      const passed = offline ? accepted && expected.length === 0 && accounting?.reservedSeconds === 0 :
        accepted && exactCurrent && remoteAccepted && accounting?.reservedSeconds === beforeReserved + (resume ? 0 : 300) &&
        accounting.reservedSeconds <= 1200 && accounting.reservedSeconds === expected.length * 300;
      const remote = proof.flatMap((item) => item.result.sessions);
      const actualSeconds = remoteAccepted ? remote.reduce((sum, item) => sum + item.actualBrowserSeconds!, 0) : null;
      const retainCredential = !!resumeState &&
        retainReportResumeState(passed, offline || playbackVerified, resumeState.expiresAt);
      if (resumeState && !retainCredential) {
        await removeReportResumeState(root, credentialInvocationId);
      }
      await save("final-proof", {
        passed, mode: resume ? "resume" : offline ? "offline-preflight" : "paid-proof", expected, proof, accounting, exactCurrent,
        resumedInvocation: resume ? credentialInvocationId : null,
        credentialRetainedUntil: retainCredential ? resumeState!.expiresAt : null,
        unchangedResumeLedger, offlineRestartVerified,
        remoteAccepted, actualSeconds, externalBaselineSeconds: 944, lifetimeReservationLimitSeconds: 1200,
        projectUsage: { beforeBrowserMinutes: usageBefore, afterBrowserMinutes: usageAfter, invoiceVerified: false,
          meaning: "Project-wide usage may include unrelated sessions and lag; session elapsed seconds are not invoiced usage." },
        replayReads, recordingStatus, playbackVerified, playbackProof,
        artifactLocation: relative(process.cwd(), privateDir),
      });
      console.log(JSON.stringify({
        passed, mode: resume ? "resume" : offline ? "offline-preflight" : "paid-proof",
        remotelyCompleted: remote.filter((item) => item.status === "COMPLETED").length,
        reservedSeconds: accounting?.reservedSeconds ?? 0, actualSeconds: offline ? 0 : actualSeconds,
        externalBaselineSeconds: 944, durationSeconds: Math.round((Date.now() - started) / 1000),
        artifactLocation: relative(process.cwd(), privateDir),
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
  console.error("report_rehearsal_failed_inspect_private_data");
  process.exitCode = 1;
});
