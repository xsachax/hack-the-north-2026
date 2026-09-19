import { z } from "zod";

export const configSchema = z.object({
  BROWSERBASE_API_KEY: z.string().trim().min(1),
  BROWSERBASE_PROJECT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.uuid().optional(),
  ),
  STAGEHAND_MODEL: z.enum([
    "google/gemini-2.5-flash", "openai/gpt-5", "anthropic/claude-sonnet-4-6",
  ]).default("google/gemini-2.5-flash"),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).max(12).default(3),
  MAX_STEPS_PER_PERSONA: z.coerce.number().int().min(1).max(30).default(12),
  SESSION_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(300).default(120),
  DATA_DIR: z.string().trim().min(1).default("./data"),
});

export type AppConfig = z.infer<typeof configSchema>;

export function readConfig(env: Record<string, string | undefined>): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    // Do not include input values: they can contain credentials.
    throw new Error(`Missing or invalid configuration: ${fields.join(", ")}. See .env.example.`);
  }
  return result.data;
}
