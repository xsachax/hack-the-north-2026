export class ServiceError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "rate_limited" | "unauthorized" | "forbidden" | "invalid_request" | "too_large" | "unavailable",
    public readonly status: number,
  ) {
    super(code);
  }
}
