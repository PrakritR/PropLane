import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { stopOwnedChild, finishOwnedProof } from "../e2e/support/signup-proof-process.mjs";

function child() { return Object.assign(new EventEmitter(), { pid: 1234, exitCode: null as number | null, signalCode: null as string | null }); }
it("reaps the owned group even when the leader exits before workers", async () => {
  const owned = child();
  const signals: Array<[number, string | number]> = [];
  const kill = vi.fn((pid: number, signal: string | number) => {
    signals.push([pid, signal]);
    if (signal === "SIGTERM") queueMicrotask(() => owned.emit("exit", 0));
    if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  await stopOwnedChild(owned, { kill, timeoutMs: 1 });
  expect(signals).toEqual([[-1234, "SIGTERM"], [-1234, "SIGKILL"], [-1234, 0]]);
});
it("escalates a stuck owned process and refuses a still-live group", async () => {
  const owned = child();
  const kill = vi.fn((_pid: number, signal: string | number) => {
    if (signal === "SIGKILL") queueMicrotask(() => owned.emit("exit", null, "SIGKILL"));
    return true;
  });
  await expect(stopOwnedChild(owned, { kill, timeoutMs: 1, reapTimeoutMs: 1 })).rejects.toThrow("still live");
});
it("refuses missing process identity before signalling", async () => {
  const kill = vi.fn();
  await expect(stopOwnedChild(undefined, { kill })).rejects.toThrow("identity");
  expect(kill).not.toHaveBeenCalled();
});

it("finalizes only after group shutdown and preserves recovery after a failed cleanup", async () => {
  const calls: string[] = [];
  const result = await finishOwnedProof({}, {
    stopChild: async () => { calls.push("stopped"); },
    writeReceipt: () => { calls.push("receipt"); },
    finalize: async () => { calls.push("finalize"); return 1; },
    recover: async () => { calls.push("encrypted-recovery"); return 0; },
  });
  expect(result).toBe(1);
  expect(calls).toEqual(["stopped", "receipt", "finalize", "encrypted-recovery"]);
});
it("never writes shutdown proof or cleans accounts after incomplete process reaping", async () => {
  const writeReceipt = vi.fn(), finalize = vi.fn(), recover = vi.fn(async () => 0);
  await expect(finishOwnedProof({}, { stopChild: async () => { throw new Error("still live"); }, writeReceipt, finalize, recover })).rejects.toThrow("still live");
  expect(writeReceipt).not.toHaveBeenCalled(); expect(finalize).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledOnce();
});
