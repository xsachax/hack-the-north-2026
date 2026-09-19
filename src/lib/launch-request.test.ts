import { describe, expect, it } from "vitest";
import { readPendingLaunch } from "./launch-request";

const ownerId = "11111111-1111-4111-8111-111111111111";
const request = { ownerId, key: "durable-request-key-0001", path: "/controlled-runs", body: {
  authorizationAcknowledged: true, controlledSiteId: "project-board",
  assignments: [{ personaId: "careful-first-timer", goal: "Find a saved project.", criteria: ["The project is visible."] }],
} };
describe("owner-bound uncertain launch replay", () => {
  it("retains the exact durable request identity and validated payload", () => {
    expect(readPendingLaunch(JSON.stringify(request), ownerId)).toEqual(request);
  });
  it("never replays a previous owner's pending request", () => {
    expect(() => readPendingLaunch(JSON.stringify(request), "22222222-2222-4222-8222-222222222222")).toThrow("pending_owner_mismatch");
  });
  it.each(["{}", "null", "{", JSON.stringify({ ...request, key: "short" }), JSON.stringify({ ...request, path: "/session" })])("rejects malformed storage %s", (raw) => {
    expect(() => readPendingLaunch(raw, ownerId)).toThrow();
  });
});
