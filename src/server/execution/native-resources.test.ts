import { describe, expect, it, vi } from "vitest";
import { isNativeSessionRetired, NativeResources, type NativeResource, type NativeSessionClosure } from "./native-resources";

const extensionId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
function setup() {
  const records: Readonly<NativeResource>[] = [];
  const provider = {
    upload: vi.fn(async () => ({ id: extensionId })),
    delete: vi.fn(async () => {}),
    deleted: vi.fn(async () => true),
  };
  const manager = new NativeResources("a".repeat(64), provider, (entry) => { records.push(entry); });
  return { records, provider, manager };
}

describe("native extension lifecycle quarantine", () => {
  it("persists intent and exact ID before allocation, and closes only after exact COMPLETED plus verified deletion", async () => {
    const { records, provider, manager } = setup();
    provider.upload.mockImplementation(async () => {
      expect(records.at(-1)?.state).toBe("upload_intent");
      return { id: extensionId };
    });
    expect(await manager.upload()).toBe(extensionId);
    expect(records.at(-1)).toMatchObject({ state: "uploaded", extensionId, sessionAllocationAttempted: false });
    manager.allocationAttempted();
    manager.sessionAllocated(sessionId);
    expect(records.at(-1)).toMatchObject({ state: "allocated", sessionId, sessionAllocationAttempted: true });
    await manager.close({ sessionId, status: "COMPLETED" });
    await manager.close({ sessionId, status: "COMPLETED" });
    expect(provider.delete).toHaveBeenCalledExactlyOnceWith(extensionId);
    expect(provider.deleted).toHaveBeenCalledExactlyOnceWith(extensionId);
    expect(records.at(-1)?.state).toBe("deleted");
    expect(records.every(Object.isFrozen)).toBe(true);
  });

  it.each(["RUNNING", "PENDING", "ERROR", "TIMED_OUT", "unknown"])("does not delete on %s without terminal proof", async (status) => {
    const { manager, provider, records } = setup();
    await manager.upload(); manager.allocationAttempted(); manager.sessionAllocated(sessionId);
    await expect(manager.close({ sessionId, status })).rejects.toThrow("native_extension_quarantined");
    expect(provider.delete).not.toHaveBeenCalled();
    expect(records.at(-1)).toMatchObject({ state: "quarantined", extensionId, sessionId });
  });

  it.each(["ERROR", "TIMED_OUT"])("retires independently confirmed %s resources without relabeling the failed session", async (status) => {
    const { manager, provider } = setup();
    await manager.upload(); manager.allocationAttempted(); manager.sessionAllocated(sessionId);
    const readback = { sessionId, status, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:00:20Z" };
    await manager.close({ ...readback, independent: { ...readback } });
    expect(provider.delete).toHaveBeenCalledExactlyOnceWith(extensionId);
    expect(manager.snapshot().state).toBe("deleted");
    expect(readback.status).toBe(status);
  });

  it.each([
    { independent: undefined },
    { independent: { sessionId: extensionId, status: "ERROR", startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:00:20Z" } },
    { independent: { sessionId, status: "COMPLETED", startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:00:20Z" } },
    { endedAt: undefined },
    { endedAt: "invalid" },
    { endedAt: "2025-01-01T00:00:00" },
    { endedAt: "2024-01-01T00:00:00Z" },
    { endedAt: "2999-01-01T00:00:00Z" },
    { startedAt: undefined },
  ])("rejects incomplete, conflicting, or impossible operational retirement proof %#", (patch) => {
    const readback = { sessionId, status: "ERROR", startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:00:20Z" };
    const remote: NativeSessionClosure = { ...readback, independent: { ...readback }, ...patch };
    expect(isNativeSessionRetired(remote)).toBe(false);
    if (!("independent" in patch)) expect(isNativeSessionRetired({ ...remote, independent: { ...remote } })).toBe(false);
  });

  it("quarantines an unknown allocation and cannot turn a later callback into clean closure", async () => {
    const { manager, provider } = setup();
    await manager.upload(); manager.allocationAttempted();
    await expect(manager.close()).rejects.toThrow("native_extension_quarantined");
    expect(() => manager.sessionAllocated(sessionId)).toThrow("native_resource_session_rejected");
    await expect(manager.close({ sessionId, status: "COMPLETED" })).rejects.toThrow("native_extension_quarantined");
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("rejects a mismatched completed session", async () => {
    const { manager, provider } = setup();
    await manager.upload(); manager.allocationAttempted(); manager.sessionAllocated(sessionId);
    await expect(manager.close({ sessionId: extensionId, status: "COMPLETED" })).rejects.toThrow("native_extension_quarantined");
    expect(provider.delete).not.toHaveBeenCalled();
  });
  it("does not ignore contradictory independent evidence even for COMPLETED", () => {
    expect(isNativeSessionRetired({
      sessionId, status: "COMPLETED", independent: { sessionId, status: "RUNNING" },
    })).toBe(false);
  });

  it("can delete a known uploaded extension only when allocation was never dispatched", async () => {
    const { manager, provider } = setup();
    await manager.upload();
    await manager.close();
    expect(provider.delete).toHaveBeenCalledExactlyOnceWith(extensionId);
    expect(() => manager.allocationAttempted()).toThrow("native_resource_allocation_rejected");
  });

  it("fences cancellation after the allocation intent but before provider dispatch", async () => {
    const { manager, provider } = setup();
    await manager.upload();
    expect(() => manager.allocationAttempted(() => { throw new Error("cancelled"); })).toThrow("cancelled");
    expect(manager.snapshot().sessionAllocationAttempted).toBe(false);
    await manager.close();
    expect(provider.delete).toHaveBeenCalledExactlyOnceWith(extensionId);
  });

  it.each(["throw", "invalid-id"])("journals unknown upload outcome without automatic retries (%s)", async (outcome) => {
    const { manager, provider, records } = setup();
    if (outcome === "throw") provider.upload.mockRejectedValue(new Error("private-provider-details"));
    else provider.upload.mockResolvedValue({ id: "" });
    await expect(manager.upload()).rejects.toThrow("native_extension_upload_unconfirmed");
    expect(records.at(-1)?.state).toBe("upload_unconfirmed");
    await expect(manager.upload()).rejects.toThrow("native_extension_retry_forbidden");
    await expect(manager.close()).rejects.toThrow("native_extension_quarantined");
    expect(provider.upload).toHaveBeenCalledTimes(1);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it.each(["delete", "readback"])("records unconfirmed extension deletion (%s)", async (operation) => {
    const { manager, provider, records } = setup();
    if (operation === "delete") provider.delete.mockRejectedValue(new Error("private"));
    else provider.deleted.mockResolvedValue(false);
    await manager.upload();
    await expect(manager.close()).rejects.toThrow("native_extension_delete_unconfirmed");
    expect(records.at(-1)).toMatchObject({ state: "delete_unconfirmed", extensionId });
    await expect(manager.close()).rejects.toThrow("native_extension_delete_unconfirmed");
    expect(provider.delete).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch upload when the intent journal fails", async () => {
    const { provider } = setup();
    const manager = new NativeResources("a".repeat(64), provider, () => { throw new Error("journal_unavailable"); });
    await expect(manager.upload()).rejects.toThrow("native_resource_journal_failed");
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it("fences after durable intent and distinguishes cancellation before upload dispatch", async () => {
    const { manager, provider, records } = setup();
    await expect(manager.upload(() => { throw new Error("cancelled"); })).rejects.toThrow("cancelled");
    expect(provider.upload).not.toHaveBeenCalled();
    await manager.close();
    expect(records.at(-1)).toMatchObject({ state: "not_dispatched", sessionAllocationAttempted: false });
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("quarantines an uploaded ID if durable ownership recording fails", async () => {
    const { provider } = setup();
    const manager = new NativeResources("a".repeat(64), provider, (entry) => {
      if (entry.state === "uploaded") throw new Error("ownership_conflict");
    });
    await expect(manager.upload()).rejects.toThrow("native_resource_journal_failed");
    await expect(manager.close()).rejects.toThrow("native_extension_quarantined");
    expect(manager.snapshot()).toMatchObject({ state: "quarantined", extensionId });
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("preserves a late known upload identity in quarantine without reopening allocation", async () => {
    const { manager, provider, records } = setup();
    let finish!: (value: { id: string }) => void;
    provider.upload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const uploading = manager.upload();
    await expect(manager.close()).rejects.toThrow("native_extension_quarantined");
    finish({ id: extensionId });
    await expect(uploading).rejects.toThrow("native_extension_quarantined");
    expect(records.at(-1)).toMatchObject({ state: "quarantined", extensionId });
    expect(() => manager.allocationAttempted()).toThrow("native_resource_allocation_rejected");
    expect(provider.delete).not.toHaveBeenCalled();
  });
});
