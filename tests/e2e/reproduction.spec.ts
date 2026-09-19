import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, chromium } from "@playwright/test";
import { reproductionMigration, ReproductionService } from "../../src/server/workflows/reproduction";
import { createOfflineReproductionRunner, prepareCouponFixture, runCouponWithWorkerDriver } from "../../src/server/workflows/reproduction-runner";
import { couponSteps, recordCouponSource } from "../../src/server/workflows/reproduction-test-support";
import { FixtureDriver } from "../../src/server/execution/driver";

test("actual grounded reduction and identical generated regression fail broken, pass fixed", async ({ browser }) => {
  test.setTimeout(180_000);
  const port = Number(process.env.FF_REPRO_FIXTURE_PORT ?? "4317");
  const fixture = await prepareCouponFixture(browser, port, "broken");
  const input = await recordCouponSource(fixture);
  await fixture.close();
  const db = new DatabaseSync(":memory:");
  db.exec(reproductionMigration);
  const owner = randomUUID(), runId = input.source.run.id, attemptId = input.source.attempts[0].id;
  const directory = resolve("data", `reproduction-proof-${randomUUID()}`);
  const generated = resolve("tests/e2e", `reproduction-generated-${randomUUID()}.spec.ts`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const attempts: number[] = [];
  const actualRunner = createOfflineReproductionRunner({ fixturePort: port });
  const service = new ReproductionService(db, {
    loadSource: () => input, reservationSeconds: 15,
    runner: async (candidate) => { attempts.push(candidate.steps.length); return actualRunner(candidate); },
  });

  try {
    const job = service.prepare(owner, runId, attemptId);
    expect(job.status).toBe("queued");
    while (await service.runNext()) { /* Every candidate is an independently allocated browser. */ }
    const result = service.status(owner, job.id);
    expect(result.status).toBe("found");
    expect(result.shortestSteps).toBe(4);
    expect(result.originalSteps).toBe(5);
    expect(result.candidatesAttempted).toBe(attempts.length);
    expect(db.prepare("SELECT count(DISTINCT session_hash) AS n FROM reproduction_candidates").get()?.n).toBe(attempts.length);
    expect(db.prepare("SELECT count(*) AS n FROM reproduction_candidates WHERE cleanup='confirmed'").get()?.n).toBe(attempts.length);
    expect(result.stepsCharged).toBe(attempts.reduce((sum, n) => sum + n + 3, 0));
    const source = service.export(owner, job.id);
    await writeFile(generated, source, { mode: 0o600, flag: "wx" });
    const config = resolve(directory, "playwright.config.mjs");
    await writeFile(config, `export default ${JSON.stringify({
      testDir: resolve("tests/e2e"), testMatch: generated.split("/").at(-1),
      fullyParallel: false, workers: 1, timeout: 30_000,
      outputDir: resolve(directory, "results"), reporter: "json",
      use: { browserName: "chromium", serviceWorkers: "block" },
    })};`, { mode: 0o600, flag: "wx" });
    const execute = (variant: string) => new Promise<{ code: number; output: string }>((done) => {
      execFile(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", "--config", config], {
        cwd: process.cwd(), timeout: 60_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, FF_REPRO_VARIANT: variant, FF_REPRO_FIXTURE_PORT: String(port),
          BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "", NEXT_TELEMETRY_DISABLED: "1" },
      }, (error, stdout) => done({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, output: stdout }));
    });
    const broken = await execute("broken");
    expect(broken.code).toBe(1);
    const brokenReport = JSON.parse(broken.output);
    expect(brokenReport.stats.unexpected).toBe(1);
    expect(broken.output).toContain("Recorded second-coupon signature must be absent");
    expect(await readFile(generated, "utf8")).toBe(source);
    const fixed = await execute("fixed");
    expect(fixed.code, fixed.output).toBe(0);
    expect(JSON.parse(fixed.output).stats.expected).toBe(1);
    expect(await readFile(generated, "utf8")).toBe(source);
    const fixedRunner = createOfflineReproductionRunner({ fixturePort: port, variant: "fixed" });
    const baseline = await fixedRunner({
      reproductionId: job.id, candidateId: randomUUID(),
      steps: [{ kind: "fill_coupon", coupon: "SAVE10" }, { kind: "apply_coupon" },
        { kind: "fill_coupon", coupon: "COZY5" }, { kind: "apply_coupon" }],
      signature: "second-coupon-error-and-missing-discount-v1", maxDurationMs: 15_000,
      reservationSeconds: 15, signal: AbortSignal.timeout(20_000),
    });
    expect(baseline).toMatchObject({ outcome: "not_reproduced", cleanup: "confirmed", environment: "trusted_fixture" });
  } finally {
    db.close();
    await rm(generated, { force: true });
    await rm(directory, { force: true, recursive: true });
  }
});

for (const variant of ["broken", "fixed"] as const) {
  test(`existing worker BrowserDriver seam executes without a model on ${variant}`, async () => {
    const browser = await chromium.launch();
    const port = Number(process.env.FF_REPRO_FIXTURE_PORT ?? "4317");
    try {
      const fixture = await prepareCouponFixture(browser, port, variant, { seedCart: false });
      const reference = async () => ({ key: "a".repeat(64), kind: "json" as const, bytes: 1, sha256: "a".repeat(64) });
      const driver = new FixtureDriver({
        page: fixture.page, artifacts: { screenshot: reference, json: reference, telemetry: reference },
        networkErrors: [], close: async () => {
          await fixture.close();
          await browser.close();
          return { status: "closed", errors: [] };
        },
      });
      const result = await runCouponWithWorkerDriver({
        reproductionId: randomUUID(), candidateId: randomUUID(), steps: couponSteps,
        signature: "second-coupon-error-and-missing-discount-v1", maxDurationMs: 20_000,
        reservationSeconds: 20, signal: AbortSignal.timeout(25_000),
      }, { driver, sessionIdentity: randomUUID() });
      expect(result).toMatchObject({
        outcome: variant === "broken" ? "reproduced" : "not_reproduced",
        cleanup: "confirmed", environment: "trusted_fixture",
      });
    } finally { await browser.close(); }
  });
}
