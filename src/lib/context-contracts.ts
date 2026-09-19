import { z } from "zod";

export const browserStateSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("fresh") }),
  z.strictObject({ mode: z.literal("save"), acknowledgeSensitiveStorage: z.literal(true) }),
  z.strictObject({
    mode: z.literal("returning"), contextId: z.uuid(), persist: z.boolean(),
    acknowledgeSensitiveStorage: z.literal(true),
  }),
]);
export type BrowserState = z.infer<typeof browserStateSchema>;
export const contextViewSchema = z.strictObject({
  id: z.uuid(),
  scopeSignature: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pending", "creating", "available", "in_use", "persisting", "quarantined",
    "creation_unknown", "revoked", "deleting", "deletion_unknown", "deleted"]),
  createdAt: z.iso.datetime(),
  availableAfter: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  revoked: z.boolean(),
  persistence: z.enum(["never_saved", "requested", "delay_elapsed_unverified", "uncertain"]),
});
export type ContextView = z.infer<typeof contextViewSchema>;
export const contextListSchema = z.strictObject({ items: z.array(contextViewSchema).max(100) });
