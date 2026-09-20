import {
  APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError,
} from "@browserbasehq/sdk/error";
import { z } from "zod";

const requestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const managedCreateFailureSchema = z.strictObject({
  category: z.enum(["http", "connection", "timeout", "aborted", "unknown"]),
  httpStatus: z.int().min(100).max(599).nullable(),
  requestId: requestIdSchema.nullable(),
  requestIdHeader: z.enum(["x-request-id", "request-id"]).nullable(),
}).refine((value) => (value.category === "http") === (value.httpStatus !== null)
  && (value.requestId === null) === (value.requestIdHeader === null));

export type ManagedCreateFailure = z.infer<typeof managedCreateFailureSchema>;

/** Diagnostic metadata only: no response status proves nonallocation. */
export function describeManagedCreateFailure(
  error: unknown, redact: (value: string) => string,
): ManagedCreateFailure {
  const status = error instanceof APIError ? error.status : undefined;
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status : null;
  const category = httpStatus !== null ? "http"
    : error instanceof APIConnectionTimeoutError ? "timeout"
      : error instanceof APIUserAbortError ? "aborted"
        : error instanceof APIConnectionError ? "connection" : "unknown";
  let requestId: string | null = null;
  let requestIdHeader: ManagedCreateFailure["requestIdHeader"] = null;
  if (error instanceof APIError) {
    for (const header of ["x-request-id", "request-id"] as const) {
      const value = error.headers?.[header];
      if (requestIdSchema.safeParse(value).success && typeof value === "string" && redact(value) === value) {
        requestId = value;
        requestIdHeader = header;
        break;
      }
    }
  }
  return { category, httpStatus, requestId, requestIdHeader };
}
