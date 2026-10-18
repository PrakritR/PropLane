import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("@/lib/one-number/config.server", () => ({
  loadSharedLineConfig: mocks.config,
  workspaceOnSharedLine: (c: { mode: string }) => c.mode === "shared",
}));

import {
  loadFeelSettings,
  mergeFeelOverride,
  resetFeelSettingsCacheForTests,
  SHARED_LINE_FEEL,
  WORK_NUMBER_FEEL,
} from "@/lib/one-number/feel-settings.server";

function dbWith(feel: unknown, fail = false) {
  return {
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => (fail ? { data: null, error: { code: "42703" } } : { data: { feel_settings: feel }, error: null }),
      };
      return q;
    },
  } as never;
}

describe("feel settings", () => {
  beforeEach(() => {
    resetFeelSettingsCacheForTests();
    mocks.config.mockReset().mockResolvedValue({ mode: "per_workspace" });
  });

  it("defaults: on for the shared line, off for a work number", async () => {
    await expect(loadFeelSettings(dbWith(null), { sharedLine: true })).resolves.toMatchObject({ ...SHARED_LINE_FEEL, lane: "shared" });
    resetFeelSettingsCacheForTests();
    await expect(loadFeelSettings(dbWith(null), { sharedLine: false })).resolves.toMatchObject({ ...WORK_NUMBER_FEEL, lane: "work" });
  });

  it("reads the line mode when the caller does not know it", async () => {
    mocks.config.mockResolvedValue({ mode: "shared" });
    await expect(loadFeelSettings(dbWith(null), { workspaceId: "ws" })).resolves.toMatchObject({ lane: "shared", bubbleReplies: true });
  });

  it("applies per-lane overrides and ignores wrong types", async () => {
    const db = dbWith({ shared: { bubbleReplies: false, debounceMs: 800 }, work: { residentFastPath: true, debounceMs: "x" } });
    await expect(loadFeelSettings(db, { sharedLine: true })).resolves.toMatchObject({ bubbleReplies: false, debounceMs: 800, residentFastPath: true });
    resetFeelSettingsCacheForTests();
    await expect(loadFeelSettings(db, { sharedLine: false })).resolves.toMatchObject({ residentFastPath: true, debounceMs: 0, bubbleReplies: false });
  });

  it("falls back to defaults when the column is missing", async () => {
    await expect(loadFeelSettings(dbWith(null, true), { sharedLine: true })).resolves.toMatchObject(SHARED_LINE_FEEL);
  });

  it("clamps the debounce window", () => {
    expect(mergeFeelOverride(SHARED_LINE_FEEL, { debounceMs: 999999 }).debounceMs).toBe(5000);
    expect(mergeFeelOverride(SHARED_LINE_FEEL, { debounceMs: -5 }).debounceMs).toBe(0);
    expect(mergeFeelOverride(SHARED_LINE_FEEL, [])).toEqual(SHARED_LINE_FEEL);
  });
});
