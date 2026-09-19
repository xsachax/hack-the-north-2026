import { sanitizeEvidence } from "./execution/artifacts";

/** Public navigation context only, never a session/replay link or a full request URL. */
export function publicPageUrl(value: string, knownSecrets: readonly string[] = []): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    if (knownSecrets.filter(Boolean).some((secret) => url.hostname.includes(secret.toLowerCase()))) return undefined;
    let sensitive = false;
    const path = url.pathname.split("/").map((segment) => {
      let decoded = segment;
      for (let depth = 0; depth < 3; depth++) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch { break; }
      }
      const hidden = sensitive || /[a-f0-9]{64}|\beyJ[A-Za-z0-9_-]{16,}|@/i.test(decoded);
      sensitive = /^(?:auth|authorization|credentials?|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key)$/i.test(decoded);
      const sanitized = hidden ? "[REDACTED]" : String(sanitizeEvidence(decoded, knownSecrets));
      return encodeURIComponent(sanitized);
    }).join("/");
    const result = `${url.origin}${path}`;
    return result.length <= 4096 ? result : undefined;
  } catch {
    return undefined;
  }
}
