import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fixedFixtures } from "../../lib/demo";
import type { AppConfig } from "../../lib/config";
import { ArtifactWriter, sanitizeEvidence, type ArtifactReference, type ArtifactSinks } from "../execution/artifacts";
import { CloudStartupError, createFixtureExecution, type CloudUsage, type FixtureExecutionOptions } from "../execution/cloud";
import { executePersona } from "../execution/loop";
import type { Brain, BrowserDriver, ExecutionEvent, ExecutionResult } from "../execution/types";
import { LeaseLostError, WorkerRepository, type Claim } from "./repository";
import { createCloudRecovery } from "./cloud-recovery";
import { workerExecutionLimits } from "./config";
import { publicPageUrl } from "../public-page-url";
import { createContextProvider, type ContextProvider } from "../workflows/context-provider";
import { runCouponWithWorkerDriver } from "../workflows/reproduction-runner";
import { fixtureNavigationMarker } from "../workflows/reproduction-grounding";
import type { PublicExecutionOptions } from "../execution/public-cloud";
import type { NativeCloudUsage } from "../execution/native-browser";
import type { NativeResource } from "../execution/native-resources";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../public-execution-readiness";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";

export type WorkerDependencies = {
  launch: (options: FixtureExecutionOptions) => Promise<{ driver: BrowserDriver; brain: Brain; usage: CloudUsage }>;
  launchPublic?: (options: PublicExecutionOptions) => Promise<{
    driver: BrowserDriver; brain: Brain; usage: NativeCloudUsage;
    signal?: AbortSignal; executionDeadlineMs?: number;
  }>;
  publicEnabled?: boolean;
  controlledEnabled?: boolean;
  publicImplementationReady?: boolean;
  recover: ReturnType<typeof createCloudRecovery>["recover"];
  artifacts: (runId: string, attemptId: string) => ArtifactSinks;
  execute?: typeof executePersona;
  diagnostic?: (code: "worker_attempt_failed" | "worker_lease_lost" | "worker_recovery_failed" |
    "worker_public_recovery_checkpoint_disabled") => void;
  knownSecrets?: readonly string[];
  contextProvider?: ContextProvider;
};
function failedResult(cancelled: boolean, cleanup: ExecutionResult["cleanup"]): ExecutionResult {
  const status = cancelled && cleanup.status === "closed" ? "cancelled" : "infrastructure_failed";
  const reason = status === "cancelled" ? "Execution cancelled during startup" : "Worker execution failed";
  return {
    status, reason, originalTerminal: { status, reason }, cleanup,
    checks: [], steps: 0, modelCalls: 0,
    modelOperations: { decision: 0, evaluation: 0, retry: 0, total: 0 },
    durationMs: 0, errors: [reason],
  };
}

export class DurableWorker {
  readonly id = randomUUID();
  private readonly active = new Set<Promise<void>>();
  constructor(
    readonly repository: WorkerRepository,
    private readonly dependencies: WorkerDependencies,
    private readonly fixturePort: number,
  ) {}

  private publicAdmission() {
    return {
      enabled: this.dependencies.publicEnabled === true,
      controlledEnabled: this.dependencies.controlledEnabled !== false,
      implementationReady: PUBLIC_EXECUTION_IMPLEMENTATION_READY &&
        this.dependencies.publicImplementationReady === true && !!this.dependencies.launchPublic,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    const stop = new AbortController();
    const combined = AbortSignal.any([signal, stop.signal]);
    try {
      while (!combined.aborted) {
        await this.repository.retireContext(this.dependencies.contextProvider);
        if (this.dependencies.controlledEnabled !== false) this.repository.pumpReproductions();
        let claim: Claim | null;
        while (!combined.aborted && this.active.size < this.repository.policy.globalConcurrency &&
          (claim = this.repository.claim(this.id, this.publicAdmission()))) {
          const task = this.executeClaim(claim, combined);
          this.active.add(task);
          void task.then(() => this.active.delete(task), () => {
            this.dependencies.diagnostic?.("worker_attempt_failed");
            stop.abort();
            this.active.delete(task);
          });
        }
        await delay(250, undefined, { signal: combined }).catch((error: unknown) => {
          if (!(error instanceof Error && error.name === "AbortError")) throw error;
        });
      }
    } finally {
      stop.abort();
      await Promise.allSettled(this.active);
    }
  }

  async executeClaim(claim: Claim, shutdown: AbortSignal): Promise<void> {
    if (claim.recovery && !PUBLIC_EXECUTION_IMPLEMENTATION_READY &&
      (claim.executionMode !== "controlled-fixture" || this.repository.hasPublicRecoveryState(claim.jobId))) {
      (this.dependencies.diagnostic ?? console.error)("worker_public_recovery_checkpoint_disabled");
      return;
    }
    const controller = new AbortController();
    let activeSignal = controller.signal;
    let nativeInterrupted = false;
    let nativeCleanupStarted = false;
    let removeNativeAbortListener: (() => void) | undefined;
    let nativeDeadlineExpired = false;
    let nativeDeadlineMs: number | undefined;
    let leaseLost = false;
    const diagnostic = this.dependencies.diagnostic ?? ((code) => console.error(code));
    const abort = () => controller.abort();
    shutdown.addEventListener("abort", abort, { once: true });
    if (shutdown.aborted) abort();
    const assertLease = (allowCancelled = false) => {
      try { this.repository.assertLease(claim, allowCancelled); }
      catch (error) {
        if (error instanceof LeaseLostError) leaseLost = true;
        if (!allowCancelled) controller.abort();
        throw error;
      }
    };
    const recordNative = (resource: Readonly<NativeResource>): undefined => {
      try { return this.repository.nativeResource(claim, resource); }
      catch (error) {
        if (error instanceof LeaseLostError) {
          leaseLost = true;
          controller.abort();
        }
        throw error;
      }
    };
    const control = claim.reproductionCandidateId || claim.executionMode !== "controlled-fixture"
      ? undefined : this.repository.takeoverControl(claim, assertLease);
    const assertActive = () => { activeSignal.throwIfAborted(); assertLease(); };
    const beginNativeCleanup = () => {
      if (!controller.signal.aborted && nativeDeadlineMs !== undefined && Date.now() >= nativeDeadlineMs) {
        nativeDeadlineExpired = true;
      }
      nativeCleanupStarted = true;
    };
    const heartbeat = setInterval(() => {
      try { if (this.repository.heartbeat(claim)) controller.abort(); }
      catch {
        leaseLost = true;
        controller.abort();
        diagnostic("worker_lease_lost");
      }
    }, Math.min(500, Math.floor(this.repository.policy.leaseMs / 3)));
    let usage: CloudUsage = { reservedSeconds: this.repository.policy.sessionSeconds, elapsedSeconds: 0 };
    let launched: Awaited<ReturnType<WorkerDependencies["launch"]>> | undefined;
    let launchInvoked = false;
    let result: ExecutionResult;
    try {
      if (claim.recovery) {
        control?.finish();
        try {
          // Cancellation/shutdown must not prevent reconciliation of a paid orphan.
          const outcome = await this.dependencies.recover({
            correlationToken: claim.correlationToken, sessionId: claim.sessionId,
            ...(claim.executionMode === "public-readonly" ? { native: {
              resource: this.repository.reconcileNativeResource(claim),
              predispatchProven: this.repository.nativePredispatchProof(claim),
              assertActive: () => assertLease(true),
              onResource: recordNative,
            } } : {}),
          });
          this.repository.recover(claim, outcome);
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          diagnostic("worker_recovery_failed");
          this.repository.recover(claim, { confirmed: false, sessions: [] });
        }
        return;
      }
      if (claim.executionMode === "controlled-fixture" && this.dependencies.controlledEnabled === false) {
        this.repository.blockUnsupported(claim);
        return;
      }
      if (claim.executionMode !== "controlled-fixture") {
        assertActive();
        try {
          if (!PUBLIC_EXECUTION_IMPLEMENTATION_READY) throw new Error("blocked_unsupported");
          this.repository.assertPublicClaim(claim, this.publicAdmission());
        }
        catch (error) {
          if (error instanceof Error && error.message === "blocked_unsupported") {
            this.repository.blockUnsupported(claim);
            return;
          }
          throw error;
        }
      }
      const raw = this.dependencies.artifacts(claim.runId, claim.attempt.id);
      const evidenceIds = new Map<string, string>();
      const save = async (operation: () => Promise<ArtifactReference>, kind: "screenshot" | "observation" | "console") => {
        assertActive();
        const artifact = await operation();
        assertActive();
        const id = this.repository.recordArtifact(claim, artifact, kind);
        evidenceIds.set(artifact.key, id);
        return artifact;
      };
      const artifacts: ArtifactSinks = {
        screenshot: (bytes) => save(() => raw.screenshot(bytes), "screenshot"),
        json: (value) => save(() => raw.json(value), "observation"),
        telemetry: (record) => save(() => raw.telemetry(record), "console"),
      };
      assertActive();
      const contextReference = claim.executionMode === "controlled-fixture"
        ? await this.repository.prepareContext(claim, this.dependencies.contextProvider) : undefined;
      assertActive();
      launchInvoked = true;
      const common = {
        runId: claim.runId, personaId: claim.attempt.persona.id, correlationToken: claim.correlationToken,
        assertActive: () => { assertActive(); if (launched) control?.assertDispatch(); },
        targetUrl: claim.scope.targetUrl, scope: claim.scope, criteria: claim.attempt.criteria,
        viewport: claim.attempt.persona.device === "phone" ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        artifacts, signal: controller.signal,
        cleanupJson: async (value: unknown) => {
          this.repository.assertLease(claim, true);
          const artifact = await raw.json(value);
          this.repository.assertLease(claim, true);
          this.repository.recordCleanupArtifact(claim, artifact);
          return artifact;
        },
        onSession: async (reference: Parameters<WorkerRepository["sessionReference"]>[1]) => {
          this.repository.sessionReference(claim, reference);
        },
      };
      let publicExecution: Awaited<ReturnType<NonNullable<WorkerDependencies["launchPublic"]>>> | undefined;
      const execution = claim.executionMode === "public-readonly"
        ? publicExecution = await this.dependencies.launchPublic!({
          ...common, mode: "public-readonly", executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
          onResource: recordNative,
        })
        : await this.dependencies.launch({
          ...common, mode: "controlled-fixture", controlledSiteId: claim.controlledSiteId,
          ...(contextReference ? { contextReference } : {}),
          fixturePort: this.fixturePort,
          ...(claim.controlledSiteId === "project-board" ? {} : {
            fixtures: { ...fixedFixtures, secondCoupon: claim.scenario === "second-coupon" },
          }),
        });
      launched = execution;
      usage = execution.usage;
      const limits = workerExecutionLimits(this.repository.policy, claim.attempt.limits);
      if (publicExecution) {
        const nativeSignal = publicExecution.signal;
        if (nativeSignal) {
          activeSignal = AbortSignal.any([controller.signal, nativeSignal]);
          const nativeAborted = () => {
            if (!nativeCleanupStarted && !controller.signal.aborted) nativeInterrupted = true;
          };
          nativeSignal.addEventListener("abort", nativeAborted, { once: true });
          removeNativeAbortListener = () => nativeSignal.removeEventListener("abort", nativeAborted);
          if (nativeSignal.aborted) nativeAborted();
        }
        nativeDeadlineMs = publicExecution.executionDeadlineMs;
        if (nativeDeadlineMs !== undefined) {
          if (!Number.isSafeInteger(nativeDeadlineMs)) throw new Error("invalid_native_execution_deadline");
          const remaining = nativeDeadlineMs - Date.now();
          if (remaining <= 0) {
            nativeDeadlineExpired = true;
            throw new Error("native_execution_deadline");
          }
          limits.maxDurationMs = Math.min(limits.maxDurationMs, remaining);
        }
      }
      let pageUrl: string | undefined;
      let lastChecks: ExecutionResult["checks"] = [];
      let recordedSteps = 0;
      const onEvent = async (event: ExecutionEvent) => {
        // Lifecycle belongs to the durable transaction, not the loop hook.
        if (event.kind === "started" || event.kind === "finished") {
          this.repository.assertLease(claim, true);
          return;
        }
        assertActive();
        if (event.kind === "observation") {
          lastChecks = event.observation.checks;
          pageUrl = publicPageUrl(event.observation.url, this.dependencies.knownSecrets);
          if (pageUrl && new URL(pageUrl).origin !== new URL(claim.scope.targetUrl).origin) pageUrl = undefined;
        }
        if (event.kind === "action") recordedSteps = event.steps;
        const navigation = event.kind === "action" && event.action.action === "navigate" &&
          claim.executionMode === "controlled-fixture" && claim.controlledSiteId !== "project-board"
          ? fixtureNavigationMarker(event.action.value) : null;
        const stored = await artifacts.json(navigation ? { ...event, fixtureNavigation: navigation } : event);
        const evidenceId = evidenceIds.get(stored.key)!;
        this.repository.recordStep(claim, event.kind, evidenceId, {
          ...(pageUrl ? { pageUrl } : {}),
          ...(event.kind === "action" ? { step: event.steps, action: event.action.action } : {}),
          ...(event.kind === "decision" ? {
            modelCalls: event.modelCalls, action: event.decision.action,
            commentary: String(sanitizeEvidence(event.decision.commentary, this.dependencies.knownSecrets)).slice(0, 240),
          } : {}),
        });
      };
      if (claim.reproductionCandidateId) {
        const dispatch = this.repository.reproductionDispatch(claim);
        const reference = this.repository.recordingSession(claim.ownerId, claim.runId, claim.attempt.id);
        if (!dispatch || !reference) throw new Error("reproduction_binding_unavailable");
        const started = Date.now();
        const candidate = await runCouponWithWorkerDriver({
          ...dispatch, signal: controller.signal,
          maxSteps: workerExecutionLimits(this.repository.policy, claim.attempt.limits).maxSteps,
          maxDurationMs: Math.min(dispatch.maxDurationMs, workerExecutionLimits(this.repository.policy, claim.attempt.limits).maxDurationMs),
        }, { driver: execution.driver, sessionIdentity: reference.sessionId, onEvent });
        const status = controller.signal.aborted ? "cancelled" :
          candidate.outcome === "reproduced" ? "target_failed" :
            candidate.outcome === "not_reproduced" ? "gave_up" : "infrastructure_failed";
        const reason = candidate.outcome === "reproduced" ? "Exact controlled fixture failure reproduced" :
          candidate.outcome === "not_reproduced" ? "Recorded failure not reproduced; persona objective success not evaluated" :
            "Reproduction environment or cleanup is uncertain";
        result = {
          status, reason, originalTerminal: { status, reason }, checks: lastChecks,
          steps: recordedSteps, modelCalls: 0,
          modelOperations: { decision: 0, evaluation: 0, retry: 0, total: 0 },
          durationMs: Date.now() - started,
          cleanup: candidate.cleanup === "confirmed" ? { status: "closed", errors: [] } :
            { status: "failed", errors: ["Reproduction cleanup unconfirmed"] },
          errors: candidate.outcome === "unknown" ? [reason] : [],
        };
        this.repository.finish(claim, result, usage, candidate);
        return;
      }
      result = await (this.dependencies.execute ?? executePersona)({
        persona: claim.attempt.persona, goal: claim.attempt.goal, criteria: claim.attempt.criteria,
        signal: activeSignal,
        limits,
      }, {
        control,
        driver: {
          observe: async (signal) => { assertActive(); control?.assertDispatch(); return execution.driver.observe(signal); },
          act: async (action, signal) => { assertActive(); control?.assertDispatch(); return execution.driver.act(action, signal); },
          close: () => {
            if (claim.executionMode === "public-readonly") {
              assertLease(true);
              beginNativeCleanup();
            }
            return execution.driver.close();
          },
        },
        brain: {
          managesModelBudget: execution.brain.managesModelBudget,
          decide: async (input, signal, budget) => {
            assertActive();
            control?.assertDispatch();
            const decision = await execution.brain.decide(input, signal, budget);
            assertActive();
            control?.assertDispatch();
            return decision;
          },
          ...(execution.brain.evaluate ? {
            evaluate: async (input, signal, budget) => {
              assertActive();
              control?.assertDispatch();
              const checks = await execution.brain.evaluate!(input, signal, budget);
              assertActive();
              control?.assertDispatch();
              return checks;
            },
          } satisfies Partial<Brain> : {}),
          ...(execution.brain.quiesce ? { quiesce: () => execution.brain.quiesce!() } : {}),
          ...(execution.brain.drain ? { drain: () => execution.brain.drain!() } : {}),
        },
        onEvent,
      });
      if (nativeInterrupted || nativeDeadlineExpired) {
        const reason = nativeDeadlineExpired ? "Public execution deadline expired" : "Public execution interrupted by infrastructure";
        result = { ...result, status: "infrastructure_failed", reason,
          originalTerminal: { status: "infrastructure_failed", reason }, errors: [...result.errors, reason] };
      }
      this.repository.finish(claim, result, usage);
    } catch (error) {
      let unexpectedCleanup: ExecutionResult["cleanup"] = { status: "failed", errors: ["Worker failure; release requires reconciliation"] };
      if (launched) {
        try {
          if (claim.executionMode === "public-readonly") {
            assertLease(true);
            beginNativeCleanup();
          }
          unexpectedCleanup = await launched.driver.close();
        }
        catch { diagnostic("worker_attempt_failed"); }
      }
      if (leaseLost || error instanceof LeaseLostError) {
        diagnostic("worker_lease_lost");
        return;
      }
      diagnostic("worker_attempt_failed");
      if (error instanceof CloudStartupError) {
        usage = error.usage;
        result = failedResult(controller.signal.aborted && !nativeInterrupted && !nativeDeadlineExpired, error.cleanup);
      } else {
        if (!launchInvoked) {
          usage.allocationAttempted = false;
          unexpectedCleanup = { status: "closed", errors: [] };
        }
        result = failedResult(controller.signal.aborted && !nativeInterrupted && !nativeDeadlineExpired, unexpectedCleanup);
      }
      try { control?.finish(); this.repository.finish(claim, result, usage); }
      catch (finishError) {
        // No success-shaped fallback: durable intent/reservation survive for recovery.
        diagnostic(finishError instanceof LeaseLostError ? "worker_lease_lost" : "worker_attempt_failed");
      }
    } finally {
      removeNativeAbortListener?.();
      clearInterval(heartbeat);
      shutdown.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}

export function productionDependencies(config: AppConfig, controlledEnabled = false): WorkerDependencies {
  const writer = new ArtifactWriter({ dataDir: config.DATA_DIR, knownSecrets: [config.BROWSERBASE_API_KEY] });
  return {
    launch: (options) => {
      if (!controlledEnabled) throw new Error("controlled_execution_disabled");
      return createFixtureExecution(config, options);
    },
    launchPublic: async (options) => {
      const { createPublicExecution } = await import("../execution/public-cloud");
      return createPublicExecution(config, options);
    },
    publicEnabled: config.ENABLE_PUBLIC_RUNS,
    controlledEnabled,
    publicImplementationReady: PUBLIC_EXECUTION_IMPLEMENTATION_READY,
    recover: createCloudRecovery(config).recover,
    artifacts: (runId, attemptId) => writer.createSinks(runId, attemptId),
    knownSecrets: [config.BROWSERBASE_API_KEY],
    contextProvider: createContextProvider(config.BROWSERBASE_API_KEY, config.BROWSERBASE_PROJECT_ID),
  };
}
