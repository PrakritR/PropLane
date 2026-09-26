// @vitest-environment jsdom
/**
 * Night QA finding #2: /portal/residents/current fetched
 * /api/portal/automation-settings 4-5x per load because several sibling
 * widgets each called the settings hook independently with no shared cache.
 * `loadManagerAutomationSettingsCached` is the fix — concurrent/near-concurrent
 * callers for the same manager must collapse into one network request.
 *
 * jsdom (not the suite default "node") because the module also listens for
 * `PAYMENT_AUTOMATION_SETTINGS_EVENT` on `window` to invalidate every scope
 * after a save (N032) — that needs a real `window` to dispatch against.
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
    for (const result of results) expect(result.settings.overdueDailyEnabled).toBe(true);
  });

  it("N mounts of every Settings-modal reader (tour settings, messaging defaults, notification routing, communication, per-field rows) collapse into one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS, source: "account" }));
    vi.stubGlobal("fetch", fetchMock);

    // Simulates every real call site converted onto the shared reader
    // (pro-portal-settings-panels.tsx's tour/communication/toggle-row panels,
    // pro-messaging-outbound-defaults.tsx, pro-notification-routing-setting.tsx,
    // reminder-settings-bundles.tsx, use-inbox-ai-draft-auto-send.ts) all
    // mounting on the same Settings modal open, unscoped (account-level).
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => loadManagerAutomationSettingsCached("mgr-1")),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(N);
    for (const result of results) expect(result.source).toBe("account");
  });

  it("serves a second caller inside the TTL window from cache with no new request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS }));
    vi.stubGlobal("fetch", fetchMock);

    await loadManagerAutomationSettingsCached("mgr-1");
    await loadManagerAutomationSettingsCached("mgr-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys the cache per workspace/property scope — a workspace-scoped read never shares an account-level read's request or value", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, overdueDailyEnabled: true }, source: "account" }))
      .mockResolvedValueOnce(jsonResponse({ settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, overdueDailyEnabled: false }, source: "workspace" }));
    vi.stubGlobal("fetch", fetchMock);

    const [account, workspace] = await Promise.all([
      loadManagerAutomationSettingsCached("mgr-1"),
      loadManagerAutomationSettingsCached("mgr-1", { workspaceId: "ws-1" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("workspaceId=ws-1");
    expect(account.source).toBe("account");
    expect(workspace.source).toBe("workspace");
    expect(account.settings.overdueDailyEnabled).toBe(true);
    expect(workspace.settings.overdueDailyEnabled).toBe(false);
  });

  it("a save's PAYMENT_AUTOMATION_SETTINGS_EVENT invalidates every cached scope, so the next read (any scope) is fresh", async () => {
    const { PAYMENT_AUTOMATION_SETTINGS_EVENT } = await import("@/lib/payment-automation-settings");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, overdueDailyEnabled: true } }))
      .mockResolvedValueOnce(jsonResponse({ settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, overdueDailyEnabled: false } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadManagerAutomationSettingsCached("mgr-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
    const after = await loadManagerAutomationSettingsCached("mgr-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(after.settings.overdueDailyEnabled).toBe(false);
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
    expect(a.settings.overdueDailyEnabled).toBe(true);
    expect(b.settings.overdueDailyEnabled).toBe(false);
  });
});
