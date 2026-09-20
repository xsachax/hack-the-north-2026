import { z } from "zod";
import { assignmentSchema } from "./contracts";
import { criterionSchema } from "./criteria";
import { hasRunCapacity, HISTORICAL_MAX_ASSIGNMENTS_PER_RUN, MAX_ASSIGNMENTS_PER_RUN } from "./execution-capacity";

export const demoCriteria = [
  "Both advertised coupons apply and the mug total is CA$21.60.",
  "The demo order is visibly complete.",
] as const;
export const demoRunSchema = z.strictObject({
  authorizationAcknowledged: z.literal(true),
  scenario: z.enum(["fixed", "second-coupon"]),
  assignments: z.array(assignmentSchema.extend({
    criteria: z.array(criterionSchema).min(1).max(12),
  })).min(1).max(HISTORICAL_MAX_ASSIGNMENTS_PER_RUN),
}).refine((value) => new Set(value.assignments.map((a) => a.personaId)).size === value.assignments.length,
  "Each persona may appear only once");
export type DemoRun = z.infer<typeof demoRunSchema>;
export const newDemoRunSchema = demoRunSchema.refine((request) => hasRunCapacity(request.assignments), {
  path: ["assignments"], message: `Select at most ${MAX_ASSIGNMENTS_PER_RUN} personas per run`,
});
export const demoScope = {
  targetUrl: "https://fixture.flash-flood.invalid/demo/category/home",
  allowedSubdomains: [],
  pathPrefixes: ["/demo", "/_next"],
};
export function supportedDemoCriteria(criteria: readonly unknown[]): boolean {
  return new Set(criteria).size === criteria.length &&
    criteria.every((criterion) => demoCriteria.some((known) => known === criterion));
}
