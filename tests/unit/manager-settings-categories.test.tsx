// @vitest-environment jsdom
//
// The manager Settings layout: a categorized nav + one mounted pane, driven by
// the `?tab=` query param.
//
// Three things break silently here and none of them fail a build:
//   1. A pane that stops being reachable — the root list and the desktop nav are
//      the ONLY entry points, so a category dropped from the catalog takes its
//      controls with it.
//   2. A control that disappears in the regroup. Every pre-existing setting had
//      to survive the split: the theme toggle moved from the Account section to
//      Preferences (row label "Theme"), so Account must still carry the portal
//      switch / sign out / delete rows and nothing may be lost in between.
//   3. Back. The category push is `history.pushState`, so the in-page chevron
//      and the browser/gesture back have to land on the SAME root list — and a
//      double-tap on the chevron must not pop past Settings out of the portal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// `useSearchParams` must reflect what `history.pushState` just wrote, the way
// Next syncs it in the browser — that sync IS the mechanism under test.
let notifyNav: () => void = () => {};
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

// Panels the Settings layout only slots in; their internals are covered by
// their own suites. Stubbed so this test fails on composition, not on fetch.
vi.mock("@/components/portal/pro-plan", () => ({
  ManagerPlan: () => <div data-testid="pane-manager-plan" />,
}));
vi.mock("@/components/portal/portal-change-password-panel", () => ({
  PortalChangePasswordPanel: () => <div data-testid="pane-change-password" />,
}));
vi.mock("@/components/portal/portal-bug-feedback-panel", () => ({
  PortalBugFeedbackPanel: () => <div data-testid="pane-bug-feedback" />,
}));
vi.mock("@/components/native/notifications-toggle", () => ({
  NotificationsToggle: () => <div data-testid="pane-notifications" />,
}));
vi.mock("@/components/portal/assistant-display-setting", () => ({
  AssistantDisplaySetting: () => <div data-testid="pane-assistant-display" />,
}));
vi.mock("@/components/portal/pro-api-keys-panel", () => ({
  ManagerApiKeysPanel: () => <div data-testid="pane-api-keys" />,
}));
vi.mock("@/components/portal/pro-messaging-settings-panel", () => ({
  ManagerMessagingSettingsPanel: () => <div data-testid="pane-messaging" />,
}));

import { PortalProfileClient } from "@/components/portal/portal-profile-client";
import { PortalSettingsExtras } from "@/components/portal/portal-settings-extras";

const CATEGORIES = [
  "profile",
  "billing",
  "messaging",
  "preferences",
  "security",
  "developer",
  "feedback",
  "account",
] as const;

function goto(search: string) {
  window.history.replaceState(null, "", `/portal/profile${search}`);
}

function renderSettings() {
  return render(
    <PortalProfileClient
      variant="manager"
      portalKind="pro"
      initialFullName="Test Manager"
      initialEmail="manager@example.com"
      initialPhone="+15105550123"
      axisId="MGR-TEST"
      idLabel="PropLane ID"
    />,
  );
}

/** A rendered `pushState` has to re-render the tree, like Next does. */
function installHistorySync() {
  const push = window.history.pushState.bind(window.history);
  return vi.spyOn(window.history, "pushState").mockImplementation((state, title, url) => {
    push(state, title as string, url as string | URL);
    act(() => notifyNav());
  });
}

describe("manager settings categories", () => {
  beforeEach(() => {
    // jsdom has no layout, so the pane-change scroll reset is a no-op here.
    Element.prototype.scrollIntoView = vi.fn();
    goto("");
    // `/api/auth/portal-roles` — what the Account pane's switch rows come from.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ roles: ["manager", "resident"] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers every category from the root list and the desktop nav", async () => {
    renderSettings();

    for (const id of CATEGORIES) {
      expect(document.querySelector(`[data-attr="settings-open-${id}"]`), `root row for ${id}`).toBeTruthy();
      expect(document.querySelector(`[data-attr="settings-nav-${id}"]`), `desktop nav item for ${id}`).toBeTruthy();
    }
    // With no `?tab=`, the root list is what a phone shows and Profile is the
    // pane a desktop defaults to.
    expect(screen.getByText("Personal information")).toBeTruthy();
  });

  it.each([
    ["profile", () => screen.getByText("Personal information")],
    ["billing", () => screen.getByTestId("pane-manager-plan")],
    ["messaging", () => screen.getByTestId("pane-messaging")],
    ["preferences", () => screen.getByText("Theme")],
    ["security", () => screen.getByTestId("pane-change-password")],
    ["developer", () => screen.getByTestId("pane-api-keys")],
    ["feedback", () => screen.getByTestId("pane-bug-feedback")],
    ["account", () => screen.getByText("Sign out")],
  ])("deep-links ?tab=%s straight to that pane", async (tab, expectPane) => {
    goto(`?tab=${tab}`);
    renderSettings();

    expect(expectPane()).toBeTruthy();
    // Only the selected pane is mounted.
    if (tab !== "billing") expect(screen.queryByTestId("pane-manager-plan")).toBeNull();
  });

  it("keeps every pre-existing control after the regroup", async () => {
    // Theme moved out of Account into Preferences, renamed to avoid an
    // "Appearance" section holding an "Appearance" row.
    goto("?tab=preferences");
    const prefs = renderSettings();
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.getByTestId("pane-assistant-display")).toBeTruthy();
    expect(screen.getByTestId("pane-notifications")).toBeTruthy();
    prefs.unmount();

    // …and nothing else left Account with it.
    goto("?tab=account");
    renderSettings();
    await waitFor(() => expect(screen.getByText("Switch to Resident portal")).toBeTruthy());
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.getByText("Delete account")).toBeTruthy();
    // The theme row is NOT duplicated into the manager's Account pane.
    expect(screen.queryByText("Appearance")).toBeNull();
  });

  it("returns to the root list from the back chevron and from browser back", async () => {
    const view = renderSettings();
    // Re-render through the real component so the mocked navigation hooks
    // re-read `window.location`, the way Next re-renders on a pushState.
    notifyNav = () => {
      view.rerender(
        <PortalProfileClient
          variant="manager"
          portalKind="pro"
          initialFullName="Test Manager"
          initialEmail="manager@example.com"
          initialPhone="+15105550123"
          axisId="MGR-TEST"
          idLabel="PropLane ID"
        />,
      );
    };
    const pushSpy = installHistorySync();

    fireEvent.click(document.querySelector('[data-attr="settings-open-security"]')!);
    expect(window.location.search).toBe("?tab=security");
    const back = document.querySelector('[data-attr="settings-back-to-root"]');
    expect(back, "detail view renders the standard back header").toBeTruthy();

    // The chevron unwinds the entry it pushed rather than appending one.
    // `popstate` lands on a LATER task in a real browser, which is the whole
    // window a double tap fits into — so resolve it asynchronously here.
    const popped: Array<() => void> = [];
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {
      popped.push(() => {
        window.history.replaceState(null, "", "/portal/profile");
        act(() => window.dispatchEvent(new PopStateEvent("popstate")));
        act(() => notifyNav());
      });
    });
    const settlePops = async () => {
      await act(async () => {
        while (popped.length) popped.shift()!();
      });
    };

    fireEvent.click(back!);
    await settlePops();
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("");
    expect(document.querySelector('[data-attr="settings-open-profile"]')).toBeTruthy();

    // A double tap inside that window must be a no-op: no second pop (which
    // would leave Settings entirely) and no compensating pushState either — an
    // extra entry makes the next browser back feel like "forward".
    fireEvent.click(document.querySelector('[data-attr="settings-open-feedback"]')!);
    const back2 = document.querySelector('[data-attr="settings-back-to-root"]')!;
    backSpy.mockClear();
    pushSpy.mockClear();
    fireEvent.click(back2);
    fireEvent.click(back2);
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
    await settlePops();
    expect(window.location.search).toBe("");
    expect(document.querySelector('[data-attr="settings-open-profile"]')).toBeTruthy();
  });
});

describe("PortalSettingsExtras variants", () => {
  beforeEach(() => {
    // A single-portal account: the only role it holds is the one it is in.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ roles: ["vendor"] }), { status: 200 })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the legacy Appearance row for resident/vendor/admin (default variant)", () => {
    render(<PortalSettingsExtras currentKind="resident" />);
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Appearance, workspace access, and session.")).toBeTruthy();
  });

  it("drops it for the manager layout, which owns Theme under Preferences", () => {
    render(<PortalSettingsExtras currentKind="pro" variant="session" />);
    expect(screen.queryByText("Appearance")).toBeNull();
    expect(screen.getByText("Workspace access and session.")).toBeTruthy();
  });

  it("renders no switcher row at all for a single-portal account", async () => {
    const { container } = render(<PortalSettingsExtras currentKind="vendor" variant="full" />);
    await waitFor(() => expect(screen.getByText("Sign out")).toBeTruthy());
    // Appearance, Sign out, Delete account — no empty padded strip between them.
    const rows = container.querySelectorAll(".border-b.border-border.px-4");
    expect([...rows].every((r) => r.textContent?.trim().length)).toBe(true);
  });
});
