import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../api";
import { WorkerRepository, type Claim } from "../worker/repository";
import { demoCriteria } from "../../lib/demo-run";
import { personas } from "../../lib/personas";
import { startTakeoverPolling, takeoverStatusSchema } from "../../lib/takeover-contracts";

const origin = "http://127.0.0.1:3000";
describe("takeover owner HTTP boundary", () => {
  let directory: string;
  let repository: WorkerRepository;
  let handler: ReturnType<typeof createApi>;
  let owner: string;
  let cookie: string;
  let csrf: string;
  let claim: Claim;
  let controllerId: string;
  const request = (body?: unknown, headers: Record<string, string> = {}) => handler(new Request(
    `${origin}/api/v1/attempts/${claim.attempt.id}/takeover${body ? "" : `?controllerId=${controllerId}`}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie, origin, "content-type": "application/json", "x-csrf-token": csrf,
        "idempotency-key": randomUUID(), ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  ));
  beforeEach(async () => {
    directory = join(process.cwd(), `.takeover-api-${randomUUID()}`);
    mkdirSync(directory);
    repository = new WorkerRepository(directory);
    handler = createApi({ repository, configuration: { origin, production: false } });
    const bootstrap = await handler(new Request(`${origin}/api/v1/session`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
    }));
    const session = (await bootstrap.json()).data;
    owner = session.ownerId;
    csrf = session.csrfToken;
    cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    controllerId = randomUUID();
    repository.createDemoRun(owner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: personas[0].id, goal: "Read the task", criteria: [demoCriteria[0]] }],
    });
    claim = repository.claim("api-worker")!;
    repository.sessionReference(claim, {
      sessionId: randomUUID(), liveViewUrl: "https://www.browserbase.com/live/private",
      replayUrl: "https://www.browserbase.com/sessions/private", timeoutSeconds: 240,
    });
  });
  afterEach(() => { vi.useRealTimers(); repository.close(); rmSync(directory, { recursive: true, force: true }); });

  it("requires owner, same origin, CSRF, strict payload and an idempotency key", async () => {
    const body = { action: "request", controllerId, expectedVersion: 0 };
    expect((await request(body, { cookie: "" })).status).toBe(401);
    expect((await request(body, { origin: "https://foreign.invalid" })).status).toBe(403);
    expect((await request(body, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await request(body, { "idempotency-key": "" })).status).toBe(400);
    expect((await request({ ...body, action: "acknowledge" })).status).toBe(400);
    expect((await request({ ...body, typedSecret: "never-store-this" })).status).toBe(400);
    const read = await request();
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect((await read.json()).data).toMatchObject({ phase: "agent", interactiveUrl: null });
  });

  it("does not equate request acceptance with acknowledgment and does not replay grants", async () => {
    const body = { action: "request", controllerId, expectedVersion: 0 };
    const headers = { "idempotency-key": randomUUID() };
    const accepted = await request(body, headers);
    expect(accepted.ok).toBe(true);
    expect((await accepted.json()).data).toMatchObject({ phase: "requested", interactiveUrl: null });
    expect((await (await request(body, headers)).json()).data.version).toBe(1);
    expect((await request(body)).status).toBe(409);
    const execution = repository.takeovers.executionControl(claim, (cancelled) => repository.assertLease(claim, cancelled));
    execution.quiesce();
    execution.acknowledge();
    expect((await (await request()).json()).data).toMatchObject({ phase: "human", interactiveUrl: expect.stringContaining("readOnly=false") });
    repository.cancelRun(owner, claim.runId);
    expect((await (await request(body, headers)).json()).data).toMatchObject({ phase: "closed", interactiveUrl: null });
  });

  it("does not expose another owner's attempt or another tab's interactive URL", async () => {
    await request({ action: "request", controllerId, expectedVersion: 0 });
    const execution = repository.takeovers.executionControl(claim, (cancelled) => repository.assertLease(claim, cancelled));
    execution.quiesce();
    execution.acknowledge();
    controllerId = randomUUID();
    expect((await (await request()).json()).data.interactiveUrl).toBeNull();
    const other = await handler(new Request(`${origin}/api/v1/session`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
    }));
    cookie = other.headers.get("set-cookie")!.split(";")[0];
    csrf = (await other.json()).data.csrfToken;
    expect((await request()).status).toBe(404);
    expect((await request({ action: "request", controllerId, expectedVersion: 3 })).status).toBe(404);
  });

  it.each(["agent", "human"] as const)("three %s viewers plus wall/report reads fit one full real limiter minute", async (phase) => {
    vi.useFakeTimers();
    // Keep the entire simulated minute inside one persisted limiter window.
    vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000);
    const claims = [claim];
    for (let index = 0; index < 2; index++) {
      repository.createDemoRun(owner, randomUUID(), {
        authorizationAcknowledged: true, scenario: "fixed",
        assignments: [{ personaId: personas[index + 1].id, goal: "Read the task", criteria: [demoCriteria[0]] }],
      });
      const next = repository.claim("api-worker")!;
      repository.sessionReference(next, {
        sessionId: randomUUID(), liveViewUrl: "https://www.browserbase.com/live/private",
        replayUrl: "https://www.browserbase.com/sessions/private", timeoutSeconds: 240,
      });
      claims.push(next);
    }
    const responses: number[] = [];
    let viewerReads = 0;
    const read = async (path: string) => {
      const response = await handler(new Request(`${origin}/api/v1${path}`, { headers: { cookie, origin } }));
      responses.push(response.status);
      return response;
    };
    const stop = claims.map((current) => {
      const tab = randomUUID();
      if (phase === "human") {
        repository.takeovers.command(owner, current.attempt.id, randomUUID(), { action: "request", expectedVersion: 0, controllerId: tab });
        const execution = repository.takeoverControl(current);
        execution.quiesce();
        execution.acknowledge();
      }
      return startTakeoverPolling(async () => {
        viewerReads++;
        const response = await read(`/attempts/${current.attempt.id}/takeover?controllerId=${tab}`);
        return response.ok ? takeoverStatusSchema.parse((await response.json()).data) : undefined;
      }, tab);
    });
    const wallRead = async () => {
      for (const suffix of ["", "/attempts", "/summaries", "/sessions", "/reports"]) {
        await read(`/runs/${claim.runId}${suffix}`);
      }
    };
    const background: Promise<void>[] = [wallRead()];
    const wallTimer = setInterval(() => { background.push(wallRead()); }, 5000);
    const heartbeat = setInterval(() => { for (const current of claims) repository.heartbeat(current); }, 1000);
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      await Promise.all(background);
      stop.forEach((close) => close());
      clearInterval(wallTimer);
      clearInterval(heartbeat);
      expect(viewerReads).toBe(phase === "human" ? 180 : 90);
      expect(responses).toHaveLength(viewerReads + 60);
      expect(responses.every((status) => status === 200)).toBe(true);

      // Exercise, rather than mock or increase, the production 300-read cap.
      while (responses.length < 300) expect((await read(`/runs/${claim.runId}`)).status).toBe(200);
      expect((await read(`/runs/${claim.runId}`)).status).toBe(429);
      await vi.advanceTimersByTimeAsync(1);
      expect((await read(`/runs/${claim.runId}`)).status).toBe(200);
    } finally {
      stop.forEach((close) => close());
      clearInterval(wallTimer);
      clearInterval(heartbeat);
    }
  });
});
