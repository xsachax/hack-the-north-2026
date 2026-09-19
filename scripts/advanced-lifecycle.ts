import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadAdvancedResume, removeAdvancedResume } from "./advanced-proof";

export function advancedRefreshWatchdog(
  refresh: () => Promise<void>, expired: () => boolean, onFailure: () => Promise<void>, intervalMs = 250,
) {
  let pendingRefresh: Promise<void> | undefined, pendingFailure: Promise<void> | undefined;
  let failed = false, failureError: unknown;
  const fail = () => {
    if (!failed) {
      failed = true;
      pendingFailure = Promise.resolve().then(onFailure).catch((error: unknown) => { failureError = error; });
    }
    return pendingFailure;
  };
  const timer = setInterval(() => {
    if (expired()) { void fail(); return; }
    if (failed || pendingRefresh) return;
    pendingRefresh = refresh().catch(fail).then(() => {}).finally(() => { pendingRefresh = undefined; });
  }, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await pendingRefresh;
      await pendingFailure;
      if (failureError !== undefined) throw failureError;
    },
  };
}

export async function closeAdvancedObserversAfterWorker(
  stopWorker: () => Promise<void>, observers: Iterable<{ close(): Promise<void> }>,
): Promise<void> {
  const errors: unknown[] = [];
  try { await stopWorker(); } catch (error) { errors.push(error); }
  for (const observer of observers) {
    try { await observer.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "advanced_owned_cleanup_failed");
}

export function advancedCancellation() {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("advanced_interrupted"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return {
    signal: controller.signal,
    dispose() { process.off("SIGINT", stop); process.off("SIGTERM", stop); },
  };
}

/** Keep an attached, bounded process alive until consumption or the original expiry. */
export async function guardAdvancedResume(root: string, invocationId: string, signal: AbortSignal): Promise<void> {
  const path = join(root, invocationId, "owner-resume.json");
  const exists = async () => {
    try { await lstat(path); return true; } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  };
  if (!await exists()) return;
  if (signal.aborted) { await removeAdvancedResume(root, invocationId); return; }
  const state = await loadAdvancedResume(root, invocationId);
  try {
    while (Date.now() < state.expiresAt && !signal.aborted) {
      if (!await exists()) return;
      await delay(Math.min(250, state.expiresAt - Date.now()), undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    if (signal.aborted || Date.now() >= state.expiresAt) await removeAdvancedResume(root, invocationId);
  }
}
