import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newRerunRequestSchema, rerunRequestSchema } from "./rerun-contracts";

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
  it("admits eight new selected attempts while preserving twelve-attempt historical replay", () => {
    const attemptIds = Array.from({ length: 12 }, () => randomUUID());
    const body = { ...request(), attemptIds: attemptIds.slice(0, 8) };
    expect(newRerunRequestSchema.parse(body)).toEqual(rerunRequestSchema.parse(body));
    for (const count of [9, 12]) {
      const historical = { ...body, attemptIds: attemptIds.slice(0, count) };
      expect(rerunRequestSchema.parse(historical)).toEqual(historical);
      expect(newRerunRequestSchema.safeParse(historical).success).toBe(false);
    }
  });
});
