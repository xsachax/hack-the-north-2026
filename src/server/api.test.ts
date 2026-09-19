import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { CreateRun, Persona, PersonaProfile, Run } from "../lib/contracts";
import { createApi, type ApiConfiguration } from "./api";
import { Repository } from "./repository";
import { validateTargetScope } from "./target-policy";

const origin = "http://127.0.0.1:3000";
const profile: PersonaProfile = {
  name: "Offline tester",
  character: "Carefully checks the checkout.",
  device: "desktop",
  techComfort: "medium",
  patienceSteps: 8,
  readingStyle: "careful",
  quirks: ["Checks labels"],
  worries: ["Unexpected costs"],
};
const runInput: CreateRun = {
  authorizationAcknowledged: true,
  scope: {
    targetUrl: "https://public-site.com/shop",
    allowedSubdomains: [],
    pathPrefixes: ["/shop"],
  },
  assignments: [{
    personaId: "careful-first-timer",
    goal: "Find a product",
    criteria: ["Product details are visible"],
  }],
};
type Session = { ownerId: string; csrfToken: string; expiresAt: number; cookie: string };
type Handler = ReturnType<typeof createApi>;

let directory: string;
let repository: Repository;
let handler: Handler;
let clock: number;
let connections: Repository[];
const validateScope = vi.fn<typeof validateTargetScope>(async (scope) => scope);
const network = vi.fn<typeof fetch>(async () => { throw new Error("Network calls are forbidden"); });

function connect() {
  const connection = new Repository(directory, () => clock);
  connections.push(connection);
  return connection;
}

function api(configuration: Partial<ApiConfiguration> = {}, connection = repository) {
  return createApi({
    repository: connection,
    configuration: { origin, production: false, ...configuration },
    validateScope,
  });
}

function request(path: string, {
  method = "GET", session, body, headers: suppliedHeaders, urlOrigin = origin,
}: {
  method?: string;
  session?: Session;
  body?: unknown;
  headers?: Record<string, string>;
  urlOrigin?: string;
} = {}) {
  const headers = new Headers(suppliedHeaders);
  if (session) {
    if (!headers.has("cookie")) headers.set("cookie", session.cookie);
    if (!headers.has("x-csrf-token")) headers.set("x-csrf-token", session.csrfToken);
  }
  if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) headers.set("origin", urlOrigin);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${urlOrigin}/api/v1/${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function data<T>(response: Response): Promise<T> {
  return (await response.json() as { data: T }).data;
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ error: { code, message: code.replaceAll("_", " ") } });
}

async function bootstrap(target = handler, options: { urlOrigin?: string; accessCode?: string } = {}) {
  const response = await target(request("session", {
    method: "POST",
    body: options.accessCode ? { accessCode: options.accessCode } : {},
    urlOrigin: options.urlOrigin,
  }));
  expect(response.status).toBe(201);
  const result = await data<Omit<Session, "cookie">>(response);
  return { ...result, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

async function createRun(session: Session, input: CreateRun = runInput, key = randomUUID()) {
  const response = await handler(request("runs", {
    method: "POST", session, body: input, headers: { "idempotency-key": key },
  }));
  expect(response.status).toBe(201);
  return data<Run>(response);
}

beforeEach(() => {
  directory = mkdtempSync(resolve(".api-test-"));
  connections = [];
  clock = Date.UTC(2026, 8, 19);
  repository = connect();
  handler = api();
  validateScope.mockReset().mockImplementation(async (scope) => scope);
  network.mockClear();
  vi.stubGlobal("fetch", network);
});

afterEach(() => {
  try {
    expect(network).not.toHaveBeenCalled();
  } finally {
    for (const connection of connections) connection.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("owner session and request boundaries", () => {
  it("bootstraps an opaque HttpOnly SameSite session and returns a separate CSRF token", async () => {
    const response = await handler(request("session", { method: "POST", body: {} }));
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toMatch(
      /^ff_owner=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/,
    );
    expect(response.headers.get("vary")).toBe("Cookie, Origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await data<Omit<Session, "cookie">>(response);
    expect(Object.keys(result).sort()).toEqual(["csrfToken", "expiresAt", "ownerId"]);
    expect(result.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toBe(clock + 7 * 24 * 60 * 60_000);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const token = cookie.split("=")[1];
    expect(token).not.toBe(result.csrfToken);
    expect(token).not.toBe(result.ownerId);
    expect(repository.session(token)?.ownerId).toBe(result.ownerId);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(resolve(directory, "flash-flood.sqlite")).mode & 0o777).toBe(0o600);
    const repeat = await handler(request("session", {
      method: "POST", body: {}, session: { ...result, cookie },
    }));
    expect(repeat.status).toBe(200);
    expect(repeat.headers.get("set-cookie")).toBeNull();
    expect(await data(repeat)).toEqual(result);
  });

  it("uses Secure __Host- cookies and gates production bootstrap", async () => {
    const productionOrigin = "https://app.public-site.com";
    const accessCode = "offline-test-access-code-with-32-characters";
    const secure = api({ origin: productionOrigin, production: true, accessCode });
    for (const body of [{}, { accessCode: "wrong" }]) {
      await expectError(await secure(request("session", {
        method: "POST", body, urlOrigin: productionOrigin,
      })), 401, "unauthorized");
    }
    const response = await secure(request("session", {
      method: "POST", body: { accessCode }, urlOrigin: productionOrigin,
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-ff_owner=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800; Secure$/,
    );
    expect(response.headers.get("set-cookie")).not.toContain("Domain");
    expect(await response.text()).not.toContain(accessCode);
    const owner = await bootstrap(secure, { urlOrigin: productionOrigin, accessCode });
    expect((await secure(request("personas", { session: owner, urlOrigin: productionOrigin }))).status).toBe(200);
    await expectError(await secure(request("personas", {
      urlOrigin: productionOrigin,
      headers: { cookie: owner.cookie.replace("__Host-ff_owner", "ff_owner") },
    })), 401, "unauthorized");
  });

  it.each([
    { production: true, origin: "https://app.public-site.com" },
    { production: true, origin: "https://app.public-site.com", accessCode: "short" },
    { production: true, origin, accessCode: "x".repeat(32) },
    { production: false, origin: "https://app.public-site.com" },
    { production: false, origin: `${origin}/` },
  ])("fails closed for unsafe configuration %j", async (configuration) => {
    await expectError(await api(configuration)(request("session", { method: "POST", body: {} })), 503, "unavailable");
    expect(validateScope).not.toHaveBeenCalled();
  });

  it.each(["", "ff_owner=invalid", `ff_owner=${"A".repeat(43)}`, "ff_owner=%zz"])(
    "rejects missing, malformed, or unknown owner cookies: %s", async (cookie) => {
      await expectError(await handler(request("runs", { headers: { cookie } })), 401, "unauthorized");
    },
  );

  it("rejects duplicate and expired cookies without accepting a CSRF token as authentication", async () => {
    const owner = await bootstrap();
    for (const cookie of [
      `${owner.cookie}; ${owner.cookie}`,
      `${owner.cookie}; ff_owner=malformed`,
      `ff_owner=${owner.csrfToken}`,
    ]) {
      await expectError(await handler(request("personas", { headers: { cookie } })), 401, "unauthorized");
    }
    clock += 7 * 24 * 60 * 60_000;
    await expectError(await handler(request("personas", { session: owner })), 401, "unauthorized");
  });

  it.each(["https://evil.com", `${origin}.evil.com`, `${origin}/`, "null", "http://localhost:3000"])(
    "requires exact Origin for reads and writes: %s", async (badOrigin) => {
      const owner = await bootstrap();
      for (const method of ["GET", "POST"]) {
        await expectError(await handler(request("personas", {
          method, session: owner, headers: { origin: badOrigin }, ...(method === "POST" ? { body: profile } : {}),
        })), 403, "forbidden");
      }
    },
  );

  it("rejects missing mutation Origin, cross-site requests and forged proxy headers", async () => {
    const owner = await bootstrap();
    const noOrigin = request("personas", { method: "POST", body: profile, session: owner });
    noOrigin.headers.delete("origin");
    await expectError(await handler(noOrigin), 403, "forbidden");
    for (const method of ["GET", "POST"]) {
      await expectError(await handler(request("personas", {
        method, session: owner, headers: { "sec-fetch-site": "cross-site" },
        ...(method === "POST" ? { body: profile } : {}),
      })), 403, "forbidden");
    }
    await expectError(await handler(request("personas", {
      session: owner, urlOrigin: "https://evil.com",
      headers: { origin, "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http", forwarded: "host=127.0.0.1:3000;proto=http" },
    })), 403, "forbidden");
    expect((await handler(request("personas", {
      session: owner, headers: { "x-forwarded-host": "evil.com", "x-forwarded-proto": "https" },
    }))).status).toBe(200);
  });

  it.each([
    ["normalized development loopback", origin, false],
    ["production TLS termination", "https://app.example", true],
  ] as const)("admits the real Host despite an internal URL: %s", async (_label, externalOrigin, production) => {
    const accessCode = "offline-proxy-access-code-with-32-characters";
    const target = api({ origin: externalOrigin, production, ...(production ? { accessCode } : {}) });
    const headers = { host: new URL(externalOrigin).host, origin: externalOrigin };
    const response = await target(request("session", {
      method: "POST", urlOrigin: "http://localhost:3000", headers,
      body: production ? { accessCode } : {},
    }));
    expect(response.status).toBe(201);
    const owner = {
      ...await data<Omit<Session, "cookie">>(response),
      cookie: response.headers.get("set-cookie")!.split(";")[0],
    };
    if (production) {
      expect(response.headers.get("set-cookie")).toContain("__Host-ff_owner=");
      expect(response.headers.get("set-cookie")).toContain("; Secure");
    }
    expect((await target(request("personas", {
      session: owner, urlOrigin: "http://localhost:3000", headers,
    }))).status).toBe(200);
    expect((await target(request("personas", {
      method: "POST", session: owner, body: profile, urlOrigin: "http://localhost:3000", headers,
    }))).status).toBe(201);
    await expectError(await target(request("personas", {
      method: "POST", session: owner, body: profile, urlOrigin: "http://localhost:3000",
      headers: { ...headers, origin: "http://localhost:3000" },
    })), 403, "forbidden");
  });

  it.each([
    ["incorrect actual Host", { host: "evil.com" }],
    ["spoofed forwarded authority", {
      host: "evil.com", "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http", forwarded: "host=127.0.0.1:3000;proto=http",
    }],
    ["incorrect port", { host: "127.0.0.1:3001" }],
  ])("rejects %s even when the URL and Origin match configuration", async (_label, hostHeaders) => {
    const owner = await bootstrap();
    const headers = { ...hostHeaders, origin } as Record<string, string>;
    for (const method of ["GET", "POST"]) {
      await expectError(await handler(request("personas", {
        method, session: owner, headers, ...(method === "POST" ? { body: profile } : {}),
      })), 403, "forbidden");
    }
    await expectError(await handler(request("session", { method: "POST", headers, body: {} })), 403, "forbidden");
    expect(validateScope).not.toHaveBeenCalled();
  });

  it("rejects missing/wrong CSRF before DNS, target validation, or writes", async () => {
    const owner = await bootstrap();
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const realPolicy = createApi({
      repository, configuration: { origin, production: false, policy: { lookup } },
    });
    for (const csrf of ["", "incorrect", owner.cookie.split("=")[1]]) {
      await expectError(await realPolicy(request("runs", {
        method: "POST", session: owner, body: runInput,
        headers: { "x-csrf-token": csrf, "idempotency-key": randomUUID() },
      })), 403, "forbidden");
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 10 }).items).toEqual([]);
    const accepted = await realPolicy(request("runs", {
      method: "POST", session: owner, body: runInput, headers: { "idempotency-key": randomUUID() },
    }));
    expect(accepted.status).toBe(201);
    expect(lookup).toHaveBeenCalledWith("public-site.com");
  });

  it("requires CSRF on every mutation, not just run creation", async () => {
    const owner = await bootstrap();
    const persona = repository.createPersona(owner.ownerId, profile);
    const run = await createRun(owner);
    for (const [path, method, body] of [
      ["personas", "POST", profile],
      [`personas/${persona.id}`, "PUT", { ...profile, name: "Untrusted update" }],
      [`personas/${persona.id}`, "DELETE", undefined],
      [`runs/${run.id}/cancel`, "POST", {}],
    ] as const) {
      const mutation = request(path, { method, session: owner, body });
      mutation.headers.delete("x-csrf-token");
      await expectError(await handler(mutation), 403, "forbidden");
    }
    expect(repository.getRun(owner.ownerId, run.id)).toEqual(run);
    expect(repository.listPersonas(owner.ownerId).filter((entry) => entry.id === persona.id)).toEqual([persona]);
  });

  it("reports target policy rejection without exposing DNS answers or creating a run", async () => {
    const owner = await bootstrap();
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const realPolicy = createApi({
      repository, configuration: { origin, production: false, policy: { lookup } },
    });
    await expectError(await realPolicy(request("runs", {
      method: "POST", session: owner, body: runInput, headers: { "idempotency-key": randomUUID() },
    })), 400, "invalid_request");
    expect(lookup).toHaveBeenCalledWith("public-site.com");
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 10 }).items).toEqual([]);
  });
});

describe("owner-scoped resources", () => {
  it("creates, lists, updates and deletes custom personas while preserving predefined personas", async () => {
    const owner = await bootstrap();
    const baseline = await data<{ items: Persona[] }>(await handler(request("personas", { session: owner })));
    expect(baseline.items.length).toBeGreaterThan(0);
    const created = await handler(request("personas", { method: "POST", session: owner, body: profile }));
    expect(created.status).toBe(201);
    const persona = await data<Persona>(created);
    expect(persona).toEqual({ ...profile, id: expect.any(String) });
    expect((await data<{ items: Persona[] }>(await handler(request("personas", { session: owner })))).items).toEqual([
      ...baseline.items, persona,
    ]);
    const updated = await handler(request(`personas/${persona.id}`, {
      method: "PUT", session: owner, body: { ...profile, name: "Updated" },
    }));
    expect(updated.status).toBe(200);
    expect(await data(updated)).toEqual({ ...persona, name: "Updated" });
    for (const method of ["PUT", "DELETE"]) {
      const response = await handler(request(`personas/${baseline.items[0].id}`, {
        method, session: owner, ...(method === "PUT" ? { body: profile } : {}),
      }));
      expect([400, 404]).toContain(response.status);
    }
    const deleted = await handler(request(`personas/${persona.id}`, { method: "DELETE", session: owner }));
    expect(deleted.status).toBe(200);
    expect(await data(deleted)).toEqual({ deleted: true });
    await expectError(await handler(request(`personas/${persona.id}`, { method: "DELETE", session: owner })), 404, "not_found");
    expect(await data(await handler(request("personas", { session: owner })))).toEqual(baseline);
  });

  it("deletes using Next's nonnull empty body stream while preserving ownership and payload checks", async () => {
    const owner = await bootstrap();
    const other = await bootstrap();
    const persona = repository.createPersona(owner.ownerId, profile);
    function streamedDelete(session: Session, payload?: Uint8Array) {
      const init = {
        method: "DELETE",
        headers: { origin, cookie: session.cookie, "x-csrf-token": session.csrfToken },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            if (payload) controller.enqueue(payload);
            controller.close();
          },
        }),
        duplex: "half",
      };
      const deletion = new Request(`${origin}/api/v1/personas/${persona.id}`, init);
      expect(deletion.body).not.toBeNull();
      return deletion;
    }
    await expectError(await handler(streamedDelete(other)), 404, "not_found");
    expect(repository.listPersonas(owner.ownerId)).toContainEqual(persona);
    for (const payload of [new TextEncoder().encode("{}"), new Uint8Array([32])]) {
      await expectError(await handler(streamedDelete(owner, payload)), 400, "invalid_request");
      expect(repository.listPersonas(owner.ownerId)).toContainEqual(persona);
    }
    const response = await handler(streamedDelete(owner));
    expect(response.status).toBe(200);
    expect(await data(response)).toEqual({ deleted: true });
    expect(repository.listPersonas(owner.ownerId)).not.toContainEqual(persona);
    await expectError(await handler(streamedDelete(owner)), 404, "not_found");
  });

  it("prevents cross-owner reads, writes, cancellation, and assignment of private personas", async () => {
    const owner = await bootstrap();
    const other = await bootstrap();
    const persona = repository.createPersona(owner.ownerId, profile);
    const input = { ...runInput, assignments: [{ ...runInput.assignments[0], personaId: persona.id }] };
    const run = await createRun(owner, input);
    const attempt = repository.attempts(owner.ownerId, run.id)[0];
    const evidence = repository.recordEvidence(owner.ownerId, {
      runId: run.id, attemptId: attempt.id, kind: "observation", summary: "A safe summary",
    }, "a".repeat(64));
    const finding = repository.recordFinding(owner.ownerId, {
      runId: run.id, attemptId: attempt.id, title: "Unclear button", description: "The label is unclear",
      evidenceIds: [evidence.id],
    });
    for (const [path, expected] of [
      [`runs/${run.id}`, run],
      [`runs/${run.id}/attempts`, { items: [attempt] }],
      [`evidence/${evidence.id}`, evidence],
      [`findings/${finding.id}`, finding],
    ] as const) {
      const response = await handler(request(path, { session: owner }));
      expect(response.status).toBe(200);
      expect(await data(response)).toEqual(expected);
      await expectError(await handler(request(path, { session: other })), 404, "not_found");
      await expectError(await handler(request(path)), 401, "unauthorized");
    }
    const events = await handler(request(`runs/${run.id}/events`, { session: owner }));
    expect(events.status).toBe(200);
    expect((await data<{ items: unknown[] }>(events)).items).toHaveLength(3);
    await expectError(await handler(request(`runs/${run.id}/events`, { session: other })), 404, "not_found");
    await expectError(await handler(request(`runs/${run.id}/events`)), 401, "unauthorized");
    await expectError(await handler(request(`runs/${run.id}/cancel`, {
      method: "POST", session: other, body: {},
    })), 404, "not_found");
    for (const method of ["PUT", "DELETE"]) {
      await expectError(await handler(request(`personas/${persona.id}`, {
        method, session: other, ...(method === "PUT" ? { body: profile } : {}),
      })), 404, "not_found");
    }
    await expectError(await handler(request("runs", {
      method: "POST", session: other, body: input, headers: { "idempotency-key": randomUUID() },
    })), 404, "not_found");
    const otherPersonas = await data<{ items: Persona[] }>(await handler(request("personas", { session: other })));
    expect(otherPersonas.items.some((entry) => entry.id === persona.id)).toBe(false);
    expect(await data(await handler(request("runs", { session: other })))).toEqual({ items: [], nextCursor: null });
    expect(repository.getRun(owner.ownerId, run.id).status).toBe("queued");
    expect(repository.listPersonas(owner.ownerId).find((entry) => entry.id === persona.id)).toEqual(persona);
  });

  it("rejects unauthenticated writes and unsupported resource mutations", async () => {
    const owner = await bootstrap();
    const id = randomUUID();
    for (const [path, method, body] of [
      ["personas", "POST", profile], [`personas/${id}`, "PUT", profile],
      [`personas/${id}`, "DELETE", undefined], ["runs", "POST", runInput],
      [`runs/${id}/cancel`, "POST", {}],
    ] as const) {
      await expectError(await handler(request(path, { method, body })), 401, "unauthorized");
    }
    for (const path of [`evidence/${id}`, `findings/${id}`, `runs/${id}/attempts`, `runs/${id}/events`]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        await expectError(await handler(request(path, { method, session: owner })), 404, "not_found");
      }
    }
  });

  it("validates strict persona input, IDs, delete bodies and mutation queries", async () => {
    const owner = await bootstrap();
    for (const body of [
      { ...profile, ownerId: owner.ownerId }, { ...profile, id: randomUUID() },
      { ...profile, name: "" }, { ...profile, patienceSteps: 0 }, { ...profile, device: "tablet" },
    ]) {
      await expectError(await handler(request("personas", { method: "POST", session: owner, body })), 400, "invalid_request");
    }
    const persona = repository.createPersona(owner.ownerId, profile);
    await expectError(await handler(request(`personas/${persona.id}`, {
      method: "DELETE", session: owner, body: {},
    })), 400, "invalid_request");
    for (const path of ["runs/not-an-id", "evidence/not-an-id", "findings/not-an-id"]) {
      await expectError(await handler(request(path, { session: owner })), 400, "invalid_request");
    }
    await expectError(await handler(request("personas?ignored=true", {
      method: "POST", session: owner, body: profile,
    })), 400, "invalid_request");
    expect(repository.listPersonas(owner.ownerId).find((entry) => entry.id === persona.id)).toEqual(persona);
  });
});

describe("runs and pagination", () => {
  it("deduplicates by owner and header key, rejects changed bodies, and cancels repeatedly without duplicate events", async () => {
    const owner = await bootstrap();
    const key = randomUUID();
    const run = await createRun(owner, runInput, key);
    expect(run.status).toBe("queued");
    const repeat = await handler(request("runs", {
      method: "POST", session: owner, body: runInput, headers: { "idempotency-key": key },
    }));
    expect(repeat.status).toBe(200);
    expect(await data(repeat)).toEqual(run);
    await expectError(await handler(request("runs", {
      method: "POST", session: owner,
      body: { ...runInput, assignments: [{ ...runInput.assignments[0], goal: "A changed goal" }] },
      headers: { "idempotency-key": key },
    })), 409, "conflict");
    const other = await bootstrap();
    expect((await createRun(other, runInput, key)).id).not.toBe(run.id);
    const cancel = () => handler(request(`runs/${run.id}/cancel`, { method: "POST", session: owner, body: {} }));
    const first = await cancel();
    expect(first.status).toBe(200);
    const cancelled = await data<Run>(first);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequestedAt).not.toBeNull();
    const before = repository.events(owner.ownerId, run.id, { after: 0, limit: 100 });
    expect(await data(await cancel())).toEqual(cancelled);
    expect(repository.events(owner.ownerId, run.id, { after: 0, limit: 100 })).toEqual(before);
    expect(before.items.filter((event) => event.kind === "run.cancel_requested")).toHaveLength(1);
    expect(repository.attempts(owner.ownerId, run.id)[0].status).toBe("cancelled");
  });

  it("rejects nonempty cancellation bodies without changing state", async () => {
    const owner = await bootstrap();
    const run = await createRun(owner);
    await expectError(await handler(request(`runs/${run.id}/cancel`, {
      method: "POST", session: owner, body: { status: "succeeded" },
    })), 400, "invalid_request");
    expect(repository.getRun(owner.ownerId, run.id)).toEqual(run);
  });

  it.each([
    ["missing authorization", { ...runInput, authorizationAcknowledged: undefined }],
    ["false authorization", { ...runInput, authorizationAcknowledged: false }],
    ["unknown root property", { ...runInput, ownerId: randomUUID() }],
    ["body idempotency key", { ...runInput, idempotencyKey: "body-key-not-supported" }],
    ["empty assignments", { ...runInput, assignments: [] }],
    ["duplicate assignments", { ...runInput, assignments: [...runInput.assignments, ...runInput.assignments] }],
    ["unknown assignment property", { ...runInput, assignments: [{ ...runInput.assignments[0], status: "succeeded" }] }],
    ["unknown scope property", { ...runInput, scope: { ...runInput.scope, allowPrivate: true } }],
    ["empty criteria", { ...runInput, assignments: [{ ...runInput.assignments[0], criteria: [] }] }],
  ])("rejects strict run input: %s", async (_label, body) => {
    const owner = await bootstrap();
    await expectError(await handler(request("runs", {
      method: "POST", session: owner, body, headers: { "idempotency-key": randomUUID() },
    })), 400, "invalid_request");
    expect(validateScope).not.toHaveBeenCalled();
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 10 }).items).toEqual([]);
  });

  it.each([undefined, "", "short", "x".repeat(129), "invalid key with spaces"])(
    "requires a valid idempotency header: %s", async (key) => {
      const owner = await bootstrap();
      await expectError(await handler(request("runs", {
        method: "POST", session: owner, body: runInput,
        headers: key === undefined ? {} : { "idempotency-key": key },
      })), 400, "invalid_request");
      expect(validateScope).not.toHaveBeenCalled();
    },
  );

  it("paginates runs and events without overlap or cross-owner disclosure", async () => {
    const owner = await bootstrap();
    const other = await bootstrap();
    const first = await createRun(owner);
    await createRun(other);
    const second = await createRun(owner);
    const page = await data<{ items: Run[]; nextCursor: number }>(await handler(request("runs?limit=1", { session: owner })));
    expect(page.items).toEqual([first]);
    expect(page.nextCursor).toBe(first.cursor);
    const next = await data(await handler(request(`runs?limit=1&after=${page.nextCursor}`, { session: owner })));
    expect(next).toEqual({ items: [second], nextCursor: null });
    await handler(request(`runs/${first.id}/cancel`, { method: "POST", session: owner, body: {} }));
    const eventPage = await data<{ items: { sequence: number }[]; nextCursor: number }>(
      await handler(request(`runs/${first.id}/events?limit=1`, { session: owner })),
    );
    expect(eventPage.items).toHaveLength(1);
    expect(eventPage.nextCursor).toBe(eventPage.items[0].sequence);
    const eventNext = await data<{ items: { sequence: number }[] }>(
      await handler(request(`runs/${first.id}/events?after=${eventPage.nextCursor}`, { session: owner })),
    );
    expect(eventNext.items.length).toBeGreaterThan(0);
    expect(eventNext.items.every((event) => event.sequence > eventPage.nextCursor)).toBe(true);
    expect(await data(await handler(request("runs?after=9007199254740991", { session: owner })))).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    "unknown=1", "limit=1&limit=2", "after=0&after=1", "limit=0", "limit=101",
    "limit=-1", "limit=1.5", "limit=NaN", "after=-1", "after=1.5",
    "after=9007199254740992", "after=Infinity",
  ])("rejects invalid pagination %s on runs and events", async (query) => {
    const owner = await bootstrap();
    const run = await createRun(owner);
    for (const path of ["runs", `runs/${run.id}/events`]) {
      await expectError(await handler(request(`${path}?${query}`, { session: owner })), 400, "invalid_request");
    }
  });

  it("rejects query parameters on endpoints without pagination", async () => {
    const owner = await bootstrap();
    const run = await createRun(owner);
    for (const path of ["personas", `runs/${run.id}`, `runs/${run.id}/attempts`, `evidence/${randomUUID()}`, `findings/${randomUUID()}`]) {
      await expectError(await handler(request(`${path}?limit=1`, { session: owner })), 400, "invalid_request");
    }
    await expectError(await handler(request("session?extra=1", { method: "POST", body: {} })), 400, "invalid_request");
  });
});

describe("bounded JSON transport", () => {
  function raw(body: BodyInit | null, headers: Record<string, string> = {}) {
    return new Request(`${origin}/api/v1/session`, {
      method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    });
  }

  it.each(["text/plain", "application/x-www-form-urlencoded", "application/problem+json", ""])(
    "rejects unsupported media type %s", async (contentType) => {
      await expectError(await handler(raw("{}", { "content-type": contentType })), 415, "invalid_request");
    },
  );

  it("accepts JSON with charset and rejects missing media type", async () => {
    expect((await handler(raw("{}", { "content-type": "application/json; charset=utf-8" }))).status).toBe(201);
    const missing = raw(new Uint8Array([123, 125]));
    missing.headers.delete("content-type");
    await expectError(await handler(missing), 415, "invalid_request");
  });

  it.each(["", "{", "null", "[]", "true", '{"accessCode":123}', '{"extra":true}'])(
    "rejects malformed JSON and bootstrap shape: %s", async (body) => {
      await expectError(await handler(raw(body)), 400, "invalid_request");
    },
  );

  it("rejects invalid UTF-8, absent bodies and stream errors without leaking details", async () => {
    await expectError(await handler(raw(new Uint8Array([123, 34, 0xc3, 0x28, 34, 58, 49, 125]))), 400, "invalid_request");
    await expectError(await handler(raw(null)), 400, "invalid_request");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("private-stream-detail")); },
    });
    await expectError(await handler(raw(stream)), 503, "unavailable");
    expect(log).toHaveBeenCalledExactlyOnceWith("flash_flood_api_internal_error");
  });

  it.each(["32769", "99999999999999999999", "-1", "not-a-number", "1.5"])(
    "rejects excessive or invalid declared content length %s", async (length) => {
      await expectError(await handler(raw("{}", { "content-length": length })), 413, "too_large");
    },
  );

  it("accepts exactly 32768 bytes and rejects one byte more", async () => {
    const atLimit = `{${" ".repeat(32766)}}`;
    expect(Buffer.byteLength(atLimit)).toBe(32768);
    expect((await handler(raw(atLimit))).status).toBe(201);
    await expectError(await handler(raw(`${atLimit} `)), 413, "too_large");
  });

  it("limits encoded bytes rather than JavaScript character count", async () => {
    const body = JSON.stringify({ accessCode: "é".repeat(16400) });
    expect(body.length).toBeLessThan(32768);
    expect(Buffer.byteLength(body)).toBeGreaterThan(32768);
    await expectError(await handler(raw(body)), 413, "too_large");
  });

  it.each([undefined, "1"])("enforces streamed byte limits even with content-length %s", async (length) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16384).fill(32));
        controller.enqueue(new Uint8Array(16384).fill(32));
        controller.enqueue(new Uint8Array([32]));
      },
      cancel,
    });
    await expectError(await handler(raw(stream, length === undefined ? {} : { "content-length": length })), 413, "too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("decodes multibyte UTF-8 split across chunks only after assembling the stream", async () => {
    const bytes = new TextEncoder().encode('{"accessCode":"é"}');
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    expect((await handler(raw(stream))).status).toBe(201);
  });

  it("times out an unending body and cancels its reader", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const pending = handler(raw(new ReadableStream<Uint8Array>({ cancel })));
      await vi.advanceTimersByTimeAsync(5000);
      await expectError(await pending, 408, "invalid_request");
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("persistent rates, safe errors and route surface", () => {
  it("shares bootstrap limits across connections and resets in the next window", async () => {
    const other = api({}, connect());
    for (let index = 0; index < 30; index++) {
      const target = index % 2 ? handler : other;
      expect((await target(request("session", { method: "POST", body: {} }))).status).toBe(201);
    }
    const limited = await api({}, connect())(request("session", { method: "POST", body: {} }));
    expect(limited.headers.get("retry-after")).toBe("60");
    await expectError(limited, 429, "rate_limited");
    clock += 60_000;
    expect((await other(request("session", { method: "POST", body: {} }))).status).toBe(201);
  });

  it.each([
    ["read", 300, "GET"],
    ["mutation", 60, "POST"],
  ] as const)("shares %s limits across connections and isolates owners and buckets", async (_bucket, maximum, method) => {
    const owner = await bootstrap();
    const otherOwner = await bootstrap();
    const other = api({}, connect());
    for (let index = 0; index < maximum; index++) {
      const target = index % 2 ? handler : other;
      const response = await target(request(method === "GET" ? "personas" : "not-a-route", { method, session: owner }));
      expect(response.status).toBe(method === "GET" ? 200 : 404);
    }
    const limited = await api({}, connect())(request("personas", { method, session: owner }));
    expect(limited.headers.get("retry-after")).toBe("60");
    await expectError(limited, 429, "rate_limited");
    expect((await other(request("personas", { session: otherOwner }))).status).toBe(200);
    const opposite = await other(request(method === "GET" ? "not-a-route" : "personas", {
      method: method === "GET" ? "POST" : "GET", session: owner,
    }));
    expect(opposite.status).toBe(method === "GET" ? 404 : 200);
    clock += 60_000;
    expect((await other(request("personas", { session: owner }))).status).toBe(200);
  });

  it("sanitizes internal errors and never logs private error objects or request credentials", async () => {
    const owner = await bootstrap();
    const privateDetail = `database-password ${owner.cookie} ${owner.csrfToken} https://private.com/?token=private`;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(repository, "listPersonas").mockImplementation(() => { throw new Error(privateDetail); });
    const response = await handler(request("personas", { session: owner }));
    await expectError(response, 503, "unavailable");
    expect(log).toHaveBeenCalledExactlyOnceWith("flash_flood_api_internal_error");
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
    expect(validateScope).not.toHaveBeenCalled();
  });

  it("treats persisted schema corruption as a safe internal error, not invalid client input", async () => {
    const owner = await bootstrap();
    const persona = repository.createPersona(owner.ownerId, profile);
    const privateDetail = "private-persisted-profile-detail";
    const database = new DatabaseSync(resolve(directory, "flash-flood.sqlite"));
    try {
      database.prepare("UPDATE personas SET profile=? WHERE id=?").run(
        JSON.stringify({ ...profile, name: 42, [privateDetail]: owner.csrfToken }), persona.id,
      );
    } finally {
      database.close();
    }
    expect(() => repository.listPersonas(owner.ownerId)).toThrow(ZodError);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expectError(await handler(request("personas", { session: owner })), 503, "unavailable");
    expect(log).toHaveBeenCalledExactlyOnceWith("flash_flood_api_internal_error");
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
    expect(JSON.stringify(log.mock.calls)).not.toContain(owner.csrfToken);
    await expectError(await handler(request("personas", {
      method: "POST", session: owner, body: { ...profile, name: 42 },
    })), 400, "invalid_request");
    expect(log).toHaveBeenCalledOnce();
  });

  it("uses only the four supported methods in the simple Node catchall adapter", () => {
    const source = readFileSync(resolve("src/app/api/v1/[...path]/route.ts"), "utf8");
    expect(source).toMatch(/export const runtime = ["']nodejs["']/);
    expect(source).toMatch(/export const dynamic = ["']force-dynamic["']/);
    const methods = [...source.matchAll(/export const (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*=\s*(\w+)/g)];
    expect(methods.map((match) => [match[1], match[2]])).toEqual([
      ["GET", "handleApi"], ["POST", "handleApi"], ["PUT", "handleApi"], ["DELETE", "handleApi"],
    ]);
  });
});
