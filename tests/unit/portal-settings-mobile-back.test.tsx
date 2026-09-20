// @vitest-environment jsdom
/**
 * Defect 3: on `/portal/settings/<tab>` the mobile list↔detail split was local `useState` with
 * no history entry behind it — the URL already names the module (see this route's own doc
 * comment in `portal-settings-section-client.tsx`), so the detail view WAS the page's only
 * history entry. Pressing native/browser Back skipped past the list overlay entirely and left
 * Settings, landing on whatever page preceded it — a broken gesture on the native shells that
 * load this same site.
 *
 * `jsdom` renders every Tailwind breakpoint at once (there is no real viewport/CSS layout), so
 * the mobile-only list/detail markup this suite queries by `data-attr` is present regardless of
 * the width a real browser would need to actually show it — that visual condition is covered by
 * the browser verification, not this suite. What belongs here is the history mechanism: does
 * opening a module push an entry, and does popping it (the in-app control OR a real
 * browser/native Back) land on the module list rather than leaving Settings.
 *
 * `resident` is the tab under test on purpose. Its real Welcome module loads reminder settings,
 * so the harness returns one bounded response and verifies that history changes do not reload it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.hoisted(() => vi.fn());
const managerFixture = vi.hoisted(() => ({ sequence: 0 }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: `mgr-${managerFixture.sequence}` }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));
// This suite owns the standalone page's history layer. The real settings body
// imports every settings panel and its data graph, which can exhaust a bounded
// worker during collection. Keep the actual welcome-rule consumer to verify
// one reminder fetch and no remount/refetch on history changes, without loading
// unrelated module/property-directory consumers.
vi.mock("@/components/portal/settings-module-page", async () => {
  const React = await import("react");
  const { AutomationRuleRows } = await import("@/components/portal/automation-rule-rows");
  return {
    SettingsModulePage: React.forwardRef(function StubSettingsModulePage() {
      return (
        <section data-attr="settings-module-stub">
          <h2>Welcome</h2>
          <AutomationRuleRows rows={[{ kind: "resident_welcome", multi: true }]} />
        </section>
      );
    }),
  };
});
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode, and a hand-listed mock
  // silently breaks every time the module gains an export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { PortalSettingsSectionClient } from "@/components/portal/portal-settings-section-client";

const requestEvidence: { url: string; method: string; caller: string }[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  requestEvidence.push({
    url: String(input),
    method: init?.method ?? "GET",
    // Test-only caller locations, never request headers, cookies or body.
    caller: new Error("Settings request caller").stack?.split("\n").slice(1, 12).join("\n") ?? "unavailable",
  });
  if (String(input) === "/api/portal-pro-relationships") {
    return { ok: true, json: async () => ({ rows: [] }) };
  }
  if (String(input) !== "/api/portal/reminder-settings") throw new Error(`Unexpected settings request: ${String(input)}`);
  return { ok: true, json: async () => ({ settings: {}, overriddenPropertyIds: [] }) };
});

function expectSettingsRequestCounts(expected: { relationships: number; reminders: number }) {
  const reminderRequests = fetchMock.mock.calls.filter(
    ([input]) => String(input) === "/api/portal/reminder-settings",
  );
  const relationshipRequests = fetchMock.mock.calls.filter(
    ([input]) => String(input) === "/api/portal-pro-relationships",
  );
  expect(
    reminderRequests,
    `Reminder request evidence: ${JSON.stringify(requestEvidence, null, 2)}`,
  ).toHaveLength(expected.reminders);
  expect(relationshipRequests).toHaveLength(expected.relationships);
  expect(
    requestEvidence.map(({ url, method }) => ({ url, method })).sort((a, b) => a.url.localeCompare(b.url)),
    JSON.stringify(requestEvidence, null, 2),
  ).toEqual([
      ...Array.from({ length: expected.relationships }, () => ({ url: "/api/portal-pro-relationships", method: "GET" })),
      ...Array.from({ length: expected.reminders }, () => ({ url: "/api/portal/reminder-settings", method: "GET" })),
    ].sort((a, b) => a.url.localeCompare(b.url)));
  expect(fetchMock.mock.calls, JSON.stringify(requestEvidence, null, 2))
    .toHaveLength(expected.relationships + expected.reminders);
}

async function waitForReminderSettingsReady() {
  await waitFor(() => expect(screen.getByRole("switch")).toHaveProperty("disabled", false));
  // One mounted resident settings consumer should issue one bounded request.
  // Include exact call diagnostics if a second caller appears in evidence.
  expectSettingsRequestCounts({ relationships: 0, reminders: 1 });
}

beforeEach(() => {
  managerFixture.sequence += 1;
  requestEvidence.length = 0;
  window.history.replaceState(null, "", window.location.href);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  showToast.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PortalSettingsSectionClient — mobile list↔detail Back (Defect 3)", () => {
  it("pushes a history entry naming the opened module", async () => {
    const pushSpy = vi.spyOn(window.history, "pushState");

    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);

    expect(pushSpy).toHaveBeenCalledWith({ settingsDetailTab: "resident" }, "", expect.any(String));
    await waitForReminderSettingsReady();
  });

  it("popping that entry — the real browser/native Back gesture — shows the module list, not nothing", async () => {
    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);
    await waitForReminderSettingsReady();

    // The detail view is what a phone shows by default: its own back header is present, the
    // list overlay is not.
    expect(document.querySelector('[data-attr="settings-back-to-root"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="settings-open-resident"]')).toBeNull();

    // What the browser actually does on Back: land on the entry BEFORE this component's own
    // push, which carries no `settingsDetailTab` marker at all.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    expect(document.querySelector('[data-attr="settings-open-resident"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="settings-back-to-root"]')).toBeNull();
  });

  it("popping AGAIN from the list (no pushed entry left) is what leaves Settings — a forward navigation restores the detail view", async () => {
    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);

    await waitForReminderSettingsReady();
    const welcomeModule = screen.getByText("Welcome");
    expect(welcomeModule).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(document.querySelector('[data-attr="settings-open-resident"]')).toBeTruthy();
    expect(screen.getByText("Welcome")).toBe(welcomeModule);

    // Forward: the browser re-enters the pushed "detail" entry.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { settingsDetailTab: "resident" } }));
    });

    expect(document.querySelector('[data-attr="settings-back-to-root"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="settings-open-resident"]')).toBeNull();
    expect(screen.getByText("Welcome")).toBe(welcomeModule);
    expectSettingsRequestCounts({ relationships: 0, reminders: 1 });
    expect(showToast).not.toHaveBeenCalled();
  });

  it("the in-app 'Settings' back control hands off to a real history.back(), not only local state", async () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});

    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);
    await waitForReminderSettingsReady();
    fireEvent.click(document.querySelector('[data-attr="settings-back-to-root"]')!);

    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("does not regress desktop — the module content stays mounted regardless of list/detail state", async () => {
    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);
    await waitForReminderSettingsReady();
    // The desktop rail is always present; it does not react to the mobile list/detail toggle.
    expect(document.querySelector('[data-attr="settings-nav-resident"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="settings-nav-tours"]')).toBeTruthy();
    expect(screen.getByText("Welcome")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    // Desktop nav is unaffected by the mobile pop.
    expect(document.querySelector('[data-attr="settings-nav-resident"]')).toBeTruthy();
    expect(screen.getByText("Welcome")).toBeTruthy();
  });
});
