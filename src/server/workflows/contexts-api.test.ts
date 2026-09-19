import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../api";
import { Repository } from "../repository";

let directory: string;
let repository: Repository;
let handler: ReturnType<typeof createApi>;
let owner: ReturnType<Repository["createSession"]>;
const origin = "http://127.0.0.1:3000";
const input = {
  authorizationAcknowledged: true, controlledSiteId: "project-board",
  assignments: [{
    personaId: "careful-first-timer", goal: "Inspect the board", criteria: ["The board is visible"],
    browserState: { mode: "save", acknowledgeSensitiveStorage: true },
  }],
};
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return handler(new Request(`${origin}/api/v1${path}`, {
    method, headers: {
      origin, cookie: `ff_owner=${owner.token}`, "x-csrf-token": owner.csrf,
      "content-type": "application/json", ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
beforeEach(() => {
  directory = mkdtempSync(join(process.cwd(), ".context-api-test-"));
  repository = new Repository(directory);
  owner = repository.createSession();
  handler = createApi({ repository, configuration: {
    origin, production: false, allowDemoRuns: true, accessCode: "offline-context-test-long-access-code",
  } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("provider_calls_forbidden"); }));
});
afterEach(() => {
  repository.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

it("creates exactly one local context through lost-reply idempotency, with no remote work from API", async () => {
  const headers = { "idempotency-key": randomUUID() };
  const first = await request("/controlled-runs", "POST", input, headers);
  const retry = await request("/controlled-runs", "POST", input, headers);
  expect(first.status).toBe(201);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(await first.json());
  const listed = await request("/contexts");
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const body = await listed.json();
  expect(body.data.items).toHaveLength(1);
  expect(body.data.items[0]).toMatchObject({ status: "pending", persistence: "never_saved" });
  expect(JSON.stringify(body)).not.toMatch(/remote_id|providerId|cookie|privateKey/);
  expect(fetch).not.toHaveBeenCalled();
});

it("repeats owner/origin/CSRF checks for context listing and revocation", async () => {
  await request("/controlled-runs", "POST", input, { "idempotency-key": randomUUID() });
  const id = repository.contexts.list(owner.ownerId)[0].id;
  const other = repository.createSession();
  expect((await request(`/contexts/${id}`, "DELETE", undefined, {
    cookie: `ff_owner=${other.token}`, "x-csrf-token": other.csrf,
  })).status).toBe(404);
  expect((await request(`/contexts/${id}`, "DELETE", undefined, { "x-csrf-token": "wrong" })).status).toBe(403);
  expect((await request(`/contexts/${id}`, "DELETE", undefined, { origin: "https://elsewhere.invalid" })).status).toBe(403);
  expect((await request("/contexts", "GET", undefined, { cookie: "" })).status).toBe(401);
  expect((await request("/contexts?owner=anything")).status).toBe(400);
  for (let i = 0; i < 2; i++) {
    const deleted = await request(`/contexts/${id}`, "DELETE");
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data).toMatchObject({ revoked: true, status: "revoked" });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects caller-supplied remote references and non-explicit persistence", async () => {
  for (const browserState of [
    { mode: "returning", contextId: randomUUID(), remoteId: randomUUID(), persist: false, acknowledgeSensitiveStorage: true },
    { mode: "save" },
    { mode: "returning", contextId: randomUUID(), acknowledgeSensitiveStorage: true },
  ]) {
    const response = await request("/controlled-runs", "POST", {
      ...input, assignments: [{ ...input.assignments[0], browserState }],
    }, { "idempotency-key": randomUUID() });
    expect(response.status).toBe(400);
  }
  expect(repository.contexts.list(owner.ownerId)).toEqual([]);
});
