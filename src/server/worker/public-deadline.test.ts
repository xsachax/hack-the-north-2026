import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { personas } from "../../lib/personas";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import type { NativeCloudUsage } from "../execution/native-browser";
import type { NativeResource } from "../execution/native-resources";
import type { BrowserDriver, ExecutionResult, Observation } from "../execution/types";
import { ExecutionError } from "../execution/types";
import { executePersona } from "../execution/loop";
import { WorkerRepository, type Claim } from "./repository";
import { DurableWorker, type WorkerDependencies } from "./runtime";


const completed: ExecutionResult = {
  status: "succeeded", reason: "Read-only checks completed", originalTerminal: { status: "succeeded", reason: "Read-only checks completed" },
  cleanup: { status: "closed", errors: [] }, errors: [], checks: [], steps: 0, modelCalls: 0, durationMs: 1,
};
describe("public worker native signal classification and absolute deadline", () => {
  let directory: string;
  let repository: WorkerRepository;
  let claim: Claim;
  let native: AbortController;
  let shutdown: AbortController;
  let deps: WorkerDependencies;
  let close: Mock<BrowserDriver["close"]>;
  let observe: Mock<BrowserDriver["observe"]>;
  let deadline: number | undefined;
  let bootstrapMs: number;
  beforeEach(() => {
    vi.useFakeTimers();
    directory = join(process.cwd(), `.public-deadline-${randomUUID()}`);
    mkdirSync(directory, { mode: 0o700 });
    repository = new WorkerRepository(directory);
    const owner = repository.createSession().ownerId;
    repository.createRun(owner, randomUUID(), {
      authorizationAcknowledged: true, executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
      scope: { targetUrl: "https://example.com/docs", allowedSubdomains: [], pathPrefixes: ["/docs"] },
      assignments: [{ personaId: personas[0].id, goal: "Read documentation", criteria: [{
        id: "heading", kind: "visible_text", description: "Documentation is visible", text: "Documentation",
        match: "exact", semantics: "current",
      }] }],
    });
    claim = repository.claim("worker", { enabled: true, implementationReady: true })!;
    native = new AbortController();
    shutdown = new AbortController();
    deadline = undefined;
    bootstrapMs = 0;
    observe = vi.fn(() => new Promise<Observation>((_resolve, reject) => {
      const fail = () => reject(new ExecutionError("infra", "native_policy_fault"));
      native.signal.addEventListener("abort", fail, { once: true });
      if (native.signal.aborted) fail();
    }));
    close = vi.fn();
    deps = {
      publicEnabled: true, publicImplementationReady: true,
      launch: vi.fn(), recover: vi.fn(), diagnostic: vi.fn(),
      artifacts: () => ({ screenshot: vi.fn(), json: vi.fn(), telemetry: vi.fn() }),
      launchPublic: async (options) => {
        const resource: NativeResource = { version: 1, archiveSha256: "a".repeat(64),
          state: "upload_intent", sessionAllocationAttempted: false };
        options.onResource(resource);
        resource.extensionId = randomUUID(); resource.state = "uploaded";
        options.onResource(resource);
        resource.state = "allocated"; resource.sessionAllocationAttempted = true; resource.sessionId = randomUUID();
        options.onResource(resource);
        await options.onSession({ sessionId: resource.sessionId, liveViewUrl: "",
          replayUrl: `https://www.browserbase.com/sessions/${resource.sessionId}`, timeoutSeconds: 240 });
        const usage: NativeCloudUsage = { reservedSeconds: 240, elapsedSeconds: 1, allocationAttempted: true };
        close.mockImplementation(async () => {
          native.abort();
          options.onResource({ ...resource, state: "delete_intent" });
          options.onResource({ ...resource, state: "deleted" });
          usage.remoteStatus = "COMPLETED"; usage.actualBrowserSeconds = 1;
          return { status: "closed", errors: [] };
        });
        if (bootstrapMs > 0) await new Promise((resolve) => setTimeout(resolve, bootstrapMs));
        return { driver: { observe, act: vi.fn(), close }, brain: { decide: vi.fn() }, usage,
          signal: native.signal, ...(deadline === undefined ? {} : { executionDeadlineMs: deadline }) };
      },
    };
  });
  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const run = () => new DurableWorker(repository, deps, 4321).executeClaim(claim, shutdown.signal);

  it("maps native signal interruption to infrastructure failure instead of user cancellation", async () => {
    const task = run();
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledOnce();
    native.abort();
    await task;
    expect(close).toHaveBeenCalledOnce();
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("infrastructure_failed");
    expect(repository.attemptSummaries(claim.ownerId, claim.runId)[0].launchState).toBe("settled");
  });

  it("does not dispatch on an already-aborted native signal or mislabel it user cancellation", async () => {
    native.abort();
    await run();
    expect(observe).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("infrastructure_failed");
  });

  it("does not mistake normal native close abort for execution failure", async () => {
    deps.execute = async (input, adapters) => {
      expect(input.signal?.aborted).toBe(false);
      await adapters.driver.close();
      expect(input.signal?.aborted).toBe(true);
      return completed;
    };
    await run();
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("succeeded");
  });

  it("preserves worker shutdown cancellation through the combined signal", async () => {
    const task = run();
    await vi.advanceTimersByTimeAsync(0);
    shutdown.abort();
    await task;
    expect(close).toHaveBeenCalledOnce();
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("cancelled");
  });

  it("subtracts bootstrap time using the absolute native deadline rather than restarting a TTL at loop entry", async () => {
    deadline = Date.now() + 10000;
    bootstrapMs = 5679;
    deps.execute = async (input, adapters) => {
      expect(input.limits?.maxDurationMs).toBe(4321);
      await adapters.driver.close();
      return completed;
    };
    const task = run();
    await vi.advanceTimersByTimeAsync(5679);
    await task;
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("succeeded");
  });

  it("interrupts at the absolute native deadline without reporting a site failure", async () => {
    deadline = Date.now() + 50;
    deps.execute = async (input, adapters) => {
      const result = await executePersona(input, adapters);
      expect(result.originalTerminal.status).toBe("limit_reached");
      return result;
    };
    const task = run();
    await vi.advanceTimersByTimeAsync(50);
    await task;
    expect(close).toHaveBeenCalledOnce();
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("infrastructure_failed");
  });

  it("cannot accept a successful injected result after native interruption", async () => {
    deps.execute = async (_input, adapters) => {
      native.abort();
      await adapters.driver.close();
      return completed;
    };
    await run();
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("infrastructure_failed");
  });

  it("does not dispatch loop work after bootstrap has exhausted the native execution budget", async () => {
    deadline = Date.now() + 50;
    bootstrapMs = 75;
    const task = run();
    await vi.advanceTimersByTimeAsync(75);
    await task;
    expect(observe).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("infrastructure_failed");
  });

  it.each([NaN, Infinity, 1.5])("cleans up rather than dispatching on invalid deadline %s", async (invalid) => {
    deadline = invalid;
    await run();
    expect(observe).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(repository.getRun(claim.ownerId, claim.runId).status).toBe("infrastructure_failed");
  });
});
