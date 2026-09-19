export const PUBLIC_EXECUTION_POLICY = "native-public-v1";
export const PUBLIC_ASSET_POLICY = "public-http-readonly-v1";
export const NATIVE_SHUTDOWN_RESERVE_SECONDS = 80;

export const PUBLIC_EXECUTION_LIMITS = {
  context: "Public runs require fresh profiles. Returning profiles and saving browser state are unsupported.",
  takeover: "Human takeover is unsupported for public read-only runs; the viewer is read-only.",
  rerun: "Public reruns are unsupported. Submit a new explicitly authorized scoped run instead.",
  comparison: "Public run comparisons are unsupported; matching targets and criteria do not establish equivalent execution policies or coverage.",
  reproduction: "Public reduction and reproduction are unsupported; controlled fixture recipes do not apply.",
} as const;

export const publicExecutionReason = {
  offline_checkpoint: "Public execution is disabled in this offline checkpoint. Operator flags and injected readiness cannot enable it.",
  implementation_not_ready: "Public execution is unavailable: native browser and broker integration is not ready.",
  operator_disabled: "Public execution is disabled by this deployment.",
  strong_access_code_required: "Public execution requires an operator-configured access code of at least 32 characters.",
  session_timeout_unsupported: `Public execution requires a session timeout above ${NATIVE_SHUTDOWN_RESERVE_SECONDS} seconds (maximum 300 seconds) to reserve native shutdown time.`,
  ready: "Public read-only admission is enabled. A separate worker is required; this is not a worker heartbeat.",
} as const;
