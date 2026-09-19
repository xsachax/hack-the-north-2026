import "server-only";
import { createApi, validateApiConfiguration } from "./api";
import { Repository } from "./repository";

let handler: ReturnType<typeof createApi> | undefined;
export async function handleApi(request: Request): Promise<Response> {
  try {
    if (!handler) {
      const configuration = {
        origin: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000",
        production: process.env.NODE_ENV === "production",
        accessCode: process.env.FLASH_FLOOD_ACCESS_CODE,
        allowDemoRuns: process.env.ENABLE_DEMO_RUNS === "true",
      };
      validateApiConfiguration(configuration);
      handler = createApi({
        repository: new Repository(process.env.DATA_DIR ?? "./data"),
        configuration,
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
