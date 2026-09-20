import { APIConnectionTimeoutError } from "@browserbasehq/sdk/error";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED_EXECUTION_POLICY, type ManagedCreate } from "../../lib/managed-contracts";
import { personas } from "../../lib/personas";
import { WorkerRepository } from "../worker/repository";
import { ManagedWorker } from "./worker";
import type { ManagedOutcome } from "./types";
import type { ManagedProvider } from "./provider";

const options = {
  apiKey: "offline-only-provider-key", projectId: randomUUID(), agentId: "offline-agent",
  allowedOrigins: ["https://example.com"],
};
const success: ManagedOutcome = {
  status: "completed", providerStatus: "COMPLETED", cleanup: "closed", result: null, error: null,
  actualBrowserSeconds: 3.2, allocationAttempted: true,
};
describe("managed worker owns durable lifecycle", () => {
  let directory: string;
  let repository: WorkerRepository;
  let owner: string;
  function create() {
    const input: ManagedCreate = {
      executionPolicy: MANAGED_EXECUTION_POLICY, authorizationAcknowledged: true, managedPolicyAcknowledged: true,
      scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
      assignments: [{ personaId: personas[0].id, goal: "Read example", criteria: ["Example visible"] }],
    };
    return repository.managed.create(owner, randomUUID(), input, repository.listPersonas(owner)).run;
  }
  beforeEach(() => {
    directory = resolve(`.managed-worker-${randomUUID()}`);
    repository = new WorkerRepository(directory);
    owner = repository.createSession().ownerId;
  });
  afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
  it("journals dispatch and identity before progress and settlement", async () => {
    const run = create();
    const stop = new AbortController();
    const execute = vi.fn(async (_claim, journal) => {
      journal.assertActive();
      journal.dispatch({ agentId: options.agentId, task: "offline task" });
      journal.identity({ providerRunId: "provider-run", providerSessionId: randomUUID() });
      journal.progress({ id: "first", kind: "tool", text: "browser navigation" });
      stop.abort();
      journal.assertActive(true);
      return success;
    });
    await new ManagedWorker(repository, repository.policy, options, execute).run(stop.signal);
    expect(execute).toHaveBeenCalledOnce();
    expect(repository.managed.get(owner, run.id).attempts[0]).toMatchObject({
      status: "completed", cleanup: "closed", actualBrowserSeconds: 3.2,
      progress: [{ text: "browser navigation" }], modelCalls: null,
    });
  });
  it("forwards the live view to the store under the executing claim", async () => {
    create();
    const claim = repository.managed.claim("worker", repository.policy)!;
    const liveView = vi.spyOn(repository.managed, "liveView").mockImplementation(() => {});
    const liveViewUrl = "https://www.browserbase.com/devtools-fullscreen/inspector.html?navbar=false";
    const execute = vi.fn(async (_claim, journal) => {
      journal.dispatch({ agentId: options.agentId, task: "offline task" });
      journal.identity({ providerRunId: "provider-run", providerSessionId: randomUUID() });
      journal.liveView({ liveViewUrl });
      return success;
    });
    await new ManagedWorker(repository, repository.policy, options, execute).executeClaim(claim, new AbortController().signal);
    expect(liveView).toHaveBeenCalledExactlyOnceWith(claim, { liveViewUrl });
  });
  it("fences cancellation but still permits independent cleanup", async () => {
    const run = create();
    const claim = repository.managed.claim("worker", repository.policy)!;
    const execute = vi.fn(async (_claim, journal) => {
      journal.dispatch({ agentId: options.agentId, task: "offline task" });
      repository.managed.cancel(owner, run.id);
      expect(() => journal.assertActive()).toThrow();
      expect(() => journal.assertActive(true)).not.toThrow();
      return { ...success, status: "cancelled" as const };
    });
    await new ManagedWorker(repository, repository.policy, options, execute).executeClaim(claim, new AbortController().signal);
    expect(repository.managed.get(owner, run.id)).toMatchObject({ status: "cancelled", attempts: [{ cleanup: "closed" }] });
  });
  it("does not settle an unexpected runner exception or refund its reservation", async () => {
    const run = create();
    const claim = repository.managed.claim("worker", repository.policy)!;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn(async (_claim, journal) => {
      journal.dispatch({ agentId: options.agentId, task: "offline task" });
      throw new Error("must not appear in log");
    });
    await new ManagedWorker(repository, repository.policy, options, execute).executeClaim(claim, new AbortController().signal);
    const attempt = repository.managed.get(owner, run.id).attempts[0];
    expect(attempt.cleanup).not.toBe("closed");
    expect(attempt.reservedSeconds).toBe(repository.policy.sessionSeconds);
    expect(attempt.actualBrowserSeconds).toBeNull();
    expect(log).toHaveBeenCalledWith("managed_worker_attempt_recovery_required");
  });

  it("wires real runner create diagnostics to durable storage before finishing unknown allocation", async () => {
    const run = create();
    const claim = repository.managed.claim("worker", repository.policy)!;
    const provider: ManagedProvider = {
      createRun: vi.fn().mockRejectedValue(new APIConnectionTimeoutError()),
      retrieveRun: vi.fn(), listRuns: vi.fn(), listMessages: vi.fn(), stopRun: vi.fn(),
      retrieveSession: vi.fn(), debugSession: vi.fn(), releaseSession: vi.fn(),
    };
    const record = vi.spyOn(repository.managed, "createFailure");
    const finish = vi.spyOn(repository.managed, "finish");
    await new ManagedWorker(repository, repository.policy, { ...options, provider })
      .executeClaim(claim, new AbortController().signal);
    expect(record).toHaveBeenCalledExactlyOnceWith(claim, {
      category: "timeout", httpStatus: null, requestId: null, requestIdHeader: null,
    });
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(finish.mock.invocationCallOrder[0]);
    expect(repository.managed.get(owner, run.id).attempts[0]).toMatchObject({
      status: "cleanup_required", cleanup: "unconfirmed", error: "managed_allocation_unknown", actualBrowserSeconds: null,
    });
    expect(repository.accounting(owner)).toMatchObject({
      reservedSeconds: repository.policy.sessionSeconds, consumedSeconds: 0, releasedSeconds: 0,
    });
    expect(provider.createRun).toHaveBeenCalledOnce();
  });
});
