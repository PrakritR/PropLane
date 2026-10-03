// @vitest-environment jsdom
//
// Settings is one place (captain, 2026-10-03, C2-CP1..CP5): the avatar menu has a
// single Settings row; the nav has PROFILE (Profile, Login & security, API & MCP,
// Account, Billing & plan) and WORKSPACE (Workspace, Balance & payouts,
// Communication, Integrations) groups; Settings follows the workspace picked in the
// sidebar switcher and shows its name read-only instead of carrying a switcher.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    workspaces: [{ id: "w1", name: "Seattle Homes", owned: true, canManageMembers: true, propertyIds: [] }],
    active: { id: "w1", name: "Seattle Homes", owned: true, canManageMembers: true, propertyIds: [] },
    plan: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    mutate: vi.fn(),
    select: vi.fn(),
  }),
}));
vi.mock("@/components/portal/workspace-settings", () => ({ WorkspaceSettings: () => <div data-testid="pane-workspace" /> }));
vi.mock("@/components/portal/pro-plan", () => ({ ManagerPlan: () => <div data-testid="pane-plan" /> }));
vi.mock("@/components/portal/portal-change-password-panel", () => ({ PortalChangePasswordPanel: () => <div /> }));
vi.mock("@/components/portal/pro-api-keys-panel", () => ({ ManagerApiKeysPanel: () => <div /> }));
vi.mock("@/components/portal/pro-messaging-settings-panel", () => ({ ManagerMessagingSettingsPanel: () => <div /> }));
vi.mock("@/components/portal/pro-portal-settings-panels", () => ({ CommunicationSettingsPanel: () => <div /> }));
vi.mock("@/components/portal/settings-module-page", () => ({ SettingsModulePage: ({ tab }: { tab: string }) => <div data-testid={`pane-module-${tab}`} /> }));
vi.mock("@/components/portal/manager-sheet-link-panel", () => ({ ManagerSheetLinkPanel: () => <div /> }));
vi.mock("@/components/portal/portal-settings-extras", () => ({ PortalSettingsExtras: () => <div /> }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "u1", ready: true }) }));

import { PortalProfileClient } from "@/components/portal/portal-profile-client";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function renderSettings() {
  return render(
    <PortalProfileClient variant="manager" portalKind="pro" initialFullName="Alex" initialEmail="alex@example.com" initialPhone="+15105550123" idValue="MGR" idLabel="PropLane ID" />,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/portal/profile?tab=profile");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings is one place", () => {
  it("orders the rail as PROFILE then WORKSPACE, Billing & plan in Profile", () => {
    renderSettings();
    const nav = document.querySelector('nav[aria-label="Settings sections"]')!;
    const order = [...nav.querySelectorAll("[data-attr]")].map((el) => el.getAttribute("data-attr"));
    expect(order).toEqual([
      "settings-group-profile",
      "settings-nav-profile",
      "settings-nav-security",
      "settings-nav-developer",
      "settings-nav-account",
      "settings-nav-billing",
      "settings-group-workspace",
      "settings-workspace-name",
      "settings-nav-workspaces",
      "settings-nav-payments",
      "settings-nav-applicationsLeases",
      "settings-nav-messaging",
      "settings-nav-spreadsheets",
    ]);
    const labels = (id: string) => nav.querySelector(`[data-attr="${id}"]`)?.textContent;
    expect(labels("settings-group-profile")).toBe("Profile");
    expect(labels("settings-group-workspace")).toBe("Workspace");
    expect(labels("settings-nav-payments")).toBe("Balance & payouts");
    expect(labels("settings-nav-billing")).toBe("Billing & plan");
  });

  it("shows the sidebar's workspace read-only: a name, not a switcher", () => {
    renderSettings();
    const name = document.querySelector('[data-attr="settings-workspace-name"]')!;
    expect(name.textContent).toContain("Seattle Homes");
    expect(name.querySelector("button, [role=combobox], svg.lucide-chevron-down")).toBeNull();
    expect(document.querySelector('[data-attr="workspace-switcher"], [data-attr="workspace-switcher-item"]')).toBeNull();
  });

  it("titles the Workspace pane 'Workspace settings' and the payouts pane 'Balance & payouts'", () => {
    window.history.replaceState(null, "", "/portal/profile?tab=workspaces");
    const view = renderSettings();
    expect(view.container.querySelector('[data-attr="settings-layout"] h1')?.textContent).toBe("Workspace settings");
    cleanup();
    window.history.replaceState(null, "", "/portal/profile?tab=payments");
    const payments = renderSettings();
    expect(payments.container.querySelector('[data-attr="settings-layout"] h1')?.textContent).toBe("Balance & payouts");
  });

  it("has no Profile row in either avatar menu — one Settings row", () => {
    for (const file of ["src/components/portal/portal-top-bar.tsx", "src/components/portal/portal-mobile-nav-bar.tsx"]) {
      const src = read(file);
      expect(src).not.toContain("profileHome=1");
      expect(src).not.toContain("settingsHome=1");
      expect(src).not.toMatch(/portal-(top-bar|mobile)-profile"/);
    }
    expect(read("src/components/portal/portal-top-bar.tsx")).toContain("portal-top-bar-settings");
  });

  it("keeps Settings open when the sidebar switcher changes workspace", () => {
    const src = read("src/components/portal/workspace-switcher.tsx");
    expect(src).toContain("inSettings ? { href: false }");
    expect(read("src/components/portal/portal-profile-client.tsx")).not.toContain("<WorkspaceSwitcher");
  });
});

describe("Defaults for properties is gone (C2-CP5)", () => {
  it("has no page file and no entry point", () => {
    expect(existsSync(join(process.cwd(), "src/components/portal/workspace-pricing-defaults-panel.tsx"))).toBe(false);
    const payments = read("src/components/portal/pro-payments.tsx");
    expect(payments).not.toContain("Defaults for properties");
    expect(payments).not.toContain("tab=defaults");
    expect(read("src/components/portal/pro-portal-settings-panels.tsx")).not.toContain("WorkspacePricingDefaultsPanel");
  });
});
