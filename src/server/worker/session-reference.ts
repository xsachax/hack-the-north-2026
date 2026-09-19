import { z } from "zod";

export const referenceSchema = z.strictObject({
  sessionId: z.uuid(),
  liveViewUrl: z.union([z.literal(""), z.url()]),
  replayUrl: z.url(),
  timeoutSeconds: z.int().min(1).max(300),
}).refine((ref) => [ref.liveViewUrl, ref.replayUrl].filter(Boolean).every((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password &&
    (url.hostname === "browserbase.com" || url.hostname.endsWith(".browserbase.com"));
}));
