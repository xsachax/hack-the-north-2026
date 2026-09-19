import { z } from "zod";

export const nativeResourceSchema = z.strictObject({
  version: z.literal(1),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["upload_intent", "not_dispatched", "uploaded", "upload_unconfirmed", "allocated", "quarantined", "delete_intent", "deleted", "delete_unconfirmed"]),
  extensionId: z.uuid().optional(),
  sessionAllocationAttempted: z.boolean(),
  sessionId: z.uuid().optional(),
});
export type NativeResource = z.infer<typeof nativeResourceSchema>;
type Provider = {
  upload(): Promise<{ id: string }>;
  delete(id: string): Promise<void>;
  /** Must return true only for an authenticated, exact-ID not-found response. */
  deleted(id: string): Promise<boolean>;
};

/** A synchronous durable journal is mandatory; this manager never retries provider operations. */
export class NativeResources {
  private resource: NativeResource;
  private uploadStarted = false;
  private uploadDispatched = false;
  private journalFailed = false;
  private cleanup: Promise<void> | undefined;
  constructor(
    archiveSha256: string,
    private readonly provider: Provider,
    private readonly persist: (resource: Readonly<NativeResource>) => undefined,
  ) {
    this.resource = nativeResourceSchema.parse({
      version: 1, archiveSha256, state: "upload_intent", sessionAllocationAttempted: false,
    });
  }

  snapshot(): Readonly<NativeResource> { return Object.freeze({ ...this.resource }); }

  private record(patch: Partial<NativeResource>) {
    this.resource = nativeResourceSchema.parse({ ...this.resource, ...patch });
    try {
      if (this.persist(this.snapshot()) !== undefined) throw new Error("native_resource_journal_not_synchronous");
    } catch {
      this.journalFailed = true;
      throw new Error("native_resource_journal_failed");
    }
  }

  async upload(beforeDispatch: () => void = () => {}): Promise<string> {
    if (this.uploadStarted) throw new Error("native_extension_retry_forbidden");
    this.uploadStarted = true;
    this.record({ state: "upload_intent" });
    beforeDispatch();
    let uploaded: { id: string };
    try { this.uploadDispatched = true; uploaded = await this.provider.upload(); }
    catch {
      this.record({ state: this.cleanup ? "quarantined" : "upload_unconfirmed" });
      throw new Error("native_extension_upload_unconfirmed");
    }
    const parsed = z.uuid().safeParse(uploaded?.id);
    if (!parsed.success) {
      this.record({ state: this.cleanup ? "quarantined" : "upload_unconfirmed" });
      throw new Error("native_extension_upload_unconfirmed");
    }
    this.record({ state: this.cleanup ? "quarantined" : "uploaded", extensionId: parsed.data });
    if (this.cleanup) throw new Error("native_extension_quarantined");
    return parsed.data;
  }

  allocationAttempted(beforeDispatch: () => void = () => {}): void {
    if (this.resource.state !== "uploaded" || !this.resource.extensionId || this.cleanup || this.journalFailed) {
      throw new Error("native_resource_allocation_rejected");
    }
    this.record({ state: "allocated", sessionAllocationAttempted: true });
    try { beforeDispatch(); }
    catch (error) {
      this.record({ state: "uploaded", sessionAllocationAttempted: false });
      throw error;
    }
  }

  sessionAllocated(sessionId: string): void {
    if (!this.resource.sessionAllocationAttempted || this.resource.sessionId) {
      throw new Error("native_resource_session_rejected");
    }
    this.record({
      sessionId: z.uuid().parse(sessionId),
      ...(this.cleanup ? { state: "quarantined" as const } : {}),
    });
    if (this.cleanup) throw new Error("native_resource_session_rejected");
  }

  /** Never delete a native extension while a possibly-live remote browser uses it. */
  close(remote?: { sessionId: string; status: string }): Promise<void> {
    return this.cleanup ??= (async () => {
      if (!this.uploadDispatched) {
        if (this.uploadStarted && !this.journalFailed) this.record({ state: "not_dispatched" });
        return;
      }
      const id = this.resource.extensionId;
      if (this.journalFailed || !id || (this.resource.sessionAllocationAttempted
        && (!this.resource.sessionId || remote?.sessionId !== this.resource.sessionId || remote.status !== "COMPLETED"))) {
        this.record({ state: "quarantined" });
        throw new Error("native_extension_quarantined");
      }
      this.record({ state: "delete_intent" });
      try {
        await this.provider.delete(id);
        if (!await this.provider.deleted(id)) throw new Error("native_extension_delete_unconfirmed");
      } catch {
        this.record({ state: "delete_unconfirmed" });
        throw new Error("native_extension_delete_unconfirmed");
      }
      this.record({ state: "deleted" });
    })();
  }
}
