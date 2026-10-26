// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceShellData } from "@/lib/service/service-mode";

const showToast = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => "/portal/dashboard",
}));
vi.mock("@/components/portal/workspace-provider", () => ({ useWorkspaces: () => null }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "u1", email: "a@example.com", ready: true }) }));
vi.mock("@/components/portal/portal-help-panel", () => ({ PortalHelpPanel: () => null }));
vi.mock("@/components/layout/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/portal/portal-role-switcher", () => ({
  PortalRoleSwitcher: ({ currentKind }: { currentKind: string }) => <button type="button">{`Switch to Admin portal (${currentKind})`}</button>,
}));
vi.mock("@/components/portal/portal-sign-out-button", () => ({ PortalSignOutButton: () => null }));
vi.mock("@/components/portal/admin-new-service-workspace", () => ({
  AdminNewServiceWorkspace: ({ open, onCreated }: { open: boolean; onCreated: (id: string, name: string) => void }) =>
    open ? (
      <button type="button" onClick={() => onCreated("new-ws", "Maya")}>
        create-new
      </button>
    ) : null,
}));

import { PortalWorkspaceRail } from "@/components/portal/portal-workspace-rail";

const AMBIKA = { id: "ws-ambika", name: "Ambika", city: "Seattle" };
const VINOD = { id: "ws-vinod", name: "Vinod", city: "Seattle" };

function shell(over: Partial<ServiceShellData> = {}): ServiceShellData {
  return { workspaces: [AMBIKA, VINOD], isAdmin: true, activeId: null, propertyPortalWorkspaceId: null, ...over };
}

function openAccountMenu() {
  const trigger = screen.getByRole("button", { name: "Account menu" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  showToast.mockClear();
  refresh.mockClear();
});

describe("the service rail", () => {
  it("admin portal: PropLane logo first, then Ambika and Vinod, then the +", () => {
    render(<PortalWorkspaceRail kind="admin" basePath="/admin" name="Prakrit" email="p@example.com" service={shell()} />);
    const nav = screen.getByRole("navigation", { name: "Workspaces" });
    const order = Array.from(nav.querySelectorAll("[data-attr]"))
      .map((el) => el.getAttribute("data-attr"))
      .filter((attr) => attr?.startsWith("portal-rail"));
    expect(order).toEqual(["portal-rail-brand", "portal-rail-service-workspace", "portal-rail-service-workspace", "portal-rail-new-service-workspace"]);
    expect(screen.getByRole("link", { name: "PropLane software overview" }).getAttribute("href")).toBe("/admin/dashboard");
    expect(screen.getByRole("link", { name: "PropLane software overview" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Open Ambika · Seattle" }).textContent).toBe("AM");
  });

  it("service mode: the open workspace is the active tile, the logo is no longer current", () => {
    render(<PortalWorkspaceRail kind="pro" basePath="/portal" name="P" email="p@example.com" service={shell({ activeId: VINOD.id })} />);
    expect(screen.getByRole("button", { name: "Open Vinod · Seattle" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Open Ambika · Seattle" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: "PropLane software overview" }).getAttribute("aria-current")).toBeNull();
    // The Property portal's own tiles and create/join are gone in service mode.
    expect(document.querySelector('[data-attr="portal-rail-workspace"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Create or join a workspace" })).toBeNull();
  });

  it("a helper sees only their workspaces: no logo, no +", () => {
    render(<PortalWorkspaceRail kind="pro" basePath="/portal" name="H" email="h@example.com" service={shell({ isAdmin: false, workspaces: [VINOD], activeId: VINOD.id })} />);
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "PropLane software overview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New PropLane Service workspace" })).toBeNull();
  });

  it("a tile runs the admin open (cookie), makes the manager portal active, then lands on that dashboard", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, href: "/portal/dashboard" }) });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<PortalWorkspaceRail kind="admin" basePath="/admin" name="P" email="p@example.com" service={shell()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Ambika · Seattle" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/portal/dashboard"));
    const calls = fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))]);
    expect(calls).toEqual([
      ["/api/admin/service-workspaces", { action: "open", id: AMBIKA.id }],
      ["/api/auth/set-active-portal", { role: "manager", keepWorkspace: true }],
    ]);
  });

  it("a helper's tile uses the ordinary workspace switch, not the admin route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<PortalWorkspaceRail kind="pro" basePath="/portal" name="H" email="h@example.com" service={shell({ isAdmin: false, workspaces: [VINOD, AMBIKA], activeId: VINOD.id })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Ambika · Seattle" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/portal/dashboard"));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/workspaces");
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ action: "select", id: AMBIKA.id });
  });

  it("the + opens the new service workspace flow, refreshes the rail and opens the new one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, href: "/portal/dashboard" }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    render(<PortalWorkspaceRail kind="admin" basePath="/admin" name="P" email="p@example.com" service={shell()} />);
    fireEvent.click(screen.getByRole("button", { name: "New PropLane Service workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "create-new" }));
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ action: "open", id: "new-ws" }));
  });

  it("a failed open says so instead of navigating", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Ask a teammate of this workspace to add you to its team first." }) }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<PortalWorkspaceRail kind="admin" basePath="/admin" name="P" email="p@example.com" service={shell()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Vinod · Seattle" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Ask a teammate of this workspace to add you to its team first."));
    expect(assign).not.toHaveBeenCalled();
  });

  it("a helper in service mode keeps their way back: the rail has no PropLane tile for them", () => {
    render(
      <PortalWorkspaceRail
        kind="pro"
        basePath="/portal"
        name="P"
        email="p@example.com"
        service={shell({ isAdmin: false, activeId: VINOD.id, propertyPortalWorkspaceId: "mine" })}
      />,
    );
    expect(document.querySelector('[data-attr="portal-rail-brand"]')).toBeNull();
    openAccountMenu();
    expect(document.querySelector('[data-attr="portal-account-switch-property"]')).toBeTruthy();
  });

  it("a helper with no workspace of their own gets no Property portal row", () => {
    render(
      <PortalWorkspaceRail kind="pro" basePath="/portal" name="P" email="p@example.com" service={shell({ isAdmin: false, activeId: VINOD.id })} />,
    );
    openAccountMenu();
    expect(document.querySelector('[data-attr="portal-account-switch-property"]')).toBeNull();
  });

  it("admin service mode: the account menu is only Settings, Help & feedback, Sign out (no switch-portal rows)", () => {
    // An admin's way out is the rail's PropLane tile, so the menu keeps nothing but the three rows.
    render(<PortalWorkspaceRail kind="pro" basePath="/portal" name="P" email="p@example.com" service={shell({ activeId: VINOD.id, propertyPortalWorkspaceId: "mine" })} />);
    openAccountMenu();
    const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')).map((el) => el.textContent?.trim());
    expect(items).toEqual(["Settings", "Help & feedback"]);
    expect(screen.queryByText("Switch to Property portal")).toBeNull();
    expect(screen.queryByText(/Switch to .* portal/)).toBeNull();
    expect(document.querySelector('[data-attr="portal-account-switch-property"]')).toBeNull();
  });

  it("admin home (no workspace open): Settings is the first item and the switch rows stay", () => {
    render(<PortalWorkspaceRail kind="admin" basePath="/admin" name="P" email="p@example.com" service={shell()} />);
    openAccountMenu();
    const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')).map((el) => el.textContent?.trim());
    expect(items[0]).toBe("Settings");
    expect(items).toContain("Switch to Admin portal (admin)");
    expect(items).toContain("Help & feedback");
  });

  it("a helper in the Property portal reaches their service workspace from the account menu", () => {
    render(<PortalWorkspaceRail kind="pro" basePath="/portal" name="H" email="h@example.com" serviceEntries={[VINOD]} />);
    openAccountMenu();
    expect(screen.getByText("Open Vinod")).toBeTruthy();
  });
});
