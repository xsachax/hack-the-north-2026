import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import https from "node:https";
import net from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import Browserbase from "@browserbasehq/sdk";
import { MANAGED_EXECUTION_POLICY, managedResultSchema } from "../../lib/managed-contracts";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { personas } from "../../lib/personas";
import { WorkerRepository } from "../worker/repository";
import { workerPolicySchema } from "../worker/config";
import { readPrivateJson, writePrivateJson } from "../../../scripts/advanced-proof";
import { publicProofHash, publicProofRequestSchema } from "../../../scripts/public-proof";
import * as proof from "../../../scripts/managed-proof";
import * as runtime from "../../../scripts/release-runtime";
import { installManagedOfflineNetworkGuard } from "../../../scripts/managed-offline";
import {
  assertManagedBrowserEvidence, extractManagedGoalScreenshot, managedIntegration, runManagedProof, verifyManagedProofClosure,
} from "../../../scripts/managed-integration";

vi.mock("server-only", () => ({}));
const sdk = vi.hoisted(() => ({ calls: [] as unknown[][], provider: {} as Record<string, unknown> }));
vi.mock("@browserbasehq/sdk", async (original) => {
  const actual = await original<typeof import("@browserbasehq/sdk")>();
  return { ...actual, default: class {
    static APIError = actual.default.APIError;
    constructor(options: unknown) { sdk.calls.push([options]); Object.assign(this, sdk.provider); }
  } };
});

const policy = workerPolicySchema.parse({
  globalConcurrency: 1, ownerConcurrency: 1, sessionSeconds: 300,
  baselineSeconds: 3780, developmentBudgetSeconds: 5580, ownerBudgetSeconds: 1800,
  lifetimeReservationLimitSeconds: 1800, maxSteps: 6, maxModelCalls: 6,
});
const request = proof.managedProofRequestSchema.parse({
  executionPolicy: MANAGED_EXECUTION_POLICY, authorizationAcknowledged: true, managedPolicyAcknowledged: true,
  scope: { targetUrl: "https://www.iana.org/help/example-domains", allowedSubdomains: [],
    pathPrefixes: ["/help/example-domains", "/domains/reserved"] },
  assignments: [{ personaId: "careful-first-timer", goal: proof.MANAGED_PROOF_GOAL,
    criteria: [...proof.MANAGED_PROOF_CRITERIA] }],
});
let directory: string, db: DatabaseSync, repository: WorkerRepository;
beforeEach(() => {
  directory = join(process.cwd(), `.managed-proof-test-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  repository = new WorkerRepository(directory, policy);
  db = new DatabaseSync(join(directory, "flash-flood.sqlite"));
  sdk.calls = []; sdk.provider = {};
});
afterEach(() => {
  db.close(); repository.close(); rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function plan() {
  return proof.managedProofPlanSchema.parse({
    version: 1, dataDir: directory, packageDir: join(directory, "clean-package"), projectId: randomUUID(),
    request, policy, allowedOrigins: ["https://www.iana.org"],
    policyNotice: proof.MANAGED_PROOF_NOTICE, providerOperations: [...proof.MANAGED_PROOF_OPERATIONS],
    agent: { mode: "create-one-temporary", name: `flash-flood-managed-proof-${randomUUID()}`,
      systemPrompt: proof.MANAGED_PROOF_PROMPT, resultSchemaDigest: publicProofHash(z.toJSONSchema(managedResultSchema)),
      deleteAfterVerifiedClosure: true, projectTargetingAvailable: false },
    sourceDigest: "a".repeat(64), packageDigest: "b".repeat(64), harnessDigest: "c".repeat(64),
    harnessPackageDigest: "d".repeat(64), ledgerDigest: proof.readManagedProofLedger(db).fingerprint,
    invocationDigest: publicProofHash({ inventory: [], used: [] }),
    reservedBefore: 900, plannedReservations: 300, createdAt: Date.now() - 1000,
  });
}
function approval(value = plan()) {
  return { version: 1, planDigest: publicProofHash(value), approvedAt: Date.now() - 500, expiresAt: Date.now() + 60000,
    explicitUserApproval: true, managedPolicyAcknowledged: true, authoritativeLedgerConfirmed: true,
    authorizedTarget: true, providerOperations: true, privateEvidenceCapture: true };
}
function nativeReservation() {
  const owner = repository.createSession().ownerId;
  const input = publicProofRequestSchema.parse({
    authorizationAcknowledged: true, executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
    scope: request.scope, assignments: [{ personaId: personas[0].id, goal: "Offline test only",
      criteria: [{ id: "reserved", kind: "url", path: "/domains/reserved", semantics: "current", description: "Destination" }] }],
  });
  const run = repository.createRun(owner, randomUUID(), input).run;
  const jobId = String(db.prepare("SELECT id FROM jobs WHERE run_id=?").get(run.id)!.id);
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
  db.prepare("INSERT INTO launches(job_id,correlation_token,state,usage,created_at) VALUES(?,?,'settled',?,?)")
    .run(jobId, randomUUID(), JSON.stringify({ allocationAttempted: false, actualBrowserSeconds: 0 }), new Date().toISOString());
  db.prepare("UPDATE usage_reservations SET reserved_seconds=300,consumed_seconds=0,released_seconds=300 WHERE job_id=?").run(jobId);
}
function managedReservation() {
  const owner = repository.createSession().ownerId;
  const run = repository.managed.create(owner, randomUUID(), request, repository.listPersonas(owner)).run;
  const claim = repository.managed.claim("offline-proof-test", policy)!;
  expect(claim).not.toBeNull();
  repository.managed.dispatch(claim, { agentId: "offline-agent", task: `Offline fixture\n${JSON.stringify({
    correlationToken: claim.correlationToken, goal: claim.goal, criteria: claim.criteria, persona: claim.persona,
    targetUrl: claim.scope.targetUrl, declaredScope: { origin: new URL(claim.scope.targetUrl).origin,
      allowedSubdomains: claim.scope.allowedSubdomains, pathPrefixes: claim.scope.pathPrefixes },
  })}` });
  repository.managed.identity(claim, { providerRunId: `run_${randomUUID()}`, providerSessionId: randomUUID() });
  repository.managed.progress(claim, { id: "offline-tool-1", kind: "tool", text: "browser_navigate" });
  repository.managed.finish(claim, { status: "completed", providerStatus: "COMPLETED", cleanup: "closed",
    actualBrowserSeconds: 1.2, allocationAttempted: true, result: null, error: null });
  return { run, claim };
}

describe("managed proof approval (offline, no provider operations)", () => {
  it("blocks fetch, HTTP, TCP, DNS and UDP in the offline command and restores its process-local guard", () => {
    const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect;
    const guard = installManagedOfflineNetworkGuard();
    const socket = new net.Socket();
    try {
      expect(() => fetch("https://offline.invalid")).toThrow("managed_offline_network_forbidden");
      expect(() => https.request("https://offline.invalid")).toThrow("managed_offline_network_forbidden");
      expect(() => socket.connect({ host: "127.0.0.1", port: 1 })).toThrow("managed_offline_network_forbidden");
      expect(() => dns.lookup("offline.invalid", () => {})).toThrow("managed_offline_network_forbidden");
      expect(() => Reflect.apply(dgram.Socket.prototype.send, {}, [])).toThrow("managed_offline_network_forbidden");
      expect(guard.attempts).toBe(5);
    } finally { socket.destroy(); guard.close(); }
    expect(globalThis.fetch).toBe(originalFetch);
    expect(net.Socket.prototype.connect).toBe(originalConnect);
  });

  it("runs the actual maintained no-key CLI offline, with traffic blocked and no operator DATA_DIR access", async () => {
    const guard = join(directory, "offline.cjs");
    const attempted = join(directory, "network-attempted");
    const operatorDirectory = join(directory, "operator-data-must-not-be-opened");
    const previousOfflineDirectories = (await readdir(join(process.cwd(), "data")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }))
      .filter((entry) => entry.startsWith("managed-offline-")).sort();
    writeFileSync(guard, `
      const fs = require('node:fs'), path = require('node:path');
      const read = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        if (typeof file === 'string' && /^\\.env(?:\\.|$)/.test(path.basename(file))) {
          const error = new Error('offline_env_file_absent'); error.code = 'ENOENT'; throw error;
        }
        return read.call(this, file, ...args);
      };
      const deny = () => {
        fs.writeFileSync(${JSON.stringify(attempted)}, "attempt", {mode:0o600});
        throw Error('offline_network_forbidden');
      };
      globalThis.fetch = deny;
      for (const module of ['node:http','node:https']) {
        require(module).request = deny; require(module).get = deny;
      }
      const net = require('node:net'), connect = net.Socket.prototype.connect;
      net.Socket.prototype.connect = function(...args) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0];
        if (options && typeof options === 'object' && typeof options.path === 'string') return connect.apply(this,args);
        return deny();
      };
      require('node:tls').connect = deny;
      const dns = require('node:dns');
      dns.lookup=deny; dns.resolve=deny; dns.promises.lookup=deny; dns.promises.resolve=deny;
      require('node:dgram').Socket.prototype.send=deny;
      require('node:dgram').Socket.prototype.connect=deny;
    `, { mode: 0o600 });
    const result = spawnSync("npm", ["run", "managed:integration", "--", "--offline-preflight"], {
      encoding: "utf8", timeout: 30000,
      env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: "test", DATA_DIR: operatorDirectory,
        TSX_DISABLE_CACHE: "1", TMPDIR: directory, NPM_CONFIG_CACHE: join(directory, "npm-cache"),
        NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
        NODE_OPTIONS: `--require ${JSON.stringify(guard)}` },
    });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("{"));
    expect(JSON.parse(line!)).toMatchObject({
      phase: "managed-offline-preflight", accepted: false, providerCalls: 0, modelCalls: 0,
      liveLedgerOpened: false, liveLedgerChanged: false, privateOfflineDatabase: true,
      schemaValidated: true, readOnlyLedgerValidated: true, lifetimeRefundsDoNotRenewBudget: true,
      dispatchBindingNegativeValidated: true,
      configurationGatesValidated: true, requestNegativeCases: 4, approvalNegativeCases: 6,
      blockedNetworkAttempts: 0, issue8Acceptance: false,
    });
    expect(result.stderr).not.toMatch(/offline_network_forbidden|Client Component|server-only.*Error/);
    expect(existsSync(attempted)).toBe(false);
    expect(existsSync(operatorDirectory)).toBe(false);
    expect((await readdir(join(process.cwd(), "data"))).filter((entry) => entry.startsWith("managed-offline-")).sort())
      .toEqual(previousOfflineDirectories);
    expect(sdk.calls).toHaveLength(0);
  });

  it("requires exact booleans and rejects unknown approval fields", () => {
    const value = plan(), consent = approval(value);
    expect(() => proof.assertManagedProofApproval(consent, value)).not.toThrow();
    for (const key of ["explicitUserApproval", "managedPolicyAcknowledged", "authoritativeLedgerConfirmed",
      "authorizedTarget", "providerOperations", "privateEvidenceCapture"]) {
      for (const replacement of [false, "true", 1, undefined]) {
        expect(() => proof.assertManagedProofApproval({ ...consent, [key]: replacement }, value)).toThrow();
      }
    }
    expect(() => proof.assertManagedProofApproval({ ...consent, override: true }, value)).toThrow();
  });
  it("requires a fresh nonrenewable approval at most fifteen minutes long", () => {
    const value = plan(), now = Date.now(), consent = approval(value);
    for (const change of [
      { approvedAt: value.createdAt - 1 }, { approvedAt: now + 1 }, { expiresAt: now },
      { expiresAt: consent.approvedAt + 900001 }, { approvedAt: -1 }, { approvedAt: 1.5 },
    ]) expect(() => proof.assertManagedProofApproval({ ...consent, ...change }, value, now)).toThrow();
    expect(() => proof.assertManagedProofApproval({ ...consent, expiresAt: consent.approvedAt + 900000 }, value, now)).not.toThrow();
  });
  it("binds source, package, dependencies, harness, full ledger, inventory, project, and Agent prompt", () => {
    const value = plan(), consent = approval(value);
    for (const key of ["sourceDigest", "packageDigest", "harnessPackageDigest", "harnessDigest", "ledgerDigest", "invocationDigest"] as const) {
      expect(() => proof.assertManagedProofApproval(consent, { ...value, [key]: "f".repeat(64) })).toThrow();
    }
    for (const change of [
      { projectId: randomUUID() }, { allowedOrigins: ["https://example.com"] },
      { providerOperations: [] }, { agent: { ...value.agent, systemPrompt: "different" } },
      { agent: { ...value.agent, resultSchemaDigest: "f".repeat(64) } },
      { agent: { ...value.agent, projectTargetingAvailable: true } },
      { policy: { ...value.policy, globalConcurrency: 2 } },
      { policy: { ...value.policy, baselineSeconds: 0 } },
    ]) expect(() => proof.assertManagedProofApproval(consent, { ...value, ...change } as typeof value)).toThrow();
  });
  it("restricts one unchanged persona, IANA scope and read-only goal", () => {
    for (const change of [
      { assignments: [...request.assignments, { ...request.assignments[0], personaId: "other" }] },
      { assignments: [{ ...request.assignments[0], goal: "Buy something" }] },
      { scope: { ...request.scope, pathPrefixes: ["/"] } },
      { scope: { ...request.scope, allowedSubdomains: ["evil"] } },
      { assignments: [{ ...request.assignments[0], criteria: ["Trust the model"] }] },
    ]) expect(proof.managedProofRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });
  it("consumes once before any provider read and never rewrites the used claim", async () => {
    const value = plan(), consent = approval(value), invocationId = randomUUID();
    await proof.consumeManagedProofApproval(directory, value, consent, invocationId);
    const used = join(directory, `managed-proof-${publicProofHash(value)}.used.json`);
    expect(await readPrivateJson(used)).toMatchObject({ planDigest: publicProofHash(value), invocationId });
    await expect(proof.consumeManagedProofApproval(directory, value, consent, randomUUID())).rejects.toThrow();
    await expect(proof.consumeManagedProofApproval(directory, value, { ...consent, planDigest: "f".repeat(64) }, randomUUID())).rejects.toThrow();
    expect(await readPrivateJson(used)).toMatchObject({ invocationId });
    expect(sdk.calls).toHaveLength(0);
  });
  it("has no default paid mode or auto-generated approval", async () => {
    for (const args of [[], ["--confirm-paid"], ["--prepare-plan"], ["--resume", "anything"]]) {
      await expect(managedIntegration(args, new AbortController().signal)).rejects.toThrow("managed_explicit_mode_required");
    }
    expect(sdk.calls).toHaveLength(0);
  });
});

describe("combined authoritative ledger (offline SQLite)", () => {
  it("independently rejects mismatched reservation, policy, native-history and full-ledger claims", () => {
    expect(() => proof.assertManagedProofLedgerBinding(plan(), proof.readManagedProofLedger(db))).toThrow();
    for (let i = 0; i < 3; i++) nativeReservation();
    const value = plan(), ledger = proof.readManagedProofLedger(db);
    expect(() => proof.assertManagedProofLedgerBinding(value, ledger)).not.toThrow();
    for (const change of [
      { reservedBefore: 1200 }, { ledgerDigest: "f".repeat(64) },
      { policy: { ...policy, maxSteps: policy.maxSteps + 1 } },
    ]) expect(() => proof.assertManagedProofLedgerBinding({ ...value, ...change }, ledger)).toThrow("managed_approved_ledger_changed");
  });

  it("counts all native and managed lifetime reservations, including refunds", () => {
    for (let i = 0; i < 3; i++) nativeReservation();
    for (let i = 0; i < 3; i++) managedReservation();
    const ledger = proof.readManagedProofLedger(db);
    expect(ledger).toMatchObject({ reservedSeconds: 1800, consumedSeconds: 6, committedSeconds: 6, unknownActualAttempts: 0 });
    expect(ledger.actualBrowserSeconds).toBeCloseTo(3.6);
    expect(() => proof.assertManagedProofSettled(ledger)).not.toThrow();
    expect(() => proof.managedProofPlanSchema.parse({ ...plan(), reservedBefore: 1800 })).toThrow();
    db.prepare("UPDATE managed_attempts SET reserved_seconds=301 WHERE id=(SELECT id FROM managed_attempts LIMIT 1)").run();
    expect(() => proof.readManagedProofLedger(db)).toThrow();
  });
  it("fingerprints every private managed run, attempt and progress field plus native reservations", () => {
    nativeReservation();
    const { claim } = managedReservation();
    let previous = proof.readManagedProofLedger(db).fingerprint;
    for (const sql of [
      "UPDATE managed_runs SET updated_at='changed'",
      "UPDATE managed_attempts SET recovery_count=1",
      "UPDATE managed_attempts SET live_view_url='private-view'",
      "UPDATE managed_progress SET text='browser_click'",
      "UPDATE launches SET usage='{\"allocationAttempted\":false,\"actualBrowserSeconds\":0,\"extra\":true}'",
    ]) {
      db.exec(sql);
      const next = proof.readManagedProofLedger(db).fingerprint;
      expect(next).not.toBe(previous); previous = next;
    }
    expect(proof.readManagedProofLedger(db).attempts[0].id).toBe(claim.id);
  });
  it("rejects queued, reserved, dispatched and quarantined attempts", () => {
    managedReservation();
    for (const state of ["queued", "reserved", "dispatched", "quarantined"]) {
      db.prepare("UPDATE managed_attempts SET state=?").run(state);
      expect(() => proof.assertManagedProofSettled(proof.readManagedProofLedger(db))).toThrow("managed_prior_allocations_unsettled");
    }
  });
  it("rejects undercharged sessions, mismatched release claims and unknown allocated identities", () => {
    managedReservation();
    db.exec("UPDATE managed_attempts SET consumed_seconds=0");
    expect(() => proof.readManagedProofLedger(db)).toThrow("managed_lifetime_accounting_mismatch");
    db.exec("UPDATE managed_attempts SET consumed_seconds=2,released_seconds=300");
    expect(() => proof.readManagedProofLedger(db)).toThrow("managed_lifetime_accounting_mismatch");
    db.exec("UPDATE managed_attempts SET released_seconds=298,provider_run_id=NULL,provider_session_id=NULL");
    expect(() => proof.assertManagedProofSettled(proof.readManagedProofLedger(db))).toThrow("managed_prior_allocations_unsettled");
  });
  it("rejects duplicate native/managed session identities rather than double-counting them", () => {
    nativeReservation();
    managedReservation();
    const sessionId = String(db.prepare("SELECT provider_session_id FROM managed_attempts").get()!.provider_session_id);
    db.prepare("UPDATE launches SET session_reference=?").run(JSON.stringify({ sessionId }));
    expect(() => proof.readManagedProofLedger(db)).toThrow("managed_duplicate_allocation_identity");
  });
  it("retains uncertain agent creation intent and blocks a new plan without erasing it", async () => {
    const invocation = join(directory, `managed-proof-${randomUUID()}`);
    mkdirSync(invocation, { mode: 0o700 });
    await writePrivateJson(join(invocation, "agent-intent.json"), { accountingIntentSeconds: 300 });
    await writePrivateJson(join(invocation, "final.json"), {
      accepted: false, agentCreation: "unknown", agentDeleted: false, cleanupUncertain: false, identityUncertain: true,
    });
    await expect(proof.readManagedInvocationInventory(directory)).rejects.toThrow("manual_reconciliation");
    expect(await readPrivateJson(join(invocation, "agent-intent.json"))).toEqual({ accountingIntentSeconds: 300 });
  });
  it("rejects orphaned or mismatched approval-consumption journals", async () => {
    await writePrivateJson(join(directory, `managed-proof-${"a".repeat(64)}.used.json`), {
      version: 1, planDigest: "b".repeat(64), invocationId: randomUUID(), startedAt: Date.now(),
    });
    await expect(proof.readManagedInvocationInventory(directory)).rejects.toThrow("managed_consumption_journal_mismatch");
  });
});

describe("independent evidence versus model-authored goal reports", () => {
  it("does not classify Search/Fetch claims as browser progress", () => {
    for (const name of ["Search", "Fetch", "browser_search", "fetch_page", "thinking"]) expect(proof.isBrowserToolProgress(name)).toBe(false);
    for (const name of ["browser_navigate", "computer", "Click", "browser_screenshot"]) expect(proof.isBrowserToolProgress(name)).toBe(true);
  });
  it("requires exact-session protocol events and real recording metadata, without fetching any media URL", () => {
    const input = { sessionId: "offline-session", logs: [{ sessionId: "offline-session", pageId: 1, method: "Page.navigate" }],
      replay: { pageCount: 1, pages: [{ pageId: "1", startTimeMs: 1, endTimeMs: 2, url: "https://unfetched.invalid/private-media" }] } };
    expect(assertManagedBrowserEvidence(input)).toEqual({ browserProtocolEvents: 1, recordingPages: 1 });
    expect(() => assertManagedBrowserEvidence({ ...input, logs: [{ ...input.logs[0], sessionId: "other" }] })).toThrow();
    expect(() => assertManagedBrowserEvidence({ ...input, logs: [{ ...input.logs[0], method: "Search" }] })).toThrow();
    expect(() => assertManagedBrowserEvidence({ ...input, replay: { pageCount: 0, pages: [] } })).toThrow();
    expect(sdk.calls).toHaveLength(0);
  });
  it("requires goal-specific browser URL evidence followed by actual screenshot bytes", () => {
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=";
    const navigation = {
      sessionId: "offline-session", pageId: 1, method: "Page.navigate",
      request: { params: { url: "https://www.iana.org/domains/reserved" } }, response: { result: { frameId: "frame" } },
    };
    const capture = { sessionId: "offline-session", pageId: 1, method: "Page.captureScreenshot",
      response: { result: { data: pixel } } };
    const result = extractManagedGoalScreenshot("offline-session", [navigation, capture]);
    expect(result).toMatchObject({ format: "png", pageId: 1, logIndex: 1, finalUrl: "https://www.iana.org/domains/reserved" });
    expect(result.bytes.toString("base64")).toBe(pixel);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => extractManagedGoalScreenshot("offline-session", [capture, navigation])).toThrow("managed_goal_browser_pixels_missing");
    expect(() => extractManagedGoalScreenshot("offline-session", [navigation, { ...capture, pageId: 2 }])).toThrow();
    expect(() => extractManagedGoalScreenshot("other-session", [navigation, capture])).toThrow();
    expect(() => extractManagedGoalScreenshot("offline-session", [navigation, capture, {
      ...navigation, request: { params: { url: "https://example.com/" } },
    }])).toThrow("managed_goal_browser_pixels_missing");
    const location = { sessionId: "offline-session", pageId: 1, method: "Runtime.evaluate",
      request: { params: { expression: "window.location.href" } },
      response: { result: { result: { value: "https://www.iana.org/domains/reserved" } } } };
    expect(extractManagedGoalScreenshot("offline-session", [location, capture]).format).toBe("png");
    expect(() => extractManagedGoalScreenshot("offline-session", [{
      ...location, request: { params: { expression: '"https://www.iana.org/domains/reserved"' } },
    }, capture])).toThrow("managed_goal_browser_pixels_missing");
    expect(() => extractManagedGoalScreenshot("offline-session", [navigation, {
      ...capture, response: { result: { data: "a".repeat(100) } },
    }])).toThrow("managed_goal_browser_pixels_missing");
  });
  it("requires independently completed sessions in the approved project, with exact timestamps and charge", async () => {
    managedReservation();
    const ledger = proof.readManagedProofLedger(db), attempt = ledger.attempts[0], projectId = randomUUID();
    const run = { runId: attempt.provider_run_id, agentId: attempt.provider_agent_id,
      sessionId: attempt.provider_session_id, status: "COMPLETED", task: attempt.provider_task };
    const endedAt = Date.now() - 10000;
    const session = { id: attempt.provider_session_id, projectId, status: "COMPLETED",
      startedAt: new Date(endedAt - 1200).toISOString(), endedAt: new Date(endedAt).toISOString() };
    const retrieve = vi.fn().mockResolvedValue(session);
    const retrieveRun = vi.fn().mockResolvedValue(run);
    const provider = { agents: { runs: { retrieve: retrieveRun } },
      sessions: { retrieve }, extensions: { retrieve: vi.fn() } } as unknown as Parameters<typeof verifyManagedProofClosure>[0];
    expect((await verifyManagedProofClosure(provider, projectId, ledger)).managed[0].actualBrowserSeconds).toBe(1.2);
    for (const change of [{ agentId: "another-agent" }, { task: `${run.task}\nextra` }]) {
      retrieveRun.mockResolvedValue({ ...run, ...change });
      await expect(verifyManagedProofClosure(provider, projectId, ledger)).rejects.toThrow("managed_pinned_dispatch_identity_mismatch");
    }
    retrieveRun.mockResolvedValue(run);
    for (const change of [{ projectId: randomUUID() }, { status: "RUNNING" }, { endedAt: null }, { startedAt: "invalid" },
      { endedAt: new Date(endedAt + 300000).toISOString() }]) {
      retrieve.mockResolvedValue({ ...session, ...change });
      await expect(verifyManagedProofClosure(provider, projectId, ledger)).rejects.toThrow();
    }
  });
  it("never accepts model criteria alone as managed evidence", () => {
    const value = plan(), persona = personas.find((row) => row.id === request.assignments[0].personaId)!;
    const attempt = {
      id: randomUUID(), persona, goal: proof.MANAGED_PROOF_GOAL, criteria: [...proof.MANAGED_PROOF_CRITERIA],
      status: "completed", providerStatus: "COMPLETED", cleanup: "closed", cancelRequested: false,
      progress: [{ sequence: 1, timestamp: new Date().toISOString(), kind: "tool", text: "browser_navigate" }],
      result: { summary: "Offline schema fixture", finalUrl: "https://www.iana.org/domains/reserved",
        criteria: proof.MANAGED_PROOF_CRITERIA.map((criterion) => ({ criterion, status: "met", observation: "IANA-managed Reserved Domains" })),
        limitations: ["Offline unit-test fixture, not live acceptance"] },
      error: null, reservedSeconds: 300, actualBrowserSeconds: 1.2, modelCalls: null,
    };
    const report = { id: randomUUID(), executionPolicy: MANAGED_EXECUTION_POLICY, scope: request.scope,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "completed", attempts: [attempt] };
    expect(proof.assertManagedGoalEvidence(report, value)).toEqual(report);
    for (const change of [
      { progress: [] }, { providerStatus: "RUNNING" }, { cleanup: "unconfirmed" },
      { progress: [{ ...attempt.progress[0], text: "Search" }] },
      { result: { ...attempt.result, finalUrl: "https://other.invalid/domains/reserved" } },
      { result: { ...attempt.result, criteria: attempt.result.criteria.map((row) => ({ ...row, observation: "unseen" })) } },
    ]) expect(() => proof.assertManagedGoalEvidence({ ...report, attempts: [{ ...attempt, ...change }] }, value)).toThrow();
  });
});

describe("failed invocation persistence (mock provider only)", () => {
  function reorderObjectKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reorderObjectKeys);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorderObjectKeys(item)]));
    }
    return value;
  }

  it.each([
    "original", "reordered", "changed-prompt", "changed-name", "changed-id", "changed-schema",
    "missing-schema", "added-schema-key", "changed-array-order",
  ])("checks %s Agent readback before runtime startup and independently deletes the temporary Agent", async (variant) => {
    for (let i = 0; i < 3; i++) nativeReservation();
    const value = plan();
    const input = join(directory, "plan.json"), approved = join(directory, "approval.json");
    await writePrivateJson(input, value); await writePrivateJson(approved, approval(value));
    vi.spyOn(proof, "verifyManagedProofInputs").mockResolvedValue();
    const start = vi.fn().mockRejectedValue(new Error("Offline simulated runtime startup failure"));
    vi.spyOn(runtime, "packagedManagedDeployment").mockReturnValue({ verifyPackage: vi.fn(), start });
    vi.stubEnv("BROWSERBASE_API_KEY", "offline-test-placeholder");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", value.projectId);
    const agent = { agentId: "offline-agent", name: value.agent.name, systemPrompt: value.agent.systemPrompt,
      resultSchema: z.toJSONSchema(managedResultSchema) };
    const reviewed: { agentId: string; name: string; systemPrompt?: string; resultSchema?: unknown } = { ...agent };
    switch (variant) {
      case "reordered": reviewed.resultSchema = reorderObjectKeys(agent.resultSchema); break;
      case "changed-prompt": reviewed.systemPrompt = `${agent.systemPrompt}\nDifferent instructions`; break;
      case "changed-name": reviewed.name = "different-agent"; break;
      case "changed-id": reviewed.agentId = "different-agent"; break;
      case "changed-schema":
        reviewed.resultSchema = { ...agent.resultSchema, properties: { ...agent.resultSchema.properties,
          summary: { type: "string", minLength: 1, maxLength: 3999 } } };
        break;
      case "missing-schema": delete reviewed.resultSchema; break;
      case "added-schema-key": reviewed.resultSchema = { ...agent.resultSchema, title: "Unapproved schema" }; break;
      case "changed-array-order":
        reviewed.resultSchema = { ...agent.resultSchema, required: [...(agent.resultSchema.required ?? [])].reverse() };
        break;
    }
    const valid = variant === "original" || variant === "reordered";
    if (variant === "reordered") expect(publicProofHash(reviewed.resultSchema)).not.toBe(value.agent.resultSchemaDigest);
    const order: string[] = [];
    const retrieve = vi.fn().mockResolvedValueOnce(reviewed).mockImplementationOnce(async () => {
      order.push("absent");
      throw new Browserbase.APIError(404, {}, "Offline exact-ID absence", {});
    });
    const remove = vi.fn(async () => { order.push("delete"); });
    sdk.provider = {
      agents: { create: vi.fn().mockResolvedValue(agent), retrieve, delete: remove,
        runs: { list: vi.fn(async () => { order.push("related"); return { data: [], nextCursor: null }; }) } },
      sessions: { retrieve: vi.fn() }, extensions: { retrieve: vi.fn() },
    };
    const result = await runManagedProof(input, approved, new AbortController().signal);
    expect(result).toMatchObject({ accepted: false, identityUncertain: false, cleanupUncertain: false,
      errorCode: valid ? "managed_proof_failed" : "managed_agent_review_mismatch" });
    expect(start).toHaveBeenCalledTimes(valid ? 1 : 0);
    expect(order).toEqual(["related", "delete", "absent"]);
    expect(remove).toHaveBeenCalledExactlyOnceWith("offline-agent");
    const inventory = await proof.readManagedInvocationInventory(directory);
    expect(inventory.inventory).toHaveLength(1);
    expect(inventory.used).toHaveLength(1);
    expect(await readPrivateJson(join(directory, inventory.inventory[0].directory, "agent-reviewed.json"))).toEqual(reviewed);
  });

  it("journals intent before the sole create, consumes approval before reads, and retains unknown outcomes", async () => {
    for (let i = 0; i < 3; i++) nativeReservation();
    const value = plan(), consent = approval(value);
    const input = join(directory, "plan.json"), approved = join(directory, "approval.json");
    await writePrivateJson(input, value); await writePrivateJson(approved, consent);
    vi.spyOn(proof, "verifyManagedProofInputs").mockResolvedValue();
    vi.stubEnv("BROWSERBASE_API_KEY", "offline-test-placeholder");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", value.projectId);
    const create = vi.fn(async () => {
      const invocation = (await readdir(directory)).find((name) => /^managed-proof-[a-f0-9-]{36}$/.test(name))!;
      expect(await readPrivateJson(join(directory, `managed-proof-${publicProofHash(value)}.used.json`))).toBeTruthy();
      expect(await readPrivateJson(join(directory, invocation, "agent-intent.json"))).toMatchObject({ accountingIntentSeconds: 300 });
      throw new Error("Simulated unknown provider response; offline only");
    });
    sdk.provider = { agents: { create }, sessions: { retrieve: vi.fn() }, extensions: { retrieve: vi.fn() } };
    const result = await runManagedProof(input, approved, new AbortController().signal);
    expect(result).toMatchObject({ accepted: false, issue8Acceptance: false, identityUncertain: true, cumulativeReservedSeconds: 900 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sdk.calls).toEqual([[{ apiKey: "offline-test-placeholder", maxRetries: 0, timeout: 10000 }]]);
    const invocation = (await readdir(directory)).find((name) => /^managed-proof-[a-f0-9-]{36}$/.test(name))!;
    expect(await readPrivateJson(join(directory, invocation, "final.json"), 65536))
      .toMatchObject({ accepted: false, agentCreation: "unknown", agentDeleted: false, identityUncertain: true });
    await expect(proof.readManagedInvocationInventory(directory)).rejects.toThrow("manual_reconciliation");
    await expect(runManagedProof(input, approved, new AbortController().signal)).resolves.toMatchObject({
      accepted: false, errorCode: "managed_prior_invocation_requires_manual_reconciliation",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(value.projectId);
    expect(JSON.stringify(result)).not.toContain("https://");
  });
});
