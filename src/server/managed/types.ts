import type { Persona } from "../../lib/contracts";
import type { ManagedResult } from "../../lib/managed-contracts";
import type { TargetScope } from "../../lib/target-scope";

export type ManagedClaim = {
  id: string;
  runId: string;
  ownerId: string;
  workerId: string;
  generation: number;
  correlationToken: string;
  persona: Persona;
  goal: string;
  criteria: string[];
  scope: TargetScope;
  reservedSeconds: number;
  startedAt: number;
  recovery: boolean;
  dispatchStarted: boolean;
  providerRunId?: string;
  providerSessionId?: string;
  providerAgentId?: string;
  providerTask?: string;
};
export type ManagedOutcome = {
  status: "completed" | "failed" | "cancelled";
  providerStatus: string | null;
  cleanup: "closed" | "unconfirmed";
  result: ManagedResult | null;
  error: string | null;
  actualBrowserSeconds: number | null;
  allocationAttempted: boolean;
};
export type ManagedJournal = {
  assertActive(allowCancelled?: boolean): void;
  dispatch(reference: { agentId: string; task: string }): void;
  identity(reference: { providerRunId: string; providerSessionId?: string }): void;
  progress(event: { id: string; kind: "status" | "text" | "tool" | "error"; text: string }): void;
  sessionView(value: { liveViewUrl: string; replayUrl: string }): void;
};
