import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rerunRequestSchema } from "./rerun-contracts";

describe("immutable scoped rerun admission", () => {
  const request = () => ({ authorizationAcknowledged: true, attemptIds: [randomUUID()] });
  it("accepts only selected parent IDs and an explicit bounded fixture scenario change", () => {
    expect(rerunRequestSchema.parse(request())).not.toHaveProperty("scenario");
    expect(rerunRequestSchema.parse({ ...request(), scenario: "fixed" }).scenario).toBe("fixed");
    expect(rerunRequestSchema.parse({ ...request(), scenario: "second-coupon" }).scenario).toBe("second-coupon");
  });
  it.each([
    { scope: { targetUrl: "https://example.com" } }, { persona: { name: "Changed" } },
    { goal: "Other" }, { criteria: ["Other"] }, { limits: { maxSteps: 30 } },
    { liveViewUrl: "https://provider.example" }, { sessionId: "provider" },
    { context: "reuse" }, { scenario: "arbitrary" }, { authorizationAcknowledged: false },
    { attemptIds: [] }, { attemptIds: Array.from({ length: 13 }, () => randomUUID()) },
  ])("rejects unsupported clone changes: %j", (override) => {
    expect(rerunRequestSchema.safeParse({ ...request(), ...override }).success).toBe(false);
  });
  it("rejects duplicate selected attempts", () => {
    const id = randomUUID();
    expect(rerunRequestSchema.safeParse({ ...request(), attemptIds: [id, id] }).success).toBe(false);
  });
});
