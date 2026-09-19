import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, errorMessage } from "./client-api";

afterEach(() => vi.unstubAllGlobals());
describe("owner browser API transport", () => {
  it("sends mutation secrets in headers/body, never in the URL, with the exact durable key", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { id: "run" } })));
    vi.stubGlobal("fetch", fetcher);
    await expect(api("/controlled-runs", {
      method: "POST", csrfToken: "csrf-private", idempotencyKey: "stable-request-key",
      body: { goal: "Small task" },
    })).resolves.toEqual({ id: "run" });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/controlled-runs", expect.objectContaining({
      credentials: "same-origin", cache: "no-store", method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf-private", "Idempotency-Key": "stable-request-key" },
      body: '{"goal":"Small task"}', signal: expect.any(AbortSignal),
    }));
  });
  it("never retries an ambiguous paid POST", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("private URL should not reach UI"); });
    vi.stubGlobal("fetch", fetcher);
    await expect(api("/controlled-runs", { method: "POST", body: {} })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(errorMessage(new TypeError("private URL"))).not.toContain("private URL");
  });
  it("retains typed authorization and throttling errors without exposing server messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "rate_limited", message: "private infrastructure detail" },
    }), { status: 429 })));
    await expect(api("/runs")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(errorMessage(new ApiError(429, "rate_limited"))).toContain("at least a minute");
  });
});
