import { z } from "zod";
import { configSchema } from "../../lib/config";

export const nativeSdkOptionsSchema = z.strictObject({
  apiKey: z.string().min(1).max(2048),
  sessionId: z.uuid(),
  extensionId: z.string().regex(/^[a-p]{32}$/),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port
      && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  }),
  model: configSchema.shape.STAGEHAND_MODEL,
});

export const nativeSdkCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ id: z.int().positive(), operation: z.literal("connect") }),
  z.strictObject({ id: z.int().positive(), operation: z.literal("initialize") }),
  z.strictObject({ id: z.int().positive(), operation: z.literal("selectPage"), url: z.string().url().max(4096) }),
  z.strictObject({
    id: z.int().positive(), operation: z.literal("extract"),
    schema: z.enum(["decision", "evaluation"]), prompt: z.string().min(1).max(128 * 1024),
  }),
  z.strictObject({ id: z.int().positive(), operation: z.literal("metrics") }),
]);
export type NativeSdkCommand = z.infer<typeof nativeSdkCommandSchema>;
export type NativeSdkRequest = NativeSdkCommand extends infer T
  ? T extends NativeSdkCommand ? Omit<T, "id"> : never : never;

export const nativeSdkReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ id: z.int().positive(), ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ id: z.int().positive(), ok: z.literal(false), code: z.literal("native_sdk_operation_failed") }),
]);

const metric = z.number().finite().nonnegative();
export const nativeSdkMetricsSchema = z.strictObject({
  actPromptTokens: metric, actCompletionTokens: metric, actReasoningTokens: metric,
  actCachedInputTokens: metric, actInferenceTimeMs: metric,
  extractPromptTokens: metric, extractCompletionTokens: metric, extractReasoningTokens: metric,
  extractCachedInputTokens: metric, extractInferenceTimeMs: metric,
  observePromptTokens: metric, observeCompletionTokens: metric, observeReasoningTokens: metric,
  observeCachedInputTokens: metric, observeInferenceTimeMs: metric,
  totalPromptTokens: metric, totalCompletionTokens: metric, totalReasoningTokens: metric,
  totalCachedInputTokens: metric, totalInferenceTimeMs: metric,
});
