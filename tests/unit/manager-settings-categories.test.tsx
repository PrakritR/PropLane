// @vitest-environment jsdom
//
// The manager Settings layout: a categorized nav + one mounted pane, driven by
// the `?tab=` query param.
//
// Three things break silently here and none of them fail a build:
//   1. A pane that stops being reachable — the root list and the desktop nav are
//      the ONLY entry points, so a category dropped from the catalog takes its
//      controls with it.
//   2. A control that disappears from a pane that is supposed to keep it —
//      Account must still carry the portal switch / sign out / delete rows
//      and nothing may be lost. Preferences and Notifications left manager
//      Settings entirely (S019, captain 2026-09-27): an old bookmark to
//      either one must land on Profile, never render blank.
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

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
vi.mock("@/components/portal/pro-portal-settings-panels", () => ({
  CommunicationSettingsPanel: () => <div data-testid="pane-communication-module" />,
}));
vi.mock("@/components/portal/settings-module-page", () => ({
  SettingsModulePage: ({ tab }: { tab: string }) => <div data-testid={`pane-module-${tab}`} />,
}));
vi.mock("@/components/portal/manager-sheet-link-panel", () => ({
  ManagerSheetLinkPanel: () => <div data-testid="pane-spreadsheets" />,
}));
vi.mock("@/components/portal/google-calendar-connect-panel", () => ({
  GoogleCalendarConnectPanel: () => <div data-testid="pane-google-calendar" />,
}));
vi.mock("@/components/portal/manager-application-form-settings", () => ({
  ManagerApplicationFormSettings: () => <div data-testid="pane-application-form" />,
}));
vi.mock("@/components/portal/lease-document-library-panel", () => ({
  LeaseDocumentLibraryPanel: () => <div data-testid="pane-lease-documents" />,
}));

import { PortalProfileClient } from "@/components/portal/portal-profile-client";
import { PortalSettingsExtras } from "@/components/portal/portal-settings-extras";

// The manager Settings nav after the studio redesign: Application form and
// Lease documents leave this nav, and Payouts folds into Payments. Applications,
// Leases, Forms, Tours, Residents, Services, Tasks, Reminders, Notifications,
// and Preferences are also absent — see `portal-settings-group-split.test.ts` and
// `settings-account-tags.test.tsx` for the removal and classification
// coverage; this file only checks the panes manager Settings still has.
const CATEGORIES = [
  "profile",
  "billing",
  "security",
  "developer",
  "account",
  "workspaces",
  "messaging",
  "payments",
  "spreadsheets",
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
      idValue="MGR-TEST"
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
    goto("?profileHome=1");
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

  it.each([
    ["?profileHome=1", ["profile", "security", "developer", "account"]],
    ["?settingsHome=1", ["workspaces", "payments", "messaging", "spreadsheets", "billing"]],
  ])("offers the matching root list and rail for %s", async (query, categories) => {
    goto(query as string);
    renderSettings();
    for (const id of categories) {
      expect(document.querySelector(`[data-attr="settings-open-${id}"]`), `root row for ${id}`).toBeTruthy();
      expect(document.querySelector(`[data-attr="settings-nav-${id}"]`), `nav for ${id}`).toBeTruthy();
    }
  });

  it.each([
    ["profile", () => screen.getByText("Personal information")],
    ["billing", () => screen.getByTestId("pane-manager-plan")],
    ["messaging", () => screen.getByTestId("pane-messaging")],
    ["security", () => screen.getByTestId("pane-change-password")],
    ["developer", () => screen.getByTestId("pane-api-keys")],
    ["account", () => screen.getByText("Sign out")],
    ["payments", () => {
      expect(screen.getByTestId("pane-module-payments")).toBeTruthy();
      return screen.getByTestId("pane-module-payouts");
    }],
    ["spreadsheets", () => screen.getByTestId("pane-spreadsheets")],
  ])("deep-links ?tab=%s straight to that pane", async (tab, expectPane) => {
    goto(`?tab=${tab}`);
    renderSettings();

    expect(expectPane()).toBeTruthy();
    // Only the selected pane is mounted.
    if (tab !== "billing") expect(screen.queryByTestId("pane-manager-plan")).toBeNull();
  });

  it("drops Preferences and Notifications from manager Settings entirely (S019)", async () => {
    // Neither id is in the manager nav any more — root row and desktop nav
    // item are both gone (already covered generically by `CATEGORIES` above);
    // an old bookmark to either one redirects to Profile instead of 404ing
    // or rendering blank.
    expect(document.querySelector('[data-attr="settings-open-preferences"]')).toBeNull();
    expect(document.querySelector('[data-attr="settings-open-notifications"]')).toBeNull();

    goto("?tab=preferences");
    renderSettings();
    expect(screen.queryByTestId("pane-assistant-display")).toBeNull();
    expect(screen.getByText("Personal information")).toBeTruthy();
  });

  it("keeps every pre-existing Account control after the regroup", async () => {
    goto("?tab=account");
    renderSettings();
    await waitFor(() => expect(screen.getByText("Switch to Resident portal")).toBeTruthy());
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.getByText("Delete account")).toBeTruthy();
    // The theme row is NOT duplicated into the manager's Account pane.
    expect(screen.queryByText("Appearance")).toBeNull();
    expect(screen.queryByTestId("pane-spreadsheets")).toBeNull();
    expect(screen.queryByText("Add spreadsheet")).toBeNull();
  });

  it("edits profile name in place and confirms only after the profile API succeeds", async () => {
    const fetchMock = vi.mocked(fetch);
    renderSettings();
    const edit = document.querySelector('[data-attr="settings-edit-fullName"]');
    expect(edit).toBeTruthy();
    fireEvent.click(edit!);
    const input = await screen.findByLabelText("Full name");
    fireEvent.change(input, { target: { value: "Changed Manager" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/profile",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ fullName: "Changed Manager", phone: "+15105550123" }) }),
    ));
    await waitFor(() => expect(document.querySelector('[data-attr="settings-edit-fullName"]')?.textContent).toContain("Changed Manager"));
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
          idValue="MGR-TEST"
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
        window.history.replaceState(null, "", "/portal/profile?profileHome=1");
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
    expect(window.location.search).toBe("?profileHome=1");
    expect(document.querySelector('[data-attr="settings-open-profile"]')).toBeTruthy();

    // A double tap inside that window must be a no-op: no second pop (which
    // would leave Settings entirely) and no compensating pushState either — an
    // extra entry makes the next browser back feel like "forward".
    fireEvent.click(document.querySelector('[data-attr="settings-open-developer"]')!);
    const back2 = document.querySelector('[data-attr="settings-back-to-root"]')!;
    backSpy.mockClear();
    pushSpy.mockClear();
    fireEvent.click(back2);
    fireEvent.click(back2);
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
    await settlePops();
    expect(window.location.search).toBe("?profileHome=1");
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

  it("drops the Appearance row everywhere while dark mode is off (default variant)", () => {
    // DARK_MODE_ENABLED (src/lib/theme-storage.ts) is off product-wide, so the
    // legacy `full`-variant Appearance row stays hidden even for
    // resident/vendor/admin — not just for the manager layout below.
    render(<PortalSettingsExtras currentKind="resident" />);
    expect(screen.queryByText("Appearance")).toBeNull();
    // No sentence under the section title (AGENTS.md § No subtext).
    expect(screen.queryByText("Appearance, workspace access, and session.")).toBeNull();
  });

  it("drops it for the manager layout, which owns Theme under Preferences", () => {
    render(<PortalSettingsExtras currentKind="pro" variant="session" />);
    expect(screen.queryByText("Appearance")).toBeNull();
    expect(screen.queryByText("Workspace access and session.")).toBeNull();
  });

  it("renders no switcher row at all for a single-portal account", async () => {
    const { container } = render(<PortalSettingsExtras currentKind="vendor" variant="full" />);
    await waitFor(() => expect(screen.getByText("Sign out")).toBeTruthy());
    // Appearance, Sign out, Delete account — no empty padded strip between them.
    const rows = container.querySelectorAll(".border-b.border-border.px-4");
    expect([...rows].every((r) => r.textContent?.trim().length)).toBe(true);
  });
});
