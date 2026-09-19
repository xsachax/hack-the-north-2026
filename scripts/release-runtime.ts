import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:https";
import { createServer as portProbe } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser } from "playwright-core";
import { releaseSourceDigest as packageSourceDigest } from "../src/server/deployment/build";
import { assertPrivateDirectory } from "./advanced-proof";
import type { ReleaseDeployment } from "./release-integration";
import { releasePolicy, sha256 } from "./release-proof";

const origin = "https://127.0.0.1:4330";
const packagePort = 4321;
const healthPort = 4322;

export function releaseRuntimeEnvironment(input: {
  dataDir: string; accessCode: string; paid: boolean;
  provider: { apiKey: string; projectId: string; replayOrigins: string };
}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME,
    NEXT_TELEMETRY_DISABLED: "1", DEBUG: "false", NODE_OPTIONS: "--max-old-space-size=768",
    APP_ORIGIN: origin, DATA_DIR: resolve(input.dataDir), FIXTURE_PORT: String(packagePort),
    DEPLOYMENT_BIND_HOST: "127.0.0.1",
    FLASH_FLOOD_ACCESS_CODE: input.accessCode,
    ENABLE_DEMO_RUNS: String(input.paid), DEPLOYMENT_CONFIRM_PAID: String(input.paid),
    BROWSERBASE_API_KEY: input.provider.apiKey, BROWSERBASE_PROJECT_ID: input.provider.projectId,
    BROWSERBASE_REPLAY_ORIGINS: input.provider.replayOrigins,
    STAGEHAND_MODEL: "google/gemini-2.5-flash",
    MAX_CONCURRENT_SESSIONS: String(releasePolicy.globalConcurrency),
    MAX_OWNER_SESSIONS: String(releasePolicy.ownerConcurrency),
    SESSION_TIMEOUT_SECONDS: String(releasePolicy.sessionSeconds),
    MAX_STEPS_PER_PERSONA: String(releasePolicy.maxSteps),
    MAX_MODEL_CALLS_PER_PERSONA: String(releasePolicy.maxModelCalls),
    EXTERNAL_BASELINE_SECONDS: String(releasePolicy.baselineSeconds),
    DEVELOPMENT_BUDGET_SECONDS: String(releasePolicy.developmentBudgetSeconds),
    OWNER_BUDGET_SECONDS: String(releasePolicy.ownerBudgetSeconds),
    LIFETIME_RESERVATION_LIMIT_SECONDS: String(releasePolicy.lifetimeReservationLimitSeconds),
    WORKER_SHUTDOWN_MS: "60000",
  };
}

async function freePort(port: number) {
  const probe = portProbe();
  await new Promise<void>((done, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : done()));
  });
}

export async function stopReleaseProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0) throw new Error("release_packaged_process_failed");
    return;
  }
  await new Promise<void>((done, reject) => {
    let forced = false;
    const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 80000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (forced || code !== 0) reject(new Error("release_packaged_shutdown_failed"));
      else done();
    });
    child.kill("SIGTERM");
  });
}

async function waitReady(child: ChildProcess, signal: AbortSignal) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("release_packaged_start_failed");
    try {
      const response = await fetch(`http://127.0.0.1:${healthPort}/readiness`, {
        redirect: "error", signal: AbortSignal.timeout(2500),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "TimeoutError")) throw error;
    }
    await delay(200, undefined, { signal });
  }
  throw new Error("release_packaged_readiness_timeout");
}

export function packagedReleaseDeployment(packageDirectory: string, provider: {
  apiKey: string; projectId: string; replayOrigins: string;
}): ReleaseDeployment {
  const root = resolve(packageDirectory);
  return {
    async verifyPackage() {
      await assertPrivateDirectory(root);
      if (await packageSourceDigest(root) !== await packageSourceDigest()) throw new Error("release_package_source_mismatch");
      execFileSync(process.execPath, ["--import", "tsx", "-e",
        "import('./src/server/deployment/build.ts').then(m=>m.assertReleaseBuild()).catch(()=>process.exit(1))"],
      { cwd: root, stdio: "ignore", timeout: 120000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" } });
      return sha256(Buffer.concat([await readFile(join(root, ".next/deployment-release.json")),
        Buffer.from(`\0${process.versions.node}`)]));
    },
    async start(input) {
      if (JSON.stringify(input.policy) !== JSON.stringify(releasePolicy)) throw new Error("release_runtime_policy_mismatch");
      await assertPrivateDirectory(input.directory);
      for (const port of [packagePort, healthPort, 4330]) await freePort(port);
      let child: ChildProcess | undefined, browser: Browser | undefined, proxy: Server | undefined;
      let paid = false, closed = false;
      const key = join(input.directory, "release-tls-key.pem");
      const cert = join(input.directory, "release-tls-cert.pem");
      const launch = async (nextPaid: boolean, signal = input.signal) => {
        signal.throwIfAborted();
        child = spawn(process.execPath, ["--import", "tsx", "scripts/deployment-start.ts"], {
          cwd: root, stdio: "ignore",
          env: releaseRuntimeEnvironment({ ...input, paid: nextPaid, provider }),
        });
        const error = new Promise<never>((_, reject) => child!.once("error", () => reject(new Error("release_packaged_spawn_failed"))));
        await Promise.race([waitReady(child, signal), error]);
        paid = nextPaid;
      };
      const close = async () => {
        if (closed) return;
        closed = true;
        const errors: unknown[] = [];
        for (const work of [
          () => stopReleaseProcess(child),
          async () => { await browser?.close(); },
          async () => {
            if (proxy?.listening) {
              proxy.closeAllConnections();
              await new Promise<void>((done, reject) => proxy!.close((error) => error ? reject(error) : done()));
            }
          },
          async () => {
            for (const file of [key, cert]) {
              try { await unlink(file); } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
              }
            }
          },
        ]) {
          try { await work(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "release_packaged_cleanup_failed");
      };
      try {
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
          "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore", timeout: 20000 });
        await Promise.all([chmod(key, 0o600), chmod(cert, 0o600)]);
        proxy = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
          if (incoming.headers.host !== new URL(origin).host) { outgoing.writeHead(421); outgoing.end(); return; }
          const upstream = request({
            hostname: "127.0.0.1", port: packagePort, path: incoming.url, method: incoming.method,
            headers: { ...incoming.headers, "x-forwarded-proto": "https", "x-forwarded-host": new URL(origin).host },
          }, (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
            response.on("error", () => outgoing.destroy());
          });
          upstream.setTimeout(65000, () => upstream.destroy());
          upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
          incoming.on("aborted", () => upstream.destroy());
          outgoing.on("close", () => upstream.destroy());
          incoming.pipe(upstream);
        });
        await new Promise<void>((done, reject) => {
          proxy!.once("error", reject);
          proxy!.listen(4330, "127.0.0.1", done);
        });
        await launch(false);
        browser = await chromium.launch({ headless: true });
        return {
          browser, origin, close,
          async startWorker() {
            if (input.offline || closed || paid) throw new Error("release_worker_start_forbidden");
            await stopReleaseProcess(child);
            await launch(true);
          },
          async stopWorker() {
            if (closed || !paid) return;
            await stopReleaseProcess(child);
            // Cleanup readback keeps the same owner/API available after cancellation.
            await launch(false, new AbortController().signal);
          },
        };
      } catch (error) {
        try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "release_packaged_start_cleanup_failed"); }
        throw error;
      }
    },
  };
}

export async function assertPackagePath(path: string): Promise<string> {
  const root = resolve(path);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || root === process.cwd()) throw new Error("release_clean_package_required");
  await assertPrivateDirectory(root);
  return root;
}
