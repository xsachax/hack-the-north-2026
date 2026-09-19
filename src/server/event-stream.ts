import { terminalStatusSchema } from "../lib/contracts";
import { ServiceError } from "./errors";
import type { OwnerSession, Repository } from "./repository";

export type EventStreamOptions = {
  pollMs?: number;
  keepaliveMs?: number;
  lifetimeMs?: number;
  now?: () => number;
};

function cursor(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ServiceError("invalid_request", 400);
  }
  return Number(value);
}

function pagination(request: Request) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => !["after", "limit"].includes(key) || query.getAll(key).length !== 1)) {
    throw new ServiceError("invalid_request", 400);
  }
  const lastId = request.headers.get("last-event-id");
  const queryAfter = cursor(query.get("after") ?? "0");
  const after = lastId === null ? queryAfter : cursor(lastId);
  const limit = cursor(query.get("limit") ?? "50");
  if (limit < 1 || limit > 100) throw new ServiceError("invalid_request", 400);
  return { after, limit };
}

export function createEventStreamHandler(repository: Pick<Repository, "getRun" | "events">, {
  pollMs = 500, keepaliveMs = 15_000, lifetimeMs = 60_000, now = Date.now,
}: EventStreamOptions = {}) {
  if (![pollMs, keepaliveMs, lifetimeMs].every((value) => Number.isFinite(value) && value > 0 && value <= 60_000)) {
    throw new Error("Invalid event stream timing");
  }
  const owners = new Map<string, number>();
  let active = 0;

  return function stream(request: Request, session: OwnerSession, runId: string, headers: Headers): Response {
    const { after: initialCursor, limit } = pagination(request);
    let after = initialCursor;
    repository.getRun(session.ownerId, runId);
    if (session.expiresAt <= now()) throw new ServiceError("unauthorized", 401);
    if (active >= 100 || (owners.get(session.ownerId) ?? 0) >= 5) {
      throw new ServiceError("rate_limited", 429);
    }
    active++;
    owners.set(session.ownerId, (owners.get(session.ownerId) ?? 0) + 1);
    const encoder = new TextEncoder();
    const deadline = Math.min(session.expiresAt, now() + lifetimeMs);
    let lastWrite = now();
    let stopped = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadlineTimer);
      clearTimeout(pollTimer);
      request.signal.removeEventListener("abort", close);
      wake?.();
      wake = undefined;
      active--;
      const remaining = (owners.get(session.ownerId) ?? 1) - 1;
      if (remaining) owners.set(session.ownerId, remaining);
      else owners.delete(session.ownerId);
    };
    const close = () => {
      if (stopped) return;
      cleanup();
      controller.close();
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        request.signal.addEventListener("abort", close, { once: true });
        deadlineTimer = setTimeout(close, Math.max(0, deadline - now()));
        if (request.signal.aborted) close();
      },
      async pull() {
        try {
          while (!stopped) {
            if (now() >= deadline) { close(); return; }
            // Read status first: a terminal snapshot guarantees its final events
            // were committed before the following page read.
            const run = repository.getRun(session.ownerId, runId);
            const page = repository.events(session.ownerId, runId, { after, limit });
            if (page.items.length > limit) throw new Error("Invalid event page");
            let next = after;
            const frames = page.items.map((event) => {
              if (event.runId !== runId || !Number.isSafeInteger(event.sequence) || event.sequence <= next) {
                throw new Error("Invalid event sequence");
              }
              next = event.sequence;
              return `id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
            });
            const terminal = terminalStatusSchema.safeParse(run.status).success && page.nextCursor === null;
            if (frames.length) {
              after = next;
              lastWrite = now();
              controller.enqueue(encoder.encode(frames.join("")));
              if (terminal) close();
              return;
            }
            if (terminal) { close(); return; }
            if (now() - lastWrite >= keepaliveMs) {
              lastWrite = now();
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              return;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              pollTimer = setTimeout(resolve, Math.min(pollMs, keepaliveMs - (now() - lastWrite)));
            });
            wake = undefined;
          }
        } catch {
          if (!stopped) {
            controller.enqueue(encoder.encode('event: error\ndata: {"code":"unavailable"}\n\n'));
            close();
          }
        }
      },
      cancel: cleanup,
    }, { highWaterMark: 0 });
    const streamHeaders = new Headers(headers);
    streamHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
    streamHeaders.set("Cache-Control", "no-store, no-transform");
    streamHeaders.set("X-Accel-Buffering", "no");
    return new Response(body, { headers: streamHeaders });
  };
}
