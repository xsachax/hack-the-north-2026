import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  create: vi.fn(), retrieve: vi.fn(), list: vi.fn(), listMessages: vi.fn(),
  post: vi.fn(), retrieveSession: vi.fn(), debug: vi.fn(), update: vi.fn(),
}));
vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    constructor(config: unknown) { mocks.constructor(config); }
    agents = { runs: { create: mocks.create, retrieve: mocks.retrieve, list: mocks.list, listMessages: mocks.listMessages } };
    sessions = { retrieve: mocks.retrieveSession, debug: mocks.debug, update: mocks.update };
    post = mocks.post;
  },
}));

import { createManagedProvider } from "./provider";

beforeEach(() => { vi.clearAllMocks(); });

describe("managed SDK adapter", () => {
  it("uses SDK 2.20.0 with no retries and only documented create fields", async () => {
    const provider = createManagedProvider("offline-key");
    const input = { agentId: "reviewed-agent", task: "task", resultSchema: { type: "object" } };
    await provider.createRun(input);
    expect(mocks.constructor).toHaveBeenCalledWith({ apiKey: "offline-key", maxRetries: 0, timeout: 10_000 });
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("maps bounded cursor paging to the documented since/nextSince message API", async () => {
    const provider = createManagedProvider("offline-key");
    mocks.listMessages.mockResolvedValue({ data: [{ id: "message" }], nextSince: "next-message" });
    expect(await provider.listMessages("run-id", { limit: 100, cursor: "last-message" })).toEqual({
      data: [{ id: "message" }], nextCursor: "next-message",
    });
    expect(mocks.listMessages).toHaveBeenCalledExactlyOnceWith("run-id", { limit: 100, since: "last-message" });
  });

  it("uses public typed post for stop, not SDK internals or a reusable-agent mutation", async () => {
    const provider = createManagedProvider("offline-key");
    await provider.stopRun("run-id");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/v1/agents/runs/run-id/stop");
    await expect(provider.stopRun("../other-run?secret=value")).rejects.toThrow("managed_provider_identity_rejected");
    expect(mocks.post).toHaveBeenCalledOnce();
  });

  it("leaves stop conflicts to independent runner verification", async () => {
    const provider = createManagedProvider("offline-key");
    const conflict = Object.assign(new Error("conflict"), { status: 409 });
    mocks.post.mockRejectedValueOnce(conflict);
    await expect(provider.stopRun("run-id")).rejects.toBe(conflict);
  });

  it("releases only an exact existing session without creating a replacement", async () => {
    const provider = createManagedProvider("offline-key");
    await provider.releaseSession("session-id", "project-id");
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("session-id", {
      projectId: "project-id", status: "REQUEST_RELEASE",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
