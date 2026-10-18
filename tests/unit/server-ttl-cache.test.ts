import { describe, expect, it, vi } from "vitest";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";

describe("createTtlCache", () => {
  it("serves one computation to repeated and concurrent callers until the ttl lapses", async () => {
    let clock = 1_000;
    const cache = createTtlCache<string>(60_000, () => clock);
    const load = vi.fn(async () => `built-${load.mock.calls.length}`);

    const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
    expect(a).toBe("built-1");
    expect(b).toBe("built-1");
    expect(load).toHaveBeenCalledTimes(1);

    clock += 59_999;
    expect(await cache.get("k", load)).toBe("built-1");
    expect(load).toHaveBeenCalledTimes(1);

    clock += 2;
    expect(await cache.get("k", load)).toBe("built-2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure", async () => {
    const cache = createTtlCache<string>(60_000);
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce("ok");
    await expect(cache.get("k", load)).rejects.toThrow("db down");
    expect(await cache.get("k", load)).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps keys apart and clears on demand", async () => {
    const cache = createTtlCache<string>(60_000);
    expect(await cache.get("a", async () => "A")).toBe("A");
    expect(await cache.get("b", async () => "B")).toBe("B");
    cache.clear();
    expect(await cache.get("a", async () => "A2")).toBe("A2");
  });

  it("a clear during an in-flight load is not undone when that load settles", async () => {
    const cache = createTtlCache<string>(60_000, () => 1_000);
    let release: (value: string) => void = () => {};
    const slow = cache.get("k", () => new Promise<string>((resolve) => { release = resolve; }));

    cache.clear();
    release("pre-clear");
    expect(await slow).toBe("pre-clear");

    // The cleared cache must recompute, not serve the value the cleared load produced.
    expect(await cache.get("k", async () => "after-clear")).toBe("after-clear");
    expect(await cache.get("k", async () => "third")).toBe("after-clear");
  });

  it("is switched off under test so route tests read their mocks live", () => {
    expect(serverSnapshotCacheEnabled()).toBe(false);
  });
});
