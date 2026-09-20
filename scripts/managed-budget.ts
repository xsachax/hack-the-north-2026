import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { workerPolicySchema } from "../src/server/worker/config";

export const MANAGED_AMENDED_LIFETIME_SECONDS = 3600;
export const managedBudgetAmendmentSchema = z.strictObject({
  version: z.literal(1),
  previousPolicy: workerPolicySchema,
  amendedPolicy: workerPolicySchema,
  reservedAtAmendment: z.literal(1800),
  ledgerDigestBefore: z.string().regex(/^[a-f0-9]{64}$/),
  unchangedHistoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  receiptIssuedAt: z.int().nonnegative(),
  userApproval: z.literal("use as many seconds as you want"),
  provenance: z.literal("Explicit newer user message in the independent driver session; receipt time is not a new user-message timestamp."),
  allocationRetries: z.literal(false),
}).refine((value) => value.previousPolicy.lifetimeReservationLimitSeconds === 1800 &&
  value.amendedPolicy.lifetimeReservationLimitSeconds === MANAGED_AMENDED_LIFETIME_SECONDS &&
  value.amendedPolicy.globalConcurrency === 1 && value.amendedPolicy.ownerConcurrency === 1 &&
  value.amendedPolicy.sessionSeconds === 300 &&
  isDeepStrictEqual(value.amendedPolicy, { ...value.previousPolicy, lifetimeReservationLimitSeconds: MANAGED_AMENDED_LIFETIME_SECONDS }),
"Only the explicitly authorized lifetime ceiling may change; reservations and all other limits stay intact");

/** A missing amendment never expands the original ceiling. This reader performs no writes. */
export function readManagedBudgetAmendment(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_proof_budget_amendment'").get()) return null;
  const rows = db.prepare("SELECT receipt FROM managed_proof_budget_amendment").all();
  if (rows.length !== 1) throw new Error("managed_budget_amendment_rejected");
  const receipt = managedBudgetAmendmentSchema.parse(JSON.parse(z.string().parse(rows[0].receipt)));
  const stored = JSON.parse(z.string().parse(db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get()?.configuration));
  if (!isDeepStrictEqual(stored, receipt.amendedPolicy)) throw new Error("managed_budget_amendment_policy_mismatch");
  return receipt;
}

export function managedBudgetHistoryDigest(db: DatabaseSync) {
  const tables = db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table'
    AND name NOT LIKE 'sqlite_%' AND name NOT IN ('worker_policy','managed_proof_budget_amendment') ORDER BY name`).all();
  const history = tables.map((table) => ({
    ...table, rows: db.prepare(`SELECT * FROM "${z.string().parse(table.name).replaceAll('"', '""')}"`).all(),
  }));
  return createHash("sha256").update(JSON.stringify(history)).digest("hex");
}

/** Explicit operator action only; plan preparation and execution never amend a budget. */
export function applyManagedBudgetAmendment(db: DatabaseSync, input: unknown) {
  const receipt = managedBudgetAmendmentSchema.parse(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (readManagedBudgetAmendment(db)) throw new Error("managed_budget_already_amended");
    const current = JSON.parse(z.string().parse(db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get()?.configuration));
    const reserved = Number(db.prepare(`SELECT
      (SELECT COALESCE(SUM(reserved_seconds),0) FROM usage_reservations) +
      (SELECT COALESCE(SUM(reserved_seconds),0) FROM managed_attempts) AS total`).get()?.total);
    if (!isDeepStrictEqual(current, receipt.previousPolicy) || reserved !== receipt.reservedAtAmendment ||
      managedBudgetHistoryDigest(db) !== receipt.unchangedHistoryDigest ||
      db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','leased') LIMIT 1").get() ||
      db.prepare("SELECT 1 FROM managed_attempts WHERE state!='settled' OR cleanup!='closed' LIMIT 1").get()) {
      throw new Error("managed_budget_amendment_binding_mismatch");
    }
    db.exec("CREATE TABLE managed_proof_budget_amendment(singleton INTEGER PRIMARY KEY CHECK(singleton=1),receipt TEXT NOT NULL)");
    db.prepare("INSERT INTO managed_proof_budget_amendment VALUES(1,?)").run(JSON.stringify(receipt));
    db.prepare("UPDATE worker_policy SET configuration=? WHERE singleton=1").run(JSON.stringify(receipt.amendedPolicy));
    if (managedBudgetHistoryDigest(db) !== receipt.unchangedHistoryDigest) throw new Error("managed_budget_history_changed");
    db.exec("COMMIT");
    return receipt;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
