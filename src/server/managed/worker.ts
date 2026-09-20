import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Repository } from "../repository";
import { workerConcurrencyLimits, type WorkerPolicy } from "../worker/config";
import type { ManagedClaim, ManagedJournal } from "./types";
import { executeManagedAgent } from "./runner";

export class ManagedWorker {
  readonly id = randomUUID();
  private readonly active = new Set<Promise<void>>();
  constructor(
    private readonly repository: Repository,
    private readonly policy: WorkerPolicy,
    private readonly options: Omit<Parameters<typeof executeManagedAgent>[2], "signal">,
    private readonly execute = executeManagedAgent,
  ) {}

  async run(signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        let claim: ManagedClaim | null;
        while (!signal.aborted && this.active.size < workerConcurrencyLimits(this.policy).globalConcurrency
          && (claim = this.repository.managed.claim(this.id, this.policy))) {
          const task = this.executeClaim(claim, signal);
          this.active.add(task);
          void task.finally(() => { this.active.delete(task); }).catch(() => {
            console.error("managed_worker_attempt_unsettled");
          });
        }
        try { await delay(500, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    } finally { await Promise.allSettled(this.active); }
  }

  async executeClaim(claim: ManagedClaim, shutdown: AbortSignal) {
    const store = this.repository.managed;
    const stop = new AbortController();
    const signal = AbortSignal.any([shutdown, stop.signal]);
    const heartbeat = setInterval(() => {
      try { if (store.heartbeat(claim, this.policy.leaseMs)) stop.abort(); }
      catch { stop.abort(); console.error("managed_worker_lease_lost"); }
    }, Math.min(500, this.policy.leaseMs / 3));
    const journal: ManagedJournal = {
      assertActive: (allowCancelled = false) => {
        store.assertLease(claim, allowCancelled);
        if (!allowCancelled) signal.throwIfAborted();
      },
      dispatch: (reference) => store.dispatch(claim, reference),
      identity: (value) => store.identity(claim, value),
      progress: (value) => store.progress(claim, value),
      sessionView: (value) => store.sessionView(claim, value),
    };
    try {
      const result = await this.execute(claim, journal, { ...this.options, signal });
      store.finish(claim, result);
    } catch {
      // The existing dispatched reservation remains occupied for fenced recovery.
      console.error("managed_worker_attempt_recovery_required");
    } finally { clearInterval(heartbeat); }
  }
}
