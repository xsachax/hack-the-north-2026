import { z } from "zod";
import { assignmentSchema } from "./contracts";

export const demoCriteria = [
  "Both advertised coupons apply and the mug total is CA$21.60.",
  "The demo order is visibly complete.",
] as const;
export const demoRunSchema = z.strictObject({
  authorizationAcknowledged: z.literal(true),
  scenario: z.enum(["fixed", "second-coupon"]),
  assignments: z.array(assignmentSchema).min(1).max(12),
}).refine((value) => new Set(value.assignments.map((a) => a.personaId)).size === value.assignments.length,
  "Each persona may appear only once");
export type DemoRun = z.infer<typeof demoRunSchema>;
export const demoScope = {
  targetUrl: "https://fixture.flash-flood.invalid/demo/category/home",
  allowedSubdomains: [],
  pathPrefixes: ["/demo", "/_next"],
};
export function supportedDemoCriteria(criteria: readonly string[]): boolean {
  return new Set(criteria).size === criteria.length &&
    criteria.every((criterion) => demoCriteria.some((known) => known === criterion));
}
