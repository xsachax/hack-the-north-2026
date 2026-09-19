export class ServiceError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "rate_limited" | "unauthorized" | "forbidden" | "invalid_request" | "too_large" | "unavailable" | "unsupported_criteria" | "demo_disabled" | "public_takeover_unsupported" | "public_rerun_unsupported" | "public_reproduction_unsupported" | "public_comparison_unsupported" | "public_session_timeout_unsupported" | "public_execution_checkpoint_disabled",
    public readonly status: number,
  ) {
    super(code);
  }
}
