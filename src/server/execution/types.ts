import { z } from "zod";
import type { TerminalStatus } from "../../lib/contracts";
import type { Persona } from "../../lib/personas";

export type { TerminalStatus, Persona };

export interface Candidate {
  readonly id: string;
  readonly kind: "link" | "button" | "input" | "select";
  readonly label: string;
  readonly href?: string;
  readonly inputType?: string;
}

export interface CriterionCheck {
  readonly criterion: string;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface TelemetrySignal {
  readonly kind: "functional_failure" | "http" | "console" | "network" | "info";
  readonly message: string;
  readonly evidence?: string;
  readonly status?: number;
}

export interface Observation {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly candidates: readonly Candidate[];
  readonly screenshotKey?: string;
  readonly signals: readonly TelemetrySignal[];
  readonly checks: readonly CriterionCheck[];
}

export const decisionSchema = z.strictObject({
  action: z.enum(["click", "type", "select", "navigate", "back", "scroll", "key", "wait", "done", "give_up"]),
  candidateId: z.string().min(1).max(200).nullable(),
  value: z.string().max(2000).nullable(),
  commentary: z.string().max(240),
});
export type Decision = z.infer<typeof decisionSchema>;
/** A null wait value selects the driver's default delay, bounded to 5000ms. */
export type BrowserAction = Readonly<Decision & { actor: "agent" }>;

export interface CleanupOutcome {
  readonly status: "closed" | "failed";
  /** Loop results replace driver error detail with fixed, non-sensitive messages. */
  readonly errors: readonly string[];
}

export type ExecutionErrorCode = "block" | "target" | "infra" | "limit" | "unsupported";
export class ExecutionError extends Error {
  constructor(readonly code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

export interface BrowserDriver {
  observe(signal: AbortSignal): Promise<Observation>;
  /** Must validate eligibility and target policy, including fixture-only purchases. */
  act(action: BrowserAction, signal: AbortSignal): Promise<void>;
  /**
   * Cleanup fence: must revoke the session and settle outstanding browser work
   * before resolving or rejecting. Called exactly once, including invalid input.
   */
  close(): Promise<CleanupOutcome>;
}

export interface HistoryEntry {
  readonly observation: Observation;
  readonly decision: Readonly<Decision>;
}

export interface BrainInput {
  readonly persona: Persona;
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly observation: Observation;
  readonly history: readonly HistoryEntry[];
}

export interface Brain {
  /** Model output is untrusted and is parsed by the loop, even with a typed brain. */
  decide(input: BrainInput, signal: AbortSignal): Promise<Decision>;
}

export interface ExecutionLimits {
  readonly maxSteps?: number;
  readonly maxModelCalls?: number;
  readonly maxDurationMs?: number;
  readonly stallThreshold?: number;
  readonly historyLimit?: number;
  readonly rushDelayMs?: number;
  readonly carefulDelayMs?: number;
}

export interface ExecutePersonaInput {
  readonly persona: Persona;
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly limits?: ExecutionLimits;
  readonly signal?: AbortSignal;
}

export interface TerminalOutcome {
  readonly status: TerminalStatus;
  readonly reason: string;
}

export interface ExecutionResult extends TerminalOutcome {
  readonly checks: readonly CriterionCheck[];
  readonly steps: number;
  readonly modelCalls: number;
  readonly durationMs: number;
  readonly cleanup: CleanupOutcome;
  /** Preserved when cleanup or reporting overrides the primary result. */
  readonly originalTerminal: TerminalOutcome;
  /** Fixed failure messages only; never raw SDK, driver, or page exception text. */
  readonly errors: readonly string[];
}

export type ExecutionEvent =
  | { readonly kind: "started"; readonly actor: "agent"; readonly personaId: string }
  | { readonly kind: "observation"; readonly actor: "agent"; readonly observation: Observation }
  | { readonly kind: "decision"; readonly actor: "agent"; readonly decision: Readonly<Decision>; readonly modelCalls: number }
  | { readonly kind: "action"; readonly actor: "agent"; readonly action: BrowserAction; readonly steps: number }
  | { readonly kind: "finished"; readonly actor: "agent"; readonly result: ExecutionResult };

export interface ExecutionDependencies {
  readonly driver: BrowserDriver;
  readonly brain: Brain;
  readonly onEvent?: (event: ExecutionEvent, signal: AbortSignal) => Promise<void>;
}
