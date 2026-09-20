import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../lib/config";
import type { NativeResource } from "../execution/native-resources";
import { createCloudRecovery, type CloudRecoveryRequest } from "./cloud-recovery";


const mocks = vi.hoisted(() => ({
  sessions: { list: vi.fn(), retrieve: vi.fn(), update: vi.fn(), create: vi.fn() },
  extensions: { delete: vi.fn(), retrieve: vi.fn(), create: vi.fn() },
  APIError: class extends Error { constructor(readonly status: number) { super("offline-provider-error"); } },
}));
vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    static APIError = mocks.APIError;
    sessions = mocks.sessions;
    extensions = mocks.extensions;
  },
}));
const projectId = randomUUID(), correlationToken = randomUUID(), sessionId = randomUUID(), extensionId = randomUUID();
const config = configSchema.parse({ BROWSERBASE_API_KEY: "offline-placeholder", BROWSERBASE_PROJECT_ID: projectId });
const session = { id: sessionId, projectId, userMetadata: { correlationToken }, status: "COMPLETED",
  startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:02Z" };
const resource: NativeResource = { version: 1, archiveSha256: "a".repeat(64), extensionId,
  state: "quarantined", sessionAllocationAttempted: true, sessionId };
const request = (overrides: Partial<NativeResource> = {}): CloudRecoveryRequest => ({
  correlationToken, sessionId,
  native: { resource: { ...resource, ...overrides }, assertActive: vi.fn(), onResource: vi.fn(() => undefined) },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.sessions.list.mockResolvedValue([session]);
  mocks.sessions.retrieve.mockResolvedValue(session);
  mocks.extensions.delete.mockResolvedValue(undefined);
  mocks.extensions.retrieve.mockRejectedValue(new mocks.APIError(404));
});

describe("native recovery never uploads or reallocates (offline)", () => {
  it("deletes only after correlated COMPLETED and authentic exact-ID 404, journaling both boundaries", async () => {
    const input = request();
    expect(await createCloudRecovery(config).recover(input)).toMatchObject({
      confirmed: true, nativeResourceConfirmed: true, sessions: [{ sessionId, status: "COMPLETED" }],
    });
    expect(mocks.extensions.delete).toHaveBeenCalledExactlyOnceWith(extensionId, { headers: { "Content-Type": null } });
    expect(mocks.extensions.retrieve).toHaveBeenCalledExactlyOnceWith(extensionId);
    expect(input.native!.onResource).toHaveBeenNthCalledWith(1, { ...resource, state: "delete_intent" });
    expect(input.native!.onResource).toHaveBeenNthCalledWith(2, { ...resource, state: "deleted" });
    expect(mocks.extensions.create).not.toHaveBeenCalled();
    expect(mocks.sessions.create).not.toHaveBeenCalled();
  });

  it.each(["RUNNING", "PENDING"])("never deletes after status %s", async (status) => {
    mocks.sessions.list.mockResolvedValue([{ ...session, status }]);
    mocks.sessions.retrieve.mockResolvedValue({ ...session, status });
    const input = request();
    expect((await createCloudRecovery(config).recover(input)).nativeResourceConfirmed).toBe(false);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(input.native!.onResource).toHaveBeenCalledWith(resource);
  });

  it.each(["ERROR", "TIMED_OUT"])("retires %s only after two independent matching private readbacks", async (status) => {
    const ended = { ...session, status };
    mocks.sessions.list.mockResolvedValue([ended]);
    mocks.sessions.retrieve.mockResolvedValue(ended);
    const input = request();
    const result = await createCloudRecovery(config).recover(input);
    expect(result).toMatchObject({
      confirmed: true, nativeResourceConfirmed: true,
      sessions: [{ sessionId, status, actualBrowserSeconds: 2, nativeClosure: {
        sessionId, status, startedAt: session.startedAt, endedAt: session.endedAt,
        independent: { sessionId, status, startedAt: session.startedAt, endedAt: session.endedAt },
      } }],
    });
    expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(3);
    expect(mocks.sessions.retrieve.mock.invocationCallOrder.at(-1))
      .toBeLessThan(mocks.extensions.delete.mock.invocationCallOrder[0]);
    expect(mocks.extensions.retrieve).toHaveBeenCalledExactlyOnceWith(extensionId);
    expect(input.native!.onResource).toHaveBeenLastCalledWith({ ...resource, state: "deleted" });
    expect(mocks.sessions.update).not.toHaveBeenCalled();
    expect(mocks.sessions.create).not.toHaveBeenCalled();
    expect(mocks.extensions.create).not.toHaveBeenCalled();
  });

  it.each([
    { status: "COMPLETED" },
    { status: "TIMED_OUT" },
    { id: randomUUID() },
    { projectId: randomUUID() },
    { userMetadata: { correlationToken: randomUUID() } },
    { startedAt: "2026-01-01T00:00:01Z" },
    { endedAt: "2026-01-01T00:00:03Z" },
    { startedAt: undefined },
    { endedAt: undefined },
    { endedAt: "invalid-date" },
  ])("quarantines conflicting or missing independent ERROR readback fields %j", async (override) => {
    const ended = { ...session, status: "ERROR" };
    mocks.sessions.list.mockResolvedValue([ended]);
    mocks.sessions.retrieve.mockResolvedValueOnce(ended).mockResolvedValueOnce(ended)
      .mockResolvedValueOnce({ ...ended, ...override });
    const input = request();
    const result = await createCloudRecovery(config).recover(input);
    expect(result).toMatchObject({
      confirmed: false, nativeResourceConfirmed: false,
    });
    expect(result.sessions[0]).not.toHaveProperty("actualBrowserSeconds");
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(input.native!.onResource).toHaveBeenLastCalledWith(resource);
  });

  it.each([
    { startedAt: undefined }, { endedAt: undefined }, { endedAt: "invalid-date" },
    { endedAt: "2025-12-31T23:59:59Z" }, { endedAt: "2999-01-01T00:00:00Z" },
  ])("does not accept matching TIMED_OUT reads with invalid timestamps %j", async (override) => {
    const ended = { ...session, status: "TIMED_OUT", ...override };
    mocks.sessions.list.mockResolvedValue([ended]);
    mocks.sessions.retrieve.mockResolvedValue(ended);
    expect((await createCloudRecovery(config).recover(request())).nativeResourceConfirmed).toBe(false);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
  });

  it("retains quarantine if the independent readback fails", async () => {
    const ended = { ...session, status: "ERROR" };
    mocks.sessions.list.mockResolvedValue([ended]);
    mocks.sessions.retrieve.mockResolvedValueOnce(ended).mockResolvedValueOnce(ended)
      .mockRejectedValueOnce(new Error("offline_readback_unavailable"));
    expect((await createCloudRecovery(config).recover(request())).nativeResourceConfirmed).toBe(false);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
  });

  it("never treats empty metadata as proof of no session allocation", async () => {
    mocks.sessions.list.mockResolvedValue([]);
    const input = request();
    expect(await createCloudRecovery(config).recover(input)).toMatchObject({
      confirmed: false, nativeResourceConfirmed: false,
    });
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
  });

  it("leaves unknown uploads quarantined even if a correlated session completes", async () => {
    const input = request({ extensionId: undefined });
    expect((await createCloudRecovery(config).recover(input)).nativeResourceConfirmed).toBe(false);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(mocks.extensions.create).not.toHaveBeenCalled();
    expect(mocks.sessions.create).not.toHaveBeenCalled();
  });

  it("does not delete on foreign correlation or an unmatched known session", async () => {
    for (const foreign of [{ ...session, userMetadata: { correlationToken: randomUUID() } },
      { ...session, id: randomUUID() }]) {
      mocks.sessions.retrieve.mockResolvedValue(foreign);
      mocks.sessions.list.mockResolvedValue([foreign]);
      expect((await createCloudRecovery(config).recover(request())).nativeResourceConfirmed).toBe(false);
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
    }
  });

  it.each(["exists", "generic404", "unauthorized"])("requires authenticated readback, not %s", async (mode) => {
    if (mode === "exists") mocks.extensions.retrieve.mockResolvedValue({ id: extensionId });
    else mocks.extensions.retrieve.mockRejectedValue(mode === "generic404" ? { status: 404 } : new mocks.APIError(401));
    const input = request();
    expect((await createCloudRecovery(config).recover(input)).nativeResourceConfirmed).toBe(false);
    expect(input.native!.onResource).toHaveBeenLastCalledWith({ ...resource, state: "delete_unconfirmed" });
  });

  it("reconciles a prior delete whose response was lost, still requiring exact-ID retrieval", async () => {
    mocks.extensions.delete.mockRejectedValue(new mocks.APIError(404));
    const input = request({ state: "delete_unconfirmed" });
    expect((await createCloudRecovery(config).recover(input)).nativeResourceConfirmed).toBe(true);
    expect(mocks.extensions.retrieve).toHaveBeenCalledExactlyOnceWith(extensionId);
  });

  it("does not delete again when the journal already confirms deletion", async () => {
    const input = request({ state: "deleted" });
    expect((await createCloudRecovery(config).recover(input)).nativeResourceConfirmed).toBe(true);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(mocks.extensions.retrieve).toHaveBeenCalledExactlyOnceWith(extensionId);
  });

  it("recovers known predispatch quarantine only with durable journal proof, without querying sessions", async () => {
    const input = request({ sessionAllocationAttempted: false, sessionId: undefined });
    input.sessionId = undefined;
    input.native!.predispatchProven = true;
    expect(await createCloudRecovery(config).recover(input)).toEqual({
      confirmed: true, sessions: [], nativeResourceConfirmed: true, allocationAttempted: false,
    });
    expect(mocks.sessions.list).not.toHaveBeenCalled();
    expect(mocks.sessions.retrieve).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it("cannot infer predispatch proof merely from a quarantined false allocation flag", async () => {
    const input = request({ sessionAllocationAttempted: false, sessionId: undefined });
    input.sessionId = undefined;
    mocks.sessions.list.mockResolvedValue([]);
    expect((await createCloudRecovery(config).recover(input)).nativeResourceConfirmed).toBe(false);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
  });

  it("records a recovered exact correlated session identity before deleting its extension", async () => {
    const input = request({ sessionId: undefined });
    input.sessionId = undefined;
    expect((await createCloudRecovery(config).recover(input)).nativeResourceConfirmed).toBe(true);
    expect(input.native!.onResource).toHaveBeenNthCalledWith(1, resource);
    expect(input.native!.onResource).toHaveBeenLastCalledWith({ ...resource, state: "deleted" });
  });

  it("does not bind an unknown native session when multiple correlated sessions exist", async () => {
    mocks.sessions.list.mockResolvedValue([session, { ...session, id: randomUUID() }]);
    const input = request({ sessionId: undefined });
    input.sessionId = undefined;
    expect((await createCloudRecovery(config).recover(input)).nativeResourceConfirmed).toBe(false);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
  });

  it("refuses deletion when the lease or synchronous resource journal fails", async () => {
    for (const hook of ["assertActive", "onResource"] as const) {
      const input = request();
      input.native![hook] = vi.fn(() => { throw new Error("worker_lease_lost"); });
      await expect(createCloudRecovery(config).recover(input)).rejects.toThrow("worker_lease_lost");
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
    }
  });
});
