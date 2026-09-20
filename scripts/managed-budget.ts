import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { workerPolicySchema } from "../src/server/worker/config";

export const MANAGED_AMENDED_LIFETIME_SECONDS = 3600;
export const MANAGED_DEMO_LIFETIME_SECONDS = 21600;
export const MANAGED_DEMO_AUTHORIZATION = "we have 100 hours of budget, use as much as needed for an effective demo. It could be nice to have a run that isnt too long but long enough to get good results live. 30 seconds each? And it would be nice to see updates on one dashboard for all concurrent agents in the same run";
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

export const managedDemoPolicyAmendmentSchema = z.strictObject({
  version: z.literal(1), previousPolicy: workerPolicySchema, amendedPolicy: workerPolicySchema,
  reservedAtAmendment: z.int().min(1800).max(MANAGED_DEMO_LIFETIME_SECONDS),
  ledgerDigestBefore: z.string().regex(/^[a-f0-9]{64}$/),
  unchangedHistoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  receiptIssuedAt: z.int().nonnegative(),
  userApproval: z.literal(MANAGED_DEMO_AUTHORIZATION),
  userDirectionReceivedAt: z.literal("2026-09-20T06:20:35.088Z"),
  provenance: z.literal("Explicit user direction relayed by session 3d2c0015-7c44-4ba4-a278-da935ff90a0a; receipt issuance is not a new user message."),
  authorizedCeilingSeconds: z.literal(360000), projectConcurrency: z.int().min(5),
  allocationRetries: z.literal(false),
}).refine((value) => [60, 90].includes(value.amendedPolicy.sessionSeconds) &&
  value.amendedPolicy.lifetimeReservationLimitSeconds >= value.previousPolicy.lifetimeReservationLimitSeconds &&
  value.amendedPolicy.developmentBudgetSeconds <= value.authorizedCeilingSeconds &&
  isDeepStrictEqual(value.amendedPolicy, {
    ...value.previousPolicy, globalConcurrency: 5, ownerConcurrency: 5,
    sessionSeconds: value.amendedPolicy.sessionSeconds,
    lifetimeReservationLimitSeconds: MANAGED_DEMO_LIFETIME_SECONDS,
    ownerBudgetSeconds: MANAGED_DEMO_LIFETIME_SECONDS,
    developmentBudgetSeconds: value.previousPolicy.baselineSeconds + MANAGED_DEMO_LIFETIME_SECONDS,
  }), "Only the authorized demo concurrency, short duration and bounded budget may change");

/** Without a complete amendment chain the original native proof policy remains mandatory. */
export function readManagedBudgetPolicy(db: DatabaseSync) {
  const hasBudget = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_proof_budget_amendment'").get();
  const hasDemo = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_demo_policy_amendments'").get();
  if (!hasBudget) {
    if (hasDemo) throw new Error("managed_demo_policy_chain_rejected");
    return { budgetAmendment: null, demoAmendments: [], policy: undefined };
  }
  const rows = db.prepare("SELECT receipt FROM managed_proof_budget_amendment").all();
  if (rows.length !== 1) throw new Error("managed_budget_amendment_rejected");
  const receipt = managedBudgetAmendmentSchema.parse(JSON.parse(z.string().parse(rows[0].receipt)));
  const demoAmendments = hasDemo ? db.prepare("SELECT sequence,receipt FROM managed_demo_policy_amendments ORDER BY sequence").all()
    .map((row, index) => {
      if (row.sequence !== index + 1) throw new Error("managed_demo_policy_chain_rejected");
      return managedDemoPolicyAmendmentSchema.parse(JSON.parse(z.string().parse(row.receipt)));
    }) : [];
  let policy = receipt.amendedPolicy;
  for (const amendment of demoAmendments) {
    if (!isDeepStrictEqual(amendment.previousPolicy, policy)) throw new Error("managed_demo_policy_chain_rejected");
    policy = amendment.amendedPolicy;
  }
  const stored = JSON.parse(z.string().parse(db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get()?.configuration));
  if (!isDeepStrictEqual(stored, policy)) throw new Error("managed_budget_amendment_policy_mismatch");
  return { budgetAmendment: receipt, demoAmendments, policy };
}

export function readManagedBudgetAmendment(db: DatabaseSync) {
  return readManagedBudgetPolicy(db).budgetAmendment;
}

export function managedBudgetHistoryDigest(db: DatabaseSync) {
  const tables = db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table'
    AND name NOT LIKE 'sqlite_%'
    AND name NOT IN ('worker_policy','managed_proof_budget_amendment','managed_demo_policy_amendments') ORDER BY name`).all();
  const history = tables.map((table) => ({
    ...table, rows: db.prepare(`SELECT * FROM "${z.string().parse(table.name).replaceAll('"', '""')}"`).all(),
  }));
  return createHash("sha256").update(JSON.stringify(history)).digest("hex");
}

function assertAmendmentBinding(db: DatabaseSync, receipt: {
  previousPolicy: unknown; reservedAtAmendment: number; unchangedHistoryDigest: string;
}) {
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
}

/** Explicit operator action only; plan preparation and execution never amend a budget. */
export function applyManagedBudgetAmendment(db: DatabaseSync, input: unknown) {
  const receipt = managedBudgetAmendmentSchema.parse(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (readManagedBudgetAmendment(db)) throw new Error("managed_budget_already_amended");
    assertAmendmentBinding(db, receipt);
    db.exec("CREATE TABLE managed_proof_budget_amendment(singleton INTEGER PRIMARY KEY CHECK(singleton=1),receipt TEXT NOT NULL)");
    db.prepare("INSERT INTO managed_proof_budget_amendment VALUES(1,?)").run(JSON.stringify(receipt));
    db.prepare("UPDATE worker_policy SET configuration=? WHERE singleton=1").run(JSON.stringify(receipt.amendedPolicy));
    if (managedBudgetHistoryDigest(db) !== receipt.unchangedHistoryDigest) throw new Error("managed_budget_history_changed");
    db.exec("COMMIT");
    return receipt;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function applyManagedDemoPolicyAmendment(db: DatabaseSync, input: unknown) {
  const receipt = managedDemoPolicyAmendmentSchema.parse(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    const chain = readManagedBudgetPolicy(db);
    if (!chain.budgetAmendment || !isDeepStrictEqual(chain.policy, receipt.previousPolicy)) {
      throw new Error("managed_demo_policy_chain_rejected");
    }
    assertAmendmentBinding(db, receipt);
    db.exec("CREATE TABLE IF NOT EXISTS managed_demo_policy_amendments(sequence INTEGER PRIMARY KEY,receipt TEXT NOT NULL)");
    db.prepare("INSERT INTO managed_demo_policy_amendments VALUES(?,?)")
      .run(chain.demoAmendments.length + 1, JSON.stringify(receipt));
    db.prepare("UPDATE worker_policy SET configuration=? WHERE singleton=1").run(JSON.stringify(receipt.amendedPolicy));
    if (managedBudgetHistoryDigest(db) !== receipt.unchangedHistoryDigest) throw new Error("managed_budget_history_changed");
    db.exec("COMMIT");
    return receipt;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
