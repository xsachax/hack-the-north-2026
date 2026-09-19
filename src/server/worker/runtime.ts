import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fixedFixtures } from "../../lib/demo";
import { demoScope } from "../../lib/demo-run";
import type { AppConfig } from "../../lib/config";
import { ArtifactWriter, sanitizeEvidence, type ArtifactReference, type ArtifactSinks } from "../execution/artifacts";
import { CloudStartupError, createFixtureExecution, type CloudUsage, type FixtureExecutionOptions } from "../execution/cloud";
import { executePersona } from "../execution/loop";
import type { Brain, BrowserDriver, ExecutionEvent, ExecutionResult } from "../execution/types";
import { LeaseLostError, WorkerRepository, type Claim } from "./repository";
import { createCloudRecovery } from "./cloud-recovery";

export type WorkerDependencies = {
  launch: (options: FixtureExecutionOptions) => Promise<{ driver: BrowserDriver; brain: Brain; usage: CloudUsage }>;
  recover: ReturnType<typeof createCloudRecovery>["recover"];
  artifacts: (runId: string, attemptId: string) => ArtifactSinks;
  execute?: typeof executePersona;
  diagnostic?: (code: "worker_attempt_failed" | "worker_lease_lost" | "worker_recovery_failed") => void;
  knownSecrets?: readonly string[];
};

function failedResult(cancelled: boolean, cleanup: ExecutionResult["cleanup"]): ExecutionResult {
  const status = cancelled && cleanup.status === "closed" ? "cancelled" : "infrastructure_failed";
  const reason = status === "cancelled" ? "Execution cancelled during startup" : "Worker execution failed";
  return {
    status, reason, originalTerminal: { status, reason }, cleanup,
    checks: [], steps: 0, modelCalls: 0, durationMs: 0, errors: [reason],
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

  async run(signal: AbortSignal): Promise<void> {
    const stop = new AbortController();
    const combined = AbortSignal.any([signal, stop.signal]);
    try {
      while (!combined.aborted) {
        let claim: Claim | null;
        while (!combined.aborted && this.active.size < this.repository.policy.globalConcurrency &&
          (claim = this.repository.claim(this.id))) {
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
    const controller = new AbortController();
    let leaseLost = false;
    const diagnostic = this.dependencies.diagnostic ?? ((code) => console.error(code));
    const abort = () => controller.abort();
    shutdown.addEventListener("abort", abort, { once: true });
    if (shutdown.aborted) abort();
    const assertActive = () => {
      controller.signal.throwIfAborted();
      try { this.repository.assertLease(claim); }
      catch (error) { controller.abort(); throw error; }
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
        try {
          // Cancellation/shutdown must not prevent reconciliation of a paid orphan.
          const outcome = await this.dependencies.recover({
            correlationToken: claim.correlationToken, sessionId: claim.sessionId,
          });
          this.repository.recover(claim, outcome);
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          diagnostic("worker_recovery_failed");
          this.repository.recover(claim, { confirmed: false, sessions: [] });
        }
        return;
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
      launchInvoked = true;
      const execution = await this.dependencies.launch({
        mode: "controlled-fixture", runId: claim.runId, personaId: claim.attempt.persona.id,
        correlationToken: claim.correlationToken, assertActive, targetUrl: demoScope.targetUrl,
        criteria: claim.attempt.criteria, fixturePort: this.fixturePort,
        fixtures: { ...fixedFixtures, secondCoupon: claim.scenario === "second-coupon" },
        viewport: claim.attempt.persona.device === "phone" ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        artifacts, signal: controller.signal,
        cleanupJson: async (value) => {
          this.repository.assertLease(claim, true);
          const artifact = await raw.json(value);
          this.repository.assertLease(claim, true);
          this.repository.recordCleanupArtifact(claim, artifact);
          return artifact;
        },
        onSession: async (reference) => { this.repository.sessionReference(claim, reference); },
      });
      launched = execution;
      usage = execution.usage;
      const onEvent = async (event: ExecutionEvent) => {
        // Lifecycle belongs to the durable transaction, not the loop hook.
        if (event.kind === "started" || event.kind === "finished") {
          this.repository.assertLease(claim, true);
          return;
        }
        assertActive();
        const stored = await artifacts.json(event);
        const evidenceId = evidenceIds.get(stored.key)!;
        this.repository.recordStep(claim, event.kind, evidenceId, {
          ...(event.kind === "action" ? { step: event.steps, action: event.action.action } : {}),
          ...(event.kind === "decision" ? {
            modelCalls: event.modelCalls, action: event.decision.action,
            commentary: String(sanitizeEvidence(event.decision.commentary, this.dependencies.knownSecrets)).slice(0, 240),
          } : {}),
        });
      };
      result = await (this.dependencies.execute ?? executePersona)({
        persona: claim.attempt.persona, goal: claim.attempt.goal, criteria: claim.attempt.criteria,
        signal: controller.signal,
        limits: {
          maxSteps: this.repository.policy.maxSteps, maxModelCalls: this.repository.policy.maxModelCalls,
          maxDurationMs: Math.max(1000, (this.repository.policy.sessionSeconds - 60) * 1000),
        },
      }, {
        driver: {
          observe: async (signal) => { assertActive(); return execution.driver.observe(signal); },
          act: async (action, signal) => { assertActive(); return execution.driver.act(action, signal); },
          close: () => execution.driver.close(),
        },
        brain: { decide: async (input, signal) => { assertActive(); return execution.brain.decide(input, signal); } },
        onEvent,
      });
      this.repository.finish(claim, result, usage);
    } catch (error) {
      let unexpectedCleanup: ExecutionResult["cleanup"] = { status: "failed", errors: ["Worker failure; release requires reconciliation"] };
      if (launched) {
        try { unexpectedCleanup = await launched.driver.close(); }
        catch { diagnostic("worker_attempt_failed"); }
      }
      if (leaseLost || error instanceof LeaseLostError) {
        diagnostic("worker_lease_lost");
        return;
      }
      diagnostic("worker_attempt_failed");
      if (error instanceof CloudStartupError) {
        usage = error.usage;
        result = failedResult(controller.signal.aborted, error.cleanup);
      } else {
        if (!launchInvoked) usage.allocationAttempted = false;
        result = failedResult(controller.signal.aborted, unexpectedCleanup);
      }
      try { this.repository.finish(claim, result, usage); }
      catch (finishError) {
        // No success-shaped fallback: durable intent/reservation survive for recovery.
        diagnostic(finishError instanceof LeaseLostError ? "worker_lease_lost" : "worker_attempt_failed");
      }
    } finally {
      clearInterval(heartbeat);
      shutdown.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}

export function productionDependencies(config: AppConfig): WorkerDependencies {
  const writer = new ArtifactWriter({ dataDir: config.DATA_DIR, knownSecrets: [config.BROWSERBASE_API_KEY] });
  return {
    launch: (options) => createFixtureExecution(config, options),
    recover: createCloudRecovery(config).recover,
    artifacts: (runId, attemptId) => writer.createSinks(runId, attemptId),
    knownSecrets: [config.BROWSERBASE_API_KEY],
  };
}
