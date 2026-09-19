import { z } from "zod";

export const takeoverPhaseSchema = z.enum(["agent", "requested", "quiescing", "human", "handback", "resuming", "closed"]);
export const takeoverCommandSchema = z.strictObject({
  action: z.enum(["request", "handback"]),
  expectedVersion: z.int().min(0),
  controllerId: z.uuid(),
});
export const takeoverStatusSchema = z.strictObject({
  attemptId: z.uuid(),
  phase: takeoverPhaseSchema,
  version: z.int().min(0),
  controllerId: z.uuid().nullable(),
  deadline: z.number().nullable(),
  interactiveUrl: z.url().nullable(),
  validUntil: z.number().nullable(),
  validForMs: z.int().min(0).max(1500).nullable(),
});
export type TakeoverPhase = z.infer<typeof takeoverPhaseSchema>;
export type TakeoverCommand = z.infer<typeof takeoverCommandSchema>;
export type TakeoverStatus = z.infer<typeof takeoverStatusSchema>;

/** Renewal may fail closed before a slow response; polling never extends a grant. */
export function startTakeoverPolling(
  read: () => Promise<Pick<TakeoverStatus, "phase" | "controllerId"> | undefined>,
  controllerId: string,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (state?: Pick<TakeoverStatus, "phase" | "controllerId">) => {
    if (stopped) return;
    const active = state?.controllerId === controllerId &&
      ["requested", "quiescing", "human", "handback", "resuming"].includes(state.phase);
    timer = setTimeout(poll, active ? 1000 : 2000);
  };
  const poll = () => {
    if (stopped) return;
    void Promise.resolve().then(() => stopped ? undefined : read()).then(schedule, () => schedule());
  };
  poll();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}

/** Provider hints supplement, but never replace, the managed wall's inert boundary. */
export function takeoverViewerUrl(value: string, interactive = false): string {
  const url = new URL(value);
  url.searchParams.set("readOnly", String(!interactive));
  return url.href;
}
