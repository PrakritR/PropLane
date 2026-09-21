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
 * `resident` is the tab under test on purpose — `ResidentSettingsPanel` makes no network calls
 * and has no loading state, so this suite exercises the history/back contract without also
 * having to stub a module's fetch surface.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1" }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));
// This suite owns the standalone page's history layer. The real settings body
// imports every settings panel and its data graph, which adds no behavior to
// these assertions and can exhaust a bounded unit-test worker during module
// collection.
vi.mock("@/components/portal/settings-module-page", async () => {
  const React = await import("react");
  return {
    SettingsModulePage: React.forwardRef(function StubSettingsModulePage() {
      return <div data-attr="settings-module-stub" />;
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PortalSettingsSectionClient — mobile list↔detail Back (Defect 3)", () => {
  it("pushes a history entry naming the opened module", () => {
    const pushSpy = vi.spyOn(window.history, "pushState");

    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);

    expect(pushSpy).toHaveBeenCalledWith({ settingsDetailTab: "resident" }, "", expect.any(String));
  });

  it("popping that entry — the real browser/native Back gesture — shows the module list, not nothing", async () => {
    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);

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

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(document.querySelector('[data-attr="settings-open-resident"]')).toBeTruthy();

    // Forward: the browser re-enters the pushed "detail" entry.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { settingsDetailTab: "resident" } }));
    });

    expect(document.querySelector('[data-attr="settings-back-to-root"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="settings-open-resident"]')).toBeNull();
  });

  it("the in-app 'Settings' back control hands off to a real history.back(), not only local state", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});

    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);
    fireEvent.click(document.querySelector('[data-attr="settings-back-to-root"]')!);

    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("does not regress desktop — the module content stays mounted regardless of list/detail state", async () => {
    render(<PortalSettingsSectionClient tab="resident" basePath="/portal" />);
    // The desktop rail is always present; it does not react to the mobile list/detail toggle.
    expect(document.querySelector('[data-attr="settings-nav-resident"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="settings-nav-tours"]')).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    // Desktop nav is unaffected by the mobile pop.
    expect(document.querySelector('[data-attr="settings-nav-resident"]')).toBeTruthy();
  });
});
