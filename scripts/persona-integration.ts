import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
import { readConfig } from "../src/lib/config";
import { fixedFixtures } from "../src/lib/demo";
import { personas } from "../src/lib/personas";
import { ArtifactWriter } from "../src/server/execution/artifacts";
import { CloudStartupError, createFixtureExecution } from "../src/server/execution/cloud";
import { COUPON_CRITERION } from "../src/server/execution/driver";
import { FIXTURE_ORIGIN } from "../src/server/execution/fixture-network";
import { executePersona } from "../src/server/execution/loop";

nextEnv.loadEnvConfig(process.cwd());

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--confirm-paid") || args.some((arg) => ![
    "--confirm-paid", "--scenario=fixed", "--scenario=second-coupon",
  ].includes(arg))) throw new Error("Explicit paid confirmation and a supported scenario are required");
  const scenarioArgs = args.filter((arg) => arg.startsWith("--scenario="));
  if (scenarioArgs.length !== 1) throw new Error("Choose exactly one fixture scenario");
  const broken = scenarioArgs[0] === "--scenario=second-coupon";
  const config = { ...readConfig(process.env), SESSION_TIMEOUT_SECONDS: 240 };
  const root = path.resolve(config.DATA_DIR, "manual-execution");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, ".lock");
  const lock = await open(lockPath, "wx", 0o600);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    // Conservative reservations never shrink, including failed starts. This
    // manual harness is not layer04's transactional global spending ledger.
    let reserved = 0;
    for (const entry of await readdir(root)) {
      if (!entry.endsWith(".reservation.json")) continue;
      const previous: unknown = JSON.parse(await readFile(path.join(root, entry), "utf8"));
      if (!previous || typeof previous !== "object" || !("reservedSeconds" in previous)
        || previous.reservedSeconds !== 240) throw new Error("Invalid manual reservation ledger");
      reserved += previous.reservedSeconds;
    }
    if (reserved + 240 > 1800) throw new Error("Manual harness lifetime reservation limit reached");
    // Fail before spending if the trusted, loopback-only fixture source is absent.
    const fixture = await fetch("http://127.0.0.1:4321/demo/category/home", { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!fixture.ok) throw new Error("Fixture source unavailable");
    const runId = randomUUID();
    const attemptId = randomUUID();
    const privateSave = (name: string, value: unknown) => writeFile(
      path.join(root, `${runId}.${name}.json`), JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" },
    );
    await privateSave("reservation", { runId, attemptId, reservedSeconds: 240, maxModelCalls: 14, startedAt: new Date().toISOString() });
    const artifacts = new ArtifactWriter({ dataDir: config.DATA_DIR, knownSecrets: [config.BROWSERBASE_API_KEY] }).createSinks(runId, attemptId);
    const evidence: string[] = [];
    let referenceVersion = 0;
    try {
      const execution = await createFixtureExecution(config, {
        mode: "controlled-fixture", runId, personaId: "bargain-hunter",
        targetUrl: `${FIXTURE_ORIGIN}/demo/category/home`, criteria: [COUPON_CRITERION],
        fixturePort: 4321, fixtures: { ...fixedFixtures, secondCoupon: broken },
        viewport: { width: 1280, height: 900 }, artifacts, signal: abort.signal,
        onSession: (reference) => privateSave(`session-${++referenceVersion}`, reference),
      });
      const result = await executePersona({
        persona: personas.find((persona) => persona.id === "bargain-hunter")!,
        goal: "Find the Maple ceramic mug and apply both advertised SAVE10 and COZY5 offers in the cart. Do not add gift wrap or proceed to checkout.",
        criteria: [COUPON_CRITERION], signal: abort.signal,
        limits: { maxSteps: 14, maxModelCalls: 14, maxDurationMs: 180000 },
      }, {
        ...execution,
        onEvent: async (event) => {
          const stored = await artifacts.json({ timestamp: new Date().toISOString(), ...event });
          evidence.push(stored.key);
        },
      });
      const expected = broken ? "target_failed" : "succeeded";
      const passed = result.status === expected && result.cleanup.status === "closed"
        && execution.usage.remoteStatus === "COMPLETED";
      await privateSave("result", { scenario: broken ? "second-coupon" : "fixed", passed, result, usage: execution.usage, evidence });
      console.log(JSON.stringify({
        passed, status: result.status, steps: result.steps, modelCalls: result.modelCalls,
        remoteStatus: execution.usage.remoteStatus, actualBrowserSeconds: execution.usage.actualBrowserSeconds,
        reservedSeconds: 240, cumulativeReservedSeconds: reserved + 240,
      }));
      if (!passed) process.exitCode = 1;
    } catch (error) {
      await privateSave("result", {
        passed: false, code: "integration_failed",
        ...(error instanceof CloudStartupError ? { cleanup: error.cleanup, usage: error.usage, phase: error.phase } : {}),
      });
      console.error("Persona integration failed; inspect private result metadata.");
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await lock.close();
    await unlink(lockPath);
  }
}

main().catch(() => {
  console.error("Persona integration setup failed. Check arguments, private ledger, and loopback fixture source.");
  process.exitCode = 1;
});
