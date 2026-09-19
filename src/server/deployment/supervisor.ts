import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { validateDatabase } from "./database";
import { deploymentBindHost } from "./config";

export function nextServerCommand(env: NodeJS.ProcessEnv): string[] {
  return ["node_modules/next/dist/bin/next", "start", "--hostname", deploymentBindHost(env.DEPLOYMENT_BIND_HOST), "--port", "4321"];
}

export function deploymentHealthBody(probe: string, passed: boolean) {
  return {
    probe,
    probePassed: passed,
    ...(probe === "readiness" ? { operationalReady: passed } : {}),
    websiteExecutionEnabled: false,
    productReleaseReady: false,
    releaseBlockedBy: "issue8",
  };
}

export async function stopChild(
  child: ChildProcess | undefined,
  timeoutMs: number,
  options: { allowSigtermExit?: boolean } = {},
): Promise<boolean> {
  const cleanExit = (code: number | null, signal: NodeJS.Signals | null) =>
    code === 0 || (options.allowSigtermExit === true && (code === 143 || signal === "SIGTERM"));
  if (!child?.pid) return true;
  if (child.exitCode !== null || child.signalCode !== null) return cleanExit(child.exitCode, child.signalCode);
  return new Promise((resolve) => {
    let forced = false;
    const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve(!forced && cleanExit(code, signal)); });
    child.kill("SIGTERM");
  });
}

export async function fixtureHealthy(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:4321/demo/category/home", {
      signal: AbortSignal.timeout(2000), redirect: "error",
    });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

export async function supervise(env: NodeJS.ProcessEnv, paid: boolean, shutdownMs: number): Promise<number> {
  let app: ChildProcess | undefined, worker: ChildProcess | undefined;
  let started = false, stopping = false, workerReady = false, heartbeat = 0;
  let finish!: (status: number) => void;
  const finished = new Promise<number>((resolve) => { finish = resolve; });
  const alive = (child: ChildProcess | undefined) => Boolean(child?.pid && child.exitCode === null && child.signalCode === null);
  const healthy = () => !stopping && alive(app) && (!paid || (workerReady && alive(worker) && Date.now() - heartbeat < 15000));
  const server = createServer(async (request, response) => {
    let ok = false;
    if (request.url === "/startup") ok = started && !stopping;
    else if (request.url === "/liveness") ok = !stopping && (!started || healthy());
    else if (request.url === "/readiness" && started && healthy()) {
      try { validateDatabase(env.DATA_DIR!); ok = await fixtureHealthy(); } catch { ok = false; }
    }
    response.writeHead(ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(deploymentHealthBody(request.url?.slice(1) ?? "", ok)) + "\n");
  });
  const shutdown = async (status: number) => {
    if (stopping) return;
    stopping = true;
    // Keep the fixture alive until worker cancellation/remote-release cleanup finishes.
    const workerClean = await stopChild(worker, shutdownMs + 2000);
    // Next reports its handled SIGTERM as 143; the worker must still exit zero.
    const appClean = await stopChild(app, 10000, { allowSigtermExit: true });
    server.closeAllConnections();
    server.close();
    finish(workerClean && appClean ? status : 1);
  };
  const signal = () => { void shutdown(0); };
  process.once("SIGTERM", signal);
  process.once("SIGINT", signal);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(4322, "127.0.0.1", resolve);
    });
    if (stopping) throw new Error("deployment_stopping");
    const launch = (args: string[], ipc = false) => {
      const child = spawn(process.execPath, args, { env, stdio: ipc ? ["ignore", "pipe", "inherit", "ipc"] : "inherit" });
      child.once("error", () => { void shutdown(1); });
      child.once("exit", () => { if (!stopping) void shutdown(1); });
      return child;
    };
    app = launch(nextServerCommand(env));
    const deadline = Date.now() + 60000;
    while (!stopping && !await fixtureHealthy()) {
      if (Date.now() > deadline) throw new Error("deployment_app_start_timeout");
      await delay(250);
    }
    if (paid && !stopping) {
      worker = launch(["--import", "tsx", "scripts/deployment-worker.ts", "--confirm-paid"], true);
      worker.on("message", (message) => {
        if (typeof message === "object" && message !== null && "type" in message && message.type === "heartbeat") heartbeat = Date.now();
      });
      let output = "";
      worker.stdout?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        if (/(^|\n)worker_ready\r?\n/.test(output)) workerReady = true;
        process.stdout.write(chunk);
      });
      const workerDeadline = Date.now() + 45000;
      while (!stopping && (!workerReady || !heartbeat)) {
        if (Date.now() > workerDeadline) throw new Error("deployment_worker_start_timeout");
        await delay(100);
      }
    }
    if (!stopping) { started = true; console.log("deployment_ready"); }
  } catch {
    console.error("deployment_start_failed");
    void shutdown(1);
  }
  const result = await finished;
  process.off("SIGTERM", signal);
  process.off("SIGINT", signal);
  return result;
}
