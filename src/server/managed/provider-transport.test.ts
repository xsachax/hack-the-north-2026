import type { ClientOptions } from "@browserbasehq/sdk";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@browserbasehq/sdk/error";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => vi.fn<NonNullable<ClientOptions["fetch"]>>());
vi.mock("@browserbasehq/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@browserbasehq/sdk")>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: ClientOptions) { super({ ...options, fetch: transport }); }
    },
  };
});

import { describeManagedCreateFailure } from "./create-failure";
import { createManagedProvider } from "./provider";

beforeEach(() => { transport.mockReset(); });

describe("managed adapter with real SDK and offline transport", () => {
  it.each([400, 401, 403, 404, 409, 422, 429, 500, 503])(
    "does not retry create after HTTP %s and preserves original response metadata", async (status) => {
      transport.mockResolvedValue(new Response(JSON.stringify({ message: "private response body" }), {
        status, headers: { "content-type": "application/json", "X-Request-ID": "original-post-id", "retry-after-ms": "1" },
      }));
      const request = createManagedProvider("offline-key").createRun({ agentId: "offline-agent", task: "offline task" });
      await expect(request).rejects.toBeInstanceOf(APIError);
      const error = await request.catch((caught: unknown) => caught);
      expect(describeManagedCreateFailure(error, (value) => value)).toEqual({
        category: "http", httpStatus: status, requestId: "original-post-id", requestIdHeader: "x-request-id",
      });
      expect(transport).toHaveBeenCalledOnce();
      const [url, options] = transport.mock.calls[0];
      expect(new URL(String(url)).pathname).toBe("/v1/agents/runs");
      expect(options?.method).toBe("POST");
    },
  );

  it.each(["connection", "timeout"])("does not retry an ambiguous %s failure", async (kind) => {
    transport.mockRejectedValue(kind === "timeout" ? new DOMException("offline", "AbortError") : new Error("offline"));
    await expect(createManagedProvider("offline-key").createRun({ agentId: "offline-agent", task: "offline task" }))
      .rejects.toBeInstanceOf(kind === "timeout" ? APIConnectionTimeoutError : APIConnectionError);
    expect(transport).toHaveBeenCalledOnce();
  });
});
