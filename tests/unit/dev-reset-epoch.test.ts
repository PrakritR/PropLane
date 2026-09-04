/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * After a dev database wipe the browser's `axis:*` mirror survives, so the
 * portal shows properties that no longer exist — two tabs on the same account
 * showed "Listed 20" and "Listed 6" against a database with zero rows
 * (PRP-195). That does not read as a stale cache; it reads as "deletion didn't
 * work", and it silently invalidates any QA run made afterwards.
 */
const cleared = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/auth/clear-portal-browser-cache", () => ({
  clearPortalBrowserCache: () => {
    cleared.calls += 1;
    return 7;
  },
}));

import { applyDevResetEpoch, DEV_RESET_EPOCH_STORAGE_KEY } from "@/lib/dev/reset-epoch";

beforeEach(() => {
  cleared.calls = 0;
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("applyDevResetEpoch", () => {
  it("does nothing at all when no epoch is configured", () => {
    // Production never sets it, so the whole mechanism is inert there — a bug
    // here must not be able to wipe a real user's local state.
    expect(applyDevResetEpoch(undefined)).toEqual({ cleared: false, removed: 0 });
    expect(applyDevResetEpoch("")).toEqual({ cleared: false, removed: 0 });
    expect(cleared.calls).toBe(0);
  });

  it("records the epoch on a fresh browser without clearing anything", () => {
    // Nothing to clear yet, but the NEXT reset must be detected.
    expect(applyDevResetEpoch("epoch-1")).toEqual({ cleared: false, removed: 0 });
    expect(cleared.calls).toBe(0);
    expect(window.localStorage.getItem(DEV_RESET_EPOCH_STORAGE_KEY)).toBe("epoch-1");
  });

  it("clears the mirror when the epoch changes", () => {
    applyDevResetEpoch("epoch-1");
    const result = applyDevResetEpoch("epoch-2");
    expect(result).toEqual({ cleared: true, removed: 7 });
    expect(cleared.calls).toBe(1);
    expect(window.localStorage.getItem(DEV_RESET_EPOCH_STORAGE_KEY)).toBe("epoch-2");
  });

  it("does not clear again on every load with the same epoch", () => {
    applyDevResetEpoch("epoch-1");
    applyDevResetEpoch("epoch-2");
    cleared.calls = 0;
    applyDevResetEpoch("epoch-2");
    applyDevResetEpoch("epoch-2");
    expect(cleared.calls).toBe(0);
  });

  it("survives storage being blocked entirely", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => applyDevResetEpoch("epoch-3")).not.toThrow();
    expect(cleared.calls).toBe(0);
    get.mockRestore();
  });
});
