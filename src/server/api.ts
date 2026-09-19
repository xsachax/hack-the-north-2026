import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createRunSchema, idempotencyKeySchema, idSchema, paginationSchema, personaProfileSchema,
} from "../lib/contracts";
import { demoRunSchema } from "../lib/demo-run";
import { controlledRunSchema } from "../lib/controlled-run";
import { Repository, type OwnerSession } from "./repository";
import { ServiceError } from "./errors";
import { createEventStreamHandler, type EventStreamOptions } from "./event-stream";
import { TargetPolicyError, validateTargetScope, type PolicyOptions } from "./target-policy";

export type ApiConfiguration = {
  origin: string;
  production: boolean;
  accessCode?: string;
  allowDemoRuns?: boolean;
  policy?: PolicyOptions;
};
type Dependencies = {
  repository: Repository;
  configuration: ApiConfiguration;
  validateScope?: typeof validateTargetScope;
  eventStream?: EventStreamOptions;
};
const bootstrapSchema = z.strictObject({ accessCode: z.string().min(1).max(512).optional() });
const cookieName = (production: boolean) => production ? "__Host-ff_owner" : "ff_owner";
const hash = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(hash(a), hash(b));
function fail(code: ServiceError["code"], status: number): never { throw new ServiceError(code, status); }
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) fail("invalid_request", 400);
  return result.data;
}

export function validateApiConfiguration(configuration: ApiConfiguration): void {
  const origin = new URL(configuration.origin);
  if (origin.origin !== configuration.origin || origin.username || origin.password) fail("unavailable", 503);
  if (configuration.production && (origin.protocol !== "https:" || !configuration.accessCode || configuration.accessCode.length < 32)) {
    fail("unavailable", 503);
  }
  if (!configuration.production && !configuration.accessCode &&
      !["http://127.0.0.1:3000", "http://localhost:3000"].includes(origin.origin)) {
    fail("unavailable", 503);
  }
  if (!["http:", "https:"].includes(origin.protocol)) fail("unavailable", 503);
}

async function readBody(request: Request): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 32768)) fail("too_large", 413);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ServiceError("invalid_request", 408)), 5000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > 32768) fail("too_large", 413);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel();
    if (error instanceof SyntaxError || error instanceof TypeError) fail("invalid_request", 400);
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    fail("invalid_request", 415);
  }
  const body = await readBody(request);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) fail("invalid_request", 400);
    throw error;
  }
}

function readSession(request: Request, repository: Repository, production: boolean): OwnerSession | null {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((item) => item.trim());
  const matches = cookies.filter((item) => item.startsWith(`${cookieName(production)}=`));
  if (matches.length !== 1) return null;
  return repository.session(matches[0].slice(cookieName(production).length + 1));
}

function pagination(url: URL) {
  const entries = [...url.searchParams.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) fail("invalid_request", 400);
  return parseInput(paginationSchema, Object.fromEntries(entries));
}

export function createApi({ repository, configuration, validateScope = validateTargetScope, eventStream }: Dependencies) {
  const streamEvents = createEventStreamHandler(repository, eventStream);
  return async function handle(request: Request): Promise<Response> {
    const headers = new Headers({
      "Cache-Control": "no-store", "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff", "Vary": "Cookie, Origin",
    });
    const respond = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers });
    try {
      validateApiConfiguration(configuration);
      const url = new URL(request.url);
      // Next rewrites loopback URL hosts and proxies may terminate TLS upstream.
      // Trust only the actual Host authority, never X-Forwarded-* for admission.
      const authority = request.headers.get("host") ?? url.host;
      if (authority !== new URL(configuration.origin).host) fail("forbidden", 403);
      const origin = request.headers.get("origin");
      const mutation = !["GET", "HEAD"].includes(request.method);
      if ((mutation && origin !== configuration.origin) || (origin && origin !== configuration.origin) ||
          request.headers.get("sec-fetch-site") === "cross-site") fail("forbidden", 403);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api" || parts[1] !== "v1") fail("not_found", 404);
      const path = parts.slice(2);
      if (path.length === 1 && path[0] === "session" && request.method === "POST") {
        if (url.search) fail("invalid_request", 400);
        repository.consumeRate("bootstrap", 30);
        const body = parseInput(bootstrapSchema, await readJson(request));
        const existing = readSession(request, repository, configuration.production);
        if (existing) return respond({ ownerId: existing.ownerId, csrfToken: existing.csrf, expiresAt: existing.expiresAt });
        if (configuration.accessCode && !equal(body.accessCode ?? "", configuration.accessCode)) fail("unauthorized", 401);
        const session = repository.createSession();
        headers.set("Set-Cookie", [
          `${cookieName(configuration.production)}=${session.token}`, "HttpOnly", "SameSite=Strict",
          "Path=/", "Max-Age=604800", ...(configuration.production ? ["Secure"] : []),
        ].join("; "));
        return respond({ ownerId: session.ownerId, csrfToken: session.csrf, expiresAt: session.expiresAt }, 201);
      }
      const session = readSession(request, repository, configuration.production);
      if (!session) fail("unauthorized", 401);
      repository.consumeRate(`${mutation ? "mutation" : "read"}:${session.ownerId}`, mutation ? 60 : 300);
      if (mutation && !equal(request.headers.get("x-csrf-token") ?? "", session.csrf)) fail("forbidden", 403);
      const owner = session.ownerId;
      if (mutation && url.search) fail("invalid_request", 400);

      if (path.length === 1 && path[0] === "controlled-runs" && request.method === "POST") {
        if (configuration.allowDemoRuns !== true || !configuration.accessCode || configuration.accessCode.length < 32) {
          fail("demo_disabled", 503);
        }
        const key = parseInput(idempotencyKeySchema, request.headers.get("idempotency-key"));
        const input = parseInput(controlledRunSchema, await readJson(request));
        const result = repository.createControlledRun(owner, key, input);
        return respond(result.run, result.created ? 201 : 200);
      }
      if (path.length === 1 && path[0] === "demo-runs" && request.method === "POST") {
        if (configuration.allowDemoRuns !== true || !configuration.accessCode || configuration.accessCode.length < 32) {
          fail("demo_disabled", 503);
        }
        const key = parseInput(idempotencyKeySchema, request.headers.get("idempotency-key"));
        const input = parseInput(demoRunSchema, await readJson(request));
        const result = repository.createDemoRun(owner, key, input);
        return respond(result.run, result.created ? 201 : 200);
      }
      if (path[0] === "personas") {
        if (path.length === 1 && request.method === "GET") {
          if (url.search) fail("invalid_request", 400);
          return respond({ items: repository.listPersonas(owner) });
        }
        if (path.length === 1 && request.method === "POST") {
          return respond(repository.createPersona(owner, parseInput(personaProfileSchema, await readJson(request))), 201);
        }
        if (path.length === 2 && request.method === "PUT") {
          return respond(repository.updatePersona(owner, parseInput(idSchema, path[1]), parseInput(personaProfileSchema, await readJson(request))));
        }
        if (path.length === 2 && request.method === "DELETE") {
          if ((await readBody(request)).length) fail("invalid_request", 400);
          repository.deletePersona(owner, parseInput(idSchema, path[1]));
          return respond({ deleted: true });
        }
      }
      if (path[0] === "runs") {
        if (path.length === 1 && request.method === "GET") return respond(repository.listRuns(owner, pagination(url)));
        if (path.length === 1 && request.method === "POST") {
          const key = parseInput(idempotencyKeySchema, request.headers.get("idempotency-key"));
          const input = parseInput(createRunSchema, await readJson(request));
          const scope = await validateScope(input.scope, configuration.policy);
          const result = repository.createRun(owner, key, { ...input, scope });
          return respond(result.run, result.created ? 201 : 200);
        }
        if (path.length >= 2) {
          const id = parseInput(idSchema, path[1]);
          if (path.length === 2 && request.method === "GET") {
            if (url.search) fail("invalid_request", 400);
            return respond(repository.getRun(owner, id));
          }
          if (path.length === 3 && request.method === "GET" && path[2] === "attempts") {
            if (url.search) fail("invalid_request", 400);
            return respond({ items: repository.attempts(owner, id) });
          }
          if (path.length === 3 && request.method === "GET" && ["sessions", "summaries"].includes(path[2])) {
            if (url.search) fail("invalid_request", 400);
            return respond({
              items: path[2] === "sessions" ? repository.sessionViews(owner, id) : repository.attemptSummaries(owner, id),
            });
          }
          if (path.length === 3 && request.method === "GET" && path[2] === "events") {
            return respond(repository.events(owner, id, pagination(url)));
          }
          if (path.length === 4 && request.method === "GET" && path[2] === "events" && path[3] === "stream") {
            return streamEvents(request, session, id, headers);
          }
          if (path.length === 3 && request.method === "POST" && path[2] === "cancel") {
            parseInput(z.strictObject({}), await readJson(request));
            return respond(repository.cancelRun(owner, id));
          }
        }
      }
      if (path.length === 2 && request.method === "GET" && ["evidence", "findings"].includes(path[0])) {
        if (url.search) fail("invalid_request", 400);
        const id = parseInput(idSchema, path[1]);
        return respond(path[0] === "evidence" ? repository.getEvidence(owner, id) : repository.getFinding(owner, id));
      }
      fail("not_found", 404);
    } catch (error) {
      const expected = error instanceof ServiceError ? error
        : error instanceof TargetPolicyError ? new ServiceError("invalid_request", 400)
        : null;
      if (!expected) {
        // Never log request bodies, URLs, SQLite messages, cookies or evidence.
        console.error("flash_flood_api_internal_error");
      }
      const code = expected?.code ?? "unavailable";
      const status = expected?.status ?? 503;
      if (status === 429) headers.set("Retry-After", "60");
      return new Response(JSON.stringify({ error: { code, message: code.replaceAll("_", " ") } }), { status, headers });
    }
  };
}
