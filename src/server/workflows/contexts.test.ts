import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerRepository, type Claim } from "../worker/repository";
import { demoCriteria, type DemoRun } from "../../lib/demo-run";
import type { BrowserState } from "../../lib/context-contracts";
import type { ExecutionResult } from "../execution/types";
import { CONTEXT_PERSIST_DELAY_MS } from "./contexts";
import type { ContextProvider } from "./context-provider";

let dir: string;
let now: number;
let repository: WorkerRepository;
let owner: string;
let connections: WorkerRepository[];
let provider: ContextProvider;
const result: ExecutionResult = {
  status: "succeeded", reason: "verified", checks: [], steps: 0, modelCalls: 0,
  durationMs: 1, cleanup: { status: "closed", errors: [] },
  originalTerminal: { status: "succeeded", reason: "verified" }, errors: [],
};
const request = (browserState?: BrowserState): DemoRun => ({
  authorizationAcknowledged: true, scenario: "fixed",
  assignments: [{
    personaId: "careful-first-timer", goal: "Inspect coupons", criteria: [demoCriteria[0]],
    ...(browserState ? { browserState } : {}),
  }],
});
const save = () => repository.createDemoRun(owner, randomUUID(), request({ mode: "save", acknowledgeSensitiveStorage: true })).run;
const claim = (worker = "worker-a") => {
  const value = repository.claim(worker);
  expect(value).not.toBeNull();
  return value!;
};
const returning = (id: string, persist = false): BrowserState =>
  ({ mode: "returning", contextId: id, persist, acknowledgeSensitiveStorage: true });
function finish(value: Claim, extra: { neverAllocated?: boolean; clean?: boolean } = {}) {
  repository.finish(value, extra.clean === false ? {
    ...result, cleanup: { status: "failed", errors: ["cleanup_failed"] },
  } : result, {
    reservedSeconds: 240, elapsedSeconds: 1,
    ...(extra.neverAllocated ? { allocationAttempted: false as const, actualBrowserSeconds: 0 } :
      { allocationAttempted: true as const, remoteStatus: "COMPLETED", actualBrowserSeconds: 1 }),
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".context-test-"));
  now = Date.now();
  repository = new WorkerRepository(dir, {}, () => now);
  connections = [repository];
  owner = repository.createSession().ownerId;
  provider = { create: vi.fn(async () => randomUUID()), inspect: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
});
afterEach(() => {
  for (const connection of connections) connection.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("owner and exact-scope private contexts", () => {
  it("keeps every absent selection fresh and never calls a context provider", async () => {
    repository.createDemoRun(owner, randomUUID(), request());
    expect(await repository.prepareContext(claim(), provider)).toBeUndefined();
    expect(provider.create).not.toHaveBeenCalled();
    expect(repository.contexts.list(owner)).toEqual([]);
  });

  it("creates once, persists only with explicit selection and waits before returning", async () => {
    save();
    const first = claim();
    const reference = await repository.prepareContext(first, provider);
    expect(reference).toMatchObject({ persist: true });
    const context = repository.contexts.list(owner)[0];
    expect(JSON.stringify(context)).not.toContain(reference!.id);
    finish(first);
    expect(repository.contexts.list(owner)[0]).toMatchObject({ status: "persisting", persistence: "requested" });
    repository.createDemoRun(owner, randomUUID(), request(returning(context.id)));
    expect(repository.claim("second")).toBeNull();
    now += CONTEXT_PERSIST_DELAY_MS;
    const second = claim("second");
    expect(await repository.prepareContext(second, provider)).toEqual({ id: reference!.id, persist: false });
    expect(provider.create).toHaveBeenCalledTimes(1);
    finish(second);
    expect(repository.contexts.list(owner)[0]).toMatchObject({ status: "available", persistence: "delay_elapsed_unverified" });
  });

  it("rejects foreign owners, wrong target and changed path scope", async () => {
    save();
    const first = claim();
    await repository.prepareContext(first, provider);
    finish(first);
    now += CONTEXT_PERSIST_DELAY_MS;
    const id = repository.contexts.list(owner)[0].id;
    const other = repository.createSession().ownerId;
    expect(() => repository.createDemoRun(other, randomUUID(), request(returning(id)))).toThrow("not_found");
    expect(() => repository.contexts.revoke(other, id)).toThrow("not_found");
    for (const controlledSiteId of ["store", "project-board"] as const) {
      expect(() => repository.createControlledRun(owner, randomUUID(), {
        authorizationAcknowledged: true, controlledSiteId,
        assignments: [{ ...request(returning(id)).assignments[0], criteria: ["A visible outcome"] }],
      })).toThrow("not_found");
    }
    expect(repository.contexts.list(other)).toEqual([]);
  });

  it("replays identical admission without creating another context", () => {
    const key = randomUUID();
    const input = request({ mode: "save", acknowledgeSensitiveStorage: true });
    const first = repository.createDemoRun(owner, key, input);
    expect(repository.createDemoRun(owner, key, input)).toMatchObject({ created: false, run: first.run });
    expect(repository.contexts.list(owner)).toHaveLength(1);
  });

  it("rejects non-fresh contexts for website requests before allocation", () => {
    expect(() => repository.createRun(owner, randomUUID(), {
      authorizationAcknowledged: true,
      scope: { targetUrl: "https://example.com", allowedSubdomains: [], pathPrefixes: ["/"] },
      assignments: request({ mode: "save", acknowledgeSensitiveStorage: true }).assignments,
    })).toThrow();
    expect(repository.accounting().reservedSeconds).toBe(0);
  });
});

describe("durable context ownership across workers and uncertain allocation", () => {
  async function available() {
    save();
    const first = claim();
    await repository.prepareContext(first, provider);
    finish(first);
    now += CONTEXT_PERSIST_DELAY_MS;
    return repository.contexts.list(owner)[0].id;
  }
  it("atomically excludes two workers and holds across expiry, crash and unknown recovery", async () => {
    const id = await available();
    repository.createDemoRun(owner, randomUUID(), request(returning(id)));
    repository.createDemoRun(owner, randomUUID(), request(returning(id)));
    const first = claim();
    await repository.prepareContext(first, provider);
    const second = new WorkerRepository(dir, {}, () => now);
    connections.push(second);
    expect(second.claim("worker-b")).toBeNull();
    now += 31_000;
    const recovery = second.claim("worker-b")!;
    expect(recovery).toMatchObject({ jobId: first.jobId, recovery: true });
    expect(() => repository.assertLease(first)).toThrow("worker_lease_lost");
    second.recover(recovery, { confirmed: false, sessions: [] });
    expect(repository.contexts.list(owner)[0].status).toBe("quarantined");
    expect(second.claim("worker-c")).toBeNull();
    expect(repository.accounting().reservedSeconds).toBe(480);
  });

  it("holds the context after two real processes race and the winning process dies", async () => {
    const id = await available();
    repository.createDemoRun(owner, randomUUID(), request(returning(id)));
    repository.createDemoRun(owner, randomUUID(), request(returning(id)));
    const children = ["process-one", "process-two"].map((worker) => spawn(process.execPath, [
      "--import", "tsx", "src/server/worker/fixtures/claim-process.ts",
      dir, JSON.stringify(repository.policy), String(now), worker,
    ], { stdio: ["pipe", "pipe", "pipe"] }));
    const replies = children.map((child) => new Promise<Claim | null>((resolve, reject) => {
      child.once("error", reject);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.kind === "ready") child.stdin.write("claim\n");
        if (message.kind === "claimed") resolve(message.claim);
        if (message.kind === "failed") reject(new Error("context_process_claim_failed"));
      });
      child.once("exit", () => lines.close());
    }));
    try {
      const claims = await Promise.all(replies);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const held = claims.find((value) => value !== null)!;
      const died = children[claims.findIndex(Boolean)];
      await new Promise<void>((resolve) => {
        died.once("exit", () => resolve());
        died.kill("SIGKILL");
      });
      now += 31_000;
      const recovered = claim("recovery-process");
      expect(recovered).toMatchObject({ jobId: held.jobId, recovery: true });
      repository.recover(recovered, { confirmed: false, sessions: [] });
      expect(repository.contexts.list(owner)[0].status).toBe("quarantined");
      expect(repository.claim("no-overlap")).toBeNull();
    } finally {
      await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve() : new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        })));
    }
  });

  it("confirmed recovery frees money but never adopts uncertain persisted state", async () => {
    const id = await available();
    repository.createDemoRun(owner, randomUUID(), request(returning(id, true)));
    const first = claim();
    await repository.prepareContext(first, provider);
    now += 31_000;
    const recovery = claim("recovering");
    repository.recover(recovery, { confirmed: true, sessions: [{ sessionId: randomUUID(), status: "COMPLETED", actualBrowserSeconds: 1 }] });
    expect(repository.contexts.list(owner)[0]).toMatchObject({ status: "quarantined", persistence: "uncertain" });
    expect(() => repository.createDemoRun(owner, randomUUID(), request(returning(id)))).toThrow("conflict");
  });

  it("does not retry context creation with lost reply or pretend unknown resources were erased", async () => {
    save();
    provider.create = vi.fn(async () => { throw new Error("lost_reply"); });
    const first = claim();
    await expect(repository.prepareContext(first, provider)).rejects.toThrow("context_creation_unconfirmed");
    finish(first, { neverAllocated: true });
    const context = repository.contexts.list(owner)[0];
    expect(context).toMatchObject({ status: "quarantined", persistence: "uncertain" });
    repository.contexts.revoke(owner, context.id);
    await repository.retireContext(provider);
    expect(repository.contexts.list(owner)[0].status).toBe("deletion_unknown");
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("records a late known context without permitting adoption after lease loss", async () => {
    save();
    let resolve!: (id: string) => void;
    provider.create = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const first = claim();
    const preparing = repository.prepareContext(first, provider);
    now += 31_000;
    claim("replacement");
    const remoteId = randomUUID();
    resolve(remoteId);
    await expect(preparing).rejects.toThrow("context_creation_unconfirmed");
    const db = new DatabaseSync(join(dir, "flash-flood.sqlite"));
    try {
      expect(db.prepare("SELECT remote_id,status FROM browser_contexts").get()).toMatchObject({
        remote_id: remoteId, status: "creation_unknown",
      });
    } finally { db.close(); }
    expect(provider.inspect).not.toHaveBeenCalled();
  });

  it("rechecks context expiry after asynchronous inspection while the worker lease is still valid", async () => {
    const id = await available();
    const expiry = Date.parse(repository.contexts.list(owner)[0].expiresAt);
    now = expiry - 1_000;
    repository.createDemoRun(owner, randomUUID(), request(returning(id)));
    const first = claim();
    let resolve!: () => void;
    provider.inspect = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const preparing = repository.prepareContext(first, provider);
    now += 2_000;
    repository.assertLease(first, true);
    resolve();
    await expect(preparing).rejects.toThrow("context_adoption_failed");
    expect(repository.contexts.list(owner)[0]).toMatchObject({ status: "quarantined", persistence: "uncertain" });
  });

  it("fences context expiry after preparation at the actual dispatch guard, while allowing cleanup", async () => {
    const id = await available();
    const expiry = Date.parse(repository.contexts.list(owner)[0].expiresAt);
    now = expiry - 1_000;
    repository.createDemoRun(owner, randomUUID(), request(returning(id)));
    const first = claim();
    await repository.prepareContext(first, provider);
    now += 2_000;
    expect(() => repository.assertLease(first)).toThrow("context_not_active");
    expect(() => repository.assertLease(first, true)).not.toThrow();
  });

  it("revokes immediately, cancels active use and defers deletion until closed plus synchronization delay", async () => {
    save();
    const first = claim();
    const reference = await repository.prepareContext(first, provider);
    const context = repository.contexts.list(owner)[0];
    repository.contexts.revoke(owner, context.id);
    expect(repository.heartbeat(first)).toBe(true);
    expect(() => repository.assertLease(first)).toThrow("cancel_requested");
    await repository.retireContext(provider);
    expect(provider.delete).not.toHaveBeenCalled();
    finish(first);
    expect(repository.getRun(owner, first.runId).status).toBe("cancelled");
    await repository.retireContext(provider);
    expect(provider.delete).not.toHaveBeenCalled();
    now += CONTEXT_PERSIST_DELAY_MS;
    await repository.retireContext(provider);
    expect(provider.delete).toHaveBeenCalledExactlyOnceWith(reference!.id);
    expect(repository.contexts.list(owner)[0]).toMatchObject({ status: "deleted", revoked: true });
  });

  it("makes deletion failures visible and does not automatically retry", async () => {
    const id = await available();
    repository.contexts.revoke(owner, id);
    provider.delete = vi.fn(async () => { throw new Error("provider_private_error"); });
    await repository.retireContext(provider);
    await repository.retireContext(provider);
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(repository.contexts.list(owner)[0].status).toBe("deletion_unknown");
  });

  it("retire expiry without claiming immediate remote erasure", async () => {
    await available();
    now += 7 * 86_400_000;
    await repository.retireContext(provider);
    expect(repository.contexts.list(owner)[0]).toMatchObject({ status: "deleted", revoked: true });
  });
});
