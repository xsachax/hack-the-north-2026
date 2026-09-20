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
import { capabilitiesSchema, type Capabilities } from "../lib/ui-contracts";
import { workerExecutionLimits, workerPolicySchema } from "./worker/config";
import { ReportService, type EvidenceLoader } from "./reports/service";
import { exportReport } from "./reports/exports";
import { ArtifactReader, artifactDownloadResponse, getRawArtifactJson } from "./reports/artifacts";
import { ReplayError, type createReplayAdapter, type AuthorizedReplayAssociation } from "./reports/replay";
import type { ReplayReport } from "../lib/replay-contracts";
import { takeoverCommandSchema } from "../lib/takeover-contracts";
import { rerunRequestSchema } from "../lib/rerun-contracts";
import { ComparisonService } from "./workflows/comparison";
import { reproductionCreateSchema } from "../lib/reproduction-contracts";
import { NATIVE_SHUTDOWN_RESERVE_SECONDS } from "../lib/public-execution";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "./public-execution-readiness";
import { managedCreateSchema } from "../lib/managed-contracts";
import { assertManagedScope, managedCapabilities } from "./managed/config";

export type ApiConfiguration = {
  origin: string;
  production: boolean;
  accessCode?: string;
  allowDemoRuns?: boolean;
  allowPublicRuns?: boolean;
  publicExecutionReady?: boolean;
  publicSessionTimeoutSeconds?: number;
  browserbaseKeyConfigured?: boolean;
  executionLimits?: Capabilities["executionLimits"];
  policy?: PolicyOptions;
  managedEnabled?: boolean;
  managedAllowedOrigins?: readonly string[];
  managedAgentConfigured?: boolean;
  managedProjectConfigured?: boolean;
};
type Dependencies = {
  repository: Repository;
  configuration: ApiConfiguration;
  validateScope?: typeof validateTargetScope;
  eventStream?: EventStreamOptions;
  evidenceLoader?: EvidenceLoader;
  evidenceContent?: (owner: string, evidenceId: string, request: Request) => Response;
  reportSecrets?: readonly string[];
  replay?: ReturnType<typeof createReplayAdapter>;
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

export function publicExecutionCapability(configuration: ApiConfiguration, persistedSessionTimeoutSeconds: number | null = null) {
  const configuredSeconds = configuration.publicSessionTimeoutSeconds ?? workerPolicySchema.parse({}).sessionSeconds;
  const validTimeout = (seconds: number) => Number.isInteger(seconds) &&
    seconds > NATIVE_SHUTDOWN_RESERVE_SECONDS && seconds <= 300;
  const timeoutSupported = validTimeout(configuredSeconds) &&
    (persistedSessionTimeoutSeconds === null || validTimeout(persistedSessionTimeoutSeconds));
  const reason = !PUBLIC_EXECUTION_IMPLEMENTATION_READY ? "offline_checkpoint" :
    configuration.publicExecutionReady !== true ? "implementation_not_ready" :
    configuration.allowPublicRuns !== true ? "operator_disabled" :
    !configuration.accessCode || configuration.accessCode.length < 32 ? "strong_access_code_required" :
    !timeoutSupported ? "session_timeout_unsupported" : "ready";
  return { publicExecutionEnabled: reason === "ready", publicExecutionReason: reason };
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

export function createApi({
  repository, configuration, validateScope = validateTargetScope, eventStream,
  evidenceLoader, evidenceContent, reportSecrets, replay,
}: Dependencies) {
  const streamEvents = createEventStreamHandler(repository, eventStream);
  const reader = new ArtifactReader({ dataDir: repository.dataDir, knownSecrets: reportSecrets });
  const loadEvidence: EvidenceLoader = evidenceLoader ?? ((stored) => {
    const result = reader.read({
      evidence: stored.metadata, storageKey: stored.storageKey,
      runId: stored.metadata.runId, attemptId: stored.metadata.attemptId,
    });
    return {
      ...stored,
      state: result.status === "redacted" ? "unavailable" :
        result.status === "unavailable" && result.reason === "unsupported-kind" ? "unsupported" : result.status,
      data: getRawArtifactJson(result),
    };
  });
  const reports = new ReportService(repository, loadEvidence, reportSecrets);
  const comparisons = new ComparisonService(repository, loadEvidence, reportSecrets);
  const content = evidenceContent ?? ((owner: string, id: string, request: Request) => {
    const stored = repository.storedEvidence(owner, id);
    if (stored.metadata.kind === "screenshot") return artifactDownloadResponse(reader.read({
      evidence: stored.metadata, storageKey: stored.storageKey, runId: stored.metadata.runId, attemptId: stored.metadata.attemptId,
    }), { range: request.headers.get("range") });
    if (request.headers.has("range")) fail("invalid_request", 416);
    const detail = reports.detail(owner, id);
    if (detail.evidence.state !== "available") fail("not_found", 404);
    return new Response(JSON.stringify(detail), { headers: {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="evidence-${id}.json"`,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "sandbox; default-src 'none'", "Vary": "Cookie, Origin",
    } });
  });
  return async function handle(request: Request): Promise<Response> {
    const headers = new Headers({
      "Cache-Control": "no-store", "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff", "Vary": "Cookie, Origin",
      "Referrer-Policy": "no-referrer",
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
      if (path.length === 1 && path[0] === "capabilities" && request.method === "GET") {
        if (url.search) fail("invalid_request", 400);
        const persisted = repository.persistedExecutionLimits();
        return respond(capabilitiesSchema.parse({
          controlledRunsEnabled: configuration.allowDemoRuns === true && !!configuration.accessCode &&
            configuration.accessCode.length >= 32,
          websiteExecutionEnabled: false,
          ...publicExecutionCapability(configuration, repository.persistedSessionTimeoutSeconds()),
          maxActiveViews: 3,
          accessCodeConfigured: !!configuration.accessCode,
          browserbaseKeyConfigured: configuration.browserbaseKeyConfigured === true,
          executionLimits: persisted ?? configuration.executionLimits ?? workerExecutionLimits(workerPolicySchema.parse({})),
          executionLimitsSource: persisted ? "persisted-worker-policy" :
            configuration.executionLimits ? "configuration" : "defaults",
        }));
      }
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

      if (path.length === 1 && path[0] === "managed-capabilities" && request.method === "GET") {
        if (url.search) fail("invalid_request", 400);
        return respond(managedCapabilities({
          enabled: configuration.managedEnabled, allowedOrigins: configuration.managedAllowedOrigins,
          agentConfigured: configuration.managedAgentConfigured, accessCode: configuration.accessCode,
          keyConfigured: configuration.browserbaseKeyConfigured,
          projectConfigured: configuration.managedProjectConfigured,
        }));
      }
      if (path[0] === "managed-runs") {
        if (url.search) fail("invalid_request", 400);
        if (path.length === 1 && request.method === "GET") return respond({ items: repository.managed.list(owner) });
        if (path.length === 1 && request.method === "POST") {
          const key = parseInput(idempotencyKeySchema, request.headers.get("idempotency-key"));
          const input = parseInput(managedCreateSchema, await readJson(request));
          const existing = repository.managed.existing(owner, key, input);
          if (existing) return respond(existing);
          if (!managedCapabilities({
            enabled: configuration.managedEnabled, allowedOrigins: configuration.managedAllowedOrigins,
            agentConfigured: configuration.managedAgentConfigured, accessCode: configuration.accessCode,
            keyConfigured: configuration.browserbaseKeyConfigured,
            projectConfigured: configuration.managedProjectConfigured,
          }).enabled) fail("unavailable", 503);
          try { assertManagedScope(input.scope, configuration.managedAllowedOrigins ?? []); }
          catch { fail("invalid_request", 400); }
          await validateScope(input.scope);
          const result = repository.managed.create(owner, key, input, repository.listPersonas(owner));
          return respond(result.run, result.created ? 201 : 200);
        }
        if (path.length >= 2) {
          const id = parseInput(idSchema, path[1]);
          if ((path.length === 2 || path.length === 3 && path[2] === "report") && request.method === "GET") {
            return respond(repository.managed.get(owner, id));
          }
          if (path.length === 3 && path[2] === "cancel" && request.method === "POST") {
            parseInput(z.strictObject({}), await readJson(request));
            return respond(repository.managed.cancel(owner, id));
          }
          if (path.length === 5 && path[2] === "attempts" && path[4] === "view" && request.method === "GET") {
            return respond(repository.managed.view(owner, id, parseInput(idSchema, path[3])));
          }
        }
        fail("not_found", 404);
      }

      if (path[0] === "reproductions" && path.length >= 2) {
        const reproductionId = parseInput(idSchema, path[1]);
        const reproductions = repository.reproductionService();
        if (path.length === 2 && request.method === "GET") {
          if (url.search) fail("invalid_request", 400);
          return respond(reproductions.status(owner, reproductionId));
        }
        if (path.length === 3 && path[2] === "cancel" && request.method === "POST") {
          parseInput(z.strictObject({}), await readJson(request));
          return respond(reproductions.cancel(owner, reproductionId));
        }
        if (path.length === 3 && path[2] === "export" && request.method === "GET") {
          if (url.search) fail("invalid_request", 400);
          return new Response(reproductions.export(owner, reproductionId), { headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": 'attachment; filename="coupon-regression.spec.ts"',
            "Cache-Control": "private, no-store", "Vary": "Cookie, Origin",
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "sandbox; default-src 'none'",
          } });
        }
      }
      if (path.length >= 3 && path[0] === "attempts" && path[2] === "takeover") {
        const attemptId = parseInput(idSchema, path[1]);
        if (path.length === 3 && request.method === "GET") {
          const parameters = [...url.searchParams.entries()];
          if (parameters.length > 1 || parameters.some(([key]) => key !== "controllerId")) fail("invalid_request", 400);
          const controllerId = url.searchParams.has("controllerId")
            ? parseInput(idSchema, url.searchParams.get("controllerId")) : undefined;
          return respond(repository.takeovers.status(owner, attemptId, controllerId));
        }
        if (path.length === 3 && request.method === "POST") {
          const key = parseInput(idempotencyKeySchema, request.headers.get("idempotency-key"));
          return respond(repository.takeovers.command(owner, attemptId, key, parseInput(takeoverCommandSchema, await readJson(request))));
        }
        if (path.length === 4 && path[3] === "intervals" && request.method === "GET") {
          if (url.search) fail("invalid_request", 400);
          return respond({ items: repository.takeovers.intervals(owner, attemptId) });
        }
      }
      if (path[0] === "contexts") {
        if (path.length === 1 && request.method === "GET") {
          if (url.search) fail("invalid_request", 400);
          return respond({ items: repository.contexts.list(owner) });
        }
        if (path.length === 2 && request.method === "DELETE") {
          if ((await readBody(request)).length) fail("invalid_request", 400);
          return respond(repository.contexts.revoke(owner, parseInput(idSchema, path[1])));
        }
      }
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
          if (input.executionPolicy) {
            const capability = publicExecutionCapability(configuration, repository.persistedSessionTimeoutSeconds());
            if (!capability.publicExecutionEnabled) {
              fail(capability.publicExecutionReason === "offline_checkpoint" ? "public_execution_checkpoint_disabled" :
                capability.publicExecutionReason === "session_timeout_unsupported" ? "public_session_timeout_unsupported" : "unavailable", 503);
            }
          }
          const scope = await validateScope(input.scope, configuration.policy);
          const result = repository.createRun(owner, key, { ...input, scope });
          return respond(result.run, result.created ? 201 : 200);
        }
        if (path.length >= 2) {
          const id = parseInput(idSchema, path[1]);
          if (path.length === 3 && path[2] === "reproductions" && request.method === "POST") {
            if (repository.getRun(owner, id).executionMode === "public-readonly") fail("public_reproduction_unsupported", 400);
            if (configuration.allowDemoRuns !== true || !configuration.accessCode || configuration.accessCode.length < 32) {
              fail("demo_disabled", 503);
            }
            const input = parseInput(reproductionCreateSchema, await readJson(request));
            return respond(repository.reproductionService().prepare(owner, id, input.attemptId));
          }
          if (path.length === 3 && path[2] === "reruns" && request.method === "POST") {
            if (repository.getRun(owner, id).executionMode === "public-readonly") fail("public_rerun_unsupported", 400);
            if (configuration.allowDemoRuns !== true || !configuration.accessCode || configuration.accessCode.length < 32) {
              fail("demo_disabled", 503);
            }
            const key = parseInput(idempotencyKeySchema, request.headers.get("idempotency-key"));
            const input = parseInput(rerunRequestSchema, await readJson(request));
            const result = repository.createRerun(owner, key, id, input);
            return respond(result, result.created ? 201 : 200);
          }
          if (path.length === 4 && path[2] === "comparisons" && request.method === "GET") {
            if (url.search) fail("invalid_request", 400);
            return respond(comparisons.compare(owner, id, parseInput(idSchema, path[3])));
          }
          if (path.length >= 5 && path[2] === "attempts" && path[4] === "replay") {
            if (url.search) fail("invalid_request", 400);
            const attemptId = parseInput(idSchema, path[3]);
            const associated = repository.recordingSession(owner, id, attemptId);
            const basePath = `/api/v1/runs/${id}/attempts/${attemptId}/replay`;
            const name = configuration.production ? "__Secure-ff_replay" : "ff_replay";
            if (path.length === 6 && path[5] === "authorize" && request.method === "POST") {
              parseInput(z.strictObject({ acknowledgeSensitiveVideo: z.literal(true) }), await readJson(request));
              const grant = repository.authorizeReplay(owner, id, attemptId);
              headers.set("Set-Cookie", `${name}=${grant.token}; HttpOnly; SameSite=Strict; Path=${basePath}; Max-Age=900${configuration.production ? "; Secure" : ""}`);
              return respond({ authorized: true, expiresAt: grant.expiresAt });
            }
            if (request.method !== "GET") fail("not_found", 404);
            const cookies = (request.headers.get("cookie") ?? "").split(";").map((item) => item.trim())
              .filter((item) => item.startsWith(`${name}=`));
            const approved = cookies.length === 1 &&
              repository.replayAuthorized(owner, id, attemptId, cookies[0].slice(name.length + 1));
            const association: AuthorizedReplayAssociation | null = associated ? {
              sessionId: associated.sessionId, state: associated.active ? "running" : "ended",
              recordingEnabled: true, sensitivePlaybackAuthorized: approved, playbackBasePath: basePath,
            } : null;
            if (path.length === 5) {
              if (request.headers.has("range")) fail("invalid_request", 400);
              const unavailable: ReplayReport = {
                status: "unavailable", format: "hls", sensitive: true, fallback: "operator-dashboard", pages: [],
              };
              return respond(association && replay ? await replay.inspect(association) : unavailable);
            }
            if (!association || !approved) fail("not_found", 404);
            if (path.length === 6 && path[5] === "dashboard") {
              if (request.headers.has("range")) fail("invalid_request", 400);
              return new Response(null, { status: 303, headers: {
                "Location": `https://www.browserbase.com/sessions/${association.sessionId}`,
                "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff", "Vary": "Cookie, Origin",
              } });
            }
            if (!replay) fail("unavailable", 503);
            const index = (value: string) => {
              if (!/^(?:0|[1-9]\d{0,3})$/.test(value)) fail("invalid_request", 400);
              return Number(value);
            };
            try {
              if (path.length === 8 && path[5] === "pages" && path[7] === "playlist") {
                if (request.headers.has("range")) fail("invalid_request", 416);
                const playlist = await replay.playlist(association, index(path[6]));
                return new Response(playlist, { headers: {
                  "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "private, no-store",
                  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Vary": "Cookie, Origin",
                } });
              }
              if (path.length === 9 && path[5] === "pages" && path[7] === "segments") {
                const media = await replay.segment(association, index(path[6]), index(path[8]), request.headers.get("range") ?? undefined);
                return new Response(Buffer.from(media.body), { status: media.status, headers: {
                  "Content-Type": media.contentType, "Content-Length": String(media.body.byteLength),
                  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
                  "Referrer-Policy": "no-referrer", "Vary": "Cookie, Origin",
                  ...(media.contentRange ? { "Content-Range": media.contentRange } : {}),
                } });
              }
            } catch (error) {
              if (!(error instanceof ReplayError)) throw error;
              return new Response(JSON.stringify({ error: { code: `replay_${error.status}`, message: error.status } }), {
                status: request.headers.has("range") && error.status === "unsupported" ? 416 : error.status === "expired" ? 410 : 503,
                headers,
              });
            }
            fail("not_found", 404);
          }
          if (request.method === "GET" && (
            (path.length === 3 && path[2] === "reports") ||
            (path.length === 5 && path[2] === "attempts" && path[4] === "report") ||
            (path.length === 4 && path[2] === "groups") ||
            (path.length === 4 && path[2] === "exports" && ["json", "markdown"].includes(path[3]))
          )) {
            if (url.search || request.headers.has("range")) fail("invalid_request", 400);
            repository.getRun(owner, id);
            const report = reports.report(owner, id);
            if (path[2] === "exports") return exportReport(report, path[3] === "json" ? "json" : "markdown");
            if (path[2] === "attempts") {
              const attemptId = parseInput(idSchema, path[3]);
              const agent = report.agents.find((entry) => entry.attemptId === attemptId);
              if (!agent) fail("not_found", 404);
              return respond(agent);
            }
            if (path[2] === "groups") {
              if (!/^[a-f0-9]{64}$/.test(path[3])) fail("invalid_request", 400);
              const group = report.groups.find((entry) => entry.signature === path[3]);
              if (!group) fail("not_found", 404);
              return respond(group);
            }
            return respond(report);
          }
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
      if (path.length === 3 && path[0] === "evidence" && request.method === "GET" && ["detail", "content"].includes(path[2])) {
        if (url.search) fail("invalid_request", 400);
        const id = parseInput(idSchema, path[1]);
        repository.storedEvidence(owner, id);
        if (path[2] === "content") {
          return content(owner, id, request);
        }
        return respond(reports.detail(owner, id));
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
