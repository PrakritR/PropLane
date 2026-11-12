import { describe, expect, it, vi } from "vitest";
import { createManagedLockCache, MANAGED_LOCK_TTL_MS } from "@/lib/auth/managed-lock-cache";

describe("managed read-only lock cache (middleware)", () => {
  it("answers a burst for one user with one lookup, and keeps users apart", async () => {
    const cache = createManagedLockCache(10_000, () => 0);
    const load = vi.fn(async () => true);
    expect(await cache.get("u1", load)).toBe(true);
    expect(await cache.get("u1", load)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    const other = vi.fn(async () => false);
    expect(await cache.get("u2", other)).toBe(false);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("never stores a failed lookup: the next call asks again, and the failure still throws (the middleware refuses)", async () => {
    const cache = createManagedLockCache(10_000, () => 0);
    const failing = vi.fn(async () => {
      throw new Error("rpc missing");
    });
    await expect(cache.get("u1", failing)).rejects.toThrow("rpc missing");
    await expect(cache.get("u1", failing)).rejects.toThrow("rpc missing");
    expect(failing).toHaveBeenCalledTimes(2);
    // After a failure, a good answer is read fresh (the failure was never remembered as "not locked").
    const ok = vi.fn(async () => false);
    expect(await cache.get("u1", ok)).toBe(false);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("a failure after a cached answer expires does not resurrect the old answer", async () => {
    let t = 0;
    const cache = createManagedLockCache(10_000, () => t);
    expect(await cache.get("u1", async () => false)).toBe(false);
    t = 10_001;
    await expect(cache.get("u1", async () => { throw new Error("down"); })).rejects.toThrow("down");
  });

  it("re-asks once the TTL has passed, and the TTL never exceeds 30 s", async () => {
    expect(MANAGED_LOCK_TTL_MS).toBeLessThanOrEqual(30_000);
    let t = 0;
    const cache = createManagedLockCache(10 * 60_000, () => t);
    const load = vi.fn(async () => false);
    await cache.get("u1", load);
    t = 29_999;
    await cache.get("u1", load);
    expect(load).toHaveBeenCalledTimes(1);
    t = 30_001;
    await cache.get("u1", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
