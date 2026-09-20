import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { deploymentConfig } from "./config";
import { assertPaidDataNotRestored, backupMarker, migrateDatabase, validateDatabase } from "./database";
import { deploymentHealthBody, nextServerCommand, stopChild } from "./supervisor";
import { readWorkerPolicy } from "../worker/config";
import { migrations } from "../migrations";
import { assertReleaseBuild, releaseBuildDigest, releaseSourceDigest, writeReleaseBuildReceipt } from "./build";
import { releaseSourceFiles } from "./source";
import { isolatedValidationCompose, offlineReadinessPassed } from "./docker-validation";
import { WorkerRepository } from "../worker/repository";
import { personas } from "../../lib/personas";
import { demoCriteria } from "../../lib/demo-run";

const roots: string[] = [];
function directory() {
  mkdirSync("data/deployment-validation", { recursive: true, mode: 0o700 });
  const root = mkdtempSync(resolve("data/deployment-validation/test-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function environment(): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", APP_ORIGIN: "https://example.com", FLASH_FLOOD_ACCESS_CODE: "a".repeat(32), DATA_DIR: "/private/data" };
}

describe("deployment configuration", () => {
  it("keeps paid execution off by default and fixes literal fixture loopback port", () => {
    const config = deploymentConfig(environment());
    expect(config.paid).toBe(false);
    expect(config.env.FIXTURE_PORT).toBe("4321");
    expect(config.env.DEPLOYMENT_BIND_HOST).toBe("0.0.0.0");
    expect(config.shutdownMs).toBe(60000);
    expect(config.policy.baselineSeconds).toBe(1092);
    expect(config.policy.lifetimeReservationLimitSeconds).toBe(3600);
    expect(config.policy.sessionSeconds).toBe(120);
    expect(config.policy.maxSteps).toBe(12);
  });
  it("preserves supplied prior usage without changing historical worker defaults", () => {
    const config = deploymentConfig({ ...environment(), EXTERNAL_BASELINE_SECONDS: "1800" });
    expect(config.policy.baselineSeconds).toBe(1800);
    expect(config.env.EXTERNAL_BASELINE_SECONDS).toBe("1800");
    const historical = readWorkerPolicy({ NODE_ENV: "production" });
    expect(historical.baselineSeconds).toBe(363);
    expect(historical.lifetimeReservationLimitSeconds).toBe(324000);
  });
  it("supports loopback-only clean local deployments without changing fixture transport", () => {
    const config = deploymentConfig({ ...environment(), DEPLOYMENT_BIND_HOST: "127.0.0.1" });
    expect(config.env.DEPLOYMENT_BIND_HOST).toBe("127.0.0.1");
    expect(config.env.FIXTURE_PORT).toBe("4321");
  });
  it("requires explicit paid confirmation and private configuration for public-only startup", () => {
    const env = { ...environment(), ENABLE_PUBLIC_RUNS: "true",
      BROWSERBASE_API_KEY: "offline-unused", BROWSERBASE_PROJECT_ID: randomUUID() };
    expect(() => deploymentConfig(env)).toThrow("deployment_paid_confirmation_required");
    const config = deploymentConfig({ ...env, DEPLOYMENT_CONFIRM_PAID: "true" });
    expect(config.paid).toBe(true);
    expect(config.env.ENABLE_DEMO_RUNS).not.toBe("true");
  });
  it.each([
    { APP_ORIGIN: "http://example.com" },
    { APP_ORIGIN: "https://example.com/path" },
    { FLASH_FLOOD_ACCESS_CODE: "short" },
    { DATA_DIR: "./data" },
    { ENABLE_DEMO_RUNS: "true" },
    { DEPLOYMENT_CONFIRM_PAID: "true" },
    { ENABLE_DEMO_RUNS: "1" },
    { ENABLE_PUBLIC_RUNS: "1" },
    { FIXTURE_PORT: "3000" },
    { DEPLOYMENT_BIND_HOST: "localhost" },
    { WORKER_SHUTDOWN_MS: "120000" },
    { MAX_CONCURRENT_SESSIONS: "13" },
    { ENABLE_DEMO_RUNS: "true", DEPLOYMENT_CONFIRM_PAID: "true", BROWSERBASE_API_KEY: "not-a-real-key" },
  ])("fails closed for unsafe release input %j", (overrides) => {
    expect(() => deploymentConfig({ ...environment(), ...overrides })).toThrow();
  });
  it("requires runtime secrets and explicit project before allowing paid startup", () => {
    const path = join(directory(), "key");
    writeFileSync(path, "local-test-key\n", { mode: 0o600 });
    const config = deploymentConfig({
      ...environment(), ENABLE_DEMO_RUNS: "true", DEPLOYMENT_CONFIRM_PAID: "true",
      BROWSERBASE_API_KEY_FILE: path, BROWSERBASE_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    });
    expect(config.paid).toBe(true);
    expect(config.env.BROWSERBASE_API_KEY).toBe("local-test-key");
    expect(() => deploymentConfig({ ...config.env, BROWSERBASE_API_KEY_FILE: path })).toThrow("ambiguous_secret");
  });
});

describe("deployment migrations and persistent policy", () => {
  it("blocks restored 3480-second history after the live ledger exhausts the 3600-second lifetime cap", () => {
    const root = directory(), source = join(root, "live"), backup = join(root, "snapshot");
    const policy = readWorkerPolicy({
      NODE_ENV: "test", SESSION_TIMEOUT_SECONDS: "120", LIFETIME_RESERVATION_LIMIT_SECONDS: "3600",
    });
    function reserveAndSettle(count: number) {
      const repository = new WorkerRepository(source, policy);
      try {
        const owner = repository.createSession().ownerId;
        for (let i = 0; i < count; i++) {
          repository.createDemoRun(owner, randomUUID(), {
            authorizationAcknowledged: true, scenario: "fixed",
            assignments: [{ personaId: personas[0].id, goal: "Inspect the mug", criteria: [...demoCriteria] }],
          });
          const claim = repository.claim("offline-budget-test");
          if (!claim) throw new Error("expected_reserved_claim");
          repository.finish(claim, {
            status: "cancelled", reason: "offline", checks: [], steps: 0, modelCalls: 0, durationMs: 0,
            cleanup: { status: "closed", errors: [] }, originalTerminal: { status: "cancelled", reason: "offline" }, errors: [],
          }, { reservedSeconds: 120, elapsedSeconds: 0, remoteStatus: "COMPLETED", actualBrowserSeconds: 0 });
        }
        return repository.accounting().reservedSeconds;
      } finally { repository.close(); }
    }
    expect(reserveAndSettle(29)).toBe(3480);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/deployment-backup.ts", "--confirm-stopped", backup], {
      env: { NODE_ENV: "test", PATH: process.env.PATH, DATA_DIR: source, TSX_DISABLE_CACHE: "1" }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(reserveAndSettle(1)).toBe(3600);
    const restored = new WorkerRepository(backup, policy);
    try { expect(restored.accounting().reservedSeconds).toBe(3480); } finally { restored.close(); }
    expect(() => assertPaidDataNotRestored(backup, false)).not.toThrow();
    expect(() => assertPaidDataNotRestored(backup, true)).toThrow("restored_snapshot_paid_restart_forbidden");
  });

  it("marks actual backups as web-only and never treats a snapshot as complete spending history", () => {
    const root = directory(), source = join(root, "live"), backup = join(root, "snapshot");
    mkdirSync(source, { mode: 0o700 });
    migrateDatabase(source, readWorkerPolicy({ NODE_ENV: "production" }));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/deployment-backup.ts",
      "--confirm-stopped", backup], {
      env: { NODE_ENV: "test", PATH: process.env.PATH, DATA_DIR: source, TSX_DISABLE_CACHE: "1" }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(backup, backupMarker), "utf8"))).toMatchObject({
      snapshotReservedSeconds: 0, paidRestartAllowed: false, postSnapshotHistoryPreserved: false,
    });
    expect(statSync(join(backup, backupMarker)).mode & 0o777).toBe(0o600);
    expect(() => assertPaidDataNotRestored(source, true)).not.toThrow();
    expect(() => assertPaidDataNotRestored(backup, false)).not.toThrow();
    expect(() => assertPaidDataNotRestored(backup, true)).toThrow("restored_snapshot_paid_restart_forbidden");
    // Neither an empty/settled snapshot nor a forged assertion can clear quarantine.
    writeFileSync(join(backup, backupMarker), '{"paidRestartAllowed":true}');
    expect(() => assertPaidDataNotRestored(backup, true)).toThrow("restored_snapshot_paid_restart_forbidden");
  });
  it("initializes private WAL schema, persists data and rejects a mismatched policy", () => {
    const root = directory();
    migrateDatabase(root, readWorkerPolicy({ NODE_ENV: "production" }));
    validateDatabase(root, true);
    const db = new DatabaseSync(join(root, "flash-flood.sqlite"));
    db.exec("CREATE TABLE deployment_sentinel (value TEXT); INSERT INTO deployment_sentinel VALUES ('preserved')");
    db.close();
    migrateDatabase(root, readWorkerPolicy({ NODE_ENV: "production" }));
    expect(() => migrateDatabase(root, readWorkerPolicy({ NODE_ENV: "production", MAX_CONCURRENT_SESSIONS: "1" }))).toThrow("worker_policy_mismatch");
    const reopened = new DatabaseSync(join(root, "flash-flood.sqlite"));
    expect(reopened.prepare("SELECT value FROM deployment_sentinel").get()?.value).toBe("preserved");
    reopened.close();
    chmodSync(root, 0o755);
    expect(() => validateDatabase(root)).toThrow("permissions");
  });
  it("refuses future schema rather than resetting it on rollback", () => {
    const root = directory();
    migrateDatabase(root, readWorkerPolicy({ NODE_ENV: "production" }));
    const db = new DatabaseSync(join(root, "flash-flood.sqlite"));
    db.exec(`PRAGMA user_version=${migrations.length + 1}`);
    db.close();
    expect(() => migrateDatabase(root, readWorkerPolicy({ NODE_ENV: "production" }))).toThrow("newer");
    expect(() => validateDatabase(root)).toThrow("schema_mismatch");
    const unchanged = new DatabaseSync(join(root, "flash-flood.sqlite"));
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(migrations.length + 1);
    unchanged.close();
  });
});

describe("deployment shutdown", () => {
  it("delivers SIGTERM and waits for graceful cleanup", async () => {
    const child = spawn(process.execPath, ["-e", `
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));
      setInterval(() => {}, 1000); process.send('ready');
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise<void>((resolve) => child.once("message", () => resolve()));
    expect(await stopChild(child, 2000)).toBe(true);
    expect(child.exitCode).toBe(0);
  });
  it("bounds a stuck child's shutdown and marks forced cleanup as failure", async () => {
    const child = spawn(process.execPath, ["-e", `
      process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise<void>((resolve) => child.once("message", () => resolve()));
    expect(await stopChild(child, 50)).toBe(false);
    expect(child.signalCode).toBe("SIGKILL");
  });
  it("does not report success when the worker's own cleanup deadline fails", async () => {
    const child = spawn(process.execPath, ["-e", `
      process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000); process.send('ready');
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise<void>((resolve) => child.once("message", () => resolve()));
    expect(await stopChild(child, 2000)).toBe(false);
    expect(child.exitCode).toBe(1);
  });
  it("accepts Next's handled SIGTERM status without accepting it for worker cleanup", async () => {
    const child = spawn(process.execPath, ["-e", `
      process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000); process.send('ready');
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise<void>((resolve) => child.once("message", () => resolve()));
    expect(await stopChild(child, 2000, { allowSigtermExit: true })).toBe(true);
    expect(await stopChild(child, 2000)).toBe(false);
  });
});

describe("actual Next launch command", () => {
  it.each(["127.0.0.1", "0.0.0.0"])("passes requested bind %s to the spawned server", (host) => {
    expect(nextServerCommand({ NODE_ENV: "production", DEPLOYMENT_BIND_HOST: host })).toEqual([
      "node_modules/next/dist/bin/next", "start", "--hostname", host, "--port", "4321",
    ]);
  });
  it("rejects an invalid host at the launch boundary", () => {
    expect(() => nextServerCommand({ NODE_ENV: "production", DEPLOYMENT_BIND_HOST: "localhost" }))
      .toThrow("deployment_bind_host_invalid");
  });
});

it("runs the pinned tsx loader with no writable cache location when the image disables its cache", () => {
  const root = directory();
  const blockedTemp = join(root, "not-a-directory");
  const fixture = join(root, "fixture.ts");
  writeFileSync(blockedTemp, "cache creation must fail here");
  writeFileSync(fixture, "const value: number = 42; console.log(value);");
  expect(JSON.parse(readFileSync("node_modules/tsx/package.json", "utf8")).version).toBe("4.23.13");
  const execute = (disabled: string) => spawnSync(process.execPath, ["--import", "tsx", fixture], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, TMPDIR: blockedTemp, TMP: blockedTemp, TEMP: blockedTemp, TSX_DISABLE_CACHE: disabled },
  });
  const cached = execute("");
  expect(cached.status).not.toBe(0);
  expect(cached.stderr).toMatch(/ENOTDIR|EROFS/);
  const uncached = execute("1");
  expect(uncached.status, uncached.stderr).toBe(0);
  expect(uncached.stdout.trim()).toBe("42");
  const dockerfile = readFileSync("Dockerfile", "utf8");
  expect(dockerfile.slice(dockerfile.indexOf("AS runtime"))).toContain("TSX_DISABLE_CACHE=1");
});

describe("deployment health capability boundary", () => {
  it.each([true, false])("separates operational readiness from blocked product release (%s)", (passed) => {
    expect(deploymentHealthBody("readiness", passed)).toEqual({
      probe: "readiness", probePassed: passed, operationalReady: passed,
      websiteExecutionEnabled: false, productReleaseReady: false, releaseBlockedBy: "issue8",
    });
  });
  it("does not mistake a successful startup/liveness probe for readiness", () => {
    for (const probe of ["startup", "liveness"]) {
      expect(deploymentHealthBody(probe, true)).not.toHaveProperty("operationalReady");
      expect(deploymentHealthBody(probe, true).productReleaseReady).toBe(false);
    }
  });
});

describe("deployment local backups", () => {
  it("requires explicit quiescence, preserves private data, and rejects overwrites", () => {
    const root = directory(), source = join(root, "data"), destination = join(root, "snapshot");
    migrateDatabase(source, readWorkerPolicy({ NODE_ENV: "production" }));
    writeFileSync(join(source, "private-evidence"), "local only", { mode: 0o600 });
    const run = (confirmation: string) => spawnSync(process.execPath,
      ["--import", "tsx", "scripts/deployment-backup.ts", confirmation, destination],
      { env: { ...process.env, DATA_DIR: source }, encoding: "utf8" });
    expect(run("--no-confirmation").status).toBe(1);
    expect(run("--confirm-stopped").status).toBe(0);
    expect(readFileSync(join(destination, "private-evidence"), "utf8")).toBe("local only");
    expect(statSync(destination).mode & 0o077).toBe(0);
    validateDatabase(destination, true);
    expect(run("--confirm-stopped").status).toBe(1);
  });
  it("refuses symlinks instead of following private files outside the data directory", () => {
    const root = directory(), source = join(root, "data");
    migrateDatabase(source, readWorkerPolicy({ NODE_ENV: "production" }));
    writeFileSync(join(root, "outside"), "not included");
    symlinkSync(join(root, "outside"), join(source, "link"));
    const result = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/deployment-backup.ts", "--confirm-stopped", join(root, "snapshot")],
      { env: { ...process.env, DATA_DIR: source }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("not included");
  });
});

it("binds the release receipt to application and worker sources", async () => {
  const root = directory();
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "scripts"));
  for (const name of ["package.json", "package-lock.json", ".npmrc", "next.config.ts", "tsconfig.json"]) {
    writeFileSync(join(root, name), "{}");
  }
  writeFileSync(join(root, "src/app.ts"), "export const app = 1;");
  writeFileSync(join(root, "scripts/worker.ts"), "export const worker = 1;");
  const before = await releaseSourceDigest(root);
  writeFileSync(join(root, "scripts/worker.ts"), "export const worker = 2;");
  expect(await releaseSourceDigest(root)).not.toBe(before);
});

describe("runnable release approval", () => {
  const nativeExtension = "src/server/execution/native-policy-extension";
  const stagehand = "node_modules/@browserbasehq/stagehand";
  async function buildFixture(linked = false) {
    const root = directory();
    for (const path of ["src", "scripts", ".next/server", ".next/cache", "node_modules/example"]) {
      mkdirSync(join(root, path), { recursive: true });
    }
    for (const name of ["package.json", "package-lock.json", ".npmrc", "next.config.ts", "tsconfig.json"]) {
      writeFileSync(join(root, name), "{}");
    }
    writeFileSync(join(root, "src/app.ts"), "export const app = 1;");
    writeFileSync(join(root, "scripts/worker.ts"), "export const worker = 1;");
    writeFileSync(join(root, ".next/BUILD_ID"), "unchanged-build-id");
    writeFileSync(join(root, ".next/server/page.js"), "compiled approved page");
    writeFileSync(join(root, "node_modules/example/index.js"), "approved installed dependency");
    mkdirSync(join(root, nativeExtension), { recursive: true });
    for (const file of ["policy.js", "background.js", "manifest.json"]) {
      copyFileSync(join(nativeExtension, file), join(root, nativeExtension, file));
    }
    writeFileSync(join(root, nativeExtension, "composed.js"), "export const compose = true;");
    mkdirSync(join(root, stagehand, "dist/assets"), { recursive: true });
    for (const file of ["package.json", "LICENSE", "dist/assets/stagehand-extension.zip"]) {
      copyFileSync(join(stagehand, file), join(root, stagehand, file));
    }
    if (linked) symlinkSync(join(root, "node_modules/example"), join(root, ".next/server/external"));
    await writeReleaseBuildReceipt(await releaseSourceDigest(root), root);
    return root;
  }
  it.each(["policy.js", "background.js", "composed.js", "manifest.json"])(
    "rejects changed public native extension %s without a BUILD_ID change", async (file) => {
      const root = await buildFixture();
      const source = await releaseSourceDigest(root);
      const approved = await assertReleaseBuild(root);
      writeFileSync(join(root, nativeExtension, file), "tampered native runtime asset");
      expect(await releaseSourceDigest(root)).not.toBe(source);
      expect(readFileSync(join(root, ".next/BUILD_ID"), "utf8")).toBe("unchanged-build-id");
      await expect(assertReleaseBuild(root)).rejects.toThrow("deployment_build_mismatch");
      await writeReleaseBuildReceipt(await releaseSourceDigest(root), root);
      expect(await assertReleaseBuild(root)).not.toBe(approved);
    },
  );
  it.each(["package.json", "LICENSE", "dist/assets/stagehand-extension.zip"])(
    "binds actual pinned Stagehand %s bytes without a BUILD_ID change", async (file) => {
      const root = await buildFixture();
      expect(JSON.parse(readFileSync(join(root, stagehand, "package.json"), "utf8")).version).toBe("4.1.0");
      const source = await releaseSourceDigest(root);
      const approved = await assertReleaseBuild(root);
      const path = join(root, stagehand, file);
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("\ntampered")]));
      expect(await releaseSourceDigest(root)).toBe(source);
      expect(readFileSync(join(root, ".next/BUILD_ID"), "utf8")).toBe("unchanged-build-id");
      await expect(assertReleaseBuild(root)).rejects.toThrow("deployment_build_mismatch");
      await writeReleaseBuildReceipt(source, root);
      expect(await assertReleaseBuild(root)).not.toBe(approved);
    },
  );
  it("packages and fingerprints nested public native JS/JSON, not generated archives or dotenv files", async () => {
    const root = await buildFixture();
    mkdirSync(join(root, nativeExtension, "nested"));
    for (const file of ["nested/runtime.js", "nested/config.json", "generated.zip", ".env", ".env.json"]) {
      writeFileSync(join(root, nativeExtension, file), "fixture input");
    }
    writeFileSync(join(root, "src/unrelated.json"), "not a runtime extension asset");
    const files = await releaseSourceFiles(root);
    for (const file of ["policy.js", "background.js", "manifest.json", "nested/runtime.js", "nested/config.json"]) {
      expect(files).toContain(join(nativeExtension, file));
    }
    for (const file of ["generated.zip", ".env", ".env.json"]) {
      expect(files).not.toContain(join(nativeExtension, file));
    }
    expect(files).not.toContain("src/unrelated.json");
    await writeReleaseBuildReceipt(await releaseSourceDigest(root), root);
    const approved = await assertReleaseBuild(root);
    mkdirSync(join(root, "data/private-generated"), { recursive: true });
    writeFileSync(join(root, "data/private-generated/composed-extension.zip"), "private derived archive");
    writeFileSync(join(root, nativeExtension, "generated.zip"), "different derived archive");
    expect(await assertReleaseBuild(root)).toBe(approved);
  });
  it("rejects symlinked native runtime assets rather than reading outside source", async () => {
    const root = await buildFixture();
    symlinkSync(join(root, "node_modules/example/index.js"), join(root, nativeExtension, "linked.js"));
    await expect(releaseSourceDigest(root)).rejects.toThrow("deployment_source_symlink");
    await expect(releaseSourceFiles(root)).rejects.toThrow("deployment_source_symlink");
  });
  it("rejects compiled artifact tampering even with the same BUILD_ID", async () => {
    const root = await buildFixture();
    expect(await assertReleaseBuild(root)).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(root, ".next/server/page.js"), "different compiled page");
    expect(readFileSync(join(root, ".next/BUILD_ID"), "utf8")).toBe("unchanged-build-id");
    await expect(assertReleaseBuild(root)).rejects.toThrow("deployment_build_mismatch");
  });
  it.each([false, true])("rejects changed installed dependency bytes, linked from Next = %s", async (linked) => {
    const root = await buildFixture(linked);
    const approved = await assertReleaseBuild(root);
    writeFileSync(join(root, "node_modules/example/index.js"), "different installed dependency");
    await expect(assertReleaseBuild(root)).rejects.toThrow("deployment_build_mismatch");
    await writeReleaseBuildReceipt(await releaseSourceDigest(root), root);
    expect(await assertReleaseBuild(root)).not.toBe(approved);
  });
  it("excludes only mutable Next metadata and cache from approval", async () => {
    const root = await buildFixture();
    const approved = await assertReleaseBuild(root);
    writeFileSync(join(root, ".next/cache/runtime"), "new runtime cache");
    writeFileSync(join(root, ".next/trace"), "new trace metadata");
    expect(await assertReleaseBuild(root)).toBe(approved);
  });
  it("rejects external or cyclic dependency symlinks", async () => {
    const root = await buildFixture();
    writeFileSync(join(root, "outside"), "not an approved dependency");
    symlinkSync(join(root, "outside"), join(root, ".next/server/escape"));
    await expect(releaseBuildDigest(root)).rejects.toThrow("deployment_build_link_outside_dependencies");
    rmSync(join(root, ".next/server/escape"));
    symlinkSync(join(root, "node_modules/example"), join(root, "node_modules/example/cycle"));
    await expect(releaseBuildDigest(root)).rejects.toThrow("deployment_build_link_outside_dependencies");
  });
  it("does not accept the old source-and-BUILD_ID-only receipt", async () => {
    const root = await buildFixture();
    writeFileSync(join(root, ".next/deployment-release.json"), JSON.stringify({
      sourceDigest: await releaseSourceDigest(root), buildId: "unchanged-build-id",
    }));
    await expect(assertReleaseBuild(root)).rejects.toThrow("deployment_build_mismatch");
  });
});

it("keeps packaging context allowlisted, runtime nonroot and host-bound", () => {
  const ignore = readFileSync(".dockerignore", "utf8");
  expect(ignore.startsWith("**\n")).toBe(true);
  expect(ignore).not.toContain("!.env");
  expect(ignore).toContain("!.npmrc");
  expect(ignore).toContain("!src/server/execution/native-policy-extension/**/*.js");
  expect(ignore).toContain("!src/server/execution/native-policy-extension/**/*.json");
  expect(ignore).not.toContain("!src/**/*.json");
  expect(readFileSync("Dockerfile", "utf8")).toContain("USER 1000:1000");
  const compose = readFileSync("compose.yaml", "utf8");
  expect(compose).toContain('127.0.0.1:3000:4321');
  expect(compose).toContain("stop_grace_period: 90s");
  expect(compose).toContain("/tmp:uid=1000,gid=1000,mode=0700,size=134217728,noexec,nosuid,nodev");
  expect(readFileSync("Dockerfile", "utf8")).toContain("TMPDIR=/tmp");
});

it("exercises the actual pinned Playwright CDP scratch path before reaching a local rejection stub", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/deployment-cdp-check.ts"], {
    env: { NODE_ENV: "test", PATH: process.env.PATH, TMPDIR: directory(), TSX_DISABLE_CACHE: "1" }, encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("offline_real_playwright_cdp_scratch_pass");
});

describe("hosted offline Docker validation", () => {
  it("isolates runtime files and publishes an ephemeral loopback port without changing the build context", () => {
    const source = readFileSync("compose.yaml", "utf8");
    const result = isolatedValidationCompose(source, "/checkout", "/checkout/data/private-job");
    expect(result).toContain('context: "/checkout"');
    expect(result).toContain('127.0.0.1::4321');
    expect(result).not.toContain('127.0.0.1:3000:4321');
    expect(result).toContain('env_file: "/checkout/data/private-job/runtime.env"');
    expect(result).toContain('file: "/checkout/data/private-job/secrets/access-code"');
    expect(source).toContain("env_file: ./deploy/runtime.env");
  });
  it("fails closed when the Compose contract changes instead of using real runtime secrets", () => {
    expect(() => isolatedValidationCompose("services: {}", "/checkout", "/private")).toThrow("compose_contract_changed");
  });
  it("requires both operational readiness and the explicit blocked-product boundary", () => {
    expect(offlineReadinessPassed(JSON.stringify(deploymentHealthBody("readiness", true)))).toBe(true);
    expect(offlineReadinessPassed(JSON.stringify(deploymentHealthBody("readiness", false)))).toBe(false);
    expect(offlineReadinessPassed('{"operationalReady":true}')).toBe(false);
    expect(offlineReadinessPassed(JSON.stringify({
      ...deploymentHealthBody("readiness", true), websiteExecutionEnabled: true,
    }))).toBe(false);
  });
});
