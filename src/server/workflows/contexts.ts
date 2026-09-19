import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { browserStateSchema, contextViewSchema, type BrowserState, type ContextView } from "../../lib/context-contracts";
import type { TargetScope } from "../../lib/target-scope";
import { ServiceError } from "../errors";
import type { ContextProvider } from "./context-provider";

export const CONTEXT_PERSIST_DELAY_MS = 10_000;
export const contextMigration = `
  CREATE TABLE browser_contexts (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
    scope_signature TEXT NOT NULL, remote_id TEXT UNIQUE,
    status TEXT NOT NULL, persistence TEXT NOT NULL DEFAULT 'never_saved',
    created_at INTEGER NOT NULL, available_after INTEGER,
    expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
    held_job TEXT REFERENCES jobs(id), operation_token TEXT,
    CHECK(revoked IN (0,1))
  );
  CREATE INDEX browser_contexts_owner ON browser_contexts(owner_id);
  CREATE TABLE context_selections (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
    context_id TEXT NOT NULL REFERENCES browser_contexts(id),
    persist INTEGER NOT NULL CHECK(persist IN (0,1))
  );
  CREATE TABLE context_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    context_id TEXT NOT NULL REFERENCES browser_contexts(id),
    operation TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`;

export function contextScopeSignature(scope: TargetScope): string {
  return createHash("sha256").update(JSON.stringify({
    targetUrl: scope.targetUrl,
    allowedSubdomains: [...scope.allowedSubdomains].sort(),
    pathPrefixes: [...scope.pathPrefixes].sort(),
  })).digest("hex");
}

const recordSchema = z.object({
  id: z.uuid(), owner_id: z.uuid(), scope_signature: z.string(),
  remote_id: z.string().nullable(), status: contextViewSchema.shape.status,
  persistence: contextViewSchema.shape.persistence,
  created_at: z.number(), available_after: z.number().nullable(), expires_at: z.number(),
  revoked: z.number(), held_job: z.string().nullable(), operation_token: z.string().nullable(),
});
type ContextRecord = z.infer<typeof recordSchema>;
type ContextClaim = { ownerId: string; jobId: string; attempt: { id: string }; scope: TargetScope };

export class ContextStore {
  constructor(private readonly db: DatabaseSync, private readonly clock = () => Date.now()) {}

  private atomic<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private record(id: string): ContextRecord {
    const row = this.db.prepare("SELECT * FROM browser_contexts WHERE id=?").get(id);
    if (!row) throw new ServiceError("not_found", 404);
    return recordSchema.parse(row);
  }

  private view(row: ContextRecord): ContextView {
    return contextViewSchema.parse({
      id: row.id, scopeSignature: row.scope_signature, status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      availableAfter: row.available_after === null ? null : new Date(row.available_after).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      revoked: !!row.revoked, persistence: row.persistence,
    });
  }

  list(owner: string): ContextView[] {
    return this.db.prepare("SELECT * FROM browser_contexts WHERE owner_id=? ORDER BY created_at DESC LIMIT 100")
      .all(owner).map((row) => this.view(recordSchema.parse(row)));
  }

  /** Called inside the immutable run admission transaction. */
  assign(owner: string, scope: TargetScope, attemptId: string, input: BrowserState): void {
    const selection = browserStateSchema.parse(input);
    if (selection.mode === "fresh") return;
    const signature = contextScopeSignature(scope);
    let id: string;
    if (selection.mode === "save") {
      const count = this.db.prepare("SELECT count(*) AS n FROM browser_contexts WHERE owner_id=?").get(owner);
      if (Number(count?.n) >= 100) throw new ServiceError("rate_limited", 429);
      id = randomUUID();
      const expires = this.db.prepare("SELECT expires_at FROM owners WHERE id=?").get(owner)?.expires_at;
      if (typeof expires !== "number" || expires <= this.clock()) throw new ServiceError("unauthorized", 401);
      this.db.prepare(`INSERT INTO browser_contexts
        (id,owner_id,scope_signature,status,created_at,expires_at) VALUES(?,?,?,'pending',?,?)`)
        .run(id, owner, signature, this.clock(), Math.min(expires, this.clock() + 7 * 86_400_000));
    } else {
      id = selection.contextId;
      const row = this.record(id);
      if (row.owner_id !== owner || row.scope_signature !== signature) throw new ServiceError("not_found", 404);
      if (row.revoked || row.expires_at <= this.clock() ||
        !["available", "persisting"].includes(row.status)) throw new ServiceError("conflict", 409);
    }
    this.db.prepare("INSERT INTO context_selections VALUES(?,?,?)")
      .run(attemptId, id, selection.mode === "save" || selection.persist ? 1 : 0);
  }

  /** Atomic with money/launch intent; an expired worker lease never releases this hold. */
  claim(claim: ContextClaim): "fresh" | "claimed" | "wait" | "invalid" {
    const selection = this.db.prepare("SELECT context_id FROM context_selections WHERE attempt_id=?").get(claim.attempt.id);
    if (!selection) return "fresh";
    const row = this.record(z.string().parse(selection.context_id));
    if (row.owner_id !== claim.ownerId || row.scope_signature !== contextScopeSignature(claim.scope) ||
      row.revoked || row.expires_at <= this.clock()) return "invalid";
    if (row.held_job && row.held_job !== claim.jobId) return "wait";
    if (row.status === "persisting") {
      if (row.available_after === null || row.available_after > this.clock()) return "wait";
      this.db.prepare("UPDATE browser_contexts SET status='available',persistence='delay_elapsed_unverified' WHERE id=?").run(row.id);
    } else if (!["pending", "available"].includes(row.status)) return "invalid";
    this.db.prepare("UPDATE browser_contexts SET held_job=?,status='in_use' WHERE id=?").run(claim.jobId, row.id);
    return "claimed";
  }

  private operation(id: string, operation: string, status: string): void {
    this.db.prepare("INSERT INTO context_operations(context_id,operation,status,created_at) VALUES(?,?,?,?)")
      .run(id, operation, status, this.clock());
  }

  assertActive(claim: ContextClaim): void {
    const raw = this.db.prepare(`SELECT c.* FROM browser_contexts c
      JOIN context_selections s ON s.context_id=c.id WHERE s.attempt_id=?`).get(claim.attempt.id);
    if (!raw) return;
    const row = recordSchema.parse(raw);
    if (row.held_job !== claim.jobId || row.owner_id !== claim.ownerId || row.revoked ||
      row.expires_at <= this.clock() || !["in_use", "creating"].includes(row.status)) {
      throw new Error("context_not_active");
    }
  }

  async prepare(claim: ContextClaim, assertLease: () => void, provider?: ContextProvider) {
    const selection = this.db.prepare("SELECT context_id,persist FROM context_selections WHERE attempt_id=?").get(claim.attempt.id);
    if (!selection) return undefined;
    const id = z.string().parse(selection.context_id);
    const row = this.atomic(() => {
      assertLease();
      const row = this.record(id);
      if (row.held_job !== claim.jobId || row.revoked || row.expires_at <= this.clock() || row.status !== "in_use") {
        throw new Error("context_claim_unavailable");
      }
      if (!provider) throw new Error("context_provider_unavailable");
      if (!row.remote_id) {
        this.db.prepare("UPDATE browser_contexts SET status='creating' WHERE id=?").run(id);
        this.operation(id, "create", "dispatched");
      }
      return row;
    });
    if (!provider) throw new Error("context_provider_unavailable");
    let remoteId = row.remote_id;
    if (!remoteId) {
      try {
        remoteId = z.uuid().parse(await provider.create(`flash-flood-${id}`));
        const createdId = remoteId;
        // Save the known ID even if this worker lost its lease: this cannot grant
        // usage, but avoids losing the only deletion reference to a paid resource.
        this.atomic(() => {
          const current = this.record(id);
          if (current.remote_id && current.remote_id !== createdId) throw new Error("context_identity_changed");
          this.db.prepare("UPDATE browser_contexts SET remote_id=? WHERE id=?").run(createdId, id);
          this.operation(id, "create", "returned");
          assertLease();
          this.db.prepare("UPDATE browser_contexts SET status='in_use' WHERE id=?").run(id);
        });
      } catch {
        this.atomic(() => {
          // Creation is never retried after a lost reply or a crash.
          this.db.prepare(`UPDATE browser_contexts SET status='creation_unknown',persistence='uncertain',
            remote_id=COALESCE(remote_id,?) WHERE id=?`).run(remoteId, id);
          this.operation(id, "create", "uncertain");
        });
        throw new Error("context_creation_unconfirmed");
      }
    }
    try {
      await provider.inspect(remoteId);
      this.atomic(() => {
        assertLease();
        const current = this.record(id);
        if (current.revoked || current.expires_at <= this.clock() || current.held_job !== claim.jobId) {
          throw new Error("context_revoked_or_expired");
        }
        this.db.prepare("UPDATE browser_contexts SET persistence=? WHERE id=?")
          .run(selection.persist ? "requested" : row.persistence, id);
      });
    } catch {
      this.atomic(() => {
        this.db.prepare(`UPDATE browser_contexts SET status='quarantined',persistence='uncertain'
          WHERE id=? AND held_job=?`).run(id, claim.jobId);
        this.operation(id, "inspect", "failed");
      });
      throw new Error("context_adoption_failed");
    }
    return { id: remoteId, persist: selection.persist === 1 };
  }

  /** Called inside fenced settlement, only terminal remote proof can release a hold. */
  settle(jobId: string, options: { confirmed: boolean; neverAllocated: boolean; clean: boolean; recovered?: boolean }): void {
    const raw = this.db.prepare(`SELECT c.*,s.persist FROM browser_contexts c
      JOIN context_selections s ON s.context_id=c.id JOIN jobs j ON j.attempt_id=s.attempt_id
      WHERE j.id=? AND c.held_job=?`).get(jobId, jobId);
    if (!raw) return;
    const row = recordSchema.parse(raw);
    if (!options.confirmed) {
      this.db.prepare("UPDATE browser_contexts SET status='quarantined',persistence='uncertain' WHERE id=?").run(row.id);
      return;
    }
    const uncertain = ["creating", "creation_unknown", "quarantined"].includes(row.status) ||
      (!options.neverAllocated && (!options.clean || options.recovered));
    const delay = raw.persist && !options.neverAllocated;
    const status = row.revoked ? "revoked" : uncertain ? "quarantined" :
      delay ? "persisting" : row.remote_id ? "available" : "pending";
    this.db.prepare(`UPDATE browser_contexts SET held_job=NULL,status=?,available_after=?,persistence=? WHERE id=?`)
      .run(status, delay ? this.clock() + CONTEXT_PERSIST_DELAY_MS : null,
        uncertain ? "uncertain" : delay ? "requested" : row.persistence, row.id);
    this.operation(row.id, "session_settlement", uncertain ? "uncertain" : "closed");
  }

  revoke(owner: string, id: string): ContextView {
    return this.atomic(() => {
      const row = this.record(id);
      if (row.owner_id !== owner) throw new ServiceError("not_found", 404);
      if (row.status === "deleted") return this.view(row);
      this.db.prepare(`UPDATE browser_contexts SET revoked=1,
        status=CASE WHEN held_job IS NULL AND status NOT IN ('deleting','deletion_unknown') THEN 'revoked' ELSE status END WHERE id=?`).run(id);
      if (row.held_job) this.db.prepare("UPDATE jobs SET cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE id=?")
        .run(new Date(this.clock()).toISOString(), row.held_job);
      return this.view(this.record(id));
    });
  }

  async retireOne(provider?: ContextProvider): Promise<void> {
    if (!provider) return;
    const row = this.atomic(() => {
      this.db.prepare(`UPDATE browser_contexts SET status='deletion_unknown'
        WHERE status='deleting' AND EXISTS (SELECT 1 FROM context_operations o
          WHERE o.context_id=browser_contexts.id AND o.operation='delete' AND o.status='dispatched'
          AND o.created_at<=?)`).run(this.clock() - 30_000);
      this.db.prepare(`UPDATE browser_contexts SET revoked=1 WHERE expires_at<=? AND status!='deleted'`).run(this.clock());
      this.db.prepare(`UPDATE jobs SET cancel_requested_at=COALESCE(cancel_requested_at,?)
        WHERE id IN (SELECT held_job FROM browser_contexts WHERE revoked=1 AND held_job IS NOT NULL)`)
        .run(new Date(this.clock()).toISOString());
      const found = this.db.prepare(`SELECT * FROM browser_contexts WHERE revoked=1 AND held_job IS NULL
        AND status NOT IN ('deleted','deleting','deletion_unknown') AND (available_after IS NULL OR available_after<=?)
        ORDER BY created_at LIMIT 1`).get(this.clock());
      if (!found) return null;
      const row = recordSchema.parse(found);
      if (!row.remote_id) {
        const creation = this.db.prepare(`SELECT 1 AS found FROM context_operations
          WHERE context_id=? AND operation='create' AND status='dispatched' LIMIT 1`).get(row.id);
        this.db.prepare("UPDATE browser_contexts SET status=? WHERE id=?")
          .run(creation ? "deletion_unknown" : "deleted", row.id);
        return null;
      }
      this.db.prepare("UPDATE browser_contexts SET status='deleting',operation_token=? WHERE id=?").run(randomUUID(), row.id);
      this.operation(row.id, "delete", "dispatched");
      return row;
    });
    if (!row?.remote_id) return;
    try {
      await provider.delete(row.remote_id);
      this.atomic(() => {
        this.db.prepare(`UPDATE browser_contexts SET status='deleted',remote_id=NULL
          WHERE id=? AND remote_id=? AND status IN ('deleting','deletion_unknown')`).run(row.id, row.remote_id);
        this.operation(row.id, "delete", "confirmed");
      });
    } catch {
      this.atomic(() => {
        this.db.prepare("UPDATE browser_contexts SET status='deletion_unknown' WHERE id=? AND status='deleting'").run(row.id);
        this.operation(row.id, "delete", "uncertain");
      });
    }
  }
}
