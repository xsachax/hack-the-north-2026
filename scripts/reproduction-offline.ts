import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Requires a production build. No provider SDK, model, or public target is used.
export async function runReproductionOffline(): Promise<void> {
  const port = Number(process.env.FF_REPRO_FIXTURE_PORT ?? "4398");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid trusted fixture port");
  const directory = resolve("data", `reproduction-offline-${randomUUID()}`);
  const config = resolve(directory, "playwright.config.mjs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { ...process.env, FF_REPRO_FIXTURE_PORT: String(port),
    BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "", NEXT_TELEMETRY_DISABLED: "1" };
  const server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"],
  });
  let serverFailure = "";
  server.stderr.on("data", (data: Buffer) => { serverFailure = (serverFailure + data.toString()).slice(-4000); });
  const exited = new Promise<void>((done) => server.once("exit", () => done()));
  try {
    let ready = false;
    for (let index = 0; index < 120; index++) {
      if (server.exitCode !== null) throw new Error(`Offline fixture server failed: ${serverFailure}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/demo/cart`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for this explicitly launched local server. */ }
      await delay(250);
    }
    if (!ready) throw new Error("Offline fixture did not become ready");
    await writeFile(config, `export default ${JSON.stringify({
      testDir: resolve("tests/e2e"), testMatch: "reproduction.spec.ts", workers: 1,
      timeout: 180_000, reporter: "list", outputDir: resolve(directory, "results"),
      use: { browserName: "chromium", serviceWorkers: "block" },
    })};`, { mode: 0o600, flag: "wx" });
    const status = await new Promise<number>((done, reject) => {
      const tests = spawn(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", "--config", config], {
        cwd: process.cwd(), env, stdio: "inherit",
      });
      tests.once("error", reject);
      tests.once("exit", (code) => done(code ?? 1));
    });
    if (status !== 0) throw new Error("Offline reproduction acceptance failed");
    console.log("Verified: actual recorded reduction, fresh browser per candidate, identical generated test fails broken and passes fixed.");
  } finally {
    if (server.exitCode === null) server.kill("SIGTERM");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runReproductionOffline();
