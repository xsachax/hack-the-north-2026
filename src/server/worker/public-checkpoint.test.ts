import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../lib/config";
import { demoCriteria } from "../../lib/demo-run";
import { personas } from "../../lib/personas";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../public-execution-readiness";
import { WorkerRepository, type Claim } from "./repository";
import { DurableWorker, type WorkerDependencies } from "./runtime";

// Deliberately no readiness mock: this suite locks the real offline checkpoint.
describe("source-disabled public worker checkpoint", () => {
  let directory: string;
  let repository: WorkerRepository;
  let database: DatabaseSync;
  let owner: string;
  let dependencies: WorkerDependencies;
  const admission = { enabled: true, implementationReady: true };
  const create = (versioned = true) => repository.createRun(owner, randomUUID(), {
    authorizationAcknowledged: true,
    ...(versioned ? { executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY } : {}),
    scope: { targetUrl: "https://example.com/docs", allowedSubdomains: [], pathPrefixes: ["/docs"] },
    assignments: [{ personaId: personas[0].id, goal: "Read documentation", criteria: ["Documentation is understandable"] }],
  }).run;
  const assertBlocked = (runId: string) => {
    expect(repository.getRun(owner, runId).status).toBe("blocked");
    expect(repository.events(owner, runId, { after: 0, limit: 100 }).items).toEqual(
      expect.arrayContaining([expect.objectContaining({
        kind: "attempt.finished", data: expect.objectContaining({ status: "blocked", reason: "blocked_unsupported" }),
      })]),
    );
  };
  const assertNoWork = () => {
    expect(dependencies.launchPublic).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
    expect(dependencies.recover).not.toHaveBeenCalled();
    expect(dependencies.artifacts).not.toHaveBeenCalled();
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 0, consumedSeconds: 0, releasedSeconds: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM native_resources").get()?.n).toBe(0);
  };
  const restoreNative = (kind: "public" | "native-controlled" | "events-only"): Claim => {
    const run = kind === "public" ? create() : repository.createDemoRun(owner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: personas[0].id, goal: "Read the cart", criteria: [demoCriteria[0]] }],
    }).run;
    const attempt = repository.attempts(owner, run.id)[0];
    const jobId = String(database.prepare("SELECT id FROM jobs WHERE attempt_id=?").get(attempt.id)!.id);
    const correlationToken = randomUUID(), sessionId = randomUUID(), extensionId = randomUUID();
    const now = new Date().toISOString();
    const resource = JSON.stringify({ version: 1, archiveSha256: "a".repeat(64),
      state: "quarantined", extensionId, sessionAllocationAttempted: true, sessionId });
    database.prepare(`UPDATE jobs SET status='leased',lease_owner='previous',lease_generation=1,lease_expires_at=? WHERE id=?`)
      .run(new Date(Date.now() - 1000).toISOString(), jobId);
    database.prepare(`INSERT INTO launches(job_id,correlation_token,state,session_reference,recovery_count,created_at)
      VALUES(?,?,'recovering',?,3,?)`).run(jobId, correlationToken, JSON.stringify({
      sessionId, liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${sessionId}`, timeoutSeconds: 240,
    }), now);
    database.prepare("UPDATE usage_reservations SET reserved_seconds=240 WHERE job_id=?").run(jobId);
    if (kind !== "events-only") database.prepare(
      "INSERT INTO native_resources(job_id,extension_id,resource,updated_at) VALUES(?,?,?,?)").run(jobId, extensionId, resource, now);
    database.prepare("INSERT INTO native_resource_events(job_id,resource,created_at) VALUES(?,?,?)").run(jobId, resource, now);
    return { jobId, runId: run.id, ownerId: owner, workerId: "previous", generation: 1, attempt,
      correlationToken, sessionId, scope: run.scope, recovery: true, executionMode: run.executionMode,
      ...(kind === "public" ? { executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY } : {}) };
  };
  const durableState = (jobId: string) => ({
    job: database.prepare("SELECT status,lease_owner,lease_generation,lease_expires_at FROM jobs WHERE id=?").get(jobId),
    launch: database.prepare("SELECT state,session_reference,usage,recovery_count,recovery_after FROM launches WHERE job_id=?").get(jobId),
    resources: database.prepare("SELECT extension_id,resource,updated_at FROM native_resources WHERE job_id=?").all(jobId),
    discoveries: database.prepare("SELECT sequence,resource,created_at FROM native_resource_events WHERE job_id=?").all(jobId),
    accounting: repository.accounting(),
  });
  beforeEach(() => {
    vi.stubEnv("ENABLE_PUBLIC_RUNS", "true");
    vi.stubEnv("PUBLIC_EXECUTION_IMPLEMENTATION_READY", "true");
    expect(PUBLIC_EXECUTION_IMPLEMENTATION_READY).toBe(false);
    directory = join(process.cwd(), `.public-checkpoint-${randomUUID()}`);
    mkdirSync(directory, { mode: 0o700 });
    repository = new WorkerRepository(directory);
    database = new DatabaseSync(join(directory, "flash-flood.sqlite"));
    owner = repository.createSession().ownerId;
    const config = configSchema.parse({ BROWSERBASE_API_KEY: "offline-unused", ENABLE_PUBLIC_RUNS: process.env.ENABLE_PUBLIC_RUNS });
    dependencies = {
      publicEnabled: config.ENABLE_PUBLIC_RUNS, publicImplementationReady: true,
      launchPublic: vi.fn(async () => { throw new Error("checkpoint_public_factory_forbidden"); }),
      launch: vi.fn(async () => { throw new Error("checkpoint_fixture_fallback_forbidden"); }),
      recover: vi.fn(async () => { throw new Error("checkpoint_provider_forbidden"); }),
      artifacts: vi.fn(), diagnostic: vi.fn(),
    };
  });
  afterEach(() => {
    database.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("blocks an immutable versioned public snapshot despite trusted admission and operator enablement", () => {
    const run = create();
    expect(run).toMatchObject({ executionMode: "public-readonly",
      executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY });
    expect(repository.claim("worker", admission)).toBeNull();
    assertBlocked(run.id);
    assertNoWork();
    expect(database.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(0);
  });

  it("blocks public work in the real worker pump before factories, providers, artifacts, or reservations", async () => {
    const run = create();
    const shutdown = new AbortController();
    const task = new DurableWorker(repository, dependencies, 4321).run(shutdown.signal);
    try {
      await vi.waitFor(() => assertBlocked(run.id));
    } finally {
      shutdown.abort();
      await task;
    }
    assertNoWork();
    expect(database.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(0);
  });

  it("blocks a pre-existing unallocated public lease at execute time despite injected readiness", async () => {
    const run = create();
    const attempt = repository.attempts(owner, run.id)[0];
    const job = database.prepare("SELECT id FROM jobs WHERE attempt_id=?").get(attempt.id)!;
    const worker = new DurableWorker(repository, dependencies, 4321);
    const correlationToken = randomUUID();
    database.prepare(`UPDATE jobs SET status='leased',lease_owner=?,lease_generation=1,lease_expires_at=? WHERE id=?`)
      .run(worker.id, new Date(Date.now() + 30000).toISOString(), job.id);
    database.prepare("INSERT INTO launches(job_id,correlation_token,state,created_at) VALUES(?,?,'intent',?)")
      .run(job.id, correlationToken, new Date().toISOString());
    const held: Claim = {
      jobId: String(job.id), ownerId: owner, workerId: worker.id, generation: 1, runId: run.id,
      attempt, correlationToken, scope: run.scope, recovery: false, executionMode: "public-readonly",
      executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
    };
    expect(() => repository.assertPublicClaim(held, admission)).toThrow("blocked_unsupported");
    await worker.executeClaim(held, new AbortController().signal);
    assertBlocked(run.id);
    assertNoWork();
  });

  it("keeps historical websites blocked without blocking subsequent controlled claims", () => {
    const historical = create(false);
    const versioned = create();
    const controlled = repository.createDemoRun(owner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: personas[0].id, goal: "Read the cart", criteria: [demoCriteria[0]] }],
    }).run;
    const held = repository.claim("worker", admission);
    expect(held).toMatchObject({ runId: controlled.id, executionMode: "controlled-fixture" });
    assertBlocked(historical.id);
    assertBlocked(versioned.id);
    expect(repository.accounting().reservedSeconds).toBe(repository.policy.sessionSeconds);
    expect(database.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(1);
  });

  it.each(["public", "native-controlled", "events-only"] as const)(
    "does not auto-recover restored %s rows or alter identities/reservations on startup", async (kind) => {
      const held = restoreNative(kind);
      const before = durableState(held.jobId);
      const claimSpy = vi.spyOn(repository, "claim");
      const shutdown = new AbortController();
      const task = new DurableWorker(repository, dependencies, 4321).run(shutdown.signal);
      try {
        await vi.waitFor(() => expect(claimSpy).toHaveBeenCalled());
        expect(claimSpy.mock.results[0].value).toBeNull();
      } finally {
        shutdown.abort();
        await task;
      }
      expect(dependencies.recover).not.toHaveBeenCalled();
      expect(dependencies.launchPublic).not.toHaveBeenCalled();
      expect(dependencies.launch).not.toHaveBeenCalled();
      expect(durableState(held.jobId)).toEqual(before);
    },
  );

  it.each(["public", "native-controlled", "events-only"] as const)(
    "blocks restored %s direct execution and manual reconciliation without claiming cleanup", async (kind) => {
      const held = restoreNative(kind);
      database.prepare("UPDATE launches SET state='quarantined' WHERE job_id=?").run(held.jobId);
      const before = durableState(held.jobId);
      expect(() => repository.claimQuarantined(held.jobId, "new-worker")).toThrow("public_recovery_checkpoint_disabled");
      await new DurableWorker(repository, dependencies, 4321).executeClaim(held, new AbortController().signal);
      expect(dependencies.diagnostic).toHaveBeenCalledWith("worker_public_recovery_checkpoint_disabled");
      expect(dependencies.recover).not.toHaveBeenCalled();
      expect(dependencies.launchPublic).not.toHaveBeenCalled();
      expect(dependencies.launch).not.toHaveBeenCalled();
      expect(dependencies.artifacts).not.toHaveBeenCalled();
      expect(durableState(held.jobId)).toEqual(before);
    },
  );

  it("still acquires controlled-only recovery behind suspended native records", () => {
    const held = restoreNative("public");
    const before = durableState(held.jobId);
    const controlled = repository.createDemoRun(owner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: personas[0].id, goal: "Read the cart", criteria: [demoCriteria[0]] }],
    }).run;
    const first = repository.claim("controlled-worker")!;
    expect(first.runId).toBe(controlled.id);
    database.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), first.jobId);
    expect(repository.claim("controlled-recovery")).toMatchObject({ runId: controlled.id, recovery: true });
    expect(durableState(held.jobId)).toEqual({ ...before, accounting: repository.accounting() });
  });
});
