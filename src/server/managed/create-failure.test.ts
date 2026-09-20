import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@browserbasehq/sdk/error";
import { describe, expect, it } from "vitest";
import { describeManagedCreateFailure, managedCreateFailureSchema } from "./create-failure";

const unchanged = (value: string) => value;

describe("private create failure diagnostics", () => {
  it.each([
    [new APIConnectionError({ cause: new Error("private transport details") }), "connection"],
    [new APIConnectionTimeoutError(), "timeout"],
    [new APIUserAbortError(), "aborted"],
    [new Error("private arbitrary exception"), "unknown"],
    [{ status: 429, headers: { "x-request-id": "not-sdk-evidence" } }, "unknown"],
    [null, "unknown"],
  ])("classifies only known SDK errors without copying exception details", (error, category) => {
    const diagnostic = describeManagedCreateFailure(error, unchanged);
    expect(diagnostic).toEqual({ category, httpStatus: null, requestId: null, requestIdHeader: null });
    expect(managedCreateFailureSchema.parse(diagnostic)).toEqual(diagnostic);
  });

  it("retains only allowlisted HTTP metadata and the actual request ID header name", () => {
    const error = APIError.generate(429, { message: "private body", credential: "private credential" },
      "private message", { "request-id": "provider-request-123", authorization: "private header" });
    expect(describeManagedCreateFailure(error, unchanged)).toEqual({
      category: "http", httpStatus: 429, requestId: "provider-request-123", requestIdHeader: "request-id",
    });
    expect(describeManagedCreateFailure(new APIError(503, {}, "", {
      "x-request-id": "primary-request", "request-id": "fallback-request",
    }), unchanged)).toMatchObject({ requestId: "primary-request", requestIdHeader: "x-request-id" });
  });

  it.each(["", "x".repeat(129), "id\ninjected", "id with spaces", "https://private.invalid", "%73ecret", "private-secret"])(
    "drops unsafe or redacted request IDs rather than retaining a truncated or altered identifier", (requestId) => {
      const error = new APIError(500, {}, "", { "x-request-id": requestId });
      expect(describeManagedCreateFailure(error, (value) => value.replace("private-secret", "[REDACTED]")))
        .toEqual({ category: "http", httpStatus: 500, requestId: null, requestIdHeader: null });
    },
  );

  it("rejects raw fields and contradictory metadata at the persistence boundary", () => {
    const diagnostic = { category: "http", httpStatus: 400, requestId: null, requestIdHeader: null };
    for (const input of [
      { ...diagnostic, message: "private" }, { ...diagnostic, httpStatus: null },
      { ...diagnostic, httpStatus: 600 }, { ...diagnostic, httpStatus: 400.5 },
      { ...diagnostic, category: "definite_nonallocation" },
      { ...diagnostic, requestId: "id" }, { ...diagnostic, requestIdHeader: "x-request-id" },
    ]) expect(managedCreateFailureSchema.safeParse(input).success).toBe(false);
  });
});
