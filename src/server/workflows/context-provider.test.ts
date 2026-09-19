import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextProvider } from "./context-provider";

const contextId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("pinned context provider contract", () => {
  it.each(["lost-reply", "500"])("never retries context creation on %s", async (failure) => {
    const transport = vi.fn<typeof fetch>(async () => {
      if (failure === "lost-reply") throw new TypeError("connection closed");
      return Response.json({ error: "failed" }, { status: 500 });
    });
    vi.stubGlobal("fetch", transport);
    const provider = createContextProvider("offline-secret", projectId);
    await expect(provider.create("flash-flood-owned")).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    const [request, options] = transport.mock.calls[0];
    expect(String(request)).toBe("https://api.browserbase.com/v1/contexts");
    expect(options).toMatchObject({ redirect: "error", method: "POST" });
    expect(JSON.parse(String(options?.body))).toEqual({ name: "flash-flood-owned", projectId });
  });

  it("uses supported create/retrieve/delete without deprecated upload or invented readiness", async () => {
    const transport = vi.fn<typeof fetch>(async (_input, options) => {
      if (options?.method === "POST") return Response.json({ id: contextId });
      if (options?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: contextId, projectId, updatedAt: "2026-09-19T00:00:00Z" });
    });
    vi.stubGlobal("fetch", transport);
    const provider = createContextProvider("offline-secret", projectId);
    expect(await provider.create("owned")).toBe(contextId);
    await expect(provider.inspect(contextId)).resolves.toBeUndefined();
    await provider.delete(contextId);
    expect(transport.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.browserbase.com/v1/contexts",
      `https://api.browserbase.com/v1/contexts/${contextId}`,
      `https://api.browserbase.com/v1/contexts/${contextId}`,
    ]);
  });

  it("rejects substituted provider context/project identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: contextId, projectId: "other" })));
    await expect(createContextProvider("offline", projectId).inspect(contextId)).rejects.toThrow("context_provider_identity_mismatch");
  });

  it("refuses SDK debug logging and malformed remote selectors before a request", async () => {
    vi.stubEnv("DEBUG", "true");
    expect(() => createContextProvider("offline")).toThrow("context_provider_debug_forbidden");
    vi.stubEnv("DEBUG", "false");
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    await expect(createContextProvider("offline").inspect("../other")).rejects.toThrow();
    await expect(createContextProvider("offline").delete("../other")).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
