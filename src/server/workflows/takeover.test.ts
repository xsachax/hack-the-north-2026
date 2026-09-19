import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoCriteria } from "../../lib/demo-run";
import { personas } from "../../lib/personas";
import { takeoverCommandSchema, takeoverViewerUrl } from "../../lib/takeover-contracts";
import { TakeoverInterrupted } from "../execution/types";
import { WorkerRepository, type Claim } from "../worker/repository";
import type { TakeoverService } from "./takeover";

class TestRepository extends WorkerRepository {
  expire() { this.db.prepare("UPDATE jobs SET lease_expires_at=?").run(new Date(this.clock() - 1).toISOString()); }
  generation() { this.db.exec("UPDATE jobs SET lease_generation=lease_generation+1"); }
}

describe("durable takeover ownership and lease fences", () => {
  let directory: string;
  let repository: TestRepository;
  let service: TakeoverService;
  let claim: Claim;
  let owner: string;
  let now: number;
  let controllerId: string;
  const request = () => service.command(owner, claim.attempt.id, randomUUID(), { action: "request", expectedVersion: 0, controllerId });
  const control = () => service.executionControl(claim, (cancelled) => repository.assertLease(claim, cancelled));
  const acknowledge = () => {
    request();
    const execution = control();
    execution.quiesce();
    execution.acknowledge();
    return execution;
  };
  beforeEach(() => {
    now = Date.now();
    directory = join(process.cwd(), `.takeover-test-${randomUUID()}`);
    mkdirSync(directory);
    repository = new TestRepository(directory, {}, () => now);
    service = repository.takeovers;
    owner = repository.createSession().ownerId;
    controllerId = randomUUID();
    repository.createDemoRun(owner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: personas[0].id, goal: "Apply coupons", criteria: [demoCriteria[0]] }],
    });
    claim = repository.claim("test-worker")!;
    repository.sessionReference(claim, {
      sessionId: randomUUID(), liveViewUrl: "https://www.browserbase.com/live/private?readOnly=true",
      replayUrl: "https://www.browserbase.com/sessions/private", timeoutSeconds: 240,
    });
  });
  afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });

  it("persists requested→quiescing→human→handback→resuming→agent and a bounded human interval", () => {
    expect(request()).toMatchObject({ phase: "requested", version: 1, interactiveUrl: null });
    const execution = control();
    expect(() => execution.assertDispatch()).toThrow(TakeoverInterrupted);
    execution.quiesce();
    expect(service.status(owner, claim.attempt.id, controllerId)).toMatchObject({ phase: "quiescing", version: 2, interactiveUrl: null });
    execution.acknowledge();
    const human = service.status(owner, claim.attempt.id, controllerId);
    expect(human).toMatchObject({ phase: "human", version: 3, controllerId, validUntil: now + 1500 });
    expect(human.interactiveUrl).toContain("readOnly=false");
    expect(() => execution.assertDispatch()).toThrow(TakeoverInterrupted);
    expect(service.command(owner, claim.attempt.id, randomUUID(), { action: "handback", expectedVersion: 3, controllerId }))
      .toMatchObject({ phase: "handback", interactiveUrl: null });
    execution.resume();
    expect(execution.read().phase).toBe("resuming");
    execution.resume();
    expect(execution.read().phase).toBe("resuming");
    now += 1501;
    execution.resume();
    expect(execution.read()).toEqual({ phase: "agent", version: 6 });
    expect(() => execution.assertDispatch()).not.toThrow();
    const intervals = service.intervals(owner, claim.attempt.id);
    expect(intervals).toEqual([{ version: 3, startedAt: now - 1501, endedAt: now, endReason: "handback" }]);
    expect(JSON.stringify(intervals)).not.toMatch(/private|browserbase|controller/);
  });

  it("handles duplicate commands idempotently without replaying stale interactive grants", () => {
    const key = randomUUID();
    const body = { action: "request", expectedVersion: 0, controllerId };
    service.command(owner, claim.attempt.id, key, body);
    expect(service.command(owner, claim.attempt.id, key, body).version).toBe(1);
    expect(() => service.command(owner, claim.attempt.id, key, { ...body, controllerId: randomUUID() })).toThrow("conflict");
    control().quiesce();
    control().acknowledge();
    expect(service.command(owner, claim.attempt.id, key, body).phase).toBe("human");
    repository.cancelRun(owner, claim.runId);
    expect(service.command(owner, claim.attempt.id, key, body)).toMatchObject({ phase: "closed", interactiveUrl: null });
  });

  it("rejects foreign owners, competing tabs, stale versions and forged command fields", () => {
    acknowledge();
    const other = repository.createSession().ownerId;
    expect(() => service.status(other, claim.attempt.id, controllerId)).toThrow("not_found");
    expect(() => service.command(other, claim.attempt.id, randomUUID(), { action: "request", expectedVersion: 3, controllerId })).toThrow("not_found");
    expect(service.status(owner, claim.attempt.id, randomUUID()).interactiveUrl).toBeNull();
    expect(service.status(owner, claim.attempt.id).interactiveUrl).toBeNull();
    expect(() => service.command(owner, claim.attempt.id, randomUUID(), { action: "handback", expectedVersion: 3, controllerId: randomUUID() })).toThrow("conflict");
    expect(() => service.command(owner, claim.attempt.id, randomUUID(), { action: "handback", expectedVersion: 2, controllerId })).toThrow("conflict");
    expect(() => service.command(owner, claim.attempt.id, randomUUID(), { action: "request", expectedVersion: 3, controllerId: randomUUID() })).toThrow("conflict");
    expect(takeoverCommandSchema.safeParse({ action: "acknowledge", expectedVersion: 3, controllerId }).success).toBe(false);
    expect(takeoverCommandSchema.safeParse({ action: "handback", expectedVersion: 3, controllerId, secret: "typed-value" }).success).toBe(false);
  });

  it.each(["lease", "generation", "cancel"] as const)("fails closed after %s loss", (failure) => {
    const execution = acknowledge();
    expect(service.status(owner, claim.attempt.id, controllerId).interactiveUrl).not.toBeNull();
    if (failure === "lease") repository.expire();
    if (failure === "generation") repository.generation();
    if (failure === "cancel") repository.cancelRun(owner, claim.runId);
    expect(() => execution.assertDispatch()).toThrow();
    expect(service.status(owner, claim.attempt.id, controllerId)).toMatchObject({ phase: "closed", interactiveUrl: null, validUntil: null });
    expect(service.intervals(owner, claim.attempt.id)[0].endedAt).toBe(now);
  });

  it("expires human control even when worker heartbeats preserve the lease", () => {
    const execution = acknowledge();
    for (let index = 0; index < 61; index++) { now += 1000; repository.heartbeat(claim); }
    expect(() => execution.read()).toThrow("Human control timeout");
    expect(service.status(owner, claim.attempt.id, controllerId).interactiveUrl).toBeNull();
    expect(repository.accounting(owner).reservedSeconds).toBe(240);
    expect(repository.accounting(owner).releasedSeconds).toBe(0);
  });

  it("survives an independent process request and refuses a stale worker after crash/reclaim", () => {
    const script = `
      import { WorkerRepository } from './src/server/worker/repository.ts';
      const repository = new WorkerRepository(process.env.TEST_DIR);
      repository.takeovers.command(process.env.TEST_OWNER,process.env.TEST_ATTEMPT,process.env.TEST_KEY,
        {action:'request',expectedVersion:0,controllerId:process.env.TEST_CONTROLLER});
      repository.close();
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", env: {
        ...process.env, TEST_DIR: directory, TEST_OWNER: owner,
        TEST_ATTEMPT: claim.attempt.id, TEST_KEY: randomUUID(), TEST_CONTROLLER: controllerId,
      },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(control().read().phase).toBe("requested");
    control().quiesce();
    control().acknowledge();
    repository.expire();
    const recovered = repository.claim("replacement-worker")!;
    expect(recovered.recovery).toBe(true);
    expect(() => control().acknowledge()).toThrow();
    expect(service.status(owner, claim.attempt.id, controllerId).interactiveUrl).toBeNull();
    expect(service.executionControl(recovered, (cancelled) => repository.assertLease(recovered, cancelled)).read).toThrow();
  });

  it("derives read-only and interactive views without stripping access-bearing query parameters", () => {
    expect(takeoverViewerUrl("https://www.browserbase.com/live/private?token=opaque")).toBe("https://www.browserbase.com/live/private?token=opaque&readOnly=true");
  });
});
