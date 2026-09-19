import { ExecutionError } from "./types";

export type ModelOperation = "decision" | "evaluation" | "retry";
export interface ModelOperations {
  readonly decision: number;
  readonly evaluation: number;
  readonly retry: number;
  readonly total: number;
}

/** Charges initiated inference, including failures; no refunds or implicit retries. */
export class ModelBudget {
  private readonly counts = { decision: 0, evaluation: 0, retry: 0, total: 0 };
  private closed = false;

  constructor(readonly maximum: number, private readonly signal: AbortSignal) {}

  get total(): number { return this.counts.total; }
  get remaining(): number { return Math.max(0, this.maximum - this.total); }
  snapshot(): ModelOperations { return { ...this.counts }; }
  close(): void { this.closed = true; }

  assertActive(signal: AbortSignal): void {
    this.signal.throwIfAborted();
    signal.throwIfAborted();
    if (this.closed) throw new ExecutionError("infra", "Model budget closed");
  }

  charge(operation: ModelOperation, signal: AbortSignal): void {
    this.assertActive(signal);
    if (!this.remaining) throw new ExecutionError("limit", "Model-call budget exhausted");
    this.counts[operation]++;
    this.counts.total++;
  }
}
