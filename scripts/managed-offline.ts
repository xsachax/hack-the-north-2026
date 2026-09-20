import { randomUUID } from "node:crypto";
import dns from "node:dns";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { mkdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { z } from "zod";
import { MANAGED_EXECUTION_POLICY, managedResultSchema } from "../src/lib/managed-contracts";
import { managedCapabilities, requireManagedWorker } from "../src/server/managed/config";
import { WorkerRepository } from "../src/server/worker/repository";
import { workerPolicySchema } from "../src/server/worker/config";
import { assertPrivateDirectory } from "./advanced-proof";
import { openPublicProofLedger, publicProofHash } from "./public-proof";
import {
  assertManagedProofApproval, assertManagedProofLedgerBinding, assertManagedProofSettled,
  managedProofPlanSchema, managedProofRequestSchema, readManagedProofLedger,
  MANAGED_PROOF_CRITERIA, MANAGED_PROOF_GOAL, MANAGED_PROOF_NOTICE, MANAGED_PROOF_OPERATIONS, MANAGED_PROOF_PROMPT,
} from "./managed-proof";

/** Process-local denial after the maintained tsx loader has started; no ports are allowed. */
export function installManagedOfflineNetworkGuard() {
  let attempts = 0, closed = false;
  const originals: { object: object; key: string; value: unknown }[] = [];
  const deny = (): never => { attempts++; throw new Error("managed_offline_network_forbidden"); };
  const replace = (object: object, key: string) => {
    originals.push({ object, key, value: Reflect.get(object, key) });
    Reflect.set(object, key, deny);
  };
  replace(globalThis, "fetch");
  for (const api of [http, https]) for (const name of ["request", "get"]) replace(api, name);
  replace(net.Socket.prototype, "connect");
  replace(tls, "connect");
  for (const name of ["send", "connect"]) replace(dgram.Socket.prototype, name);
  const names = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
    "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];
  for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of names) if (typeof Reflect.get(api, name) === "function") replace(api, name);
  }
  syncBuiltinESMExports();
  return {
    get attempts() { return attempts; },
    close() {
      if (closed) return;
      closed = true;
      for (const original of originals.reverse()) Reflect.set(original.object, original.key, original.value);
      syncBuiltinESMExports();
    },
  };
}

function rejects(work: () => unknown) {
  let rejected = false;
  try { work(); } catch { rejected = true; }
  if (!rejected) throw new Error("managed_offline_negative_case_failed");
}

/** Synthetic local schema exercises only: never calls the paid confirmation path or writes an approval. */
export async function managedOfflinePreflight() {
  const network = installManagedOfflineNetworkGuard();
  const directory = resolve("data", `managed-offline-${randomUUID()}`);
  let repository: WorkerRepository | undefined;
  let db: Awaited<ReturnType<typeof openPublicProofLedger>> | undefined;
  const oldUmask = process.umask(0o077);
  try {
    await mkdir("data", { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    await assertPrivateDirectory(directory);
    const policy = workerPolicySchema.parse({
      globalConcurrency: 1, ownerConcurrency: 1, sessionSeconds: 300, baselineSeconds: 3780,
      developmentBudgetSeconds: 5580, ownerBudgetSeconds: 1800, lifetimeReservationLimitSeconds: 1800,
      maxSteps: 6, maxModelCalls: 6,
    });
    repository = new WorkerRepository(directory, policy);
    db = await openPublicProofLedger(directory);
    rejects(() => db!.exec("DELETE FROM worker_policy"));
    const request = managedProofRequestSchema.parse({
      executionPolicy: MANAGED_EXECUTION_POLICY, authorizationAcknowledged: true, managedPolicyAcknowledged: true,
      scope: { targetUrl: "https://www.iana.org/help/example-domains", allowedSubdomains: [],
        pathPrefixes: ["/help/example-domains", "/domains/reserved"] },
      assignments: [{ personaId: "careful-first-timer", goal: MANAGED_PROOF_GOAL, criteria: [...MANAGED_PROOF_CRITERIA] }],
    });
    const malformedRequests = [
      { ...request, managedPolicyAcknowledged: false },
      { ...request, scope: { ...request.scope, pathPrefixes: ["/"] } },
      { ...request, assignments: [...request.assignments, { ...request.assignments[0], personaId: "other" }] },
      { ...request, assignments: [{ ...request.assignments[0], goal: "Changed goal" }] },
    ];
    for (const malformed of malformedRequests) rejects(() => managedProofRequestSchema.parse(malformed));
    const owner = repository.createSession().ownerId;
    const profiles = repository.listPersonas(owner);
    const initial = readManagedProofLedger(db);
    assertManagedProofSettled(initial);
    if (initial.reservedSeconds !== 0) throw new Error("managed_offline_database_not_fresh");
    const queued = repository.managed.create(owner, randomUUID(), request, profiles).run;
    rejects(() => assertManagedProofSettled(readManagedProofLedger(db!)));
    repository.managed.cancel(owner, queued.id);
    assertManagedProofSettled(readManagedProofLedger(db));

    let fingerprintsChanged = true;
    for (let index = 0; index < 6; index++) {
      const before = readManagedProofLedger(db).fingerprint;
      repository.managed.create(owner, randomUUID(), request, profiles);
      const claim = repository.managed.claim("offline-schema-only", policy);
      if (!claim) throw new Error("managed_offline_reservation_failed");
      rejects(() => repository!.managed.dispatch(claim, { agentId: "", task: "" }));
      repository.managed.progress(claim, { id: `offline-${index}`, kind: "status",
        text: "Offline schema exercise; no provider dispatch or browser evidence." });
      repository.managed.finish(claim, {
        status: "cancelled", providerStatus: null, cleanup: "closed", result: null, error: null,
        actualBrowserSeconds: 0, allocationAttempted: false,
      });
      fingerprintsChanged &&= readManagedProofLedger(db).fingerprint !== before;
    }
    const overBudget = repository.managed.create(owner, randomUUID(), request, profiles).run;
    if (repository.managed.claim("offline-over-budget", policy) !== null ||
      repository.managed.get(owner, overBudget.id).status !== "failed") throw new Error("managed_offline_lifetime_cap_failed");
    const ledger = readManagedProofLedger(db);
    assertManagedProofSettled(ledger);
    if (!fingerprintsChanged || ledger.reservedSeconds !== 1800 || ledger.committedSeconds !== 0 ||
      ledger.consumedSeconds !== 0 || ledger.actualBrowserSeconds !== 0 || ledger.native.launches.length ||
      ledger.attempts.some((attempt) => attempt.dispatch_started || attempt.provider_run_id || attempt.provider_session_id)) {
      throw new Error("managed_offline_ledger_assertion_failed");
    }
    const now = Date.now();
    // These sentinel digests cannot authorize the source/package, and the isolated path cannot be used for paid proof.
    const plan = managedProofPlanSchema.parse({
      version: 1, dataDir: directory, packageDir: join(directory, "not-a-release"), projectId: randomUUID(),
      request, policy, allowedOrigins: ["https://www.iana.org"], policyNotice: MANAGED_PROOF_NOTICE,
      providerOperations: [...MANAGED_PROOF_OPERATIONS],
      agent: { mode: "create-one-temporary", name: `flash-flood-managed-proof-${randomUUID()}`,
        systemPrompt: MANAGED_PROOF_PROMPT, resultSchemaDigest: publicProofHash(z.toJSONSchema(managedResultSchema)),
        deleteAfterVerifiedClosure: true, projectTargetingAvailable: false },
      sourceDigest: "0".repeat(64), packageDigest: "0".repeat(64), harnessDigest: "0".repeat(64),
      harnessPackageDigest: "0".repeat(64), ledgerDigest: ledger.fingerprint, invocationDigest: "0".repeat(64),
      reservedBefore: 900, plannedReservations: 300, createdAt: now - 2000,
    });
    rejects(() => managedProofPlanSchema.parse({ ...plan, reservedBefore: 1800 }));
    rejects(() => assertManagedProofLedgerBinding(plan, ledger));
    const expiredFixture = {
      version: 1, planDigest: publicProofHash(plan), approvedAt: now - 1500, expiresAt: now - 1,
      explicitUserApproval: true, managedPolicyAcknowledged: true, authoritativeLedgerConfirmed: true,
      authorizedTarget: true, providerOperations: true, privateEvidenceCapture: true,
    };
    const malformedApprovals = [
      {}, expiredFixture, { ...expiredFixture, explicitUserApproval: false },
      { ...expiredFixture, expiresAt: now + 1000, planDigest: "f".repeat(64) },
      { ...expiredFixture, expiresAt: now + 900001 },
      { ...expiredFixture, expiresAt: now + 1000, providerOperations: "true" },
    ];
    for (const malformed of malformedApprovals) rejects(() => assertManagedProofApproval(malformed, plan, now));
    rejects(() => requireManagedWorker({ NODE_ENV: "test", ENABLE_MANAGED_AGENTS: "true" }));
    if (managedCapabilities({ enabled: true, agentConfigured: true, keyConfigured: true,
      accessCode: "x".repeat(32), allowedOrigins: ["https://www.iana.org"] }).enabled ||
      managedCapabilities({ enabled: true, projectConfigured: true, agentConfigured: true,
        accessCode: "x".repeat(32), allowedOrigins: ["https://www.iana.org"] }).enabled) {
      throw new Error("managed_offline_configuration_gate_failed");
    }
    if (network.attempts) throw new Error("managed_offline_network_attempted");
    return {
      phase: "managed-offline-preflight", accepted: false, providerCalls: 0, modelCalls: 0,
      liveLedgerOpened: false, liveLedgerChanged: false, privateOfflineDatabase: true,
      schemaValidated: true, readOnlyLedgerValidated: true, lifetimeRefundsDoNotRenewBudget: true,
      dispatchBindingNegativeValidated: true,
      requestNegativeCases: malformedRequests.length, approvalNegativeCases: malformedApprovals.length,
      configurationGatesValidated: true, blockedNetworkAttempts: network.attempts, issue8Acceptance: false,
    };
  } finally {
    try { db?.close(); repository?.close(); }
    finally {
      try { await rm(directory, { recursive: true, force: true }); }
      finally { process.umask(oldUmask); network.close(); }
    }
  }
}
