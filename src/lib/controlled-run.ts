import { z } from "zod";
import { assignmentSchema } from "./contracts";
import { controlledSite, controlledNavigationScope } from "./controlled-sites";
import type { TargetScope } from "./target-scope";
import { hasRunCapacity, HISTORICAL_MAX_ASSIGNMENTS_PER_RUN, MAX_ASSIGNMENTS_PER_RUN } from "./execution-capacity";

export const controlledSiteIdSchema = z.enum(["store", "project-board"]);
export const controlledScopeSelectionSchema = z.strictObject({
  targetPath: z.string().min(1).max(1024).optional(),
  pathPrefixes: z.array(z.string().min(1).max(1024)).min(1).max(16).optional(),
});
export const controlledRunSchema = z.strictObject({
  authorizationAcknowledged: z.literal(true),
  controlledSiteId: controlledSiteIdSchema,
  scope: controlledScopeSelectionSchema.optional(),
  assignments: z.array(assignmentSchema).min(1).max(HISTORICAL_MAX_ASSIGNMENTS_PER_RUN),
}).refine((value) => new Set(value.assignments.map((entry) => entry.personaId)).size === value.assignments.length,
  "Each persona may appear only once");
export type ControlledRun = z.infer<typeof controlledRunSchema>;
export const newControlledRunSchema = controlledRunSchema.refine((request) => hasRunCapacity(request.assignments), {
  path: ["assignments"], message: `Select at most ${MAX_ASSIGNMENTS_PER_RUN} personas per run`,
});

export function resolveControlledScope(
  id: ControlledRun["controlledSiteId"], selection?: ControlledRun["scope"],
): TargetScope {
  const site = controlledSite(id);
  const input = controlledScopeSelectionSchema.parse(selection ?? {});
  const targetPath = input.targetPath ?? site.entryPath;
  const pathPrefixes = input.pathPrefixes ?? [site.entryPath];
  if (!site.navigationPaths.includes(targetPath) ||
    pathPrefixes.some((prefix) => !site.navigationPaths.includes(prefix))) {
    throw new Error("Invalid controlled-site selection");
  }
  const scope = { targetUrl: `${site.origin}${targetPath}`, allowedSubdomains: [], pathPrefixes };
  controlledNavigationScope(site, scope.targetUrl, scope);
  return scope;
}
