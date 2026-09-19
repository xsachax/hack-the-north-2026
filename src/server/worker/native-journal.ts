import { nativeResourceSchema, type NativeResource } from "../execution/native-resources";

const transitions: Record<NativeResource["state"], readonly NativeResource["state"][]> = {
  upload_intent: ["upload_intent", "not_dispatched", "uploaded", "upload_unconfirmed", "quarantined"],
  not_dispatched: ["not_dispatched"],
  uploaded: ["uploaded", "allocated", "quarantined", "delete_intent"],
  upload_unconfirmed: ["upload_unconfirmed", "quarantined"],
  allocated: ["allocated", "uploaded", "quarantined", "delete_intent"],
  quarantined: ["quarantined", "delete_intent"],
  delete_intent: ["delete_intent", "deleted", "delete_unconfirmed", "quarantined"],
  delete_unconfirmed: ["delete_unconfirmed", "delete_intent", "deleted", "quarantined"],
  deleted: ["deleted"],
};

export function mergeNativeResource(
  previous: NativeResource, input: NativeResource, discovery = false,
): NativeResource {
  if (previous.archiveSha256 !== input.archiveSha256 ||
    (previous.extensionId && input.extensionId && previous.extensionId !== input.extensionId) ||
    (previous.sessionId && input.sessionId && previous.sessionId !== input.sessionId)) {
    throw new Error("native_resource_identity_changed");
  }
  const result = nativeResourceSchema.parse({
    ...input,
    ...(previous.extensionId ? { extensionId: previous.extensionId } : {}),
    ...(previous.sessionId ? { sessionId: previous.sessionId } : {}),
    ...(discovery ? {
      state: "quarantined",
      sessionAllocationAttempted: previous.sessionAllocationAttempted || input.sessionAllocationAttempted,
    } : {}),
  });
  if (!discovery && !transitions[previous.state].includes(result.state)) {
    // A delayed upload response may discover its identity after cleanup quarantined it.
    if (previous.state === "quarantined" && result.state === "uploaded") result.state = "quarantined";
    else throw new Error("native_resource_state_regressed");
  }
  const predispatchRollback = previous.state === "allocated" && result.state === "uploaded" &&
    !previous.sessionId && !input.sessionId;
  if (previous.sessionAllocationAttempted && !result.sessionAllocationAttempted && !predispatchRollback) {
    throw new Error("native_resource_allocation_regressed");
  }
  if (result.sessionId && !result.sessionAllocationAttempted) throw new Error("native_resource_invalid_session");
  if (["uploaded", "allocated", "delete_intent", "deleted", "delete_unconfirmed"].includes(result.state) &&
    !result.extensionId) throw new Error("native_resource_missing_extension");
  return result;
}
