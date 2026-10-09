import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

import { fetchPinnedPublicHttps } from "@/lib/sheet-sync/public-host.server";

class FakeReq extends EventEmitter {
  destroyed = false;
  setTimeout = vi.fn();
  end = vi.fn();
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit("error", err);
    this.emit("close");
    return this;
  }
}

describe("fetchPinnedPublicHttps total deadline", () => {
  let req: FakeReq;
  beforeEach(() => {
    vi.useFakeTimers();
    req = new FakeReq();
    mocks.request.mockReset().mockReturnValue(req);
    mocks.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });
  afterEach(() => vi.useRealTimers());

  it("destroys a request that never finishes once the overall deadline passes", async () => {
    const pending = fetchPinnedPublicHttps("https://slow.example.com/a.csv", { totalTimeoutMs: 5_000 });
    const settled = pending.then(() => "ok", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(req.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(req.destroyed).toBe(true);
    expect(await settled).toMatch(/total time limit/);
  });

  it("defaults to 15 seconds", async () => {
    const settled = fetchPinnedPublicHttps("https://slow.example.com/a.csv").then(() => "ok", () => "failed");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(req.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(req.destroyed).toBe(true);
    expect(await settled).toBe("failed");
  });

  it("clears the deadline once the request closes normally", async () => {
    void fetchPinnedPublicHttps("https://fast.example.com/a.csv", { totalTimeoutMs: 5_000 }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    req.emit("close");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(req.destroyed).toBe(false);
  });
});
