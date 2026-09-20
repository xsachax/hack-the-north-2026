import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personas } from "../../lib/personas";
import { demoCriteria } from "../../lib/demo-run";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { NativeResources, type NativeResource } from "../execution/native-resources";
import type { NativeCloudUsage } from "../execution/native-browser";
import type { ExecutionResult } from "../execution/types";
import { CloudStartupError } from "../execution/cloud";
import { LeaseLostError, WorkerRepository, type Claim } from "./repository";
import { DurableWorker, type WorkerDependencies } from "./runtime";


const admission = { enabled: true, implementationReady: true };
const scope = { targetUrl: "https://example.com/docs", allowedSubdomains: [], pathPrefixes: ["/docs"] };
const criteria = [{ id: "heading", kind: "visible_text" as const, text: "Documentation",
  match: "exact" as const, description: "Documentation heading is visible", semantics: "current" as const }];
const intent: NativeResource = { version: 1, archiveSha256: "a".repeat(64), state: "upload_intent",
  sessionAllocationAttempted: false };
const terminal: ExecutionResult = {
  status: "succeeded", reason: "Read-only criteria proved", originalTerminal: { status: "succeeded", reason: "Read-only criteria proved" },
  checks: [], steps: 0, modelCalls: 0, durationMs: 1, errors: [], cleanup: { status: "closed", errors: [] },
};

describe("public worker admission and native durable journal (offline)", () => {
  let directory: string;
  let repository: WorkerRepository;
  let database: DatabaseSync;
  let owner: string;
  let time: number;
  const create = (policies = true) => repository.createRun(owner, randomUUID(), {
    authorizationAcknowledged: true, scope,
    ...(policies ? { executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY } : {}),
    assignments: [{ personaId: personas[0].id, goal: "Read the documentation", criteria }],
  }).run;
  const claim = () => {
    create();
    return repository.claim("public-worker", admission)!;
  };
  const snapshot = (jobId: string) => {
    const row = database.prepare("SELECT resource FROM native_resources WHERE job_id=?").get(jobId);
    return row ? JSON.parse(String(row.resource)) : undefined;
  };
  const events = (jobId: string) => database.prepare(
    "SELECT resource FROM native_resource_events WHERE job_id=? ORDER BY sequence").all(jobId)
    .map((row) => JSON.parse(String(row.resource)));
  const uploaded = (held: Claim) => {
    repository.nativeResource(held, intent);
    const resource: NativeResource = { ...intent, state: "uploaded", extensionId: randomUUID() };
    repository.nativeResource(held, resource);
    return resource;
  };
  beforeEach(() => {
    directory = join(process.cwd(), `.public-worker-${randomUUID()}`);
    mkdirSync(directory, { mode: 0o700 });
    time = Date.now();
    repository = new WorkerRepository(directory, {}, () => time);
    database = new DatabaseSync(join(directory, "flash-flood.sqlite"));
    owner = repository.createSession().ownerId;
  });
  afterEach(() => {
    database.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([undefined, { enabled: false, implementationReady: true },
    { enabled: true, implementationReady: false }])("blocks opted-in runs before reservation when gate is %j", (gate) => {
    const run = create();
    expect(repository.claim("worker", gate)).toBeNull();
    expect(repository.getRun(owner, run.id).status).toBe("blocked");
    expect(repository.accounting().reservedSeconds).toBe(0);
    expect(database.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(0);
  });

  it("keeps historical null-policy websites blocked even when the operator and implementation are ready", () => {
    const old = create(false);
    const fresh = create();
    const held = repository.claim("worker", admission)!;
    expect(held.runId).toBe(fresh.id);
    expect(repository.getRun(owner, old.id).status).toBe("blocked");
    expect(held).toMatchObject({ executionMode: "public-readonly", executionPolicy: PUBLIC_EXECUTION_POLICY,
      assetPolicy: PUBLIC_ASSET_POLICY, scope, attempt: { criteria } });
    expect(database.prepare("SELECT execution_mode FROM runs WHERE id=?").get(fresh.id)?.execution_mode).toBe("website");
    for (const id of [old.id, fresh.id]) expect(() => database.prepare(
      "UPDATE runs SET public_execution_policy=?,public_asset_policy=? WHERE id=?")
      .run(id === old.id ? PUBLIC_EXECUTION_POLICY : null, id === old.id ? PUBLIC_ASSET_POLICY : null, id)).toThrow();
  });

  it("does not spend on or mutate queued controlled jobs in a public-only worker", () => {
    const controlled = repository.createDemoRun(owner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: personas[0].id, goal: "Read the cart", criteria: [...demoCriteria] }],
    }).run;
    const before = database.prepare("SELECT * FROM jobs WHERE run_id=?").all(controlled.id);
    const legacy = create(false);
    const fresh = create();
    const held = repository.claim("public-only", { ...admission, controlledEnabled: false })!;
    expect(held.runId).toBe(fresh.id);
    expect(database.prepare("SELECT * FROM jobs WHERE run_id=?").all(controlled.id)).toEqual(before);
    expect(repository.getRun(owner, legacy.id).status).toBe("blocked");
    expect(repository.accounting().reservedSeconds).toBe(repository.policy.sessionSeconds);
    expect(repository.claim("controlled", { ...admission, controlledEnabled: true })?.runId).toBe(controlled.id);
  });

  it("fences a directly supplied controlled claim before launch in a public-only worker", async () => {
    repository.createDemoRun(owner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: personas[0].id, goal: "Read the cart", criteria: [...demoCriteria] }],
    });
    const held = repository.claim("public-only")!;
    const launch = vi.fn(), artifacts = vi.fn();
    const worker = new DurableWorker(repository, {
      launch, artifacts, controlledEnabled: false,
      recover: vi.fn(),
    }, 4321);
    await worker.executeClaim(held, new AbortController().signal);
    expect(launch).not.toHaveBeenCalled();
    expect(artifacts).not.toHaveBeenCalled();
    expect(repository.getRun(owner, held.runId).status).toBe("blocked");
    expect(repository.accounting().committedSeconds).toBe(0);
  });

  it("synchronously journals private resources during cancellation without changing their identities", () => {
    const held = claim();
    const resource = uploaded(held);
    repository.cancelRun(owner, held.runId);
    expect(repository.nativeResource(held, { ...resource, state: "delete_intent" })).toBeUndefined();
    repository.nativeResource(held, { ...resource, state: "deleted" });
    expect(snapshot(held.jobId)).toEqual({ ...resource, state: "deleted" });
    expect(events(held.jobId)).toHaveLength(4);
    expect(() => repository.nativeResource(held, { ...resource, state: "uploaded" })).toThrow("state_regressed");
    expect(() => repository.nativeResource(held, { ...resource, state: "deleted", archiveSha256: "b".repeat(64) }))
      .toThrow("identity_changed");
    expect(() => repository.nativeResource(held, { ...resource, state: "deleted", extensionId: randomUUID() }))
      .toThrow("identity_changed");
    expect(JSON.stringify(repository.events(owner, held.runId, { after: 0, limit: 100 }))).not.toContain(resource.extensionId);
  });

  it("rejects foreign owner, run, correlation, or generation without adding discovery rows", () => {
    const held = claim();
    repository.nativeResource(held, intent);
    for (const wrong of [{ ownerId: randomUUID() }, { runId: randomUUID() }, { workerId: "foreign-worker" },
      { correlationToken: randomUUID() }, { generation: held.generation + 1 }]) {
      expect(() => repository.nativeResource({ ...held, ...wrong },
        { ...intent, state: "uploaded", extensionId: randomUUID() })).toThrow();
    }
    expect(events(held.jobId)).toEqual([intent]);
  });

  it("preserves a late upload identity append-only, rethrows lease loss and latches provider deletion", async () => {
    const held = claim();
    let reply!: (value: { id: string }) => void;
    const provider = { upload: () => new Promise<{ id: string }>((resolve) => { reply = resolve; }),
      delete: vi.fn(async () => {}), deleted: vi.fn(async () => true) };
    const manager = new NativeResources(intent.archiveSha256, provider, (value) => repository.nativeResource(held, value));
    const pending = manager.upload();
    time += repository.policy.leaseMs + 1;
    const successor = repository.claim("successor", admission)!;
    const before = database.prepare("SELECT state,usage FROM launches WHERE job_id=?").get(held.jobId);
    const extensionId = randomUUID();
    reply({ id: extensionId });
    await expect(pending).rejects.toThrow("native_resource_journal_failed");
    expect(snapshot(held.jobId)).toEqual(intent);
    expect(events(held.jobId).at(-1)).toMatchObject({ extensionId, state: "quarantined" });
    expect(database.prepare("SELECT state,usage FROM launches WHERE job_id=?").get(held.jobId)).toEqual(before);
    await expect(manager.close()).rejects.toThrow();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(repository.reconcileNativeResource(successor)).toMatchObject({ extensionId, state: "quarantined" });
    expect(repository.nativePredispatchProof(successor)).toBe(true);
    expect(() => repository.nativeResource(held, { ...intent, extensionId, state: "quarantined" })).toThrow(LeaseLostError);
  });

  it("discovers a late session ID without stale lifecycle or usage writes", () => {
    const held = claim();
    const resource = { ...uploaded(held), state: "allocated" as const, sessionAllocationAttempted: true };
    repository.nativeResource(held, resource);
    time += repository.policy.leaseMs + 1;
    const successor = repository.claim("successor", admission)!;
    const sessionId = randomUUID();
    const before = repository.accounting();
    expect(() => repository.nativeResource(held, { ...resource, sessionId })).toThrow(LeaseLostError);
    expect(snapshot(held.jobId)).not.toHaveProperty("sessionId");
    expect(repository.reconcileNativeResource(successor)).toMatchObject({ sessionId, state: "quarantined" });
    expect(repository.nativePredispatchProof(successor)).toBe(false);
    expect(repository.accounting()).toEqual(before);
    expect(() => repository.nativeResource(successor, { ...resource, sessionId, sessionAllocationAttempted: false }))
      .toThrow();
  });

  it("prevents extension identity reuse across launches", () => {
    const first = claim(), second = claim();
    const resource = uploaded(first);
    repository.nativeResource(second, intent);
    expect(() => repository.nativeResource(second, resource)).toThrow("already_bound");
    expect(snapshot(second.jobId)).toEqual(intent);
  });

  it("recovers strict predispatch native cleanup without treating metadata absence as proof", async () => {
    const held = claim();
    const resource = uploaded(held);
    repository.nativeResource(held, { ...resource, state: "quarantined" });
    time += repository.policy.leaseMs + 1;
    const successor = repository.claim("successor", admission)!;
    const deps: WorkerDependencies = {
      launch: vi.fn(), artifacts: vi.fn(),
      recover: async (request) => {
        expect(request.native).toMatchObject({ resource: { ...resource, state: "quarantined" }, predispatchProven: true });
        request.native!.onResource({ ...resource, state: "delete_intent" });
        request.native!.onResource({ ...resource, state: "deleted" });
        return { confirmed: true, sessions: [], nativeResourceConfirmed: true, allocationAttempted: false };
      },
    };
    await new DurableWorker(repository, deps, 4321).executeClaim(successor, new AbortController().signal);
    expect(repository.attemptSummaries(owner, held.runId)[0].launchState).toBe("settled");
    expect(repository.accounting().releasedSeconds).toBe(240);
    expect(repository.accounting().consumedSeconds).toBe(0);
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("retains unknown upload reservations despite a never-allocated browser result", () => {
    const held = claim();
    repository.nativeResource(held, intent);
    repository.nativeResource(held, { ...intent, state: "upload_unconfirmed" });
    const usage: NativeCloudUsage = { reservedSeconds: 240, elapsedSeconds: 1, allocationAttempted: false, gatewayDispatches: 0 };
    repository.finish(held, { ...terminal, status: "infrastructure_failed", cleanup: { status: "failed", errors: ["unknown upload"] } }, usage);
    expect(repository.attemptSummaries(owner, held.runId)[0].launchState).toBe("recovering");
    expect(repository.accounting().releasedSeconds).toBe(0);
    time += 5000;
    const successor = repository.claim("successor", admission)!;
    repository.recover(successor, { confirmed: false, sessions: [] });
    expect(JSON.parse(String(database.prepare("SELECT usage FROM launches WHERE job_id=?").get(held.jobId)?.usage)))
      .toMatchObject({ gatewayDispatches: 0 });
  });

  it("does not settle a native resource on terminal session usage alone", () => {
    const held = claim();
    const resource = { ...uploaded(held), state: "allocated" as const, sessionAllocationAttempted: true, sessionId: randomUUID() };
    repository.nativeResource(held, resource);
    repository.sessionReference(held, { sessionId: resource.sessionId, liveViewUrl: "",
      replayUrl: `https://www.browserbase.com/sessions/${resource.sessionId}`, timeoutSeconds: 240 });
    repository.nativeResource(held, { ...resource, state: "quarantined" });
    const usage: NativeCloudUsage = { reservedSeconds: 240, elapsedSeconds: 1, remoteStatus: "COMPLETED",
      actualBrowserSeconds: 1, gatewayDispatches: 7 };
    repository.finish(held, terminal, usage);
    expect(repository.attemptSummaries(owner, held.runId)[0].launchState).toBe("recovering");
    expect(repository.accounting().releasedSeconds).toBe(0);
    time += 5000;
    const successor = repository.claim("successor", admission)!;
    repository.recover(successor, { confirmed: false, sessions: [] });
    expect(JSON.parse(String(database.prepare("SELECT usage FROM launches WHERE job_id=?").get(held.jobId)?.usage)))
      .toMatchObject({ gatewayDispatches: 7 });
  });

  it.each(["ERROR", "TIMED_OUT"])("settles proven %s retirement as infrastructure failure, never successful acceptance", (status) => {
    const held = claim();
    const resource = { ...uploaded(held), state: "allocated" as const, sessionAllocationAttempted: true, sessionId: randomUUID() };
    repository.nativeResource(held, resource);
    repository.nativeResource(held, { ...resource, state: "delete_intent" });
    repository.nativeResource(held, { ...resource, state: "deleted" });
    const readback = { sessionId: resource.sessionId, status,
      startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:02Z" };
    repository.recover(held, { confirmed: true, nativeResourceConfirmed: true,
      sessions: [{ sessionId: resource.sessionId, status, actualBrowserSeconds: 2,
        nativeClosure: { ...readback, independent: readback } }] });
    expect(repository.attemptSummaries(owner, held.runId)[0].launchState).toBe("settled");
    expect(repository.getRun(owner, held.runId).status).toBe("infrastructure_failed");
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, consumedSeconds: 2, releasedSeconds: 238 });
  });

  it.each(["ERROR", "TIMED_OUT"])("does not settle %s solely on forged terminal status and resource-confirmed flag", (status) => {
    const held = claim();
    const resource = { ...uploaded(held), state: "allocated" as const, sessionAllocationAttempted: true, sessionId: randomUUID() };
    repository.nativeResource(held, resource);
    repository.nativeResource(held, { ...resource, state: "delete_intent" });
    repository.nativeResource(held, { ...resource, state: "deleted" });
    repository.recover(held, { confirmed: true, nativeResourceConfirmed: true,
      sessions: [{ sessionId: resource.sessionId, status, actualBrowserSeconds: 2 }] });
    expect(repository.attemptSummaries(owner, held.runId)[0].launchState).toBe("recovering");
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, consumedSeconds: 2, releasedSeconds: 0 });
  });

  it.each(["identity", "status", "timestamps", "duration"])("rejects an inconsistent native retirement %s proof", (field) => {
    const held = claim();
    const resource = { ...uploaded(held), state: "allocated" as const, sessionAllocationAttempted: true, sessionId: randomUUID() };
    repository.nativeResource(held, resource);
    repository.nativeResource(held, { ...resource, state: "delete_intent" });
    repository.nativeResource(held, { ...resource, state: "deleted" });
    const readback = { sessionId: resource.sessionId, status: "ERROR",
      startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:02Z" };
    repository.recover(held, { confirmed: true, nativeResourceConfirmed: true, sessions: [{
      sessionId: resource.sessionId, status: "ERROR", actualBrowserSeconds: field === "duration" ? 0 : 2,
      nativeClosure: { ...readback, independent: { ...readback,
        ...(field === "identity" ? { sessionId: randomUUID() } : {}),
        ...(field === "status" ? { status: "COMPLETED" } : {}),
        ...(field === "timestamps" ? { endedAt: "2026-01-01T00:00:03Z" } : {}),
      } },
    }] });
    expect(repository.attemptSummaries(owner, held.runId)[0].launchState).toBe("recovering");
    expect(repository.accounting().releasedSeconds).toBe(0);
  });

  it("passes public-only options, exact criteria and no contexts, fixture oracle, or takeover", async () => {
    const held = claim();
    const prepare = vi.spyOn(repository, "prepareContext");
    const takeover = vi.spyOn(repository, "takeoverControl");
    const usage: NativeCloudUsage = { reservedSeconds: 240, elapsedSeconds: 1, allocationAttempted: true, gatewayDispatches: 3 };
    const deps: WorkerDependencies = {
      publicEnabled: true, publicImplementationReady: true,
      launch: vi.fn(async () => { throw new Error("fixture_forbidden"); }),
      launchPublic: vi.fn(async (options) => {
        expect(options).toMatchObject({ mode: "public-readonly", executionPolicy: PUBLIC_EXECUTION_POLICY,
          assetPolicy: PUBLIC_ASSET_POLICY, targetUrl: scope.targetUrl, scope, criteria,
          runId: held.runId, personaId: held.attempt.persona.id, correlationToken: held.correlationToken });
        for (const field of ["fixtures", "fixturePort", "controlledSiteId", "contextReference", "demoVerifier"]) {
          expect(options).not.toHaveProperty(field);
        }
        expect(options.onResource(intent)).toBeUndefined();
        const uploaded: NativeResource = { ...intent, state: "uploaded", extensionId: randomUUID() };
        options.onResource(uploaded);
        const resource: NativeResource = { ...uploaded, state: "allocated", sessionAllocationAttempted: true, sessionId: randomUUID() };
        options.onResource(resource);
        await options.onSession({ sessionId: resource.sessionId!, liveViewUrl: "",
          replayUrl: `https://www.browserbase.com/sessions/${resource.sessionId}`, timeoutSeconds: 240 });
        return {
          usage,
          driver: { observe: vi.fn(), act: vi.fn(), close: async () => {
            options.onResource({ ...resource, state: "delete_intent" });
            options.onResource({ ...resource, state: "deleted" });
            usage.remoteStatus = "COMPLETED"; usage.actualBrowserSeconds = 2;
            usage.nativeResource = resource;
            return { status: "closed" as const, errors: [] };
          } },
          brain: { decide: vi.fn() },
        };
      }),
      artifacts: vi.fn(() => ({ screenshot: vi.fn(), json: vi.fn(), telemetry: vi.fn() })),
      recover: vi.fn(),
      execute: vi.fn(async (input, adapters) => {
        expect(input.criteria).toEqual(criteria);
        expect(adapters.control).toBeUndefined();
        await adapters.driver.close();
        return terminal;
      }),
    };
    await new DurableWorker(repository, deps, 4321).executeClaim(held, new AbortController().signal);
    expect(repository.getRun(owner, held.runId).status).toBe("succeeded");
    expect(prepare).not.toHaveBeenCalled();
    expect(takeover).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.launchPublic).toHaveBeenCalledOnce();
    const usageRow = database.prepare("SELECT usage FROM launches WHERE job_id=?").get(held.jobId);
    expect(JSON.parse(String(usageRow?.usage))).toMatchObject({ gatewayDispatches: 3 });
    expect(String(usageRow?.usage)).not.toMatch(/nativeResource|extensionId|archiveSha256/);
    expect(JSON.stringify(repository.attemptSummaries(owner, held.runId))).not.toContain("gatewayDispatches");
    expect(repository.accounting().consumedSeconds).toBe(2);
  });

  it.each(["missing", "disabled", "not-ready"])("blocks %s public implementation before launch/artifacts", async (mode) => {
    const held = claim();
    const deps: WorkerDependencies = {
      publicEnabled: mode !== "disabled", publicImplementationReady: mode !== "not-ready",
      ...(mode !== "missing" ? { launchPublic: vi.fn() } : {}),
      launch: vi.fn(), artifacts: vi.fn(), recover: vi.fn(),
    };
    await new DurableWorker(repository, deps, 4321).executeClaim(held, new AbortController().signal);
    expect(repository.getRun(owner, held.runId).status).toBe("blocked");
    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.artifacts).not.toHaveBeenCalled();
    expect(repository.accounting().releasedSeconds).toBe(240);
  });

  it("settles pre-start cancellation without allocating or changing the native gate", async () => {
    const held = claim();
    repository.cancelRun(owner, held.runId);
    const deps: WorkerDependencies = { publicEnabled: true, publicImplementationReady: true,
      launchPublic: vi.fn(), launch: vi.fn(), artifacts: vi.fn(), recover: vi.fn(), diagnostic: vi.fn() };
    await new DurableWorker(repository, deps, 4321).executeClaim(held, new AbortController().signal);
    expect(repository.getRun(owner, held.runId).status).toBe("cancelled");
    expect(deps.launchPublic).not.toHaveBeenCalled();
    expect(repository.accounting().releasedSeconds).toBe(240);
  });

  it("allows durable native cleanup after startup cancellation without dispatching a session", async () => {
    const held = claim();
    const remove = vi.fn(async () => {});
    const deps: WorkerDependencies = { publicEnabled: true, publicImplementationReady: true,
      launch: vi.fn(), recover: vi.fn(), diagnostic: vi.fn(),
      artifacts: () => ({ screenshot: vi.fn(), json: vi.fn(), telemetry: vi.fn() }),
      launchPublic: async (options) => {
        const resources = new NativeResources(intent.archiveSha256, {
          upload: async () => ({ id: randomUUID() }), delete: remove, deleted: async () => true,
        }, options.onResource);
        await resources.upload(options.assertActive);
        repository.cancelRun(owner, held.runId);
        expect(options.assertActive).toThrow("cancel_requested");
        await resources.close();
        throw new CloudStartupError({ status: "closed", errors: [] },
          { reservedSeconds: 240, elapsedSeconds: 0, allocationAttempted: false }, "native_launch");
      } };
    await new DurableWorker(repository, deps, 4321).executeClaim(held, new AbortController().signal);
    expect(remove).toHaveBeenCalledOnce();
    expect(snapshot(held.jobId)).toMatchObject({ state: "deleted", sessionAllocationAttempted: false });
    expect(repository.getRun(owner, held.runId).status).toBe("cancelled");
    expect(repository.accounting().releasedSeconds).toBe(240);
  });

  it("classifies public startup faults as infrastructure and preserves unknown native resources", async () => {
    const held = claim();
    const deps: WorkerDependencies = { publicEnabled: true, publicImplementationReady: true,
      launch: vi.fn(), artifacts: () => ({ screenshot: vi.fn(), json: vi.fn(), telemetry: vi.fn() }),
      recover: vi.fn(), diagnostic: vi.fn(),
      launchPublic: async (options) => {
        options.onResource(intent);
        options.onResource({ ...intent, state: "quarantined" });
        throw new CloudStartupError({ status: "failed", errors: ["upload unknown"] },
          { reservedSeconds: 240, elapsedSeconds: 1, allocationAttempted: false }, "native_upload");
      } };
    await new DurableWorker(repository, deps, 4321).executeClaim(held, new AbortController().signal);
    expect(repository.attemptSummaries(owner, held.runId)[0]).toMatchObject({
      launchState: "recovering", summary: { cleanup: { status: "failed" } },
    });
    expect(JSON.parse(String(database.prepare("SELECT summary FROM launches WHERE job_id=?").get(held.jobId)?.summary)))
      .toMatchObject({ status: "infrastructure_failed" });
    expect(repository.accounting().releasedSeconds).toBe(0);
  });
});
