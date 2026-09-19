import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

type Scope = { owner: object; pending: boolean; opened: number; closed: number };
const ownership = new AsyncLocalStorage<Scope>();
const openedChannel = channel("undici:websocket:open");
const closedChannel = channel("undici:websocket:close");

export type NativeSdkTransportMonitor = {
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** Seals initialization admission; false never proves transport retirement. */
  waitForClosed(milliseconds?: number): Promise<boolean>;
  dispose(): void;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedSocketUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["ws:", "wss:"].includes(url.protocol) || url.hash || url.username || url.password) {
      throw new Error("invalid_websocket_url");
    }
    return url.href;
  } catch {
    throw new Error("native_sdk_transport_url_invalid");
  }
}

/** Observes owned SDK transport retirement; never initiates transport or provider cleanup. */
export function createNativeSdkTransportMonitor(cdpUrl: string): NativeSdkTransportMonitor {
  const expectedUrl = normalizedSocketUrl(cdpUrl);
  const owner = {};
  const scopes: Scope[] = [];
  const closedSockets = new WeakSet<WebSocket>();
  const waiters = new Set<() => void>();
  let invalid = false;
  let sealed = false;
  let disposed = false;
  const notify = () => { for (const waiter of waiters) waiter(); };
  const currentScope = () => {
    const scope = ownership.getStore();
    return !disposed && scope?.owner === owner ? scope : undefined;
  };
  const onOpen = (message: unknown) => {
    const scope = currentScope();
    if (!scope) return;
    try {
      if (!record(message) || !record(message.address)
        || typeof message.address.address !== "string"
        || typeof message.address.family !== "string" || !["IPv4", "IPv6"].includes(message.address.family)
        || !Number.isInteger(message.address.port) || Number(message.address.port) < 1
        || Number(message.address.port) > 65535
        || !(message.protocol === null || typeof message.protocol === "string")
        || !(message.extensions === null || typeof message.extensions === "string")) {
        invalid = true;
      } else {
        scope.opened++;
      }
    } catch {
      invalid = true;
    }
    notify();
  };
  const onClose = (message: unknown) => {
    const scope = currentScope();
    if (!scope) return;
    try {
      if (!record(message) || !(message.websocket instanceof WebSocket)
        || message.websocket.readyState !== WebSocket.CLOSED
        || message.websocket.url !== expectedUrl
        || !Number.isInteger(message.code) || Number(message.code) < 1000 || Number(message.code) > 4999
        || typeof message.reason !== "string"
        || closedSockets.has(message.websocket) || scope.closed >= scope.opened) {
        invalid = true;
      } else {
        closedSockets.add(message.websocket);
        scope.closed++;
      }
    } catch {
      invalid = true;
    }
    notify();
  };
  const confirmed = () => scopes.length === 0 || (
    scopes.every((scope) => !scope.pending && scope.closed === scope.opened)
    && scopes.some((scope) => scope.opened > 0)
  );
  openedChannel.subscribe(onOpen);
  closedChannel.subscribe(onClose);
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (disposed || sealed) throw new Error("native_sdk_transport_inactive");
      const scope: Scope = { owner, pending: true, opened: 0, closed: 0 };
      scopes.push(scope);
      try {
        return await ownership.run(scope, operation);
      } finally {
        scope.pending = false;
        notify();
      }
    },
    async waitForClosed(milliseconds = 10000): Promise<boolean> {
      if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647) {
        throw new Error("native_sdk_transport_timeout_invalid");
      }
      sealed = true;
      if (disposed || invalid) return false;
      if (confirmed()) return true;
      if (milliseconds === 0) return false;
      return await new Promise<boolean>((resolve) => {
        const finish = (result: boolean) => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(result);
        };
        const check = () => {
          if (disposed || invalid) finish(false);
          else if (confirmed()) finish(true);
        };
        const timer = setTimeout(() => finish(false), milliseconds);
        waiters.add(check);
        check();
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      openedChannel.unsubscribe(onOpen);
      closedChannel.unsubscribe(onClose);
      notify();
    },
  };
}
