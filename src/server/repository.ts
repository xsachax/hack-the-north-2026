import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import {
  attemptSchema, createRunSchema, newCreateRunSchema, evidenceSchema, findingSchema, idempotencyKeySchema,
  idSchema, paginationSchema, personaProfileSchema, personaSchema, runSchema,
  eventSchema, terminalStatusSchema, publicAttemptSummarySchema, gatewayMetricsSchema,
  type Attempt, type CreateRun, type Evidence, type Finding, type Pagination,
  type Persona, type PersonaProfile, type Run, type RunEvent, type TerminalStatus,
} from "../lib/contracts";
import { personas } from "../lib/personas";
import { ServiceError } from "./errors";
import { migrations } from "./migrations";
import { demoRunSchema, demoScope, supportedDemoCriteria, type DemoRun } from "../lib/demo-run";
import { referenceSchema } from "./worker/session-reference";
import { resultSchema } from "./worker/result";
import { controlledRunSchema, resolveControlledScope, type ControlledRun } from "../lib/controlled-run";
import { isLegacyCriterion } from "../lib/criteria";
import { attemptSummarySchema, sessionViewSchema, type AttemptSummary, type SessionView } from "../lib/ui-contracts";
import { workerExecutionLimits, workerPolicySchema } from "./worker/config";
import { runReportSchema, type RunReport } from "../lib/report-contracts";
import { sanitizeEvidence } from "./execution/artifacts";
import { publicPageUrl } from "./public-page-url";
import type { RerunRequest } from "../lib/rerun-contracts";
import { insertRerun, readRerunLineage } from "./workflows/rerun";
import { ContextStore } from "./workflows/contexts";
import { TakeoverService } from "./workflows/takeover";
import { reproductionService as createReproductionService } from "./worker/advanced-workflows";
import { ManagedStore } from "./managed/store";

type Row = Record<string, SQLOutputValue>;
const parseJson = (value: unknown): unknown => JSON.parse(z.string().parse(value));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const notFound = () => new ServiceError("not_found", 404);
const conflict = () => new ServiceError("conflict", 409);
const publicEvidenceText = (value: string) => String(sanitizeEvidence(value)).replace(/[a-f0-9]{64}/gi, "[PRIVATE_ARTIFACT]");
export type OwnerSession = { ownerId: string; csrf: string; expiresAt: number };
export type Page<T> = { items: T[]; nextCursor: number | null };
export type StoredEvidence = { metadata: Evidence; storageKey: string };
export type ReportSource = {
  run: Run;
  attempts: Attempt[];
  summaries: AttemptSummary[];
  events: RunEvent[];
  evidence: StoredEvidence[];
  results: { attemptId: string; result: z.infer<typeof resultSchema> }[];
  sequence: number;
  humanAssistedAttemptIds?: string[];
};

function readRun(row: Row): Run {
  return runSchema.parse({
    id: row.id, cursor: row.cursor, status: row.status, authorizationAcknowledged: true,
    scope: parseJson(row.scope), createdAt: row.created_at, updatedAt: row.updated_at,
    cancelRequestedAt: row.cancel_requested_at,
    executionMode: row.public_execution_policy !== null ? "public-readonly" : row.execution_mode,
    ...(row.public_execution_policy !== null ? {
      executionPolicy: row.public_execution_policy, assetPolicy: row.public_asset_policy,
    } : {}),
    ...(row.controlled_site_id ? { controlledSiteId: row.controlled_site_id } : {}),
  });
}

export class Repository {
  protected readonly db: DatabaseSync;
  readonly contexts: ContextStore;
  readonly takeovers: TakeoverService;
  readonly managed: ManagedStore;
  constructor(readonly dataDir: string, protected readonly clock = () => Date.now()) {
    const dir = resolve(dataDir);
    if (dir === resolve("/")) throw new Error("A dedicated private data directory is required");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
      throw new Error("Data directory must be a real directory");
    }
    chmodSync(dir, 0o700);
    const path = resolve(dir, "flash-flood.sqlite");
    if (!existsSync(path)) {
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error("Database must be a regular file");
    }
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.managed = new ManagedStore(this.db, (work) => this.transaction(work), this.clock);
    this.contexts = new ContextStore(this.db, this.clock);
    this.takeovers = new TakeoverService(this.db, (work) => this.transaction(work), this.clock,
      (attemptId, phase, version) => {
        const row = this.db.prepare("SELECT run_id FROM attempts WHERE id=?").get(attemptId);
        if (!row) throw new Error("control_attempt_missing");
        this.append(z.string().parse(row.run_id), attemptId, "attempt.control", {
          actor: ["requested", "human", "handback"].includes(phase) ? "human" : "system",
          controlPhase: phase, controlVersion: version,
          commentary: `Managed control: ${phase}. Interval markers only; human inputs are not recorded.`,
        });
      });
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.transaction(() => {
        const version = z.number().parse(this.db.prepare("PRAGMA user_version").get()?.user_version);
        if (version > migrations.length) throw new Error("Database version is newer than this application");
        for (let index = version; index < migrations.length; index++) {
          this.db.exec(migrations[index]);
          this.db.exec(`PRAGMA user_version=${index + 1}`);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }
  reproductionService() { return createReproductionService(this.db, this, this.clock); }
  persistedExecutionLimits() {
    const policy = this.persistedWorkerPolicy();
    return policy ? workerExecutionLimits(policy) : null;
  }
  persistedSessionTimeoutSeconds(): number | null {
    return this.persistedWorkerPolicy()?.sessionSeconds ?? null;
  }
  private persistedWorkerPolicy() {
    const row = this.db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get();
    return row ? workerPolicySchema.parse(parseJson(row.configuration)) : null;
  }
  protected now(): string { return new Date(this.clock()).toISOString(); }
  protected transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  consumeRate(bucket: string, maximum: number, windowMs = 60_000): void {
    const allowed = this.transaction(() => {
      const start = Math.floor(this.clock() / windowMs) * windowMs;
      this.db.prepare(`INSERT INTO rate_limits(bucket, window_start, count) VALUES(?, ?, 1)
        ON CONFLICT(bucket) DO UPDATE SET
          count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,
          window_start=excluded.window_start`).run(bucket, start);
      return z.number().parse(this.db.prepare("SELECT count FROM rate_limits WHERE bucket=?").get(bucket)?.count) <= maximum;
    });
    if (!allowed) throw new ServiceError("rate_limited", 429);
  }

  createSession(): OwnerSession & { token: string } {
    return this.transaction(() => {
      const count = z.number().parse(this.db.prepare("SELECT count(*) AS n FROM owners").get()?.n);
      if (count >= 1000) throw new ServiceError("rate_limited", 429);
      const ownerId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const csrf = randomBytes(32).toString("base64url");
      const expiresAt = this.clock() + 7 * 24 * 60 * 60_000;
      this.db.prepare("INSERT INTO owners VALUES(?, ?, ?, ?)").run(ownerId, digest(token), csrf, expiresAt);
      return { ownerId, token, csrf, expiresAt };
    });
  }

  session(token: string): OwnerSession | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare("SELECT id, csrf, expires_at FROM owners WHERE session_hash=? AND expires_at>?")
      .get(digest(token), this.clock());
    if (!row) return null;
    return { ownerId: z.string().parse(row.id), csrf: z.string().parse(row.csrf), expiresAt: z.number().parse(row.expires_at) };
  }

  listPersonas(owner: string): Persona[] {
    return [
      ...personas.map((persona) => personaSchema.parse(persona)),
      ...this.db.prepare("SELECT id, profile FROM personas WHERE owner_id=? ORDER BY id").all(owner)
        .map((row) => personaSchema.parse({ ...personaProfileSchema.parse(parseJson(row.profile)), id: row.id })),
    ];
  }

  createPersona(owner: string, input: PersonaProfile): Persona {
    const profile = personaProfileSchema.parse(input);
    return this.transaction(() => {
      const count = z.number().parse(this.db.prepare("SELECT count(*) AS n FROM personas WHERE owner_id=?").get(owner)?.n);
      if (count >= 50) throw new ServiceError("rate_limited", 429);
      const id = randomUUID();
      this.db.prepare("INSERT INTO personas VALUES(?, ?, ?)").run(id, owner, JSON.stringify(profile));
      return { ...profile, id };
    });
  }

  updatePersona(owner: string, id: string, input: PersonaProfile): Persona {
    const profile = personaProfileSchema.parse(input);
    const result = this.db.prepare("UPDATE personas SET profile=? WHERE id=? AND owner_id=?")
      .run(JSON.stringify(profile), id, owner);
    if (!result.changes) throw notFound();
    return { ...profile, id };
  }

  deletePersona(owner: string, id: string): void {
    if (!this.db.prepare("DELETE FROM personas WHERE id=? AND owner_id=?").run(id, owner).changes) throw notFound();
  }

  createRun(owner: string, key: string, input: CreateRun): { run: Run; created: boolean } {
    return this.insertRun(owner, key, input);
  }

  createRerun(owner: string, key: string, parentRunId: string, input: RerunRequest): { run: Run; created: boolean } {
    if (this.getRun(owner, parentRunId).executionMode === "public-readonly") throw new ServiceError("public_rerun_unsupported", 400);
    return this.transaction(() => {
      const result = insertRerun(this.db, this, owner, key, parentRunId, input, this.now());
      if (result.created) this.append(result.run.id, null, "run.created", { status: "queued" });
      return result;
    });
  }

  rerunLineage(owner: string, parentRunId: string, childRunId: string) {
    return readRerunLineage(this.db, this, owner, parentRunId, childRunId);
  }

  createDemoRun(owner: string, key: string, input: DemoRun): { run: Run; created: boolean } {
    const request = demoRunSchema.parse(input);
    if (!request.assignments.every((a) => supportedDemoCriteria(a.criteria))) {
      throw new ServiceError("unsupported_criteria", 400);
    }
    return this.insertRun(owner, key, {
      authorizationAcknowledged: true, scope: demoScope, assignments: request.assignments,
    }, { scenario: request.scenario });
  }

  createControlledRun(owner: string, key: string, input: ControlledRun): { run: Run; created: boolean } {
    const request = controlledRunSchema.parse(input);
    if (request.controlledSiteId !== "store" &&
      request.assignments.some(({ criteria }) => criteria.some(isLegacyCriterion))) {
      throw new ServiceError("unsupported_criteria", 400);
    }
    let scope: CreateRun["scope"];
    try { scope = resolveControlledScope(request.controlledSiteId, request.scope); }
    catch { throw new ServiceError("invalid_request", 400); }
    return this.insertRun(owner, key, {
      authorizationAcknowledged: true, scope, assignments: request.assignments,
    }, { controlledSiteId: request.controlledSiteId });
  }

  private insertRun(owner: string, key: string, input: CreateRun,
    controlled?: { scenario?: DemoRun["scenario"]; controlledSiteId?: ControlledRun["controlledSiteId"] },
  ): { run: Run; created: boolean } {
    const request = createRunSchema.parse(input);
    idempotencyKeySchema.parse(key);
    const hash = digest(JSON.stringify(controlled
      ? { request, ...controlled, mode: "controlled-fixture" } : request));
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM runs WHERE owner_id=? AND idempotency_key=?").get(owner, key);
      if (existing) {
        if (existing.request_hash !== hash) throw conflict();
        return { run: readRun(existing), created: false };
      }
      if (!newCreateRunSchema.safeParse(request).success) throw new ServiceError("invalid_request", 400);
      if (!controlled && request.assignments.some((assignment) =>
        assignment.browserState && assignment.browserState.mode !== "fresh")) {
        throw new ServiceError("invalid_request", 400);
      }
      const active = z.number().parse(this.db.prepare("SELECT count(*) AS n FROM runs WHERE owner_id=? AND status IN ('queued','running')").get(owner)?.n);
      const daily = z.number().parse(this.db.prepare("SELECT count(*) AS n FROM runs WHERE owner_id=? AND created_at>=?")
        .get(owner, new Date(this.clock() - 86_400_000).toISOString())?.n);
      if (active >= 5 || daily >= 100) throw new ServiceError("rate_limited", 429);
      const available = this.listPersonas(owner);
      const snapshots = request.assignments.map((assignment) => {
        const persona = available.find((entry) => entry.id === assignment.personaId);
        if (!persona) throw notFound();
        return { assignment, persona };
      });
      const id = randomUUID();
      const time = this.now();
      this.db.prepare(`INSERT INTO runs(id, owner_id, idempotency_key, request_hash, status, scope, created_at, updated_at, execution_mode, scenario, controlled_site_id, public_execution_policy, public_asset_policy)
        VALUES(?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, owner, key, hash, JSON.stringify(request.scope), time, time,
          controlled ? "controlled-fixture" : "website", controlled?.scenario ?? null, controlled?.controlledSiteId ?? null,
          request.executionPolicy ?? null, request.assetPolicy ?? null);
      for (const { assignment, persona } of snapshots) {
        const attempt = attemptSchema.parse({
          id: randomUUID(), runId: id, persona, goal: assignment.goal, criteria: assignment.criteria,
          ...(assignment.limits ? { limits: assignment.limits } : {}),
          ...(assignment.browserState ? { browserState: assignment.browserState } : {}),
          status: "queued", createdAt: time, updatedAt: time,
        });
        this.db.prepare("INSERT INTO attempts VALUES(?, ?, ?, ?)").run(attempt.id, id, "queued", JSON.stringify(attempt));
        const jobId = randomUUID();
        this.db.prepare("INSERT INTO jobs(id, run_id, attempt_id, status) VALUES(?, ?, ?, 'queued')").run(jobId, id, attempt.id);
        this.db.prepare("INSERT INTO usage_reservations(job_id) VALUES(?)").run(jobId);
        if (controlled) this.contexts.assign(owner, request.scope, attempt.id, assignment.browserState ?? { mode: "fresh" });
      }
      this.append(id, null, "run.created", { status: "queued" });
      return { run: this.getRun(owner, id), created: true };
    });
  }

  getRun(owner: string, id: string): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE owner_id=? AND id=?").get(owner, id);
    if (!row) throw notFound();
    return readRun(row);
  }

  listRuns(owner: string, pagination: Pagination): Page<Run> {
    const { after, limit } = paginationSchema.parse(pagination);
    const rows = this.db.prepare("SELECT * FROM runs WHERE owner_id=? AND cursor>? ORDER BY cursor LIMIT ?").all(owner, after, limit + 1);
    const items = rows.slice(0, limit).map(readRun);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.cursor : null };
  }

  attempts(owner: string, runId: string): Attempt[] {
    this.getRun(owner, runId);
    return this.db.prepare("SELECT id,status,snapshot FROM attempts WHERE run_id=? ORDER BY rowid").all(runId)
      .map((row) => {
        const attempt = attemptSchema.parse(parseJson(row.snapshot));
        if (attempt.id !== row.id || attempt.runId !== runId || attempt.status !== row.status) throw notFound();
        return attempt;
      });
  }

  sessionViews(owner: string, runId: string): SessionView[] {
    const run = this.getRun(owner, runId);
    return this.db.prepare(`SELECT j.id,j.attempt_id,j.lease_expires_at,a.status,l.state,l.session_reference FROM launches l
      JOIN jobs j ON j.id=l.job_id JOIN attempts a ON a.id=j.attempt_id AND a.run_id=j.run_id WHERE j.run_id=?`).all(runId).map((row) => {
      const reference = row.session_reference ? referenceSchema.parse(parseJson(row.session_reference)) : null;
      if (reference && this.db.prepare("SELECT job_id FROM browser_session_bindings WHERE session_id=?")
        .get(reference.sessionId)?.job_id !== row.id) throw notFound();
      const active = row.state === "active" && row.status === "running" && !run.cancelRequestedAt &&
        typeof row.lease_expires_at === "string" && row.lease_expires_at > this.now();
      return sessionViewSchema.parse({
        attemptId: z.string().parse(row.attempt_id),
        available: active && !!reference?.liveViewUrl,
        liveViewUrl: active ? reference?.liveViewUrl || null : null,
      });
    });
  }

  attemptSummaries(owner: string, runId: string): AttemptSummary[] {
    this.getRun(owner, runId);
    return this.db.prepare(`SELECT j.attempt_id,a.status,l.state,l.summary,l.usage,
      u.reserved_seconds,u.consumed_seconds,u.released_seconds
      FROM jobs j JOIN attempts a ON a.id=j.attempt_id AND a.run_id=j.run_id JOIN usage_reservations u ON u.job_id=j.id
      LEFT JOIN launches l ON l.job_id=j.id WHERE j.run_id=? ORDER BY j.rowid`).all(runId).map((row) => {
      const privateSummary = row.summary ? resultSchema.parse(parseJson(row.summary)) : null;
      const summary = privateSummary ? publicAttemptSummarySchema.parse({
        steps: privateSummary.steps, modelCalls: privateSummary.modelCalls,
        modelOperations: privateSummary.modelOperations, durationMs: privateSummary.durationMs,
        cleanup: { status: privateSummary.cleanup.status },
        checks: privateSummary.checks.map((check) => ({
          ...check,
          evidence: publicEvidenceText(check.evidence),
          ...(check.uncertainty !== undefined ? { uncertainty: publicEvidenceText(check.uncertainty) } : {}),
          ...(check.citations ? {
            citations: check.citations.map(({ screenshotKey, ...citation }) => {
              const evidence = screenshotKey ? this.db.prepare(
                "SELECT id FROM evidence WHERE storage_key=? AND run_id=? AND attempt_id=? AND json_extract(metadata,'$.kind')='screenshot'",
              ).get(screenshotKey, runId, row.attempt_id!) : undefined;
              return {
                ...citation, excerpt: publicEvidenceText(citation.excerpt),
                pageUrl: publicPageUrl(citation.pageUrl) ?? "https://redacted.invalid/",
                ...(evidence ? { evidenceId: evidence.id } : {}),
              };
            }),
          } : {}),
        })),
      }) : null;
      const usage = row.usage ? z.object({
        actualBrowserSeconds: z.number().nonnegative().optional(),
        elapsedSeconds: z.number().nonnegative(),
        remoteStatus: z.enum(["PENDING", "RUNNING", "COMPLETED", "ERROR", "TIMED_OUT"]).optional(),
        modelMetrics: z.unknown().optional().transform((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
          const counters = Object.fromEntries(Object.entries(value).filter(([key, counter]) =>
            Object.hasOwn(gatewayMetricsSchema.shape, key) &&
            typeof counter === "number" && Number.isFinite(counter) && counter >= 0));
          return Object.keys(counters).length ? gatewayMetricsSchema.parse(counters) : undefined;
        }),
      }).parse(parseJson(row.usage)) : null;
      return attemptSummarySchema.parse({
        attemptId: row.attempt_id, status: row.status, launchState: row.state ?? "not_launched",
        summary, usage, reservedSeconds: row.reserved_seconds,
        consumedSeconds: row.consumed_seconds, releasedSeconds: row.released_seconds,
      });
    });
  }

  events(owner: string, runId: string, pagination: Pagination): Page<RunEvent> {
    this.getRun(owner, runId);
    const { after, limit } = paginationSchema.parse(pagination);
    const rows = this.db.prepare("SELECT event FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(runId, after, limit + 1);
    const items = rows.slice(0, limit).map((row) => eventSchema.parse(parseJson(row.event)));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.sequence : null };
  }

  protected append(runId: string, attemptId: string | null, kind: RunEvent["kind"], data: RunEvent["data"]): void {
    const sequence = z.number().parse(this.db.prepare("UPDATE runs SET next_sequence=next_sequence+1 WHERE id=? RETURNING next_sequence-1 AS sequence").get(runId)?.sequence);
    const event = eventSchema.parse({ runId, attemptId, sequence, timestamp: this.now(), kind, data });
    this.db.prepare("INSERT INTO events VALUES(?, ?, ?)").run(runId, sequence, JSON.stringify(event));
  }

  protected saveAttempt(attempt: Attempt): void {
    this.db.prepare("UPDATE attempts SET status=?, snapshot=? WHERE id=?")
      .run(attempt.status, JSON.stringify(attempt), attempt.id);
  }

  cancelRun(owner: string, runId: string): Run {
    return this.transaction(() => {
      const run = this.getRun(owner, runId);
      if (run.cancelRequestedAt || terminalStatusSchema.safeParse(run.status).success) return run;
      const time = this.now();
      this.db.prepare("UPDATE runs SET cancel_requested_at=?, updated_at=? WHERE id=?").run(time, time, runId);
      this.db.prepare("UPDATE jobs SET cancel_requested_at=? WHERE run_id=? AND status IN ('queued','leased')").run(time, runId);
      this.append(runId, null, "run.cancel_requested", {});
      for (const attempt of this.attempts(owner, runId)) {
        if (attempt.status !== "queued") continue;
        this.saveAttempt({ ...attempt, status: "cancelled", updatedAt: time });
        this.db.prepare("UPDATE jobs SET status='cancelled' WHERE attempt_id=?").run(attempt.id);
        this.append(runId, attempt.id, "attempt.finished", { status: "cancelled" });
      }
      this.reconcile(owner, runId);
      return this.getRun(owner, runId);
    });
  }

  // Internal state primitives, not a lease/launch protocol. Layer 04 must fence paid work.
  startAttempt(owner: string, runId: string, attemptId: string): Attempt {
    return this.transaction(() => {
      if (this.db.prepare("SELECT l.job_id FROM launches l JOIN jobs j ON j.id=l.job_id WHERE j.attempt_id=?").get(attemptId)) throw conflict();
      const run = this.getRun(owner, runId);
      const attempt = this.attempts(owner, runId).find((entry) => entry.id === attemptId);
      if (!attempt) throw notFound();
      if (run.cancelRequestedAt || attempt.status !== "queued") throw conflict();
      const next = { ...attempt, status: "running" as const, updatedAt: this.now() };
      this.saveAttempt(next);
      this.db.prepare("UPDATE jobs SET status='leased' WHERE attempt_id=?").run(attemptId);
      this.db.prepare("UPDATE runs SET status='running', updated_at=? WHERE id=?").run(this.now(), runId);
      this.append(runId, attemptId, "attempt.started", { status: "running" });
      return next;
    });
  }

  finishAttempt(owner: string, runId: string, attemptId: string, outcome: TerminalStatus): Attempt {
    terminalStatusSchema.parse(outcome);
    return this.transaction(() => {
      if (this.db.prepare("SELECT l.job_id FROM launches l JOIN jobs j ON j.id=l.job_id WHERE j.attempt_id=?").get(attemptId)) throw conflict();
      const run = this.getRun(owner, runId);
      const attempt = this.attempts(owner, runId).find((entry) => entry.id === attemptId);
      if (!attempt) throw notFound();
      if (attempt.status === outcome) return attempt;
      const status = run.cancelRequestedAt && outcome !== "infrastructure_failed" ? "cancelled" : outcome;
      if (attempt.status === status) return attempt;
      if (attempt.status !== "running") throw conflict();
      const next = { ...attempt, status, updatedAt: this.now() };
      this.saveAttempt(next);
      this.db.prepare("UPDATE jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL WHERE attempt_id=?")
        .run(status === "cancelled" ? "cancelled" : "completed", attemptId);
      this.append(runId, attemptId, "attempt.finished", { status });
      this.reconcile(owner, runId);
      return next;
    });
  }

  protected reconcile(owner: string, runId: string): void {
    const attempts = this.attempts(owner, runId);
    if (attempts.some((entry) => entry.status === "running" || entry.status === "queued")) return;
    const run = this.getRun(owner, runId);
    const priority: TerminalStatus[] = [
      "infrastructure_failed", "limit_reached", "blocked", "target_failed", "gave_up", "cancelled", "succeeded",
    ];
    const hasInfrastructureFailure = attempts.some((entry) => entry.status === "infrastructure_failed");
    const status = run.cancelRequestedAt && !hasInfrastructureFailure
      ? "cancelled"
      : priority.find((value) => attempts.some((entry) => entry.status === value))!;
    this.db.prepare("UPDATE runs SET status=?, updated_at=? WHERE id=?").run(status, this.now(), runId);
    this.append(runId, null, "run.finished", { status });
  }

  recordEvidence(owner: string, input: Omit<Evidence, "id" | "createdAt">, storageKey: string): Evidence {
    const evidence = evidenceSchema.parse({ ...input, id: randomUUID(), createdAt: this.now() });
    z.string().regex(/^[a-f0-9]{64}$/).parse(storageKey);
    return this.transaction(() => {
      const attempt = this.attempts(owner, evidence.runId).find((entry) => entry.id === evidence.attemptId);
      if (!attempt) throw notFound();
      this.db.prepare("INSERT INTO evidence VALUES(?, ?, ?, ?, ?)").run(
        evidence.id, evidence.runId, evidence.attemptId, storageKey, JSON.stringify(evidence),
      );
      this.append(evidence.runId, evidence.attemptId, "evidence.recorded", { evidenceId: evidence.id });
      return evidence;
    });
  }

  getEvidence(owner: string, id: string): Evidence {
    return this.storedEvidence(owner, id).metadata;
  }

  storedEvidence(owner: string, id: string, runId?: string, attemptId?: string): StoredEvidence {
    idSchema.parse(id);
    const row = this.db.prepare(`SELECT e.id,e.run_id,e.attempt_id,e.storage_key,e.metadata
      FROM evidence e JOIN runs r ON r.id=e.run_id
      JOIN attempts a ON a.id=e.attempt_id AND a.run_id=e.run_id
      WHERE e.id=? AND r.owner_id=?`).get(id, owner);
    if (!row) throw notFound();
    const metadata = evidenceSchema.parse(parseJson(row.metadata));
    if (metadata.id !== row.id || metadata.runId !== row.run_id || metadata.attemptId !== row.attempt_id ||
      (runId !== undefined && metadata.runId !== runId) || (attemptId !== undefined && metadata.attemptId !== attemptId)) throw notFound();
    return { metadata, storageKey: z.string().regex(/^[a-f0-9]{64}$/).parse(row.storage_key) };
  }

  recordFinding(owner: string, input: Omit<Finding, "id" | "createdAt">): Finding {
    const finding = findingSchema.parse({ ...input, id: randomUUID(), createdAt: this.now() });
    return this.transaction(() => {
      if (!this.attempts(owner, finding.runId).some((entry) => entry.id === finding.attemptId)) throw notFound();
      for (const id of finding.evidenceIds) {
        const evidence = this.getEvidence(owner, id);
        if (evidence.runId !== finding.runId || evidence.attemptId !== finding.attemptId) throw conflict();
      }
      this.db.prepare("INSERT INTO findings VALUES(?, ?, ?, ?)").run(finding.id, finding.runId, finding.attemptId, JSON.stringify(finding));
      for (const id of new Set(finding.evidenceIds)) {
        this.db.prepare("INSERT INTO finding_evidence VALUES(?, ?)").run(finding.id, id);
      }
      this.append(finding.runId, finding.attemptId, "finding.recorded", { findingId: finding.id });
      return finding;
    });
  }

  getFinding(owner: string, id: string): Finding {
    idSchema.parse(id);
    const row = this.db.prepare(`SELECT f.id,f.run_id,f.attempt_id,f.finding FROM findings f
      JOIN runs r ON r.id=f.run_id JOIN attempts a ON a.id=f.attempt_id AND a.run_id=f.run_id
      WHERE f.id=? AND r.owner_id=?`).get(id, owner);
    if (!row) throw notFound();
    const finding = findingSchema.parse(parseJson(row.finding));
    if (finding.id !== row.id || finding.runId !== row.run_id || finding.attemptId !== row.attempt_id) throw notFound();
    for (const evidenceId of finding.evidenceIds) this.storedEvidence(owner, evidenceId, finding.runId, finding.attemptId);
    return finding;
  }

  reportSource(owner: string, runId: string): ReportSource {
    return this.transaction(() => {
      const run = this.getRun(owner, runId);
      const attempts = this.attempts(owner, runId);
      const attemptIds = new Set(attempts.map(({ id }) => id));
      const rows = this.db.prepare("SELECT id FROM evidence WHERE run_id=? ORDER BY rowid").all(runId);
      if (rows.length > 12 * 128) throw new ServiceError("too_large", 413);
      const evidence = rows.map((row) => this.storedEvidence(owner, z.string().parse(row.id), runId));
      const ownedEvidence = new Map(evidence.map(({ metadata }) => [metadata.id, metadata]));
      const events = this.db.prepare("SELECT sequence,event FROM events WHERE run_id=? ORDER BY sequence LIMIT 5001").all(runId)
        .map((row) => {
          const event = eventSchema.parse(parseJson(row.event));
          if (event.runId !== runId || event.sequence !== row.sequence ||
            (event.attemptId !== null && !attemptIds.has(event.attemptId))) throw notFound();
          if (event.data.evidenceId && ownedEvidence.get(event.data.evidenceId)?.attemptId !== event.attemptId) {
            const { evidenceId: _evidenceId, ...data } = event.data;
            void _evidenceId;
            return { ...event, data };
          }
          return event;
        });
      if (events.length > 5000) throw new ServiceError("too_large", 413);
      const results = this.db.prepare(`SELECT j.attempt_id,l.summary FROM launches l
        JOIN jobs j ON j.id=l.job_id JOIN attempts a ON a.id=j.attempt_id AND a.run_id=j.run_id
        WHERE j.run_id=? AND l.summary IS NOT NULL`).all(runId).map((row) => ({
        attemptId: z.string().parse(row.attempt_id), result: resultSchema.parse(parseJson(row.summary)),
      }));
      const humanAssistedAttemptIds = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='takeover_intervals'").get()
        ? this.db.prepare(`SELECT DISTINCT t.attempt_id FROM takeover_intervals t
          JOIN attempts a ON a.id=t.attempt_id WHERE a.run_id=?`).all(runId)
          .map((row) => z.string().parse(row.attempt_id))
        : [];
      return {
        run, attempts, summaries: this.attemptSummaries(owner, runId), events, evidence, results, humanAssistedAttemptIds,
        sequence: z.number().parse(this.db.prepare("SELECT next_sequence FROM runs WHERE id=?").get(runId)?.next_sequence),
      };
    });
  }

  persistReport(owner: string, report: RunReport, sequence: number): void {
    runReportSchema.parse(report);
    this.transaction(() => {
      this.getRun(owner, report.runId);
      if (this.db.prepare("SELECT next_sequence FROM runs WHERE id=?").get(report.runId)?.next_sequence !== sequence) return;
      this.db.prepare(`INSERT INTO report_snapshots VALUES(?,?,?)
        ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision,report=excluded.report`)
        .run(report.runId, report.revision, JSON.stringify(report));
    });
  }

  recordingSession(owner: string, runId: string, attemptId: string): { sessionId: string; active: boolean } | null {
    const attempt = this.attempts(owner, runId).find(({ id }) => id === attemptId);
    if (!attempt) throw notFound();
    const row = this.db.prepare(`SELECT l.session_reference,l.state,j.id FROM launches l
      JOIN jobs j ON j.id=l.job_id JOIN attempts a ON a.id=j.attempt_id AND a.run_id=j.run_id
      WHERE j.run_id=? AND j.attempt_id=?`).get(runId, attemptId);
    if (!row?.session_reference) return null;
    const reference = referenceSchema.parse(parseJson(row.session_reference));
    const binding = this.db.prepare("SELECT job_id FROM browser_session_bindings WHERE session_id=?").get(reference.sessionId);
    if (binding?.job_id !== row.id) throw notFound();
    return { sessionId: reference.sessionId, active: row.state === "active" || row.state === "intent" };
  }

  authorizeReplay(owner: string, runId: string, attemptId: string): { token: string; expiresAt: number } {
    return this.transaction(() => {
      const session = this.recordingSession(owner, runId, attemptId);
      if (!session) throw notFound();
      this.db.prepare("DELETE FROM replay_grants WHERE expires_at<=?").run(this.clock());
      const token = randomBytes(32).toString("base64url");
      const expiresAt = this.clock() + 15 * 60_000;
      this.db.prepare(`INSERT INTO replay_grants VALUES(?,?,?,?,?)
        ON CONFLICT(owner_id,attempt_id) DO UPDATE SET session_id=excluded.session_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at`)
        .run(owner, attemptId, session.sessionId, digest(token), expiresAt);
      return { token, expiresAt };
    });
  }

  replayAuthorized(owner: string, runId: string, attemptId: string, token: string): boolean {
    const session = this.recordingSession(owner, runId, attemptId);
    if (!session || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return !!this.db.prepare(`SELECT owner_id FROM replay_grants
      WHERE owner_id=? AND attempt_id=? AND session_id=? AND token_hash=? AND expires_at>?`)
      .get(owner, attemptId, session.sessionId, digest(token), this.clock());
  }
}
