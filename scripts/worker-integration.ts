import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import Browserbase from "@browserbasehq/sdk";
import nextEnv from "@next/env";
import { z } from "zod";
import { readConfig } from "../src/lib/config";
import { demoCriteria } from "../src/lib/demo-run";
import { personas } from "../src/lib/personas";
import { createCloudRecovery, inspectProject } from "../src/server/worker/cloud-recovery";
import { WorkerRepository } from "../src/server/worker/repository";

nextEnv.loadEnvConfig(process.cwd());
const origin = "https://worker-rehearsal.invalid";
const port = 4321;
const base = `http://127.0.0.1:${port}`;
const goal = "Find the Maple ceramic mug and apply both advertised SAVE10 and COZY5 offers in the cart. Do not add gift wrap or proceed to checkout.";

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 65000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function main() {
  const argumentsText = process.argv.slice(2).join(" ");
  if (!["--confirm-paid", "--confirm-paid --cancel-only"].includes(argumentsText)) throw new Error("explicit_paid_confirmation_required");
  const cancelOnly = argumentsText.endsWith("--cancel-only");
  const expectedCount = cancelOnly ? 1 : 3;
  const config = readConfig(process.env);
  const project = await inspectProject(config);
  if (project.concurrency < 3) throw new Error("provider_concurrency_below_rehearsal_requirement");
  const dataDir = resolve(config.DATA_DIR, "worker-rehearsal");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const policy = {
    globalConcurrency: 3, ownerConcurrency: 3, sessionSeconds: 240,
    developmentBudgetSeconds: 2163, ownerBudgetSeconds: 1800,
    lifetimeReservationLimitSeconds: 1800,
  };
  const repository = new WorkerRepository(dataDir, policy);
  if (repository.accounting().reservedSeconds + expectedCount * 240 > 1800) {
    repository.close();
    throw new Error("cumulative_live_reservation_limit");
  }
  const accessCode = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, FLASH_FLOOD_ACCESS_CODE: accessCode,
    DATA_DIR: dataDir, ENABLE_DEMO_RUNS: "true", BROWSERBASE_PROJECT_ID: project.projectId,
    MAX_CONCURRENT_SESSIONS: "3", MAX_OWNER_SESSIONS: "3", SESSION_TIMEOUT_SECONDS: "240",
    MAX_STEPS_PER_PERSONA: "14", MAX_MODEL_CALLS_PER_PERSONA: "14",
    DEVELOPMENT_BUDGET_SECONDS: "2163", OWNER_BUDGET_SECONDS: "1800",
    EXTERNAL_BASELINE_SECONDS: "363", LIFETIME_RESERVATION_LIMIT_SECONDS: "1800",
    WORKER_LEASE_MS: "30000", WORKER_RECOVERY_LIMIT: "6", FIXTURE_PORT: String(port),
  };
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const children: ChildProcess[] = [];
  const runs: { id: string; expected: string }[] = [];
  let cookie = "";
  let csrf = "";
  let owner = "";
  const save = async (value: unknown) => {
    await writeFile(join(dataDir, `${randomUUID()}.rehearsal.json`), JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  };
  const api = async (path: string, body?: unknown) => {
    const response = await new Promise<{ status: number; cookie?: string; body: string }>((resolve, reject) => {
      const request = httpRequest(`${base}/api/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Host: new URL(origin).host, Origin: origin, Cookie: cookie,
          "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID(),
        },
      }, (incoming) => {
        let text = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 131072) request.destroy(new Error("api_response_limit"));
        });
        incoming.on("error", reject);
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 500, cookie: incoming.headers["set-cookie"]?.[0], body: text }));
      });
      request.on("error", reject);
      request.setTimeout(10000, () => request.destroy(new Error("api_request_timeout")));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    if (response.status < 200 || response.status > 299) throw new Error(`rehearsal_api_${response.status}`);
    if (path === "session") cookie = response.cookie!.split(";")[0];
    return z.object({ data: z.unknown() }).parse(JSON.parse(response.body)).data;
  };
  try {
    // Refuse to reuse an unrelated listener or send it the generated access code.
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      throw new Error("fixture_port_already_in_use");
    } catch (error) {
      if (error instanceof Error && error.message === "fixture_port_already_in_use") throw error;
    }
    const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      env, stdio: "ignore",
    });
    children.push(server);
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      if (server.exitCode !== null) throw new Error("fixture_server_exited");
      try {
        const response = await fetch(`${base}/demo/category/home`, { signal: AbortSignal.timeout(1000) });
        ready = response.ok;
        await response.body?.cancel();
      } catch { /* Bounded startup polling before any browser reservation. */ }
      if (!ready) await delay(250);
    }
    if (!ready) throw new Error("fixture_server_not_ready");
    const session = z.object({ ownerId: z.string(), csrfToken: z.string() }).parse(await api("session", { accessCode }));
    owner = session.ownerId;
    csrf = session.csrfToken;
    const { id: _id, ...profile } = personas.find((p) => p.id === "bargain-hunter")!;
    void _id;
    const custom = z.object({ id: z.string() }).parse(await api("personas", { ...profile, name: "Rehearsal coupon shopper" }));
    const cases = cancelOnly ? [["fixed", "cancelled", custom.id] as const] : [
      ["fixed", "succeeded", "bargain-hunter"], ["second-coupon", "target_failed", "bargain-hunter"], ["fixed", "cancelled", custom.id],
    ] as const;
    for (const [scenario, expected, personaId] of cases) {
      const run = z.object({ id: z.string() }).parse(await api("demo-runs", {
        authorizationAcknowledged: true, scenario,
        assignments: [{ personaId, goal, criteria: [demoCriteria[0]] }],
      }));
      runs.push({ id: run.id, expected });
    }
    for (let i = 0; i < 2; i++) children.push(spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/worker.ts", "--confirm-paid"], { env, stdio: "ignore" }));
    let cancelled = false;
    const cancelRun = runs.find((run) => run.expected === "cancelled")!;
    const deadline = Date.now() + 360000;
    while (Date.now() < deadline && !controller.signal.aborted) {
      if (children.slice(1).some((child) => child.exitCode !== null)) throw new Error("worker_exited");
      const active = runs.flatMap((run) => repository.sessionViews(owner, run.id)).filter((ref) => ref.available).length;
      const cancelObserved = repository.events(owner, cancelRun.id, { after: 0, limit: 100 }).items.some((event) => event.kind === "attempt.observation");
      if (!cancelled && active >= (cancelOnly ? 1 : 2) && cancelObserved && repository.sessionViews(owner, cancelRun.id).some((ref) => ref.available)) {
        await api(`runs/${cancelRun.id}/cancel`, {});
        cancelled = true;
      }
      if (runs.every((run) => !["queued", "running"].includes(repository.getRun(owner, run.id).status))) break;
      await delay(500);
    }
    if (!cancelled) throw new Error("overlap_or_cancellation_not_observed");
    const results = runs.map((run) => ({
      expected: run.expected, status: repository.getRun(owner, run.id).status,
      summaries: repository.attemptSummaries(owner, run.id),
      events: repository.events(owner, run.id, { after: 0, limit: 100 }).items,
    }));
    await save({ phase: "durable-results", results, accounting: repository.accounting() });
    if (results.some((run) => run.status !== run.expected || !run.events.some((event) => event.kind === "attempt.observation"))) {
      throw new Error("rehearsal_outcomes_failed");
    }
  } finally {
    for (const run of runs) {
      if (owner) repository.cancelRun(owner, run.id);
    }
    for (const child of children.slice(1)) await stop(child);
    if (children[0]) await stop(children[0]);
    const db = new DatabaseSync(join(dataDir, "flash-flood.sqlite"));
    const launches = db.prepare(`SELECT l.correlation_token,l.session_reference FROM launches l
      JOIN jobs j ON j.id=l.job_id WHERE j.run_id IN (${runs.map(() => "?").join(",") || "NULL"})`).all(...runs.map((run) => run.id));
    db.close();
    const cloud = createCloudRecovery({ ...config, BROWSERBASE_PROJECT_ID: project.projectId });
    const bb = new Browserbase({ apiKey: config.BROWSERBASE_API_KEY, maxRetries: 0, timeout: 10000 });
    const proof: { sessionId: string; status: string; actualBrowserSeconds?: number; startedAt: string; endedAt?: string | null; correlationToken: string; confirmed: boolean }[] = [];
    for (const row of launches) {
      const correlationToken = z.string().parse(row.correlation_token);
      try {
        const outcome = await cloud.recover({ correlationToken });
        for (const item of outcome.sessions) {
          const remote = await bb.sessions.retrieve(item.sessionId);
          proof.push({
            ...item, startedAt: remote.startedAt, endedAt: remote.endedAt,
            correlationToken, confirmed: outcome.confirmed,
          });
        }
        if (!outcome.confirmed) process.exitCode = 1;
      } catch {
        console.error("remote_proof_failed_operator_reconciliation_required");
        process.exitCode = 1;
      }
    }
    const actualBrowserSeconds = proof.reduce((sum, session) => sum + (session.actualBrowserSeconds ?? 240), 0);
    const overlap = proof.some((a, i) => proof.some((b, j) => i !== j && a.endedAt && b.endedAt &&
      Date.parse(a.startedAt) < Date.parse(b.endedAt) && Date.parse(b.startedAt) < Date.parse(a.endedAt)));
    await save({ phase: "remote-proof", proof, overlap, accounting: repository.accounting(), providerBrowserMinutesBefore: project.browserMinutes });
    const statuses = owner ? runs.map((run) => repository.getRun(owner, run.id).status) : [];
    const passed = runs.length === expectedCount && statuses.every((status, i) => status === runs[i].expected)
      && proof.length === expectedCount && proof.every((item) => item.confirmed) && (cancelOnly || overlap);
    console.log(JSON.stringify({
      passed, mode: cancelOnly ? "cancel-only" : "parallel", statuses, remotelyClosed: proof.filter((item) => item.confirmed).length, overlap,
      actualBrowserSeconds, conservativeReservedSeconds: launches.length * 240,
      cumulativeReservedSeconds: repository.accounting().reservedSeconds, providerConcurrency: project.concurrency,
    }));
    if (!passed) process.exitCode = 1;
    repository.close();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
main().catch(() => {
  console.error("worker_rehearsal_failed_inspect_private_data");
  process.exitCode = 1;
});
