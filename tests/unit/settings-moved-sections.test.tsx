// @vitest-environment jsdom
//
// The controls that list-page gear pop-ups used to hold now render as sections of the Settings
// pages those gears link to: Rent & fees on Balance & payouts; Tours, Move-in forms, Screening
// and Vendors on Automations; and a gear's #anchor scrolls its section into view.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/profile",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({
    workspaces: [{ id: "w1", name: "Seattle Homes", owned: true, canManageMembers: true, propertyIds: ["p1"], propertyLabels: { p1: "5257 Brooklyn" } }],
    active: { id: "w1", name: "Seattle Homes", owned: true, canManageMembers: true, propertyIds: ["p1"], propertyLabels: { p1: "5257 Brooklyn" } },
    plan: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    mutate: vi.fn(),
    select: vi.fn(),
  }),
}));
vi.mock("@/components/portal/workspace-settings", () => ({ WorkspaceSettings: () => <div /> }));
vi.mock("@/components/portal/pro-plan", () => ({ ManagerPlan: () => <div /> }));
vi.mock("@/components/portal/portal-change-password-panel", () => ({ PortalChangePasswordPanel: () => <div /> }));
vi.mock("@/components/portal/pro-api-keys-panel", () => ({ ManagerApiKeysPanel: () => <div /> }));
vi.mock("@/components/portal/pro-messaging-settings-panel", () => ({ ManagerMessagingSettingsPanel: () => <div /> }));
vi.mock("@/components/portal/pro-portal-settings-panels", () => ({
  CommunicationSettingsPanel: () => <div />,
  TourSettingsPanel: ({ bare }: { bare?: boolean }) => <div data-testid="tour-settings-panel" data-bare={String(Boolean(bare))} />,
}));
vi.mock("@/components/portal/settings-module-page", () => ({ SettingsModulePage: ({ tab }: { tab: string }) => <div data-testid={`pane-module-${tab}`} /> }));
vi.mock("@/components/portal/manager-sheet-link-panel", () => ({ ManagerSheetLinkPanel: () => <div /> }));
vi.mock("@/components/portal/portal-settings-extras", () => ({ PortalSettingsExtras: () => <div /> }));
vi.mock("@/components/portal/pro-payment-setup-modal", () => ({
  ManagerPaymentSetupPanel: ({ section }: { section: string }) => <div data-testid={`payment-setup-${section}`} />,
}));
vi.mock("@/components/portal/payment-late-fee-settings", () => ({
  PaymentListingLateFeeSettings: () => <div data-testid="late-fee-settings" />,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "u1", ready: true }) }));

import { PortalProfileClient } from "@/components/portal/portal-profile-client";

function renderSettings(search: string) {
  window.history.replaceState(null, "", `/portal/profile${search}`);
  return render(
    <PortalProfileClient variant="manager" portalKind="pro" initialFullName="Alex" initialEmail="alex@example.com" initialPhone="+15105550123" idValue="MGR" idLabel="PropLane ID" />,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Automations holds the sections its gears link to", () => {
  it("renders Tours, Move-in forms, Screening and Vendors with their anchors", async () => {
    const view = renderSettings("?tab=applicationsLeases");
    for (const id of ["tours", "move-in-forms", "screening", "vendors"]) {
      expect(view.container.querySelector(`section#${id}`), id).not.toBeNull();
    }
    const titles = [...view.container.querySelectorAll('section[data-slot="settings-section"] > div h2')].map((h) => h.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Applications", "Leases", "Tours", "Move-in forms", "Screening", "Vendors"]));
    // Tours reuses the existing panel (same storage), drawn bare under the section's own title.
    expect(view.container.querySelector('[data-testid="tour-settings-panel"]')?.getAttribute("data-bare")).toBe("true");
    // Screening is one dropdown over the same /api/screening/settings route.
    await waitFor(() => expect(view.container.querySelector('[data-attr="settings-screening-mode"]')).not.toBeNull());
    // Move-in forms edits one property at a time: no "All properties" entry.
    expect(view.container.querySelector('section#move-in-forms [data-attr="settings-property-scope"]')).not.toBeNull();
    expect(view.container.querySelector('section#move-in-forms [data-attr="settings-move-in-remind"]')).not.toBeNull();
    expect(view.container.querySelector('section#move-in-forms [data-attr="settings-move-in-notify"]')).not.toBeNull();
    // Vendors: one default-vendor dropdown per trade.
    expect(view.container.querySelectorAll('section#vendors [data-attr^="vendor-default-trade-"]').length).toBeGreaterThan(3);
  });

  it("subtext stays out: no sentence under a section title or row", () => {
    const view = renderSettings("?tab=applicationsLeases");
    for (const id of ["tours", "move-in-forms", "screening", "vendors"]) {
      expect(view.container.querySelector(`section#${id} p.text-muted`), id).toBeNull();
    }
  });
});

describe("Balance & payouts holds Rent & fees", () => {
  it("renders payment setup, the processing fee and late fees under #rent-and-fees", () => {
    const view = renderSettings("?tab=payments");
    const section = view.container.querySelector("section#rent-and-fees");
    expect(section).not.toBeNull();
    expect(section!.querySelector('[data-testid="payment-setup-setup"]')).not.toBeNull();
    expect(section!.querySelector('[data-testid="payment-setup-fee"]')).not.toBeNull();
    expect(section!.querySelector('[data-testid="late-fee-settings"]')).not.toBeNull();
    expect(section!.querySelector("h2")?.textContent).toBe("Rent & fees");
  });
});

describe("a gear's anchor scrolls its section into view", () => {
  it("scrolls #tours after the Automations pane mounts", async () => {
    window.history.replaceState(null, "", "/portal/profile?tab=applicationsLeases#tours");
    const view = renderSettings("?tab=applicationsLeases#tours");
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(view.container.querySelector("section#tours")).not.toBeNull();
  });
});
