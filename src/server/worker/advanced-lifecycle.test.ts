import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advancedCancellation, advancedRefreshWatchdog, closeAdvancedObserversAfterWorker, guardAdvancedResume } from "../../../scripts/advanced-lifecycle";
import { ADVANCED_RESUME_TTL_MS, removeAdvancedResume, saveAdvancedResume } from "../../../scripts/advanced-proof";

it.each([false, true])("drains a deferred watchdog refresh before handback, including failure=%s", async (rejectRefresh) => {
  let finish!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let phase = "human", disconnected = false, handback = false;
  const watchdog = advancedRefreshWatchdog(async () => {
    started();
    await pending;
    expect(phase).toBe("human");
    if (rejectRefresh) throw new Error("grant_lost");
  }, () => false, async () => { disconnected = true; }, 5);
  await entered;
  const stopping = watchdog.stop().then(() => {
    if (!disconnected) { phase = "handback"; handback = true; }
  });
  await delay(5);
  expect(handback).toBe(false);
  finish();
  await stopping;
  expect(disconnected).toBe(rejectRefresh);
  expect(handback).toBe(!rejectRefresh);
});

it("retains a passive CDP observer until the worker has settled its shared remote session", async () => {
  let connected = true;
  const order: string[] = [];
  const observer = { close: async () => { connected = false; order.push("observer-disconnect"); } };
  const stopWorker = async () => {
    expect(connected).toBe(true);
    await delay(5);
    expect(connected).toBe(true);
    order.push("worker-settled");
  };
  await closeAdvancedObserversAfterWorker(stopWorker, [observer]);
  expect(order).toEqual(["worker-settled", "observer-disconnect"]);
  expect(connected).toBe(false);
});

it("still closes every retained observer if owned worker cleanup fails and reports the failure", async () => {
  const closed: number[] = [];
  await expect(closeAdvancedObserversAfterWorker(
    async () => { throw new Error("worker_stop_failed"); },
    [
      { close: async () => { closed.push(1); throw new Error("observer_close_failed"); } },
      { close: async () => { closed.push(2); } },
    ],
  )).rejects.toThrow("advanced_owned_cleanup_failed");
  expect(closed).toEqual([1, 2]);
});

describe("bounded attached credential cleanup lifecycle", () => {
  let root: string, id: string;
  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), ".advanced-lifecycle-test-"));
    id = randomUUID();
    await mkdir(join(root, id), { mode: 0o700 });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const save = async (remaining: number) => {
    const createdAt = Date.now() - ADVANCED_RESUME_TTL_MS + remaining;
    await saveAdvancedResume(root, {
      version: 1, mode: "paid", invocationId: id, ownerId: randomUUID(),
      ownerCookie: randomBytes(32).toString("base64url"), runIds: [randomUUID()],
      createdAt, expiresAt: createdAt + ADVANCED_RESUME_TTL_MS,
      reservedSeconds: 0, ledgerDigest: "a".repeat(64),
    });
  };
  it("deletes an abandoned credential at its original deadline without a resume call", async () => {
    await save(350);
    await guardAdvancedResume(root, id, new AbortController().signal);
    await expect(readFile(join(root, id, "owner-resume.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("deletes immediately on interruption rather than abandoning a seven-day owner cookie", async () => {
    await save(ADVANCED_RESUME_TTL_MS);
    const controller = new AbortController();
    const guard = guardAdvancedResume(root, id, controller.signal);
    await delay(20);
    controller.abort();
    await guard;
    await expect(readFile(join(root, id, "owner-resume.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("ends when authenticated resume consumes the file without extending its deadline", async () => {
    await save(ADVANCED_RESUME_TTL_MS);
    const guard = guardAdvancedResume(root, id, new AbortController().signal);
    await delay(20);
    await removeAdvancedResume(root, id);
    await guard;
  });
  it("installs cancellation instead of default signal termination and removes its own listeners", () => {
    const before = process.listenerCount("SIGTERM");
    const cancellation = advancedCancellation();
    try {
      expect(process.listenerCount("SIGTERM")).toBe(before + 1);
      const handler = process.listeners("SIGTERM").at(-1)!;
      handler("SIGTERM");
      expect(cancellation.signal.aborted).toBe(true);
    } finally { cancellation.dispose(); }
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
