import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoCriteria } from "../../lib/demo-run";
import { personas } from "../../lib/personas";
import type { ArtifactSinks } from "../execution/artifacts";
import { CloudStartupError, type CloudUsage, type FixtureExecutionOptions } from "../execution/cloud";
import type { ExecutionResult, Observation } from "../execution/types";
import { executePersona } from "../execution/loop";
import { WorkerRepository } from "./repository";
import { DurableWorker, type WorkerDependencies } from "./runtime";

describe("durable worker with injected execution adapters", () => {
  let dir: string;
  let repository: WorkerRepository;
  let owner: string;
  let usage: CloudUsage;
  let deps: WorkerDependencies;
  let observed: Observation;
  const key = () => randomUUID().replaceAll("-", "").repeat(2);
  const artifact = () => ({ key: key(), kind: "json" as const, bytes: 1, sha256: key() });
  const sinks: ArtifactSinks = {
    screenshot: async () => ({ ...artifact(), kind: "screenshot" }),
    json: async () => artifact(),
    telemetry: async () => artifact(),
  };
  const create = () => repository.createDemoRun(owner, randomUUID(), {
    authorizationAcknowledged: true, scenario: "fixed",
    assignments: [{ personaId: personas[0].id, goal: "Apply the coupons", criteria: [demoCriteria[0]] }],
  }).run;
  const finish: ExecutionResult = {
    status: "succeeded", reason: "All criteria proved", originalTerminal: { status: "succeeded", reason: "All criteria proved" },
    checks: [], steps: 0, modelCalls: 0, durationMs: 1, cleanup: { status: "closed", errors: [] }, errors: [],
  };
  beforeEach(() => {
    dir = join(process.cwd(), `.worker-runtime-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    repository = new WorkerRepository(dir);
    owner = repository.createSession().ownerId;
    usage = { reservedSeconds: 240, elapsedSeconds: 1 };
    observed = {
      id: "state", url: "https://fixture.flash-flood.invalid/demo/cart", title: "Cart", text: "Cart",
      candidates: [], signals: [], checks: [{ criterion: demoCriteria[0], passed: true, evidence: "state" }],
    };
    deps = {
      artifacts: () => sinks,
      recover: vi.fn(async () => ({ confirmed: false, sessions: [] })),
      launch: vi.fn(async (options: FixtureExecutionOptions) => {
        options.assertActive?.();
        await options.onSession({
          sessionId: randomUUID(), liveViewUrl: "https://www.browserbase.com/live/private",
          replayUrl: "https://www.browserbase.com/sessions/private", timeoutSeconds: 240,
        });
        return {
          usage,
          driver: {
            observe: vi.fn(async () => observed),
            act: vi.fn(async () => {}),
            close: vi.fn(async () => {
              usage.remoteStatus = "COMPLETED"; usage.actualBrowserSeconds = 1.5;
              return { status: "closed" as const, errors: [] };
            }),
          },
          brain: { decide: vi.fn(async () => ({ action: "give_up" as const, value: null, candidateId: null, commentary: "" })) },
        };
      }),
      diagnostic: vi.fn(),
    };
  });
  afterEach(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

  it("persists private evidence, steps and returned success without duplicate lifecycle hooks", async () => {
    const run = create();
    const worker = new DurableWorker(repository, deps, 4321);
    const claim = repository.claim(worker.id)!;
    await worker.executeClaim(claim, new AbortController().signal);
    expect(repository.getRun(owner, run.id).status).toBe("succeeded");
    const events = repository.events(owner, run.id, { after: 0, limit: 100 }).items;
    expect(events.map((e) => e.kind)).toEqual([
      "run.created", "attempt.started", "evidence.recorded", "attempt.observation", "attempt.finished", "run.finished",
    ]);
    expect(JSON.stringify(events)).not.toContain("browserbase.com");
    expect(JSON.stringify(events)).not.toContain("storageKey");
    expect(repository.accounting().consumedSeconds).toBe(2);
    expect(repository.attemptSummaries(owner, run.id)[0].summary?.cleanup.status).toBe("closed");
    expect(repository.sessionViews(owner, run.id)[0].liveViewUrl).toBeNull();
    const options = vi.mocked(deps.launch).mock.calls[0][0];
    expect(options.correlationToken).toBe(claim.correlationToken);
    expect(options.criteria).toEqual(claim.attempt.criteria);
  });

  it("never finalizes from a success finished hook when the authoritative return failed", async () => {
    const run = create();
    deps.execute = async (input, dependencies) => {
      await dependencies.driver.close();
      await dependencies.onEvent?.({ kind: "finished", actor: "agent", result: finish }, input.signal!);
      expect(repository.getRun(owner, run.id).status).toBe("running");
      return { ...finish, status: "infrastructure_failed", reason: "Final sink failed" };
    };
    const worker = new DurableWorker(repository, deps, 4321);
    await worker.executeClaim(repository.claim(worker.id)!, new AbortController().signal);
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
  });

  it("cancellation aborts a pending model and awaits remote release", async () => {
    vi.useFakeTimers();
    const run = create();
    observed = { ...observed, checks: [] };
    let modelStarted = false;
    const launch = deps.launch;
    deps.launch = async (options) => {
      const execution = await launch(options);
      execution.brain.decide = async (_input, signal) => {
        modelStarted = true;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { action: "give_up", candidateId: null, value: null, commentary: "" };
      };
      return execution;
    };
    const worker = new DurableWorker(repository, deps, 4321);
    const running = worker.executeClaim(repository.claim(worker.id)!, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1);
    expect(modelStarted).toBe(true);
    repository.cancelRun(owner, run.id);
    await vi.advanceTimersByTimeAsync(500);
    await running;
    expect(repository.getRun(owner, run.id).status).toBe("cancelled");
    expect(usage.remoteStatus).toBe("COMPLETED");
  });

  it("retains uncertain startup reservations and dispatches no second launch", async () => {
    const run = create();
    deps.launch = vi.fn(async () => { throw new CloudStartupError({ status: "failed", errors: ["unknown"] }, usage); });
    const worker = new DurableWorker(repository, deps, 4321);
    await worker.executeClaim(repository.claim(worker.id)!, new AbortController().signal);
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.accounting().committedSeconds).toBe(240);
    expect(repository.claim(worker.id)).toBeNull();
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });

  it("cleans up on an unexpectedly rejecting execution adapter", async () => {
    const run = create();
    deps.execute = async () => { throw new Error("raw private error"); };
    const worker = new DurableWorker(repository, deps, 4321);
    await worker.executeClaim(repository.claim(worker.id)!, new AbortController().signal);
    expect(usage.remoteStatus).toBe("COMPLETED");
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(JSON.stringify(repository.events(owner, run.id, { after: 0, limit: 100 }))).not.toContain("private error");
  });

  it("persists action/decision actor and safe commentary but not action values or private URLs", async () => {
    const run = create();
    let observations = 0;
    const launch = deps.launch;
    deps.launch = async (options) => {
      const result = await launch(options);
      result.driver.observe = async () => ++observations === 1 ? { ...observed, checks: [] } : observed;
      result.brain.decide = async () => ({
        action: "wait", candidateId: null, value: "0",
        commentary: "Open https://www.browserbase.com/private?token=secret token=secret",
      });
      return result;
    };
    deps.execute = (input, dependencies) => executePersona({
      ...input, limits: { ...input.limits, carefulDelayMs: 0 },
    }, dependencies);
    const worker = new DurableWorker(repository, deps, 4321);
    await worker.executeClaim(repository.claim(worker.id)!, new AbortController().signal);
    const events = repository.events(owner, run.id, { after: 0, limit: 100 }).items;
    expect(events.find((e) => e.kind === "attempt.action")?.data).toMatchObject({ actor: "agent", step: 1, action: "wait" });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("browserbase.com");
  });

  it("graceful shutdown of the worker waits for active cleanup and stops claiming", async () => {
    const run = create();
    observed = { ...observed, checks: [] };
    const shutdown = new AbortController();
    const launch = deps.launch;
    deps.launch = async (options) => {
      const execution = await launch(options);
      execution.brain.decide = async (_input, signal) => {
        shutdown.abort();
        signal.throwIfAborted();
        return { action: "give_up", candidateId: null, value: null, commentary: "" };
      };
      return execution;
    };
    await new DurableWorker(repository, deps, 4321).run(shutdown.signal);
    expect(repository.getRun(owner, run.id).status).toBe("cancelled");
    expect(usage.remoteStatus).toBe("COMPLETED");
  });

  it("a stale returned result cannot complete a recovered lease and never launches twice", async () => {
    vi.useFakeTimers();
    const run = create();
    const worker = new DurableWorker(repository, deps, 4321);
    const first = repository.claim(worker.id)!;
    let recovery: ReturnType<WorkerRepository["claim"]>;
    deps.execute = async (_input, execution) => {
      vi.setSystemTime(Date.now() + 31000);
      recovery = repository.claim("replacement");
      await execution.driver.close();
      return finish;
    };
    await worker.executeClaim(first, new AbortController().signal);
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.events(owner, run.id, { after: 0, limit: 100 }).items.filter((e) => e.kind === "attempt.finished")).toHaveLength(0);
    deps.recover = vi.fn(async () => ({
      confirmed: true, sessions: [{ sessionId: randomUUID(), status: "COMPLETED", actualBrowserSeconds: 1.5 }],
    }));
    await worker.executeClaim(recovery!, new AbortController().signal);
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.recover).toHaveBeenCalledTimes(1);
    expect(repository.accounting().consumedSeconds).toBe(2);
  });

  it("recovery provider errors retain reservation and emit only a fixed diagnostic", async () => {
    vi.useFakeTimers();
    const run = create();
    repository.claim("dead");
    vi.setSystemTime(Date.now() + 31000);
    const recovered = repository.claim("new")!;
    deps.recover = vi.fn(async () => { throw new Error("private provider payload"); });
    const worker = new DurableWorker(repository, deps, 4321);
    await worker.executeClaim(recovered, new AbortController().signal);
    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.diagnostic).toHaveBeenCalledWith("worker_recovery_failed");
    expect(repository.accounting().committedSeconds).toBe(240);
    expect(repository.getRun(owner, run.id).status).toBe("running");
  });

  it("cancel fences normal evidence but permits lease-owned teardown telemetry before terminal settlement", async () => {
    vi.useFakeTimers();
    const run = create();
    observed = { ...observed, checks: [] };
    const order: string[] = [];
    const launch = deps.launch;
    deps.launch = async (options) => {
      const execution = await launch(options);
      execution.brain.decide = async (_input, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { action: "give_up", value: null, candidateId: null, commentary: "" };
      };
      const close = execution.driver.close;
      execution.driver.close = async () => {
        await expect(options.artifacts.json({ forbidden: "post-cancel observation" })).rejects.toThrow();
        order.push("normal-evidence-fenced");
        expect(repository.getRun(owner, run.id).status).toBe("running");
        expect(options.cleanupJson).toBeTypeOf("function");
        await options.cleanupJson!({ telemetry: [{ code: "REQUEST_FAILED" }] });
        order.push("cleanup-evidence-persisted");
        const result = await close();
        order.push("remote-closed");
        return result;
      };
      return execution;
    };
    const worker = new DurableWorker(repository, deps, 4321);
    const running = worker.executeClaim(repository.claim(worker.id)!, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1);
    repository.cancelRun(owner, run.id);
    await vi.advanceTimersByTimeAsync(500);
    await running;
    expect(order).toEqual(["normal-evidence-fenced", "cleanup-evidence-persisted", "remote-closed"]);
    expect(repository.getRun(owner, run.id).status).toBe("cancelled");
    const events = repository.events(owner, run.id, { after: 0, limit: 100 }).items;
    expect(events.slice(-3).map((event) => event.kind)).toEqual(["evidence.recorded", "attempt.finished", "run.finished"]);
    expect(repository.getEvidence(owner, events.at(-3)!.data.evidenceId!).kind).toBe("console");
  });

  it("teardown evidence cannot cross an expired lease, including expiry during file writing", async () => {
    vi.useFakeTimers();
    create();
    const worker = new DurableWorker(repository, deps, 4321);
    const claim = repository.claim(worker.id)!;
    let options: FixtureExecutionOptions;
    const launch = deps.launch;
    deps.launch = async (input) => { options = input; return launch(input); };
    let rawWrites = 0;
    deps.artifacts = () => ({
      ...sinks,
      json: async () => { rawWrites++; vi.setSystemTime(Date.now() + 31000); return artifact(); },
    });
    deps.execute = async (_input, execution) => {
      await expect(options.cleanupJson!({ telemetry: [] })).rejects.toThrow("worker_lease_lost");
      expect(rawWrites).toBe(1);
      await expect(options.cleanupJson!({ telemetry: [] })).rejects.toThrow("worker_lease_lost");
      expect(rawWrites).toBe(1);
      await execution.driver.close();
      return finish;
    };
    await worker.executeClaim(claim, new AbortController().signal);
    expect(repository.events(owner, claim.runId, { after: 0, limit: 100 }).items.map((event) => event.kind))
      .toEqual(["run.created", "attempt.started"]);
  });
});
