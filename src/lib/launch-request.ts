import { z } from "zod";
import { createRunSchema, idempotencyKeySchema, idSchema } from "./contracts";
import { controlledRunSchema } from "./controlled-run";

export const pendingLaunchSchema = z.discriminatedUnion("path", [
  // Reconciliation must retain historical 9-12-persona payloads and their exact keys.
  z.strictObject({ ownerId: idSchema, key: idempotencyKeySchema, path: z.literal("/runs"), body: createRunSchema }),
  z.strictObject({ ownerId: idSchema, key: idempotencyKeySchema, path: z.literal("/controlled-runs"), body: controlledRunSchema }),
]);
export type PendingLaunch = z.infer<typeof pendingLaunchSchema>;
export const pendingLaunchKey = "flash-flood.pending-launch.v1";
export function readPendingLaunch(raw: string, ownerId: string): PendingLaunch {
  const request = pendingLaunchSchema.parse(JSON.parse(raw));
  if (request.ownerId !== ownerId) throw new Error("pending_owner_mismatch");
  return request;
}
