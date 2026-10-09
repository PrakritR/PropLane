// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  idleTabPrefetchAllowed,
  resetIdleTabPrefetchForTests,
  scheduleIdleTabPrefetch,
} from "@/lib/portal-idle-tab-prefetch";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const runNow = (run: () => void) => run();

function setConnection(value: unknown) {
  Object.defineProperty(navigator, "connection", { value, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "production");
  resetIdleTabPrefetchForTests();
  setConnection(undefined);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("idle bottom-tab prefetch", () => {
  it("waits for the quiet window, then warms each tab exactly once", async () => {
    const prefetch = vi.fn();
    scheduleIdleTabPrefetch(["/portal/dashboard", "/portal/properties", "/portal/communication"], prefetch, {
      idle: runNow,
    });
    expect(prefetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2100);
    expect(prefetch.mock.calls.map((c) => c[0])).toEqual([
      "/portal/dashboard",
      "/portal/properties",
      "/portal/communication",
    ]);

    // Navigating re-renders the sidebar and re-arms the effect: nothing refires.
    scheduleIdleTabPrefetch(["/portal/dashboard", "/portal/properties"], prefetch, { idle: runNow });
    await vi.advanceTimersByTimeAsync(5000);
    expect(prefetch).toHaveBeenCalledTimes(3);
  });

  it("does nothing outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const prefetch = vi.fn();
    scheduleIdleTabPrefetch(["/portal/dashboard"], prefetch, { idle: runNow });
    await vi.advanceTimersByTimeAsync(5000);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("is skipped on save-data and slow connections", async () => {
    for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
      setConnection(connection);
      expect(idleTabPrefetchAllowed()).toBe(false);
      const prefetch = vi.fn();
      scheduleIdleTabPrefetch(["/portal/dashboard"], prefetch, { idle: runNow });
      await vi.advanceTimersByTimeAsync(5000);
      expect(prefetch).not.toHaveBeenCalled();
      resetIdleTabPrefetchForTests();
    }
    setConnection({ effectiveType: "4g", saveData: false });
    expect(idleTabPrefetchAllowed()).toBe(true);
  });

  it("is skipped while the tab is hidden", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const prefetch = vi.fn();
    scheduleIdleTabPrefetch(["/portal/dashboard"], prefetch, { idle: runNow });
    await vi.advanceTimersByTimeAsync(5000);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("cancels cleanly when the sidebar unmounts before the quiet window ends", async () => {
    const prefetch = vi.fn();
    const cancel = scheduleIdleTabPrefetch(["/portal/dashboard"], prefetch, { idle: runNow });
    cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("is wired into the bottom nav without turning on link or background prefetch", () => {
    expect(read("src/components/portal/portal-sidebar.tsx")).toContain("scheduleIdleTabPrefetch(");
    const gate = read("src/lib/portal-nav-prefetch.ts");
    expect(gate).toMatch(/portalBackgroundPrefetchEnabled\(\): boolean \{\s*return false;/);
    expect(gate).toMatch(/portalMobileLinkPrefetchEnabled\(\): boolean \{\s*return false;/);
  });
});

describe("mount reads stay on the guarded path", () => {
  it("Properties forces the portfolio sync only for writes and explicit refreshes, never on mount", () => {
    const src = read("src/components/portal/pro-properties.tsx");
    expect(src).toContain("void refreshPortfolio(false);");
    expect(src).toContain("syncManagerPortfolioFromServer(scopeUserId, { force })");
    expect(src).not.toContain("syncManagerPortfolioFromServer(scopeUserId, { force: true })");
    // A write still refreshes: the pipeline event listener and refreshPending use the forcing default.
    expect(src).toContain("async (force = true): Promise<boolean>");
    expect(src).toMatch(/const refreshPending = refreshPortfolio;/);
  });

  it("the unified inbox revalidates a remount on the TTL path and does not force on refocus", () => {
    const src = read("src/components/portal/pro-unified-inbox.tsx");
    expect(src).toContain("loadSms({ force: !hadCachedSnapshot, initialGeneration: requestGeneration })");
    expect(src).not.toContain("loadSms({ force: true, initialGeneration: requestGeneration })");
    expect(src).toContain('if (document.visibilityState === "visible") void loadSms();');
    // Mutations keep forcing.
    expect(src).toMatch(/onSmsDeleted: \(\) => \{[^}]*loadSms\(\{ force: true \}\)/s);
  });
});
