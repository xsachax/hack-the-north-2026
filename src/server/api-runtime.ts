import "server-only";
import { z } from "zod";
import { createApi, validateApiConfiguration } from "./api";
import { Repository } from "./repository";
import { readWorkerPolicy, workerExecutionLimits } from "./worker/config";
import { createBrowserbaseReplayProvider, createReplayAdapter } from "./reports/replay";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "./public-execution-readiness";
import { managedConfiguration } from "./managed/config";

let handler: ReturnType<typeof createApi> | undefined;
export async function handleApi(request: Request): Promise<Response> {
  try {
    if (!handler) {
      const workerPolicy = readWorkerPolicy(process.env);
      const managed = managedConfiguration(process.env);
      const configuration = {
        origin: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000",
        production: process.env.NODE_ENV === "production",
        accessCode: process.env.FLASH_FLOOD_ACCESS_CODE,
        allowDemoRuns: process.env.ENABLE_DEMO_RUNS === "true",
        allowPublicRuns: process.env.ENABLE_PUBLIC_RUNS === "true",
        publicExecutionReady: PUBLIC_EXECUTION_IMPLEMENTATION_READY,
        publicSessionTimeoutSeconds: workerPolicy.sessionSeconds,
        browserbaseKeyConfigured: !!process.env.BROWSERBASE_API_KEY?.trim(),
        executionLimits: workerExecutionLimits(workerPolicy),
        managedEnabled: managed.enabled,
        managedAllowedOrigins: managed.allowedOrigins,
        managedAgentConfigured: !!managed.agentId,
        managedProjectConfigured: z.uuid().safeParse(process.env.BROWSERBASE_PROJECT_ID).success,
      };
      validateApiConfiguration(configuration);
      const segmentOrigins = (process.env.BROWSERBASE_REPLAY_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      if (segmentOrigins.length > 8) throw new Error("replay_origin_limit");
      handler = createApi({
        repository: new Repository(process.env.DATA_DIR ?? "./data"),
        configuration,
        reportSecrets: [process.env.BROWSERBASE_API_KEY ?? "", process.env.FLASH_FLOOD_ACCESS_CODE ?? ""].filter(Boolean),
        replay: process.env.BROWSERBASE_API_KEY ? createReplayAdapter({
          provider: createBrowserbaseReplayProvider(process.env.BROWSERBASE_API_KEY), segmentOrigins,
        }) : undefined,
      });
    }
    return await handler(request);
  } catch {
    console.error("flash_flood_api_initialization_failed");
    return Response.json({ error: { code: "unavailable", message: "unavailable" } }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
