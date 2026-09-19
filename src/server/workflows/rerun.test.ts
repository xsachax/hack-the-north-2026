import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { personas } from "../../lib/personas";
import { personaSchema } from "../../lib/contracts";
import { demoCriteria } from "../../lib/demo-run";
import type { RerunRequest } from "../../lib/rerun-contracts";
import { Repository } from "../repository";
import { ComparisonService } from "./comparison";
import { rerunMigration } from "./rerun-migration";
import { takeoverMigration } from "./takeover";

describe("durable immutable scoped reruns", () => {
  let dir: string, repository: Repository, db: DatabaseSync, owner: string, other: string;
  beforeEach(() => {
    dir = join(process.cwd(), `.rerun-test-${randomUUID()}`);
    repository = new Repository(dir);
    db = new DatabaseSync(join(dir, "flash-flood.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='rerun_runs'").get()) db.exec(rerunMigration);
    owner = repository.createSession().ownerId;
    other = repository.createSession().ownerId;
  });
  afterEach(() => { db.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = (who = owner, personaIds: string[] = [personas[0].id, personas[1].id]) =>
    repository.createDemoRun(who, randomUUID(), {
      authorizationAcknowledged: true, scenario: "second-coupon",
      assignments: personaIds.map((personaId) => ({
        personaId, goal: "Buy the mug using both advertised coupons", criteria: [...demoCriteria],
        limits: { maxSteps: 11, maxModelCalls: 13, maxDurationMs: 120000 },
      })),
    }).run;
  const request = (runId: string): RerunRequest => ({
    authorizationAcknowledged: true, attemptIds: [repository.attempts(owner, runId)[0].id],
  });
  const rejected = (fn: () => unknown, status = 404) => expect(fn).toThrow(expect.objectContaining({ status }));

  it("copies only selected immutable snapshots, creates fresh jobs, and never changes parent sources", () => {
    const parent = create();
    const attempts = repository.attempts(owner, parent.id);
    const parentRows = ["runs", "attempts", "events", "jobs"].map((table) =>
      db.prepare(`SELECT * FROM ${table} WHERE ${table === "runs" ? "id" : "run_id"}=?`).all(parent.id));
    const child = repository.createRerun(owner, randomUUID(), parent.id, request(parent.id));
    expect(child.created).toBe(true);
    expect(child.run.scope).toEqual(parent.scope);
    expect(child.run.executionMode).toBe("controlled-fixture");
    const cloned = repository.attempts(owner, child.run.id);
    expect(cloned).toHaveLength(1);
    expect(cloned[0]).toEqual({ ...attempts[0], id: cloned[0].id, runId: child.run.id,
      createdAt: cloned[0].createdAt, updatedAt: cloned[0].updatedAt, status: "queued" });
    expect(cloned[0].id).not.toBe(attempts[0].id);
    expect(repository.rerunLineage(owner, parent.id, child.run.id)).toEqual([
      { parentAttemptId: attempts[0].id, childAttemptId: cloned[0].id },
    ]);
    expect(db.prepare("SELECT scenario FROM runs WHERE id=?").get(child.run.id)?.scenario).toBe("second-coupon");
    expect(db.prepare("SELECT * FROM launches WHERE job_id IN (SELECT id FROM jobs WHERE run_id=?)").all(child.run.id)).toEqual([]);
    expect(db.prepare("SELECT * FROM evidence WHERE run_id=?").all(child.run.id)).toEqual([]);
    expect(db.prepare("SELECT * FROM usage_reservations WHERE job_id IN (SELECT id FROM jobs WHERE run_id=?)").all(child.run.id))
      .toEqual([expect.objectContaining({ reserved_seconds: 0, consumed_seconds: 0, released_seconds: 0 })]);
    for (const [index, table] of ["runs", "attempts", "events", "jobs"].entries()) {
      expect(db.prepare(`SELECT * FROM ${table} WHERE ${table === "runs" ? "id" : "run_id"}=?`).all(parent.id)).toEqual(parentRows[index]);
    }
  });

  it("survives lost replies and process restarts after editing and deleting a custom persona", () => {
    const { id, ...profile } = personaSchema.parse(personas[0]);
    const custom = repository.createPersona(owner, profile);
    expect(custom.id).not.toBe(id);
    const parent = create(owner, [custom.id]);
    const body = request(parent.id);
    repository.updatePersona(owner, custom.id, { ...profile, name: "New profile name" });
    repository.deletePersona(owner, custom.id);
    const key = randomUUID();
    const first = repository.createRerun(owner, key, parent.id, body);
    expect(repository.attempts(owner, first.run.id)[0].persona).toEqual(custom);
    repository.close();
    repository = new Repository(dir);
    const retry = repository.createRerun(owner, key, parent.id, body);
    expect(retry).toEqual({ run: first.run, created: false });
    expect(db.prepare("SELECT count(*) AS n FROM rerun_runs WHERE parent_run_id=?").get(parent.id)?.n).toBe(1);
    rejected(() => repository.createRerun(owner, key, parent.id, { ...body, scenario: "fixed" }), 409);
    rejected(() => repository.createDemoRun(owner, key, {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: custom.id, goal: "Buy", criteria: [...demoCriteria] }],
    }), 409);
  });

  it("permits only an explicit immutable store scenario variant, without broadening scope", () => {
    const parent = create();
    const child = repository.createRerun(owner, randomUUID(), parent.id, { ...request(parent.id), scenario: "fixed" }).run;
    expect(db.prepare("SELECT scenario FROM runs WHERE id=?").get(child.id)?.scenario).toBe("fixed");
    expect(db.prepare("SELECT scenario FROM runs WHERE id=?").get(parent.id)?.scenario).toBe("second-coupon");
    expect(child.scope).toEqual(parent.scope);
    const board = repository.createControlledRun(owner, randomUUID(), {
      authorizationAcknowledged: true, controlledSiteId: "project-board",
      scope: { targetPath: "/project-board/new", pathPrefixes: ["/project-board/new"] },
      assignments: [{ personaId: personas[0].id, goal: "See the form", criteria: ["The form is visible"] }],
    }).run;
    const boardChild = repository.createRerun(owner, randomUUID(), board.id, request(board.id)).run;
    expect(boardChild.scope).toEqual(board.scope);
    expect(boardChild.controlledSiteId).toBe("project-board");
    rejected(() => repository.createRerun(owner, randomUUID(), board.id, { ...request(board.id), scenario: "fixed" }), 400);
  });

  it("does not inherit an original attempt's saved/returning browser state or context reference", () => {
    const parent = create();
    const body = request(parent.id);
    const browserState = { mode: "returning", contextId: randomUUID(), persist: true, acknowledgeSensitiveStorage: true };
    db.prepare("UPDATE attempts SET snapshot=json_set(snapshot,'$.browserState',json(?)) WHERE id=?")
      .run(JSON.stringify(browserState), body.attemptIds[0]);
    const child = repository.createRerun(owner, randomUUID(), parent.id, body).run;
    expect(repository.attempts(owner, parent.id)[0].browserState).toEqual(browserState);
    expect(repository.attempts(owner, child.id)[0].browserState).toBeUndefined();
    expect(JSON.stringify(repository.attempts(owner, child.id))).not.toContain(browserState.contextId);
  });

  it("admits controlled context selection atomically but leaves every scoped rerun fresh", () => {
    const parent = repository.createControlledRun(owner, randomUUID(), {
      authorizationAcknowledged: true, controlledSiteId: "store",
      assignments: [{ personaId: personas[0].id, goal: "Buy the mug", criteria: [...demoCriteria],
        browserState: { mode: "save", acknowledgeSensitiveStorage: true } }],
    }).run;
    const original = repository.attempts(owner, parent.id)[0];
    expect(original.browserState).toEqual({ mode: "save", acknowledgeSensitiveStorage: true });
    expect(repository.contexts.list(owner)).toHaveLength(1);
    const child = repository.createRerun(owner, randomUUID(), parent.id, request(parent.id)).run;
    expect(repository.attempts(owner, child.id)[0].browserState).toBeUndefined();
    expect(repository.contexts.list(owner)).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM context_selections WHERE attempt_id IN (SELECT id FROM attempts WHERE run_id=?)")
      .get(child.id)?.n).toBe(0);
  });

  it("rejects nonfresh website state without creating runs, jobs or context selections", () => {
    rejected(() => repository.createRun(owner, randomUUID(), {
      authorizationAcknowledged: true,
      scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
      assignments: [{ personaId: personas[0].id, goal: "Help", criteria: ["Help is visible"],
        browserState: { mode: "save", acknowledgeSensitiveStorage: true } }],
    }), 400);
    expect(db.prepare("SELECT count(*) AS n FROM runs WHERE owner_id=?").get(owner)?.n).toBe(0);
    expect(repository.contexts.list(owner)).toEqual([]);
  });

  it("fails closed for foreign parents, foreign attempt IDs, unrelated child IDs, and forged lineage", () => {
    const parent = create(), foreign = create(other), unrelated = create();
    const body = request(parent.id);
    rejected(() => repository.createRerun(other, randomUUID(), parent.id, body));
    rejected(() => repository.createRerun(owner, randomUUID(), parent.id, {
      ...body, attemptIds: [repository.attempts(other, foreign.id)[0].id],
    }));
    rejected(() => repository.createRerun(owner, randomUUID(), parent.id, {
      ...body, attemptIds: [repository.attempts(owner, unrelated.id)[0].id],
    }));
    const child = repository.createRerun(owner, randomUUID(), parent.id, body).run;
    const service = new ComparisonService(repository, (entry) => ({ ...entry, state: "missing" }));
    rejected(() => service.compare(other, parent.id, child.id));
    rejected(() => service.compare(owner, foreign.id, child.id));
    rejected(() => service.compare(owner, parent.id, foreign.id));
    rejected(() => service.compare(owner, parent.id, unrelated.id));
    rejected(() => service.compare(owner, unrelated.id, child.id));
    db.prepare("UPDATE rerun_attempts SET parent_attempt_id=? WHERE child_run_id=?")
      .run(repository.attempts(other, foreign.id)[0].id, child.id);
    rejected(() => service.compare(owner, parent.id, child.id));
  });

  it("rejects corrupt actual SQL/snapshot identity instead of trusting JSON metadata", () => {
    const parent = create();
    const body = request(parent.id);
    db.prepare("UPDATE attempts SET snapshot=json_set(snapshot,'$.runId',?) WHERE id=?").run(randomUUID(), body.attemptIds[0]);
    rejected(() => repository.createRerun(owner, randomUUID(), parent.id, body));
    expect(db.prepare("SELECT count(*) AS n FROM rerun_runs").get()?.n).toBe(0);
  });

  it("loads durable human intervention markers owner-scoped, including after handback and restart", () => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='takeover_intervals'").get()) db.exec(takeoverMigration);
    const parent = create(), foreign = create(other);
    const parentAttempt = repository.attempts(owner, parent.id)[0].id;
    const child = repository.createRerun(owner, randomUUID(), parent.id, request(parent.id)).run;
    db.prepare("INSERT INTO takeover_intervals VALUES(?,?,?,?,'handback')").run(parentAttempt, 2, 1000, 2000);
    db.prepare("INSERT INTO takeover_intervals VALUES(?,?,?,NULL,NULL)").run(repository.attempts(other, foreign.id)[0].id, 2, 1000);
    repository.close();
    repository = new Repository(dir);
    expect(repository.reportSource(owner, parent.id).humanAssistedAttemptIds).toEqual([parentAttempt]);
    expect(repository.reportSource(owner, child.id).humanAssistedAttemptIds).toEqual([]);
    rejected(() => repository.reportSource(owner, foreign.id));
    const service = new ComparisonService(repository, (entry) => ({ ...entry, state: "missing" }));
    expect(service.compare(owner, parent.id, child.id).pairs[0]).toMatchObject({
      comparable: false, parentHumanAssisted: true, childHumanAssisted: false,
    });
  });

  it("shares ordinary durable run quotas and blocks website reruns", () => {
    const parent = create();
    for (let n = 0; n < 4; n++) repository.createRerun(owner, randomUUID(), parent.id, request(parent.id));
    rejected(() => repository.createRerun(owner, randomUUID(), parent.id, request(parent.id)), 429);
    const website = repository.createRun(other, randomUUID(), {
      authorizationAcknowledged: true, scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
      assignments: [{ personaId: personas[0].id, goal: "Help", criteria: ["Help is visible"] }],
    }).run;
    rejected(() => repository.createRerun(other, randomUUID(), website.id, {
      authorizationAcknowledged: true, attemptIds: [repository.attempts(other, website.id)[0].id],
    }), 400);
  });
});
