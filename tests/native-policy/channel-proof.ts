export type WorkerRealm = "classic" | "module" | "shared" | "service";

export function assertWorkerChannelProof(realm: WorkerRealm, availability: string, packets: number, protectedLane: boolean): void {
  if (availability !== "available") throw new Error(`native_worker_channel_unsupported:${realm}`);
  if (!Number.isSafeInteger(packets) || packets < 0) throw new Error("native_worker_channel_invalid_evidence");
  if (protectedLane && packets !== 0) throw new Error("native_worker_channel_destination_reached");
  if (!protectedLane && packets === 0) throw new Error("native_worker_channel_positive_control_missing");
}
