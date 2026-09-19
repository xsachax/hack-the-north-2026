import { z } from "zod";

export const targetScopeSchema = z.strictObject({
  targetUrl: z.string().min(1).max(4096),
  allowedSubdomains: z.array(z.string().min(1).max(253)).max(16).default([]),
  pathPrefixes: z.array(z.string().min(1).max(1024)).min(1).max(16),
});

export type TargetScope = z.infer<typeof targetScopeSchema>;
