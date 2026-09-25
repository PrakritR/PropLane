/**
 * Night QA finding #2: /portal/residents/current fetched
 * /api/portal/automation-settings 4-5x per load because several sibling
 * widgets each called the settings hook independently with no shared cache.
 * `loadManagerAutomationSettingsCached` is the fix — concurrent/near-concurrent
 * callers for the same manager must collapse into one network request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import {
  invalidateManagerAutomationSettingsCache,
  loadManagerAutomationSettingsCached,
} from "@/lib/manager-automation-settings-client";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

describe("loadManagerAutomationSettingsCached", () => {
  beforeEach(() => {
    invalidateManagerAutomationSettingsCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("collapses N concurrent callers for the same manager into exactly one network request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, overdueDailyEnabled: true } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Six sibling widgets (one per PortalNotificationPreviewModal kind) all
    // mount at once and ask for the same manager's settings.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => loadManagerAutomationSettingsCached("mgr-1")),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result.overdueDailyEnabled).toBe(true);
  });

  it("serves a second caller inside the TTL window from cache with no new request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS }));
    vi.stubGlobal("fetch", fetchMock);

    await loadManagerAutomationSettingsCached("mgr-1");
    await loadManagerAutomationSettingsCached("mgr-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the TTL window has elapsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS }));
    vi.stubGlobal("fetch", fetchMock);

    await loadManagerAutomationSettingsCached("mgr-1");
    vi.advanceTimersByTime(16_000);
    await loadManagerAutomationSettingsCached("mgr-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("force always starts a fresh fetch, bypassing the TTL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS }));
    vi.stubGlobal("fetch", fetchMock);

    await loadManagerAutomationSettingsCached("mgr-1");
    await loadManagerAutomationSettingsCached("mgr-1", { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per manager — a different manager never shares another's settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, overdueDailyEnabled: true } }))
      .mockResolvedValueOnce(jsonResponse({ settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, overdueDailyEnabled: false } }));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      loadManagerAutomationSettingsCached("mgr-1"),
      loadManagerAutomationSettingsCached("mgr-2"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a.overdueDailyEnabled).toBe(true);
    expect(b.overdueDailyEnabled).toBe(false);
  });
});
