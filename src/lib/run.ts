import { z } from "zod";

export const runStatusSchema = z.enum([
  "queued", "running", "succeeded", "gave_up", "bug", "failed", "cancelled",
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export type BrowserEvidence = {
  kind: "console" | "page_error" | "request_failed" | "http_error" | "slow_request";
  timestamp: string;
  pageUrl: string;
  message: string;
};

export type PersonaStep = {
  index: number;
  timestamp: string;
  pageUrl: string;
  // A brief in-character observation, not hidden model reasoning.
  commentary: string;
  action: string;
  frustration: number;
  screenshotPath?: string;
  evidence: BrowserEvidence[];
};

export type PersonaRun = {
  id: string;
  runId: string;
  personaId: string;
  goal: string;
  status: RunStatus;
  sessionId?: string;
  steps: PersonaStep[];
};

export function remainingSteps(completed: number, personaBudget: number, runCap: number): number {
  for (const value of [completed, personaBudget, runCap]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("Step counts and budgets must be non-negative integers.");
    }
  }
  return Math.max(0, Math.min(personaBudget, runCap) - completed);
}
