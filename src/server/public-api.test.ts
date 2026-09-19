import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunSchema, runSchema } from "../lib/contracts";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../lib/public-execution";
import { capabilitiesSchema } from "../lib/ui-contracts";
import { personas } from "../lib/personas";
import { createApi, publicExecutionCapability, type ApiConfiguration } from "./api";
import { migrations } from "./migrations";
import { Repository } from "./repository";
import { WorkerRepository } from "./worker/repository";

// Future admission contracts only; real checkpoint readiness is tested without this mock.
vi.mock("./public-execution-readiness", () => ({ PUBLIC_EXECUTION_IMPLEMENTATION_READY: true }));

const origin = "http://127.0.0.1:3000";
const legacy = () => createRunSchema.parse({
  authorizationAcknowledged: true,
  scope: { targetUrl: "https://example.com/help", allowedSubdomains: [], pathPrefixes: ["/help"] },
  assignments: [{
    personaId: "careful-first-timer", goal: "Read the help page",
    criteria: [{ id: "help-heading", kind: "visible_text", semantics: "current", description: "Help is visible", text: "Help", match: "contains" }],
  }],
});
const input = () => createRunSchema.parse({
  ...legacy(), executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
});

describe("explicit public admission without a browser or provider", () => {
  let directory: string;
  let repository: Repository;
  let owner: ReturnType<Repository["createSession"]>;
  let other: typeof owner;
  const api = (configuration: Partial<ApiConfiguration> = {}) => createApi({
    repository, validateScope: async (scope) => scope,
    configuration: { origin, production: false, accessCode: "a".repeat(32), allowPublicRuns: true, publicExecutionReady: true, ...configuration },
  });
  const request = (body: unknown = input(), options: {
    path?: string; session?: typeof owner; headers?: Record<string, string>; method?: string; key?: string;
  } = {}) => {
    const { path = "runs", session = owner, headers = {}, method = "POST", key = randomUUID() } = options;
    return new Request(`${origin}/api/v1/${path}`, {
      method, headers: { origin, cookie: `ff_owner=${session.token}`, "x-csrf-token": session.csrf,
        "content-type": "application/json", "idempotency-key": key, ...headers },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  };
  beforeEach(() => {
    directory = resolve(`.public-api-${randomUUID()}`);
    repository = new Repository(directory);
    owner = repository.createSession();
    other = repository.createSession();
  });
  afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });

  it("still requires configured readiness in the future-contract harness", async () => {
    const handle = api({ publicExecutionReady: false });
    const response = await handle(request(undefined, { path: "capabilities", method: "GET", headers: { cookie: "" } }));
    const capabilities = capabilitiesSchema.parse((await response.json()).data);
    expect(capabilities).toMatchObject({ publicExecutionEnabled: false, publicExecutionReason: "implementation_not_ready", websiteExecutionEnabled: false });
    expect((await handle(request())).status).toBe(503);
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
  });

  it.each([
    { allowPublicRuns: false }, { allowPublicRuns: undefined }, { publicExecutionReady: false },
    { publicExecutionReady: undefined }, { accessCode: undefined }, { accessCode: "a".repeat(31) },
  ])("requires trusted readiness, opt-in flag and a strong access code: %j", async (configuration) => {
    expect((await api(configuration)(request())).status).toBe(503);
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
  });

  it.each([0, 60, 79, 80, 80.5, 301, NaN, Infinity])("rejects unsupported public TTL %s before creating work", async (publicSessionTimeoutSeconds) => {
    const handle = api({ publicSessionTimeoutSeconds });
    const response = await handle(request(undefined, { path: "capabilities", method: "GET" }));
    expect(capabilitiesSchema.parse((await response.json()).data)).toMatchObject({
      publicExecutionEnabled: false, publicExecutionReason: "session_timeout_unsupported",
    });
    const admission = await handle(request());
    expect(admission.status).toBe(503);
    expect((await admission.json()).error.code).toBe("public_session_timeout_unsupported");
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
  });

  it.each([81, 90, 300])("allows offline public admission above the 80-second reserve at TTL %s", async (publicSessionTimeoutSeconds) => {
    const handle = api({ publicSessionTimeoutSeconds });
    const response = await handle(request(undefined, { path: "capabilities", method: "GET" }));
    expect(capabilitiesSchema.parse((await response.json()).data)).toMatchObject({
      publicExecutionEnabled: true, publicExecutionReason: "ready",
    });
    expect((await handle(request())).status).toBe(201);
  });

  it.each([[80, 240, false], [240, 80, false], [81, 81, true]] as const)(
    "requires both persisted worker TTL %s and configured TTL %s to support the reserve",
    async (sessionSeconds, publicSessionTimeoutSeconds, supported) => {
      const worker = new WorkerRepository(directory, { sessionSeconds });
      worker.close();
      repository.close();
      repository = new Repository(directory);
      expect(repository.persistedSessionTimeoutSeconds()).toBe(sessionSeconds);
      const handle = api({ publicSessionTimeoutSeconds });
      const response = await handle(request(undefined, { path: "capabilities", method: "GET" }));
      expect(capabilitiesSchema.parse((await response.json()).data).publicExecutionEnabled).toBe(supported);
      expect((await handle(request())).status).toBe(supported ? 201 : 503);
    },
  );

  it("preserves controlled 30-second execution limits when public TTL admission is disabled", async () => {
    const worker = new WorkerRepository(directory, { sessionSeconds: 90 });
    worker.close();
    const handle = api({ publicSessionTimeoutSeconds: 80, allowDemoRuns: true });
    const response = await handle(request(undefined, { path: "capabilities", method: "GET" }));
    expect(capabilitiesSchema.parse((await response.json()).data)).toMatchObject({
      controlledRunsEnabled: true, publicExecutionEnabled: false, executionLimits: { maxDurationMs: 30_000 },
    });
    expect((await handle(request({
      authorizationAcknowledged: true, controlledSiteId: "store", assignments: legacy().assignments,
    }, { path: "controlled-runs" }))).status).toBe(201);
    expect((await handle(request())).status).toBe(503);
  });

  it.each([
    [{ cookie: "" }, 401], [{ "x-csrf-token": "" }, 403], [{ origin: "https://attacker.example" }, 403],
    [{ origin: `${origin}/` }, 403], [{ host: "attacker.example" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403], [{ "idempotency-key": "" }, 400],
  ] as const)("retains exact origin, session and mutation guards: %j", async (headers, status) => {
    expect((await api()(request(input(), { headers }))).status).toBe(status);
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
  });

  it.each([
    { authorizationAcknowledged: false }, { executionPolicy: undefined }, { assetPolicy: undefined },
    { executionPolicy: "latest" }, { assetPolicy: "all-assets" }, { executionPolicy: null },
    { executionMode: "public-readonly" }, { publicExecutionReady: true },
  ])("rejects missing, forged and unknown immutable policies: %j", async (patch) => {
    expect((await api()(request({ ...input(), ...patch }))).status).toBe(400);
  });

  it.each([
    { mode: "save", acknowledgeSensitiveStorage: true },
    { mode: "returning", contextId: randomUUID(), acknowledgeSensitiveStorage: true },
  ])("rejects non-fresh state before queue admission: %j", async (browserState) => {
    const value = input();
    expect((await api()(request({ ...value, assignments: [{ ...value.assignments[0], browserState }] }))).status).toBe(400);
  });

  it("persists canonical policies, general criteria, owner scope and exact idempotency across reopen", async () => {
    const key = randomUUID();
    const response = await api()(request(input(), { key }));
    expect(response.status).toBe(201);
    const run = runSchema.parse((await response.json()).data);
    expect(run).toMatchObject({ executionMode: "public-readonly", executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY });
    expect(repository.attempts(owner.ownerId, run.id)[0].criteria).toEqual(input().assignments[0].criteria);
    repository.close();
    repository = new Repository(directory);
    expect(repository.getRun(owner.ownerId, run.id)).toEqual(run);
    expect((await api()(request(input(), { key }))).status).toBe(200);
    expect((await api()(request(legacy(), { key }))).status).toBe(409);
    expect((await api()(request(undefined, { path: `runs/${run.id}`, method: "GET", session: other }))).status).toBe(404);
    expect((await api()(request({}, { path: `runs/${run.id}/cancel`, session: other }))).status).toBe(404);
    expect(repository.attemptSummaries(owner.ownerId, run.id)[0]).toMatchObject({ launchState: "not_launched", reservedSeconds: 0 });
    expect(repository.sessionViews(owner.ownerId, run.id)).toEqual([]);
  });

  it("rejects public takeover, rerun and reproduction specifically without leaking another owner's run", async () => {
    const run = repository.createRun(owner.ownerId, randomUUID(), input()).run;
    const attempt = repository.attempts(owner.ownerId, run.id)[0];
    for (const [path, code] of [
      [`attempts/${attempt.id}/takeover`, "public_takeover_unsupported"],
      [`runs/${run.id}/reruns`, "public_rerun_unsupported"],
      [`runs/${run.id}/reproductions`, "public_reproduction_unsupported"],
    ]) {
      const method = path.startsWith("attempts") ? "GET" : "POST";
      const response = await api()(request({}, { path, method }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(code);
      expect((await api()(request({}, { path, method, session: other }))).status).toBe(404);
    }
    expect(() => repository.createRerun(owner.ownerId, randomUUID(), run.id, {
      authorizationAcknowledged: true, attemptIds: [attempt.id],
    })).toThrow(expect.objectContaining({ code: "public_rerun_unsupported" }));
    const worker = new WorkerRepository(directory);
    worker.close();
    expect(() => repository.reproductionService().prepare(owner.ownerId, run.id, attempt.id))
      .toThrow(expect.objectContaining({ code: "public_reproduction_unsupported" }));
    expect(repository.contexts.list(owner.ownerId)).toEqual([]);
  });

  it("never exposes private native journal identities or launch metadata through public reads", async () => {
    const run = repository.createRun(owner.ownerId, randomUUID(), input()).run;
    const privateMetadata = {
      nativeResource: { extensionId: "private-extension-canary", sessionId: "private-session-canary" },
      nativePolicy: { archiveSha256: "a".repeat(64) },
      nativeObservedBrowserVersion: "private-browser-version-canary",
    };
    const db = new DatabaseSync(resolve(directory, "flash-flood.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const job = db.prepare("SELECT id FROM jobs WHERE run_id=?").get(run.id);
      if (typeof job?.id !== "string") throw new Error("missing_test_job");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO launches(job_id,correlation_token,state,created_at,usage) VALUES(?,?,'intent',?,?)")
        .run(job.id, randomUUID(), now, JSON.stringify({ elapsedSeconds: 0, ...privateMetadata }));
      db.prepare("INSERT INTO native_resources(job_id,extension_id,resource,updated_at) VALUES(?,?,?,?)")
        .run(job.id, privateMetadata.nativeResource.extensionId, JSON.stringify(privateMetadata), now);
      db.prepare("INSERT INTO native_resource_events(job_id,resource,created_at) VALUES(?,?,?)")
        .run(job.id, JSON.stringify(privateMetadata), now);
    } finally { db.close(); }
    expect(repository.attemptSummaries(owner.ownerId, run.id)[0]).toMatchObject({
      launchState: "intent", summary: null, usage: { elapsedSeconds: 0 }, reservedSeconds: 0,
    });
    for (const suffix of ["", "/attempts", "/summaries", "/sessions", "/events", "/reports", "/exports/json"]) {
      const response = await api()(request(undefined, { path: `runs/${run.id}${suffix}`, method: "GET" }));
      expect(response.status).toBe(200);
      const body = await response.text();
      for (const privateValue of [
        "nativeResource", "nativePolicy", "extensionId", "sessionId", "archiveSha256", "nativeObservedBrowserVersion",
        privateMetadata.nativeResource.extensionId, privateMetadata.nativeResource.sessionId,
        privateMetadata.nativePolicy.archiveSha256, privateMetadata.nativeObservedBrowserVersion,
      ]) expect(body).not.toContain(privateValue);
    }
  });

  it("rejects public comparisons in both directions and repeated reruns without queueing or upgrading legacy history", async () => {
    const oldKey = randomUUID();
    const old = repository.createRun(owner.ownerId, oldKey, legacy()).run;
    const publicRun = repository.createRun(owner.ownerId, randomUUID(), input()).run;
    const publicAttempt = repository.attempts(owner.ownerId, publicRun.id)[0];
    const handle = api({ allowDemoRuns: true });
    for (const [parent, child] of [[old, publicRun], [publicRun, old], [publicRun, publicRun]]) {
      const path = `runs/${parent.id}/comparisons/${child.id}`;
      const response = await handle(request(undefined, { path, method: "GET" }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("public_comparison_unsupported");
      expect((await handle(request(undefined, { path, method: "GET", session: other }))).status).toBe(404);
    }
    const inaccessible = repository.createRun(other.ownerId, randomUUID(), input()).run;
    expect((await handle(request(undefined, {
      path: `runs/${publicRun.id}/comparisons/${inaccessible.id}`, method: "GET",
    }))).status).toBe(404);
    const key = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handle(request({
        authorizationAcknowledged: true, attemptIds: [publicAttempt.id],
      }, { path: `runs/${publicRun.id}/reruns`, key }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("public_rerun_unsupported");
    }
    expect((await handle(request(legacy(), { key: oldKey }))).status).toBe(200);
    expect((await handle(request(input(), { key: oldKey }))).status).toBe(409);
    expect(repository.getRun(owner.ownerId, old.id)).toEqual(old);
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toHaveLength(2);
    const db = new DatabaseSync(resolve(directory, "flash-flood.sqlite"));
    try {
      expect(db.prepare("SELECT count(*) AS n FROM jobs WHERE run_id IN (?,?)").get(old.id, publicRun.id)?.n).toBe(2);
      expect(db.prepare("SELECT count(*) AS n FROM runs WHERE owner_id=? AND idempotency_key=?").get(owner.ownerId, key)?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM rerun_runs").get()?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(0);
    } finally { db.close(); }
  });

  it("enforces SQL paired policy invariants and prevents upgrading or downgrading historical snapshots", () => {
    const old = repository.createRun(owner.ownerId, randomUUID(), legacy()).run;
    const run = repository.createRun(owner.ownerId, randomUUID(), input()).run;
    const db = new DatabaseSync(resolve(directory, "flash-flood.sqlite"));
    try {
      expect(db.prepare("SELECT execution_mode,public_execution_policy,public_asset_policy FROM runs WHERE id=?").get(run.id))
        .toMatchObject({ execution_mode: "website", public_execution_policy: PUBLIC_EXECUTION_POLICY, public_asset_policy: PUBLIC_ASSET_POLICY });
      for (const id of [old.id, run.id]) {
        expect(() => db.prepare("UPDATE runs SET public_execution_policy=?,public_asset_policy=? WHERE id=?")
          .run(id === old.id ? PUBLIC_EXECUTION_POLICY : null, id === old.id ? PUBLIC_ASSET_POLICY : null, id)).toThrow("immutable_execution_policy");
        expect(() => db.prepare("UPDATE runs SET execution_mode='controlled-fixture' WHERE id=?").run(id)).toThrow("immutable_execution_policy");
      }
      const insert = db.prepare(`INSERT INTO runs(id,owner_id,idempotency_key,request_hash,status,scope,created_at,updated_at,public_execution_policy,public_asset_policy)
        VALUES(?,?,?,'hash','queued',?,'now','now',?,?)`);
      for (const policies of [[PUBLIC_EXECUTION_POLICY, null], [null, PUBLIC_ASSET_POLICY], ["unknown", PUBLIC_ASSET_POLICY], [PUBLIC_EXECUTION_POLICY, "unknown"]]) {
        expect(() => insert.run(randomUUID(), owner.ownerId, randomUUID(), JSON.stringify(legacy().scope), policies[0], policies[1])).toThrow();
      }
      expect(db.prepare("SELECT count(*) AS n FROM native_resources").get()?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM native_resource_events").get()?.n).toBe(0);
    } finally { db.close(); }
  });

  it("migrates an actual old queued website request without retroactive paid work or a new idempotency hash", async () => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory);
    const db = new DatabaseSync(resolve(directory, "flash-flood.sqlite"));
    const runId = randomUUID(), attemptId = randomUUID(), jobId = randomUUID(), key = randomUUID(), now = new Date().toISOString();
    try {
      for (const migration of migrations.slice(0, -1)) db.exec(migration);
      db.exec(`PRAGMA user_version=${migrations.length - 1}`);
      db.prepare("INSERT INTO owners VALUES(?,?,?,?)").run(owner.ownerId, createHash("sha256").update(owner.token).digest("hex"), owner.csrf, owner.expiresAt);
      db.prepare(`INSERT INTO runs(id,owner_id,idempotency_key,request_hash,status,scope,created_at,updated_at)
        VALUES(?,?,?,?,'queued',?,?,?)`).run(runId, owner.ownerId, key, createHash("sha256").update(JSON.stringify(legacy())).digest("hex"), JSON.stringify(legacy().scope), now, now);
      const persona = personas.find((persona) => persona.id === "careful-first-timer")!;
      db.prepare("INSERT INTO attempts VALUES(?,?,'queued',?)").run(attemptId, runId, JSON.stringify({
        id: attemptId, runId, persona, goal: legacy().assignments[0].goal, criteria: legacy().assignments[0].criteria,
        status: "queued", createdAt: now, updatedAt: now,
      }));
      db.prepare("INSERT INTO jobs(id,run_id,attempt_id,status) VALUES(?,?,?,'queued')").run(jobId, runId, attemptId);
      db.prepare("INSERT INTO usage_reservations(job_id) VALUES(?)").run(jobId);
    } finally { db.close(); }
    repository = new Repository(directory);
    expect(repository.getRun(owner.ownerId, runId).executionMode).toBe("website");
    expect((await api()(request(legacy(), { key }))).status).toBe(200);
    expect((await api()(request(input(), { key }))).status).toBe(409);
    const worker = new WorkerRepository(directory);
    try { expect(worker.claim("historical-offline")).toBeNull(); } finally { worker.close(); }
    expect(repository.getRun(owner.ownerId, runId)).toMatchObject({ executionMode: "website", status: "blocked" });
    expect((await api()(request(legacy(), { key }))).status).toBe(200);
    expect(repository.attemptSummaries(owner.ownerId, runId)[0]).toMatchObject({ launchState: "not_launched", reservedSeconds: 0 });
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toHaveLength(1);
  });
});

it("reports precise public capability reasons without accepting an operator flag as implementation proof", () => {
  const base = { origin, production: false };
  expect(publicExecutionCapability(base).publicExecutionReason).toBe("implementation_not_ready");
  expect(publicExecutionCapability({ ...base, publicExecutionReady: true }).publicExecutionReason).toBe("operator_disabled");
  expect(publicExecutionCapability({ ...base, publicExecutionReady: true, allowPublicRuns: true }).publicExecutionReason).toBe("strong_access_code_required");
  expect(publicExecutionCapability({ ...base, publicExecutionReady: true, allowPublicRuns: true, accessCode: "x".repeat(32) }))
    .toEqual({ publicExecutionEnabled: true, publicExecutionReason: "ready" });
});
