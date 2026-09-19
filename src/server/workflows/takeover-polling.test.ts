import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTakeoverPolling, type TakeoverPhase } from "../../lib/takeover-contracts";

type PollState = { phase: TakeoverPhase; controllerId: string | null };
const controllerId = "current-tab";

describe("managed takeover polling quota", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

  it.each([
    { phase: "agent", controllerId, requests: 90 },
    { phase: "human", controllerId, requests: 180 },
    { phase: "human", controllerId: null, requests: 90 },
  ] as const)("three $phase viewers ($controllerId) leave capacity for wall reads", async ({ phase, controllerId: owner, requests }) => {
    const read = vi.fn(async () => ({ phase, controllerId: owner }));
    const stop = Array.from({ length: 3 }, () => startTakeoverPolling(read, controllerId));
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(read).toHaveBeenCalledTimes(requests);
      expect(read.mock.calls.length).toBeLessThan(300);
    } finally { stop.forEach((close) => close()); }
  });

  it("uses one-second polling through acknowledgement and handback, then two seconds after resumption", async () => {
    let phase: TakeoverPhase = "requested";
    const reads: number[] = [];
    const start = Date.now();
    const stop = startTakeoverPolling(async () => {
      reads.push(Date.now() - start);
      return { phase, controllerId };
    }, controllerId);
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (const next of ["quiescing", "human", "handback", "resuming", "agent"] as const) {
        phase = next;
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(reads).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
      await vi.advanceTimersByTimeAsync(1999);
      expect(reads).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads.at(-1)).toBe(7000);
    } finally { stop(); }
  });

  it("does not overlap slow reads or turn transport failures into a polling burst", async () => {
    let finish!: (state: PollState) => void;
    const first = new Promise<PollState>((resolve) => { finish = resolve; });
    const read = vi.fn<() => Promise<PollState | undefined>>()
      .mockReturnValueOnce(first).mockRejectedValue(new Error("offline"));
    const stop = startTakeoverPolling(read, controllerId);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(read).toHaveBeenCalledOnce();
      finish({ phase: "human", controllerId });
      await vi.advanceTimersByTimeAsync(999);
      expect(read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(3);
    } finally { stop(); }
  });

  it("does not schedule another read after unmount while a response is pending", async () => {
    let finish!: (state: PollState) => void;
    const read = vi.fn(() => new Promise<PollState>((resolve) => { finish = resolve; }));
    const stop = startTakeoverPolling(read, controllerId);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    finish({ phase: "human", controllerId });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not issue the initial request if the viewer unmounts before dispatch", async () => {
    const read = vi.fn(async () => ({ phase: "agent" as const, controllerId: null }));
    startTakeoverPolling(read, controllerId)();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).not.toHaveBeenCalled();
  });
});
