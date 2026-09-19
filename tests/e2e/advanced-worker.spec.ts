import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { expect, test } from "@playwright/test";
import { createApi } from "../../src/server/api";
import { demoCriteria } from "../../src/lib/demo-run";
import { DEMO_STORAGE_KEY, freshDemo } from "../../src/lib/demo";
import { ArtifactWriter } from "../../src/server/execution/artifacts";
import { demoVerifier, FixtureDriver } from "../../src/server/execution/driver";
import { installFixtureNetwork, localFixtureSource } from "../../src/server/execution/fixture-network";
import type { CloudUsage } from "../../src/server/execution/cloud";
import type { Decision } from "../../src/server/execution/types";
import { WorkerRepository } from "../../src/server/worker/repository";
import { DurableWorker, type WorkerDependencies } from "../../src/server/worker/runtime";
import { reproductionViewSchema } from "../../src/lib/reproduction-contracts";
import { rerunResponseSchema, runComparisonSchema } from "../../src/lib/rerun-contracts";

test("owner API reduction executes fresh real browsers through durable worker reservations across restart", async ({}, info) => {
  test.setTimeout(120_000);
  const directory = info.outputPath("advanced-worker");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const policy = { sessionSeconds: 120, lifetimeReservationLimitSeconds: 600 };
  let repository = new WorkerRepository(directory, policy);
  const owner = repository.createSession();
  const writer = new ArtifactWriter({ dataDir: directory });
  const sessions = new Set<string>();
  let allocations = 0, closures = 0, decisions = 0;
  const diagnostics: string[] = [];
  const origin = "http://127.0.0.1:4317";
  const api = () => createApi({ repository, configuration: {
    origin, production: false, accessCode: "offline-reproduction-access-code-long", allowDemoRuns: true,
  } });
  const request = (path: string, body?: unknown) => api()(new Request(`${origin}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin, cookie: `ff_owner=${owner.token}`, "x-csrf-token": owner.csrf,
      "content-type": "application/json", "idempotency-key": randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const dependencies: WorkerDependencies = {
    diagnostic: (code) => diagnostics.push(code),
    recover: async () => ({ confirmed: false, sessions: [] }),
    artifacts: (runId, attemptId) => writer.createSinks(runId, attemptId),
    launch: async (options) => {
      expect(repository.accounting().reservedSeconds).toBe((allocations + 1) * policy.sessionSeconds);
      expect(options.contextReference).toBeUndefined();
      allocations++;
      const browser = await chromium.launch();
      const context = await browser.newContext({ serviceWorkers: "block", viewport: options.viewport });
      const page = await context.newPage();
      const network = await installFixtureNetwork(context, page, localFixtureSource(4317), () => {});
      const sessionId = randomUUID();
      sessions.add(sessionId);
      const usage: CloudUsage = { allocationAttempted: true, reservedSeconds: policy.sessionSeconds, elapsedSeconds: 1 };
      try {
        await page.goto(options.targetUrl, { waitUntil: "networkidle" });
        await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), {
          key: DEMO_STORAGE_KEY, value: JSON.stringify(freshDemo(options.fixtures)),
        });
        await page.reload({ waitUntil: "networkidle" });
        await page.getByRole("heading", { level: 1 }).waitFor();
        await options.onSession({
          sessionId, liveViewUrl: "https://www.browserbase.com/offline-live",
          replayUrl: "https://www.browserbase.com/offline-replay", timeoutSeconds: policy.sessionSeconds,
        });
        const driver = new FixtureDriver({
          page,
          verify: demoVerifier(options.criteria.filter((criterion) => typeof criterion === "string")),
          artifacts: options.artifacts, cleanupJson: options.cleanupJson,
          assertActive: options.assertActive, networkErrors: network.errors,
          close: async () => {
            await network.close();
            await browser.close();
            closures++;
            usage.remoteStatus = "COMPLETED";
            usage.actualBrowserSeconds = 1;
            return { status: "closed", errors: [] };
          },
        });
        const plan: { action: Decision["action"]; value: string | null; label?: string }[] = [
          { action: "navigate", value: "https://fixture.flash-flood.invalid/demo/product/mug" },
          { action: "click", value: null, label: "Add to cart" },
          { action: "navigate", value: "https://fixture.flash-flood.invalid/demo/cart" },
          { action: "type", value: "SAVE10", label: "Coupon code" },
          { action: "click", value: null, label: "Apply coupon" },
          { action: "type", value: "COZY5", label: "Coupon code" },
          { action: "click", value: null, label: "Apply coupon" },
        ];
        return { driver, usage, brain: {
          decide: async ({ observation }): Promise<Decision> => {
            decisions++;
            const next = plan.shift();
            if (!next) return { action: "done", value: null, candidateId: null, commentary: "" };
            const candidate = next.label ? observation.candidates.find((item) => item.label === next.label && !item.disabled) : undefined;
            if (next.label) expect(candidate, next.label).toBeDefined();
            return { action: next.action, value: next.value, candidateId: candidate?.id ?? null, commentary: "Controlled offline journey" };
          },
        } };
      } catch (error) {
        await network.close();
        await browser.close();
        throw error;
      }
    },
  };
  try {
    const run = repository.createDemoRun(owner.ownerId, randomUUID(), {
      authorizationAcknowledged: true, scenario: "second-coupon",
      assignments: [{ personaId: "careful-first-timer", goal: "Apply both coupons", criteria: [demoCriteria[0]] }],
    }).run;
    const worker = new DurableWorker(repository, dependencies, 4317);
    await worker.executeClaim(repository.claim(worker.id)!, new AbortController().signal);
    expect(repository.getRun(owner.ownerId, run.id).status, JSON.stringify(diagnostics)).toBe("target_failed");
    const attempt = repository.attempts(owner.ownerId, run.id)[0];
    const prepared = await request(`/runs/${run.id}/reproductions`, {
      attemptId: attempt.id, authorizationAcknowledged: true,
    });
    expect(prepared.status).toBe(200);
    let job = reproductionViewSchema.parse((await prepared.json()).data);
    expect(job.status).toBe("queued");
    const sourceDecisions = decisions;
    repository.close();
    repository = new WorkerRepository(directory, policy);
    const resumed = new DurableWorker(repository, dependencies, 4317);
    for (let i = 0; i < 6 && ["queued", "running"].includes(job.status); i++) {
      repository.pumpReproductions();
      const claim = repository.claim(resumed.id);
      if (claim) {
        expect(claim.reproductionCandidateId).toBeDefined();
        expect(repository.takeovers.status(owner.ownerId, claim.attempt.id).phase).toBe("closed");
        await resumed.executeClaim(claim, new AbortController().signal);
      }
      repository.pumpReproductions();
      job = reproductionViewSchema.parse((await (await request(`/reproductions/${job.id}`)).json()).data);
    }
    expect(job).toMatchObject({
      status: "limit_reached", candidatesAttempted: 3, modelCalls: 0,
      reservedSecondsCharged: 360, shortestSteps: 4, exportAvailable: true,
    });
    expect(decisions).toBe(sourceDecisions);
    expect(allocations).toBe(4);
    expect(sessions.size).toBe(4);
    expect(closures).toBe(4);
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 480, consumedSeconds: 4, releasedSeconds: 476 });
    const exported = await request(`/reproductions/${job.id}/export`);
    expect(exported.status).toBe(200);
    const source = await exported.text();
    expect(source).toContain("expect(observed.exactFailure");
    for (const session of sessions) expect(source).not.toContain(session);
    expect(source).not.toContain(owner.token);

    const rerunResponse = await request(`/runs/${run.id}/reruns`, {
      authorizationAcknowledged: true, attemptIds: [attempt.id], scenario: "fixed",
    });
    expect(rerunResponse.status).toBe(201);
    const child = rerunResponseSchema.parse((await rerunResponse.json()).data).run;
    const childAttempt = repository.attempts(owner.ownerId, child.id)[0];
    expect(child.scope).toEqual(run.scope);
    expect(childAttempt.persona).toEqual(attempt.persona);
    expect(childAttempt.criteria).toEqual(attempt.criteria);
    expect(childAttempt.goal).toBe(attempt.goal);
    const fixedClaim = repository.claim(resumed.id)!;
    expect(fixedClaim.runId).toBe(child.id);
    expect(fixedClaim.reproductionCandidateId).toBeUndefined();
    await resumed.executeClaim(fixedClaim, new AbortController().signal);
    expect(repository.getRun(owner.ownerId, child.id).status).toBe("succeeded");
    expect(repository.getRun(owner.ownerId, run.id).status).toBe("target_failed");
    const compared = await request(`/runs/${run.id}/comparisons/${child.id}`);
    expect(compared.status).toBe(200);
    const comparison = runComparisonSchema.parse((await compared.json()).data);
    expect(comparison).toMatchObject({ comparable: true, context: "fresh", parentFinality: "final", childFinality: "final" });
    expect(comparison.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "functional_defect", state: "confirmed_fixed",
        before: expect.objectContaining({ tested: 1, affected: 1 }),
        after: expect.objectContaining({ tested: 1, confirmed: 1 }),
      }),
    ]));
    expect(allocations).toBe(5);
    expect(sessions.size).toBe(5);
    expect(closures).toBe(5);
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 600, consumedSeconds: 5, releasedSeconds: 595 });
    expect(diagnostics).toEqual([]);
  } finally { repository.close(); }
});
