import { describe, expect, it } from "vitest";
import { browserbaseUrlSchema, managedSessionsSchema } from "./managed-contracts";

const attemptId = "11111111-1111-4111-8111-111111111111";
describe("managed live-session contract", () => {
  it("accepts unavailable sessions and provider-hosted HTTPS links only", () => {
    expect(managedSessionsSchema.parse({ items: [{ attemptId, available: false, liveViewUrl: null }] }).items).toHaveLength(1);
    expect(browserbaseUrlSchema.safeParse("https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=x").success).toBe(true);
    expect(browserbaseUrlSchema.safeParse("https://browserbase.com/sessions/x").success).toBe(true);
  });
  it.each([
    "https://browserbase.com.attacker.invalid/x", "http://www.browserbase.com/x",
    "https://user:pw@www.browserbase.com/x", "https://www.browserbase.com:8443/x", "not a url", "",
  ])("rejects %s", (value) => {
    expect(browserbaseUrlSchema.safeParse(value).success).toBe(false);
    expect(managedSessionsSchema.safeParse({ items: [{ attemptId, available: true, liveViewUrl: value }] }).success).toBe(false);
  });
  it("rejects more than eight sessions and unknown keys", () => {
    const item = { attemptId, available: false, liveViewUrl: null };
    expect(managedSessionsSchema.safeParse({ items: Array.from({ length: 9 }, () => item) }).success).toBe(false);
    expect(managedSessionsSchema.safeParse({ items: [{ ...item, sessionId: "private" }] }).success).toBe(false);
  });
});
