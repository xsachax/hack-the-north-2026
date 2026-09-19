import { z } from "zod";
import type { CloudRecoveryResult } from "../src/server/worker/cloud-recovery";

const checkSchema = z.object({
  criterion: z.string(), passed: z.boolean(), method: z.string().optional(),
  status: z.string().optional(),
  citations: z.array(z.object({ observationId: z.string(), excerpt: z.string() })).optional(),
});
export const proofObservationSchema = z.object({
  id: z.string(), text: z.string(), textBlocks: z.array(z.string()), checks: z.array(checkSchema),
});
type ProofObservation = z.infer<typeof proofObservationSchema>;
type ProofCheck = z.infer<typeof checkSchema>;

/** Harness-only oracle: this controlled board has a known, independently checkable output. */
export function boardSemanticProof(observations: readonly ProofObservation[], finalCheck: ProofCheck | undefined) {
  const grounded = (observation: ProofObservation, check: ProofCheck | undefined) =>
    check?.method === "semantic" && !!check.citations?.length && check.citations.every((citation) =>
      citation.observationId === observation.id && citation.excerpt.trim().length > 0 &&
      observation.text.includes(citation.excerpt));
  const negative = observations.some((observation) => {
    const check = observation.checks.find((item) => item.criterion === "project-category");
    return observation.textBlocks.includes("No projects yet. Start with New project.") &&
      observation.textBlocks.includes("0 of 12 synthetic projects in this tab.") &&
      !check?.passed && ["not_met", "inconclusive"].includes(check?.status ?? "") && grounded(observation, check);
  });
  const positive = observations.some((observation) => {
    return observation.textBlocks.includes("Garden planning") &&
      observation.textBlocks.includes("Category: Design") &&
      observation.textBlocks.includes("1 of 12 synthetic projects in this tab.") &&
      finalCheck?.passed === true && finalCheck.status === "met" && grounded(observation, finalCheck);
  });
  return { negative, positive };
}

export function singleSessionProof(proof: readonly CloudRecoveryResult[], expectedSessionId: string | undefined): boolean {
  if (!expectedSessionId || proof.length !== 1 || !proof[0].confirmed || proof[0].sessions.length !== 1) return false;
  const session = proof[0].sessions[0];
  return session.sessionId === expectedSessionId && ["COMPLETED", "ERROR", "TIMED_OUT"].includes(session.status);
}
