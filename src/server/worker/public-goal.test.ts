import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../api";
import { WorkerRepository } from "./repository";
import { DurableWorker } from "./runtime";
import { ArtifactWriter } from "../execution/artifacts";
import type { NativeCloudUsage } from "../execution/native-browser";
import type { NativeResource } from "../execution/native-resources";
import { nativeSdkMetricsSchema } from "../execution/native-sdk-protocol";
import { preparePublicProof, publicProofHash, publicProofPlanSchema, publicProofPolicySchema, readPublicProofLedger } from "../../../scripts/public-proof";
import { writePrivateJson, readPrivateJson } from "../../../scripts/advanced-proof";
import { runPublicGoal } from "../../../scripts/public-goal";

const testState = vi.hoisted(() => ({
  start: vi.fn(), retrieve: vi.fn(), extension: vi.fn(), provider: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../public-execution-readiness", () => ({ PUBLIC_EXECUTION_IMPLEMENTATION_READY: true }));
vi.mock("../deployment/build", () => ({
  releaseSourceDigest: async () => "a".repeat(64), assertReleaseBuild: async () => "b".repeat(64),
}));
vi.mock("../../../scripts/public-proof-source", () => ({ publicHarnessDigest: async () => "c".repeat(64) }));
vi.mock("../execution/composed-extension", () => ({ buildComposedExtension: async () => ({ sha256: "d".repeat(64) }) }));
vi.mock("../../../scripts/release-runtime", () => ({
  packagedPublicDeployment: () => ({ start: testState.start }),
}));
vi.mock("@browserbasehq/sdk", async (actual) => {
  const sdk = await actual<typeof import("@browserbasehq/sdk")>();
  return { ...sdk, default: class {
    static APIError = sdk.default.APIError;
    sessions = { retrieve: testState.retrieve };
    extensions = { retrieve: testState.extension };
    constructor(options: unknown) { testState.provider(options); }
  } };
});

let root: string, dataDir: string, packageDir: string;
let repository: WorkerRepository, db: DatabaseSync;
let planPath: string, approvalPath: string;
const policy = publicProofPolicySchema.parse({
  globalConcurrency: 1, ownerConcurrency: 1, sessionSeconds: 300, baselineSeconds: 1346,
  ownerBudgetSeconds: 1800, developmentBudgetSeconds: 3146, lifetimeReservationLimitSeconds: 1800,
});
beforeEach(async () => {
  vi.clearAllMocks();
  mkdirSync("data/public-goal-tests", { recursive: true, mode: 0o700 });
  root = mkdtempSync(resolve("data/public-goal-tests/run-"));
  dataDir = join(root, "ledger"); packageDir = join(root, "package");
  mkdirSync(dataDir, { mode: 0o700 }); mkdirSync(packageDir, { mode: 0o700 });
  repository = new WorkerRepository(dataDir, policy);
  db = new DatabaseSync(join(dataDir, "flash-flood.sqlite"));
  const projectId = randomUUID();
  vi.stubEnv("BROWSERBASE_API_KEY", "offline-synthetic-key");
  vi.stubEnv("BROWSERBASE_PROJECT_ID", projectId);
  vi.stubEnv("DEBUG", "false");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_outbound_forbidden"));
  const plan = publicProofPlanSchema.parse({
    version: 1, dataDir, packageDir, projectId, policy, sourceDigest: "a".repeat(64),
    packageDigest: "b".repeat(64), harnessPackageDigest: "b".repeat(64),
    harnessDigest: "c".repeat(64), archiveDigest: "d".repeat(64),
    ledgerDigest: readPublicProofLedger(db).fingerprint, reservedBefore: 0, plannedReservations: 300,
    createdAt: Date.now() - 1000,
    request: {
      authorizationAcknowledged: true, executionPolicy: "native-public-v1", assetPolicy: "public-http-readonly-v1",
      scope: { targetUrl: "https://example.com/docs", pathPrefixes: ["/docs"], allowedSubdomains: [] },
      assignments: [{ personaId: "careful-first-timer", goal: "Read the guide",
        criteria: [{ id: "guide", kind: "visible_text", text: "Guide ready", match: "exact",
          description: "Guide heading is visible", semantics: "current" }] }],
    },
  });
  planPath = join(root, "plan.json"); approvalPath = join(root, "approval.json");
  await writePrivateJson(planPath, plan);
  await writePrivateJson(approvalPath, {
    version: 1, planDigest: publicProofHash(plan), approvedAt: Date.now(), expiresAt: Date.now() + 60000,
    explicitUserApproval: true, authorizedTarget: true, authoritativeLedgerConfirmed: true,
    providerReadsUploadsAllocationsAndInference: true, privateEvidenceCapture: true,
  });
});
afterEach(() => {
  db.close(); repository.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each(["success", "cleanup-failure", "lost-submission"])("runs real API/worker/artifacts with synthetic browser/model adapters: %s", async (mode) => {
  const origin = "https://127.0.0.1:4330";
  const plan = publicProofPlanSchema.parse(await readPrivateJson(planPath, 65536));
  const writer = new ArtifactWriter({ dataDir });
  const launchPublic = vi.fn(async (options: Parameters<NonNullable<ConstructorParameters<typeof DurableWorker>[1]["launchPublic"]>>[0]) => {
    const sessionId = randomUUID(), extensionId = randomUUID();
    let resource: NativeResource = { version: 1, state: "upload_intent", archiveSha256: plan.archiveDigest, sessionAllocationAttempted: false };
    options.onResource(resource);
    resource = { ...resource, state: "uploaded", extensionId }; options.onResource(resource);
    resource = { ...resource, state: "allocated", sessionAllocationAttempted: true, sessionId }; options.onResource(resource);
    await options.onSession({ sessionId, timeoutSeconds: 300, liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${sessionId}` });
    const usage: NativeCloudUsage = { allocationAttempted: true, reservedSeconds: 300, elapsedSeconds: 1,
      gatewayDispatches: 1, modelMetrics: nativeSdkMetricsSchema.parse({
        ...Object.fromEntries(Object.keys(nativeSdkMetricsSchema.shape).map((key) => [key, 0])),
        totalPromptTokens: 10, totalCompletionTokens: 5,
      }) };
    let followed = false;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=", "base64");
    return {
      usage,
      brain: { async decide() { return { action: "click" as const, candidateId: "guide", value: null, commentary: "Follow the visible guide" }; } },
      driver: {
        async observe() {
          const screenshot = await options.artifacts.screenshot(png);
          return { id: randomUUID(), url: followed ? "https://example.com/docs/guide" : options.targetUrl,
            title: "Owned synthetic goal", text: followed ? "Guide ready" : "Read guide",
            textBlocks: [followed ? "Guide ready" : "Read guide"], checks: [], signals: [], screenshotKey: screenshot.key,
            candidates: followed ? [] : [{ id: "guide", kind: "link" as const, label: "Read guide", href: "https://example.com/docs/guide" }] };
        },
        async act() { followed = true; },
        async close() {
          resource = { ...resource, state: "delete_intent" }; options.onResource(resource);
          resource = { ...resource, state: "deleted" }; options.onResource(resource);
          usage.nativeResource = resource; usage.remoteStatus = "COMPLETED"; usage.actualBrowserSeconds = 1;
          testState.retrieve.mockResolvedValue({
            id: sessionId, projectId: plan.projectId, userMetadata: { correlationToken: options.correlationToken },
            status: "COMPLETED", startedAt: new Date(Date.now() - 2000).toISOString(), endedAt: new Date(Date.now() - 1000).toISOString(),
          });
          return { status: "closed" as const, errors: [] };
        },
      },
    };
  });
  const { default: RealSdk } = await vi.importActual<typeof import("@browserbasehq/sdk")>("@browserbasehq/sdk");
  testState.extension.mockRejectedValue(new RealSdk.NotFoundError(404, {}, "", {}));
  const worker = new DurableWorker(repository, {
    publicEnabled: true, publicImplementationReady: true, controlledEnabled: false,
    launch: async () => { throw new Error("controlled_execution_forbidden"); },
    launchPublic, artifacts: (runId, attemptId) => writer.createSinks(runId, attemptId),
    recover: async () => { throw new Error("unexpected_recovery"); },
  }, 4321);
  let cookie = "", started = false;
  let submissions = 0;
  const stopWorker = vi.fn(async () => { started = false; });
  const close = vi.fn(async () => { if (mode === "cleanup-failure") throw new Error("owned-runtime-close-failed"); });
  testState.start.mockImplementation(async (input) => {
    const api = createApi({ repository, validateScope: async (scope) => scope,
      configuration: { origin, production: true, accessCode: input.accessCode, allowPublicRuns: true, publicExecutionReady: true,
        publicSessionTimeoutSeconds: 300, allowDemoRuns: false } });
    const send = async (url: string, options: { method?: string; data?: unknown; headers?: Record<string, string> }) => {
      const response = await api(new Request(url, {
        method: options.method ?? "POST", headers: { "content-type": "application/json", cookie, ...options.headers },
        ...(options.data === undefined ? {} : { body: JSON.stringify(options.data) }),
      }));
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      if (options.method === "POST" && url.endsWith("/runs")) {
        submissions++;
        if (mode === "lost-submission" && response.ok) throw new Error("lost_submission_response");
      }
      if (started && options.method === "GET" && /\/runs\/[^/]+$/.test(url)) {
        const claim = repository.claim(worker.id, { enabled: true, implementationReady: true, controlledEnabled: false });
        if (claim) await worker.executeClaim(claim, new AbortController().signal);
      }
      return { ok: () => response.ok, json: () => response.json(), headers: () => Object.fromEntries(response.headers),
        body: async () => Buffer.from(await response.arrayBuffer()) };
    };
    const locator = { first() { return this; }, async waitFor() {},
      async evaluateAll() { return db.prepare("SELECT sequence FROM events ORDER BY sequence").all().map((row) => row.sequence); } };
    const page = { async goto() {}, async reload() {}, locator: () => locator };
    return { origin, close, async startWorker() { started = true; }, stopWorker,
      browser: { async newContext() { return { request: {
        post: send, fetch: send, get: (url: string) => send(url, { method: "GET" }),
      }, async newPage() { return page; } }; } } };
  });
  const pending = runPublicGoal(planPath, approvalPath, new AbortController().signal);
  if (mode === "success") {
    expect(await pending).toMatchObject({ accepted: true, allocatedSessions: 1, cumulativeReservedSeconds: 300, cumulativeActualBrowserSeconds: 1 });
  } else await expect(pending).rejects.toThrow(mode === "lost-submission" ? "lost_submission_response" : "public_proof_cleanup_failed");
  if (mode === "lost-submission") {
    expect(submissions).toBe(1);
    expect(stopWorker).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    expect(launchPublic).not.toHaveBeenCalled();
    expect(readPublicProofLedger(db)).toMatchObject({ reservedSeconds: 0, unfinished: 0 });
    expect(db.prepare("SELECT status FROM runs").get()?.status).toBe("cancelled");
    const directory = (await readdir(dataDir)).find((entry) => entry.startsWith("public-goal-"))!;
    expect(await readdir(join(dataDir, directory))).not.toContain("accepted.json");
    return;
  }
  expect(testState.provider).toHaveBeenCalledExactlyOnceWith({ apiKey: "offline-synthetic-key", maxRetries: 0, timeout: 10000 });
  expect(launchPublic).toHaveBeenCalledOnce();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  const directory = (await readdir(dataDir)).find((entry) => entry.startsWith("public-goal-"))!;
  if (mode === "success") {
    expect(await readPrivateJson(join(dataDir, directory, "accepted.json"), 1024 * 1024)).toMatchObject({
      publicSiteAcceptance: true, report: { status: "succeeded" },
    });
    expect((await readdir(join(dataDir, directory))).filter((file) => file.endsWith(".png")).length).toBeGreaterThan(0);
  } else {
    expect(await readdir(join(dataDir, directory))).not.toContain("accepted.json");
    expect(await readPrivateJson(join(dataDir, directory, "final-ledger.json"), 1024 * 1024))
      .toMatchObject({ accepted: false, failures: ["runtime_cleanup_unconfirmed"] });
  }
  await expect(runPublicGoal(planPath, approvalPath, new AbortController().signal)).rejects.toThrow("approved_ledger_changed");
  expect(launchPublic).toHaveBeenCalledOnce();
}, 15000);

it("rejects changed ledger before constructing Browserbase or starting a runtime", async () => {
  const owner = repository.createSession().ownerId;
  const plan = publicProofPlanSchema.parse(await readPrivateJson(planPath, 65536));
  repository.createRun(owner, randomUUID(), plan.request);
  await expect(runPublicGoal(planPath, approvalPath, new AbortController().signal)).rejects.toThrow("prior_resources_unsettled");
  expect(testState.provider).not.toHaveBeenCalled();
  expect(testState.start).not.toHaveBeenCalled();
});

it("consumes approval before provider work even when startup fails without an allocation", async () => {
  testState.start.mockRejectedValue(new Error("owned_startup_failed"));
  await expect(runPublicGoal(planPath, approvalPath, new AbortController().signal)).rejects.toThrow("owned_startup_failed");
  expect(readPublicProofLedger(db).reservedSeconds).toBe(0);
  await expect(runPublicGoal(planPath, approvalPath, new AbortController().signal)).rejects.toThrow("EEXIST");
  expect(testState.provider).toHaveBeenCalledOnce();
  expect(testState.start).toHaveBeenCalledOnce();
});

it("rejects an already-cancelled invocation without consuming approval or touching Browserbase", async () => {
  await expect(runPublicGoal(planPath, approvalPath, AbortSignal.abort())).rejects.toThrow();
  expect((await readdir(dataDir)).some((name) => name.endsWith(".used.json"))).toBe(false);
  expect(testState.provider).not.toHaveBeenCalled();
  expect(testState.start).not.toHaveBeenCalled();
});

it("prepares a bound plan from an existing ledger without any provider or DNS call", async () => {
  const plan = publicProofPlanSchema.parse(await readPrivateJson(planPath, 65536));
  const inputPath = join(root, "input.json"), outputPath = join(root, "prepared.json");
  await writePrivateJson(inputPath, { dataDir, packageDir, projectId: plan.projectId, request: plan.request });
  const before = readPublicProofLedger(db);
  expect(await preparePublicProof(inputPath, outputPath)).toMatchObject({
    phase: "public-plan", providerCalls: 0, modelCalls: 0,
    reservedBefore: 0, plannedReservations: 300, remainingAfterPlan: 1500,
  });
  expect(publicProofPlanSchema.parse(await readPrivateJson(outputPath, 65536))).toMatchObject({
    sourceDigest: plan.sourceDigest, packageDigest: plan.packageDigest, harnessPackageDigest: plan.harnessPackageDigest,
    harnessDigest: plan.harnessDigest, archiveDigest: plan.archiveDigest, ledgerDigest: before.fingerprint,
    request: plan.request,
  });
  expect(readPublicProofLedger(db).fingerprint).toBe(before.fingerprint);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(testState.provider).not.toHaveBeenCalled();
});
