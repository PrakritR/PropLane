import { afterEach, describe, expect, it, vi } from "vitest";
import { OVERVIEW_SOURCE_BUDGET_MS, withBudget } from "@/lib/admin/admin-overview.server";

afterEach(() => vi.useRealTimers());

describe("the Dashboard's per-source budget", () => {
  it("returns the value of a source that answers in time", async () => {
    expect(await withBudget(Promise.resolve(7), 50, null)).toBe(7);
  });

  it("returns the fallback when the source rejects", async () => {
    expect(await withBudget(Promise.reject(new Error("boom")), 50, null)).toBeNull();
  });

  it("stops waiting for a source that never answers, so one hung read cannot hold the page on Loading", async () => {
    vi.useFakeTimers();
    const hung = new Promise<number>(() => undefined);
    const result = withBudget(hung, OVERVIEW_SOURCE_BUDGET_MS, null);
    await vi.advanceTimersByTimeAsync(OVERVIEW_SOURCE_BUDGET_MS + 1);
    expect(await result).toBeNull();
  });

  it("the budget sits well under the browser's 20 second wait", () => {
    expect(OVERVIEW_SOURCE_BUDGET_MS).toBeLessThan(20_000 / 2);
  });
});
