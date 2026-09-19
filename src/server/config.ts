import "server-only";
import { configSchema } from "@/lib/config";

export function getConfigurationStatus() {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    return {
      configured: false as const,
      invalidFields: [...new Set(result.error.issues.map((issue) => issue.path.join(".")))],
    };
  }
  return {
    configured: true as const,
    concurrency: result.data.MAX_CONCURRENT_SESSIONS,
    maxSteps: result.data.MAX_STEPS_PER_PERSONA,
    timeoutSeconds: result.data.SESSION_TIMEOUT_SECONDS,
  };
}
