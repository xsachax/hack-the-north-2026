import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyManagedBudgetAmendment, managedBudgetAmendmentSchema, managedBudgetHistoryDigest, readManagedBudgetAmendment,
} from "../../../scripts/managed-budget";
import { workerPolicySchema } from "../worker/config";

let db: DatabaseSync;
const previousPolicy = workerPolicySchema.parse({
  globalConcurrency: 1, ownerConcurrency: 1, sessionSeconds: 300,
  baselineSeconds: 3780, developmentBudgetSeconds: 5580, ownerBudgetSeconds: 1800,
  lifetimeReservationLimitSeconds: 1800, maxSteps: 6, maxModelCalls: 6,
});
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE worker_policy(singleton INTEGER PRIMARY KEY,configuration TEXT,baseline_seconds INTEGER);
    CREATE TABLE usage_reservations(reserved_seconds INTEGER,consumed_seconds INTEGER);
    CREATE TABLE managed_attempts(state TEXT,cleanup TEXT,reserved_seconds INTEGER,consumed_seconds INTEGER);
    CREATE TABLE jobs(status TEXT);
    INSERT INTO usage_reservations VALUES(900,6);
    INSERT INTO managed_attempts VALUES('settled','closed',900,58);
    INSERT INTO jobs VALUES('completed')`);
  db.prepare("INSERT INTO worker_policy VALUES(1,?,3780)").run(JSON.stringify(previousPolicy));
});
afterEach(() => db.close());
function receipt() {
  return {
    version: 1, previousPolicy, amendedPolicy: { ...previousPolicy, lifetimeReservationLimitSeconds: 3600 },
    reservedAtAmendment: 1800, ledgerDigestBefore: "a".repeat(64),
    unchangedHistoryDigest: managedBudgetHistoryDigest(db), receiptIssuedAt: Date.now(),
    userApproval: "use as many seconds as you want",
    provenance: "Explicit newer user message in the independent driver session; receipt time is not a new user-message timestamp.",
    allocationRetries: false,
  };
}
describe("explicit managed lifetime-budget amendment", () => {
  it("requires a durable amendment and retains every history row and prior reserved second", () => {
    expect(readManagedBudgetAmendment(db)).toBeNull();
    const before = managedBudgetHistoryDigest(db);
    const approved = receipt();
    applyManagedBudgetAmendment(db, approved);
    expect(readManagedBudgetAmendment(db)).toEqual(approved);
    expect(managedBudgetHistoryDigest(db)).toBe(before);
    expect(db.prepare("SELECT reserved_seconds FROM managed_attempts").get()?.reserved_seconds).toBe(900);
    expect(() => applyManagedBudgetAmendment(db, approved)).toThrow("managed_budget_already_amended");
  });
  it.each(["globalConcurrency", "ownerConcurrency", "sessionSeconds", "baselineSeconds", "developmentBudgetSeconds"])(
    "rejects changing %s alongside the ceiling", (field) => {
      const input = receipt();
      expect(managedBudgetAmendmentSchema.safeParse({
        ...input, amendedPolicy: { ...input.amendedPolicy, [field]: 2 },
      }).success).toBe(false);
    },
  );
  it.each([
    "UPDATE managed_attempts SET reserved_seconds=600",
    "UPDATE managed_attempts SET consumed_seconds=59",
    "UPDATE managed_attempts SET state='quarantined',cleanup='unconfirmed'",
    "UPDATE jobs SET status='leased'",
  ])("rejects stale or unsettled history without changing the ceiling", (change) => {
    const approved = receipt();
    db.exec(change);
    expect(() => applyManagedBudgetAmendment(db, approved)).toThrow("managed_budget_amendment_binding_mismatch");
    expect(readManagedBudgetAmendment(db)).toBeNull();
    expect(JSON.parse(String(db.prepare("SELECT configuration FROM worker_policy").get()?.configuration)))
      .toEqual(previousPolicy);
  });
  it("rejects a later unjournalled policy change", () => {
    applyManagedBudgetAmendment(db, receipt());
    db.prepare("UPDATE worker_policy SET configuration=?").run(JSON.stringify(previousPolicy));
    expect(() => readManagedBudgetAmendment(db)).toThrow("managed_budget_amendment_policy_mismatch");
  });
});
