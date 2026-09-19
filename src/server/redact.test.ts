import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "./redact";

describe("safe diagnostics", () => {
  it("redacts supplied secrets, Browserbase credentials, and signed URLs", () => {
    const error = new Error("Denied custom-secret bb_live_placeholder https://host/path?token=private");
    expect(safeErrorMessage(error, ["custom-secret"])).toBe("Denied [REDACTED] [REDACTED] [REDACTED_URL]");
  });

  it("keeps operation and cleanup errors visible without raw objects", () => {
    expect(safeErrorMessage(new AggregateError([
      new Error("Navigation failed"), new Error("Release failed"),
    ], "Session failed"), [])).toBe("Session failed Navigation failed; Release failed");
    expect(safeErrorMessage({ credential: "private" }, [])).toBe("Unknown error");
  });
});
