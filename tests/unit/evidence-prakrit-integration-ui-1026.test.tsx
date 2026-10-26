// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the four surfaces of the Prakrit integration change, rendered for a reviewer screenshot:
// the Service fee split card (admin-editable and read-only), the Service invite sheet with the Owner role, Settings >
// Profile > Phone (Verify, then the code row), and the ADMIN account menu with Settings first.
// Set EVIDENCE_DIR to write each surface's HTML next to the generated app.css.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeEvidenceSurface } from "../helpers/evidence-dom";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/components/ui/modal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/modal")>()),
  useModalPresentation: () => "dialog",
}));
vi.mock("@/lib/shared-get-cache", () => ({
  sharedGet: vi.fn(async () => ({ ok: true, data: { enabled: false } })),
}));
vi.mock("@/components/layout/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/portal/portal-role-switcher", () => ({
  PortalRoleSwitcher: () => (
    <div className="px-[9px] py-[7px] text-[14px] text-foreground" data-attr="portal-role-switcher-stub">Switch to Property portal</div>
  ),
}));
vi.mock("@/components/portal/portal-sign-out-button", () => ({
  PortalSignOutButton: ({ className }: { className?: string }) => (
    <button type="button" className={className}>Sign out</button>
  ),
}));
vi.mock("@/components/portal/portal-read-only-context", () => ({ usePortalReadOnly: () => false }));
// Panels the Settings layout only slots in; their internals are covered by their own suites.
vi.mock("@/components/portal/pro-plan", () => ({ ManagerPlan: () => <div /> }));
vi.mock("@/components/portal/portal-change-password-panel", () => ({ PortalChangePasswordPanel: () => <div /> }));
vi.mock("@/components/portal/portal-bug-feedback-panel", () => ({ PortalBugFeedbackPanel: () => <div /> }));
vi.mock("@/components/native/notifications-toggle", () => ({ NotificationsToggle: () => <div /> }));
vi.mock("@/components/portal/assistant-display-setting", () => ({ AssistantDisplaySetting: () => <div /> }));
vi.mock("@/components/portal/pro-api-keys-panel", () => ({ ManagerApiKeysPanel: () => <div /> }));
vi.mock("@/components/portal/pro-messaging-settings-panel", () => ({ ManagerMessagingSettingsPanel: () => <div /> }));
vi.mock("@/components/portal/pro-portal-settings-panels", () => ({ CommunicationSettingsPanel: () => <div /> }));
vi.mock("@/components/portal/settings-module-page", () => ({ SettingsModulePage: () => <div /> }));
vi.mock("@/components/portal/manager-integrations-panel", () => ({
  INTEGRATIONS_TAB_PARAM: "integration",
  ManagerIntegrationsPanel: () => <div />,
}));
vi.mock("@/components/portal/google-calendar-connect-panel", () => ({ GoogleCalendarConnectPanel: () => <div /> }));
vi.mock("@/components/portal/manager-application-form-settings", () => ({ ManagerApplicationFormSettings: () => <div /> }));
vi.mock("@/components/portal/lease-document-library-panel", () => ({ LeaseDocumentLibraryPanel: () => <div /> }));

import { ServiceFeeSplitCard } from "@/components/portal/service-fee-split-card";
import { ServiceInviteSheet } from "@/components/portal/service-invite-sheet";
import { PortalProfileClient } from "@/components/portal/portal-profile-client";
import { PortalAccountMenu } from "@/components/portal/portal-account-menu";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const WS = "11111111-1111-4111-8111-111111111111";
const CHALLENGE = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/portal/profile?tab=profile");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("evidence: Service fee split card", () => {
  function stubView(view: unknown) {
    vi.stubGlobal("fetch", vi.fn(async () => json(view)));
  }

  it("platform admin sees the editable split", async () => {
    stubView({ split: { feePercent: 10, version: 2, since: "2026-10-20" }, canEdit: true, viewerIsOwnerOfRecord: false });
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    const input = (await screen.findByLabelText("PropLane percent")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("10"));
    expect(screen.getByText("Version 2 · since Oct 20, 2026")).toBeTruthy();
    expect(screen.getByText("On $1,000 rent: PropLane $100 · Owner $900")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    writeEvidenceSurface("fee-split-admin-editable", "Settings > Balance & payouts: PropLane Service fee split, platform admin (editable)");
  });

  it("owner of record sees a read-only one-liner", async () => {
    stubView({ split: { feePercent: 10, version: 2, since: "2026-10-20" }, canEdit: false, viewerIsOwnerOfRecord: true });
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(screen.queryByLabelText("PropLane percent")).toBeNull());
    await waitFor(() => expect(document.body.textContent ?? "").toContain("10%"));
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    writeEvidenceSurface("fee-split-owner-readonly", "Settings > Balance & payouts: PropLane Service fee split, owner/seat (read-only)");
  });
});

describe("evidence: Service invite sheet", () => {
  it("opens with the Owner role selected", async () => {
    const workspace = {
      id: "ws-1", name: "Ambika", propertyIds: ["h1", "h2"],
      propertyLabels: { h1: "5257 Brooklyn Ave", h2: "5259 Brooklyn Ave" },
    } as unknown as PortalWorkspace;
    render(<ServiceInviteSheet open workspace={workspace} member={null} onClose={vi.fn()} onChanged={vi.fn()} />);
    const email = await screen.findByPlaceholderText("Email or PropLane ID");
    fireEvent.change(email, { target: { value: "owner@example.com" } });
    expect(document.querySelector('[data-attr="service-invite-houses"]')).toBeTruthy();
    writeEvidenceSurface("service-invite-sheet-viewer", "Service team invite sheet (default Viewer role, per-module permissions)", 120);
    fireEvent.click(document.querySelector('[data-attr="service-invite-role"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("option", { name: "Owner" }));
    expect(document.querySelector('[data-attr="service-invite-houses"]')).toBeNull();
    expect((screen.getByRole("button", { name: "Send invite" }) as HTMLButtonElement).disabled).toBe(false);
    writeEvidenceSurface("service-invite-sheet-owner", "Service team invite sheet with the Owner role selected (no houses, view-only capabilities)", 120);
  });
});

describe("evidence: Profile phone verify", () => {
  function renderProfile() {
    return render(
      <PortalProfileClient
        variant="manager"
        portalKind="pro"
        initialFullName="Test Manager"
        initialEmail="manager@example.com"
        initialPhone="+15103098345"
        initialPhoneVerified={false}
        idValue="MGR-TEST"
        idLabel="PropLane ID"
      />,
    );
  }
  it("shows the unverified Verify button, then the code row", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, "https://proplane.test").pathname.startsWith("/api/auth/phone/")) return json({ challengeId: CHALLENGE });
      return json({ roles: ["manager"] });
    }));
    renderProfile();
    expect(screen.getByText("+1 (510) 309-8345 · Not verified")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
    writeEvidenceSurface("profile-phone-unverified", "Settings > Profile > Phone: unverified, Verify button");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    const code = await screen.findByLabelText("6-digit code");
    fireEvent.change(code, { target: { value: "123456" } });
    expect(screen.getByText("Code sent to +1 (510) 309-8345")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
    writeEvidenceSurface("profile-phone-code-entry", "Settings > Profile > Phone: code entry after Verify");
  });
});

describe("evidence: admin account menu", () => {
  it("shows Settings as the first item", async () => {
    render(
      <div style={{ paddingTop: 8 }}>
        <PortalAccountMenu kind="admin" basePath="/admin" name="Pat Admin" email="pat@example.com" onOpenHelp={vi.fn()} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu" }), { button: 0 });
    await screen.findByText("Settings");
    const labels = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')).map((el) => el.textContent?.trim());
    expect(labels[0]).toBe("Settings");
    expect(labels.slice(-2)).toEqual(["Help & feedback", "Sign out"]);
    writeEvidenceSurface("admin-account-menu", "ADMIN portal account menu, open: Settings is the first item", 120);
  });
});
