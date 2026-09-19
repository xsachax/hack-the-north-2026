import type { CDPSession } from "playwright-core";
import { z } from "zod";

const messageSchema = z.object({
  id: z.int().positive().optional(), method: z.string().optional(),
  params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional(),
});

/** Public CDP target sessions, without Playwright's redirect-continuation routing. */
export async function attachCdpTarget(
  browser: CDPSession, targetId: string, onEvent: (method: string, params: unknown) => void,
) {
  let attachment: { sessionId: string; waitingForDebugger: boolean } | undefined;
  const attached = (event: { sessionId: string; targetInfo: { targetId: string }; waitingForDebugger: boolean }) => {
    if (event.targetInfo.targetId === targetId) attachment = event;
  };
  browser.on("Target.attachedToTarget", attached);
  let sessionId: string;
  try { ({ sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: false })); }
  finally { browser.off("Target.attachedToTarget", attached); }
  let next = 0;
  let closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const rejectAll = () => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("public_cdp_closed"));
    }
    pending.clear();
  };
  const receive = (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId || closed) return;
    try {
      if (Buffer.byteLength(event.message) > 12 * 1024 * 1024) throw new Error("public_cdp_message_limit");
      const message = messageSchema.parse(JSON.parse(event.message));
      if (message.id !== undefined) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error !== undefined) entry.reject(new Error("public_cdp_command_failed"));
        else entry.resolve(message.result);
      } else if (message.method) onEvent(message.method, message.params);
      else throw new Error("public_cdp_message_rejected");
    } catch {
      rejectAll();
      onEvent("public.cdpFailure", undefined);
    }
  };
  const detached = (event: { sessionId: string }) => {
    if (event.sessionId === sessionId && !closed) {
      rejectAll();
      onEvent("public.cdpFailure", undefined);
    }
  };
  browser.on("Target.receivedMessageFromTarget", receive);
  browser.on("Target.detachedFromTarget", detached);
  return {
    startupWaiting: attachment?.sessionId === sessionId ? attachment.waitingForDebugger : undefined,
    send(method: string, params: object = {}): Promise<unknown> {
      if (closed || pending.size >= 32 || next >= 10000) return Promise.reject(new Error("public_cdp_unavailable"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("public_cdp_timeout"));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        void browser.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) })
          .catch(() => {
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error("public_cdp_command_failed"));
          });
      });
    },
    async close(detach = true) {
      const wasClosed = closed;
      rejectAll();
      browser.off("Target.receivedMessageFromTarget", receive);
      browser.off("Target.detachedFromTarget", detached);
      if (detach && !wasClosed) await browser.send("Target.detachFromTarget", { sessionId });
    },
  };
}
