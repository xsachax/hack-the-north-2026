import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  takeoverCommandSchema, takeoverPhaseSchema, takeoverStatusSchema, takeoverViewerUrl,
  type TakeoverStatus, type TakeoverPhase,
} from "../../lib/takeover-contracts";
import { idempotencyKeySchema } from "../../lib/contracts";
import { ServiceError } from "../errors";
import { ExecutionError, TakeoverInterrupted, type ExecutionControl } from "../execution/types";
import type { Claim } from "../worker/repository";
import { referenceSchema } from "../worker/session-reference";

export const takeoverMigration = `
CREATE TABLE takeover_controls (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  phase TEXT NOT NULL CHECK(phase IN ('agent','requested','quiescing','human','handback','resuming','closed')),
  version INTEGER NOT NULL DEFAULT 0,
  controller_id TEXT,
  lease_generation INTEGER NOT NULL,
  deadline INTEGER,
  viewer_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE takeover_commands (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  command_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  PRIMARY KEY(owner_id,attempt_id,command_key)
);
CREATE TABLE takeover_intervals (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  version INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  PRIMARY KEY(attempt_id,version)
);`;

const rowSchema = z.object({
  phase: takeoverPhaseSchema, version: z.number(), controller_id: z.string().nullable(),
  lease_generation: z.number(), deadline: z.number().nullable(), viewer_until: z.number(),
});
type ControlRow = z.infer<typeof rowSchema>;
type Transaction = <T>(work: () => T) => T;
const conflict = () => new ServiceError("conflict", 409);
const HUMAN_TIMEOUT_MS = 60_000;
const VIEWER_GRANT_MS = 1_500;

/**
 * All mutations run inside the caller's BEGIN IMMEDIATE transaction. Authorization
 * (including CSRF/Origin) belongs to the route; ownership and leases are rechecked here.
 * These interval records intentionally contain no human keystrokes or page payloads.
 */
export class TakeoverService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction,
    private readonly clock = () => Date.now(),
    private readonly onTransition?: (attemptId: string, phase: TakeoverPhase, version: number) => void,
  ) {}

  private attempt(owner: string, attemptId: string) {
    const row = this.db.prepare(`SELECT a.status,r.cancel_requested_at AS run_cancel,r.public_execution_policy,j.id AS job_id,
      j.cancel_requested_at,j.status AS job_status,j.lease_expires_at,j.lease_generation,
      l.state,l.session_reference FROM attempts a JOIN runs r ON r.id=a.run_id
      JOIN jobs j ON j.attempt_id=a.id AND j.run_id=r.id LEFT JOIN launches l ON l.job_id=j.id
      WHERE a.id=? AND r.owner_id=?`).get(attemptId, owner);
    if (!row) throw new ServiceError("not_found", 404);
    if (row.public_execution_policy !== null) throw new ServiceError("public_takeover_unsupported", 400);
    return row;
  }

  private active(row: ReturnType<TakeoverService["attempt"]>) {
    return row.status === "running" && row.job_status === "leased" && row.state === "active" &&
      !row.cancel_requested_at && !row.run_cancel && typeof row.lease_expires_at === "string" &&
      row.lease_expires_at > new Date(this.clock()).toISOString();
  }

  private read(attemptId: string): ControlRow | undefined {
    const row = this.db.prepare("SELECT * FROM takeover_controls WHERE attempt_id=?").get(attemptId);
    return row ? rowSchema.parse(row) : undefined;
  }

  private transition(attemptId: string, phase: TakeoverPhase) {
    this.db.prepare("UPDATE takeover_controls SET phase=?,version=version+1 WHERE attempt_id=?").run(phase, attemptId);
    const row = this.read(attemptId);
    if (row) this.onTransition?.(attemptId, phase, row.version);
  }

  private endInterval(attemptId: string, reason: string) {
    this.db.prepare("UPDATE takeover_intervals SET ended_at=?,end_reason=? WHERE attempt_id=? AND ended_at IS NULL")
      .run(this.clock(), reason, attemptId);
  }

  private close(attemptId: string, reason: string) {
    if (this.read(attemptId)?.phase !== "closed") {
      this.endInterval(attemptId, reason);
      this.transition(attemptId, "closed");
    }
  }

  /** A GET never grants control to a different tab or resurrects an expired lease. */
  status(owner: string, attemptId: string, controllerId?: string): TakeoverStatus {
    if (controllerId !== undefined) z.uuid().parse(controllerId);
    return this.transaction(() => this.statusInTransaction(owner, attemptId, controllerId));
  }

  private statusInTransaction(owner: string, attemptId: string, controllerId?: string): TakeoverStatus {
    const attempt = this.attempt(owner, attemptId);
    let control = this.read(attemptId);
    const timedOut = control && control.phase !== "agent" && control.deadline !== null && control.deadline <= this.clock();
    if (control && (!this.active(attempt) || control.lease_generation !== attempt.lease_generation ||
      timedOut)) {
      this.close(attemptId, timedOut ? "timeout" : "control_unavailable");
      control = this.read(attemptId);
    }
    let interactiveUrl: string | null = null;
    let validUntil: number | null = null;
    if (control?.phase === "human" && control.controller_id === controllerId && attempt.session_reference) {
      const reference = referenceSchema.parse(JSON.parse(String(attempt.session_reference)));
      if (this.db.prepare("SELECT job_id FROM browser_session_bindings WHERE session_id=?")
        .get(reference.sessionId)?.job_id !== attempt.job_id) throw new ServiceError("not_found", 404);
      if (reference.liveViewUrl) {
        interactiveUrl = takeoverViewerUrl(reference.liveViewUrl, true);
        validUntil = Math.min(this.clock() + VIEWER_GRANT_MS, control.deadline!, Date.parse(String(attempt.lease_expires_at)));
        this.db.prepare("UPDATE takeover_controls SET viewer_until=max(viewer_until,?) WHERE attempt_id=?").run(validUntil, attemptId);
      }
    }
    return takeoverStatusSchema.parse({
      attemptId, phase: control?.phase ?? (this.active(attempt) ? "agent" : "closed"),
      version: control?.version ?? 0, controllerId: control && control.controller_id === controllerId ? control.controller_id : null,
      deadline: control?.deadline ?? null, interactiveUrl, validUntil,
      validForMs: validUntil === null ? null : Math.max(0, validUntil - this.clock()),
    });
  }

  command(owner: string, attemptId: string, key: string, input: unknown): TakeoverStatus {
    const command = takeoverCommandSchema.parse(input);
    idempotencyKeySchema.parse(key);
    const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    return this.transaction(() => {
      const attempt = this.attempt(owner, attemptId);
      const duplicate = this.db.prepare(`SELECT request_hash FROM takeover_commands
        WHERE owner_id=? AND attempt_id=? AND command_key=?`).get(owner, attemptId, key);
      if (duplicate) {
        if (duplicate.request_hash !== hash) throw conflict();
        // Replay the command, not an old access-bearing human grant.
        return this.statusInTransaction(owner, attemptId, command.controllerId);
      }
      if (!this.active(attempt)) throw conflict();
      let control = this.read(attemptId);
      if (!control) {
        this.db.prepare(`INSERT INTO takeover_controls(attempt_id,phase,lease_generation)
          VALUES(?,'agent',?)`).run(attemptId, attempt.lease_generation);
        control = this.read(attemptId)!;
      }
      if (control.version !== command.expectedVersion || control.lease_generation !== attempt.lease_generation) throw conflict();
      if (command.action === "request") {
        if (control.phase !== "agent") throw conflict();
        this.db.prepare(`UPDATE takeover_controls SET controller_id=?,deadline=?,viewer_until=0 WHERE attempt_id=?`)
          .run(command.controllerId, this.clock() + HUMAN_TIMEOUT_MS, attemptId);
        this.transition(attemptId, "requested");
      } else {
        if (control.phase !== "human" || control.controller_id !== command.controllerId ||
          control.deadline === null || control.deadline <= this.clock()) throw conflict();
        this.transition(attemptId, "handback");
      }
      this.db.prepare("INSERT INTO takeover_commands VALUES(?,?,?,?)").run(owner, attemptId, key, hash);
      return this.statusInTransaction(owner, attemptId, command.controllerId);
    });
  }

  intervals(owner: string, attemptId: string) {
    this.attempt(owner, attemptId);
    return this.db.prepare(`SELECT version,started_at AS startedAt,ended_at AS endedAt,end_reason AS endReason
      FROM takeover_intervals WHERE attempt_id=? ORDER BY version`).all(attemptId);
  }

  /** The callback MUST assert the current worker lease, generation and cancellation. */
  executionControl(claim: Claim, assertLease: (allowCancelled?: boolean) => void): ExecutionControl {
    const read = () => {
      assertLease();
      const row = this.read(claim.attempt.id);
      if (row && row.lease_generation !== claim.generation) {
        throw new ExecutionError("infra", "Human control unavailable");
      }
      if (row?.phase !== "agent" && row?.deadline !== null && row?.deadline !== undefined && row.deadline <= this.clock()) {
        this.transaction(() => this.close(claim.attempt.id, "timeout"));
        throw new ExecutionError("limit", "Human control timeout");
      }
      if (row?.phase === "closed") throw new ExecutionError("infra", "Human control unavailable");
      return row ?? { phase: "agent" as const, version: 0, viewer_until: 0 };
    };
    return {
      read: () => { const row = read(); return { phase: row.phase, version: row.version }; },
      assertDispatch: () => { if (read().phase !== "agent") throw new TakeoverInterrupted(); },
      quiesce: () => this.transaction(() => {
        if (read().phase === "requested") this.transition(claim.attempt.id, "quiescing");
      }),
      acknowledge: () => this.transaction(() => {
        if (read().phase !== "quiescing") throw new TakeoverInterrupted();
        this.transition(claim.attempt.id, "human");
        const row = this.read(claim.attempt.id)!;
        this.db.prepare("INSERT INTO takeover_intervals VALUES(?,?,?,NULL,NULL)").run(claim.attempt.id, row.version, this.clock());
      }),
      resume: () => this.transaction(() => {
        const row = read();
        if (row.phase === "handback") this.transition(claim.attempt.id, "resuming");
        else if (row.phase === "resuming" && row.viewer_until <= this.clock()) {
          this.endInterval(claim.attempt.id, "handback");
          this.transition(claim.attempt.id, "agent");
          this.db.prepare("UPDATE takeover_controls SET controller_id=NULL,deadline=NULL WHERE attempt_id=?").run(claim.attempt.id);
        }
      }),
      finish: () => this.transaction(() => {
        // Cleanup markers may be written after cancellation, never after lease loss.
        assertLease(true);
        this.close(claim.attempt.id, "execution_ended");
      }),
    };
  }
}
