export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export async function api<T>(path: string, options: {
  method?: string; body?: unknown; csrfToken?: string; idempotencyKey?: string; signal?: AbortSignal;
} = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.csrfToken ? { "X-CSRF-Token": options.csrfToken } : {}),
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, typeof result?.error?.code === "string" ? result.error.code : "unavailable");
  if (!result || !Object.hasOwn(result, "data")) throw new ApiError(503, "invalid_response");
  return result.data as T;
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Connection interrupted. Your input is still here. Check your connection and retry.";
  if (error.status === 401) return "Your owner session is unavailable. Unlock again; a lost or expired cookie cannot recover previous data.";
  if (error.status === 403) return "This request was not authorized. Use the configured app address and refresh your owner session.";
  if (error.status === 404) return "Not found or not accessible to this owner.";
  if (error.status === 409) return "This request conflicts with an existing request or state. No new run was created by this reply.";
  if (error.status === 429) return "The request or usage limit was reached. Wait at least a minute before trying again.";
  if (error.code === "demo_disabled") return "Controlled runs are disabled by the operator. No browser was started.";
  if (error.status === 400) return "The server rejected this configuration. Check the scope, criteria and persona selection.";
  return "The service is unavailable. Your input is still here; retry when it is available.";
}
