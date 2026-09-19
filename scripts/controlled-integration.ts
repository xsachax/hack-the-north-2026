import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";
import { z } from "zod";
import { readConfig } from "../src/lib/config";
import { createCloudRecovery, inspectProject } from "../src/server/worker/cloud-recovery";
import { WorkerRepository } from "../src/server/worker/repository";
import { boardSemanticProof, proofObservationSchema, singleSessionProof } from "./controlled-proof";

nextEnv.loadEnvConfig(process.cwd());
const port = 4322;
const origin = "https://controlled-rehearsal.invalid";
const base = `http://127.0.0.1:${port}`;
const reservation = 300;
const cumulativeCap = 1200;
const baseline = 727;

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 65000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function main() {
  if (process.argv.slice(2).join(" ") !== "--confirm-paid") throw new Error("explicit_paid_confirmation_required");
  const config = readConfig(process.env);
  const dataDir = resolve(config.DATA_DIR, "controlled-rehearsal");
  if (!dataDir.startsWith(`${process.cwd()}${sep}`)) throw new Error("rehearsal_requires_worktree_local_data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, "integration.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const policy = {
    globalConcurrency: 1, ownerConcurrency: 1, sessionSeconds: reservation,
    maxSteps: 12, maxModelCalls: 24, baselineSeconds: baseline,
    developmentBudgetSeconds: baseline + cumulativeCap, ownerBudgetSeconds: cumulativeCap,
    lifetimeReservationLimitSeconds: cumulativeCap,
  };
  let repository: WorkerRepository | undefined;
  const children: ChildProcess[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let owner = "";
  let runId = "";
  let accepted = false;
  const save = async (value: unknown) => writeFile(
    join(dataDir, `${randomUUID()}.controlled-proof.json`),
    JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" },
  );
  try {
    repository = new WorkerRepository(dataDir, policy);
    if (repository.accounting().reservedSeconds + reservation > cumulativeCap) {
      throw new Error("cumulative_reservation_cap_reached");
    }
    const project = await inspectProject(config);
    if (project.concurrency < 1) throw new Error("provider_concurrency_unavailable");
    const accessCode = randomBytes(32).toString("hex");
    const env: NodeJS.ProcessEnv = {
      ...process.env, NODE_ENV: "production", APP_ORIGIN: origin,
      FLASH_FLOOD_ACCESS_CODE: accessCode, DATA_DIR: dataDir, ENABLE_DEMO_RUNS: "true",
      BROWSERBASE_PROJECT_ID: project.projectId, MAX_CONCURRENT_SESSIONS: "1", MAX_OWNER_SESSIONS: "1",
      SESSION_TIMEOUT_SECONDS: String(reservation), MAX_STEPS_PER_PERSONA: "12", MAX_MODEL_CALLS_PER_PERSONA: "24",
      DEVELOPMENT_BUDGET_SECONDS: String(baseline + cumulativeCap), OWNER_BUDGET_SECONDS: String(cumulativeCap),
      EXTERNAL_BASELINE_SECONDS: String(baseline), LIFETIME_RESERVATION_LIMIT_SECONDS: String(cumulativeCap),
      WORKER_LEASE_MS: "30000", WORKER_RECOVERY_LIMIT: "6", FIXTURE_PORT: String(port),
    };
    let cookie = "";
    let csrf = "";
    const api = async (path: string, body?: unknown) => {
      const response = await new Promise<{ status: number; cookie?: string; body: string }>((done, reject) => {
        const req = request(`${base}/api/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: new URL(origin).host, Origin: origin, Cookie: cookie, "Content-Type": "application/json",
            "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID(),
          },
        }, (incoming) => {
          let text = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => {
            text += chunk;
            if (text.length > 131072) req.destroy(new Error("api_response_limit"));
          });
          incoming.on("error", reject);
          incoming.on("end", () => done({
            status: incoming.statusCode ?? 500, cookie: incoming.headers["set-cookie"]?.[0], body: text,
          }));
        });
        req.on("error", reject);
        req.setTimeout(10000, () => req.destroy(new Error("api_request_timeout")));
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
      if (response.status < 200 || response.status > 299) throw new Error(`controlled_api_${response.status}`);
      if (path === "session") cookie = response.cookie!.split(";")[0];
      return z.object({ data: z.unknown() }).parse(JSON.parse(response.body)).data;
    };
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      throw new Error("fixture_port_in_use");
    } catch (error) {
      if (error instanceof Error && error.message === "fixture_port_in_use") throw error;
    }
    const server = spawn(process.execPath, [
      "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port),
    ], { env, stdio: "ignore" });
    children.push(server);
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      controller.signal.throwIfAborted();
      if (server.exitCode !== null) throw new Error("fixture_server_exited");
      try {
        const response = await fetch(`${base}/project-board`, { signal: AbortSignal.timeout(1000) });
        ready = response.ok;
        await response.body?.cancel();
      } catch { /* Bounded readiness polling before paid allocation. */ }
      if (!ready) await delay(250);
    }
    if (!ready) throw new Error("fixture_server_not_ready");
    const session = z.object({ ownerId: z.string(), csrfToken: z.string() }).parse(await api("session", { accessCode }));
    owner = session.ownerId;
    csrf = session.csrfToken;
    const persona = z.object({ id: z.string() }).parse(await api("personas", {
      name: "Methodical volunteer organizer", character: "A volunteer organizes a small community garden planning project.",
      device: "desktop", techComfort: "medium", patienceSteps: 12, readingStyle: "careful",
      quirks: ["Checks the project title and category after saving."], worries: ["Losing a project before it is visibly listed."],
    }));
    const run = z.object({ id: z.string() }).parse(await api("controlled-runs", {
      authorizationAcknowledged: true, controlledSiteId: "project-board",
      scope: { targetPath: "/project-board/projects", pathPrefixes: ["/project-board"] },
      assignments: [{
        personaId: persona.id,
        goal: "Create a synthetic project named Garden planning in the Design category. Confirm it is listed, without modifying other projects.",
        criteria: [{
          id: "named-project", kind: "visible_text", description: "The saved project name is visibly listed.",
          semantics: "current", paths: ["/project-board/projects"], text: "Garden planning", match: "contains",
        }, {
          id: "project-category", kind: "semantic", semantics: "current", paths: ["/project-board/projects"],
          description: "The projects list visibly confirms a saved project named Garden planning in the Design category.",
        }],
      }],
    }));
    runId = run.id;
    const worker = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/worker.ts", "--confirm-paid"], { env, stdio: "ignore" });
    children.push(worker);
    const deadline = Date.now() + 390000;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      if (worker.exitCode !== null) throw new Error("worker_exited");
      if (!["queued", "running"].includes(repository.getRun(owner, runId).status)) break;
      await delay(500);
    }
    const status = repository.getRun(owner, runId).status;
    const summaries = repository.attemptSummaries(owner, runId);
    const events = repository.events(owner, runId, { after: 0, limit: 100 }).items;
    await save({ phase: "durable-results", status, summaries, events, accounting: repository.accounting() });
    if (status !== "succeeded") throw new Error("controlled_objective_not_verified");
    const summary = summaries[0]?.summary;
    const semantic = summary?.checks?.find((check) => check.criterion === "project-category");
    if (!semantic?.passed || semantic.method !== "semantic" || !semantic.citations?.length ||
      !summary?.modelOperations || summary.modelOperations.evaluation < 1 ||
      summary.modelCalls !== summary.modelOperations.total ||
      summary.modelOperations.total !== summary.modelOperations.decision + summary.modelOperations.evaluation + summary.modelOperations.retry) {
      throw new Error("controlled_semantic_accounting_not_verified");
    }
    const db = new DatabaseSync(join(dataDir, "flash-flood.sqlite"));
    const observations = db.prepare(`SELECT e.attempt_id,e.storage_key FROM attempt_steps s
      JOIN evidence e ON e.id=s.evidence_id WHERE e.run_id=? AND s.kind='observation' ORDER BY s.ordinal`).all(runId);
    db.close();
    const observationSchema = z.object({ observation: proofObservationSchema });
    const observed = [];
    for (const row of observations) {
      const attemptId = z.uuid().parse(row.attempt_id);
      const key = z.string().regex(/^[a-f0-9]{64}$/).parse(row.storage_key);
      const observation = observationSchema.parse(JSON.parse(
        await readFile(join(dataDir, "execution", runId, attemptId, key), "utf8"),
      )).observation;
      observed.push(observation);
    }
    const grounding = boardSemanticProof(observed, semantic);
    await save({ phase: "semantic-grounding", ...grounding, semantic, modelOperations: summary.modelOperations });
    if (!grounding.negative || !grounding.positive) throw new Error("controlled_grounding_disagrees_with_fixture");
    accepted = true;
  } finally {
    if (repository && owner && runId) repository.cancelRun(owner, runId);
    for (const child of children.slice(1)) await stop(child);
    if (children[0]) await stop(children[0]);
    if (repository) {
      const db = new DatabaseSync(join(dataDir, "flash-flood.sqlite"));
      const rows = db.prepare(`SELECT correlation_token,session_reference FROM launches l JOIN jobs j ON j.id=l.job_id WHERE j.run_id=?`).all(runId);
      db.close();
      const recovery = createCloudRecovery(config);
      const proof = [];
      for (const row of rows) {
        try {
          const reference = row.session_reference
            ? z.object({ sessionId: z.uuid() }).parse(JSON.parse(z.string().parse(row.session_reference))) : undefined;
          const result = await recovery.recover({
            correlationToken: z.string().parse(row.correlation_token), sessionId: reference?.sessionId,
          });
          proof.push(result);
          if (!result.confirmed) process.exitCode = 1;
        } catch {
          process.exitCode = 1;
          console.error("controlled_remote_proof_failed_reconciliation_required");
        }
      }
      const statuses = owner && runId ? [repository.getRun(owner, runId).status] : [];
      const finalSummary = owner && runId ? repository.attemptSummaries(owner, runId)[0] : undefined;
      await save({ phase: "remote-proof", proof, accounting: repository.accounting(), externalBaselineSeconds: baseline });
      const reference = rows.length === 1 && rows[0].session_reference
        ? z.object({ sessionId: z.uuid() }).parse(JSON.parse(z.string().parse(rows[0].session_reference))) : undefined;
      const remoteAccepted = singleSessionProof(proof, reference?.sessionId);
      console.log(JSON.stringify({
        passed: accepted && remoteAccepted,
        statuses, remotelyClosed: proof.flatMap((item) => item.confirmed ? item.sessions : []).length,
        actualBrowserSeconds: proof.flatMap((item) => item.sessions).reduce((sum, item) => sum + (item.actualBrowserSeconds ?? reservation), 0),
        cumulativeReservedSeconds: repository.accounting().reservedSeconds,
        externalBaselineSeconds: baseline,
        modelOperations: finalSummary?.summary?.modelOperations,
        modelMetrics: finalSummary?.usage?.modelMetrics,
      }));
      if (!accepted || !remoteAccepted || statuses[0] !== "succeeded") process.exitCode = 1;
      repository.close();
    }
    await lock.close();
    await unlink(lockPath);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

main().catch(() => {
  console.error("controlled_rehearsal_failed_inspect_private_data");
  process.exitCode = 1;
});
