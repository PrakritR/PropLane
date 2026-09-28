// @vitest-environment jsdom
//
// C004: Settings lives only in the avatar/account menu (never the sidebar).
//
// S001 (captain, 2026-09-27): Billing & plan, the Switch workspace submenu,
// and Help were dropped from this desktop menu — it already matched the
// phone menu's shorter shape. Workspace switching stays reachable from the
// sidebar's own WorkspaceSwitcher, and Help from the sidebar's pinned footer
// link; this menu keeps only Settings, Appearance, the role switcher, and
// Sign out.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceContextValue } from "@/components/portal/workspace-provider";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const workspaceCtx: { value: WorkspaceContextValue | null } = { value: null };
vi.mock("@/components/portal/workspace-provider", () => ({ useWorkspaces: () => workspaceCtx.value }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));

vi.mock("@/components/layout/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/portal/portal-role-switcher", () => ({
  PortalRoleSwitcher: () => <div data-attr="portal-role-switcher-stub" />,
}));
vi.mock("@/components/portal/portal-sign-out-button", () => ({
  PortalSignOutButton: ({ className }: { className?: string }) => (
    <button type="button" className={className}>
      Sign out
    </button>
  ),
}));
vi.mock("@/components/portal/axis-assistant", () => ({
  useAxisAssistantDock: () => ({ dockable: false, mode: "popup", setMode: vi.fn() }),
}));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));

import { PortalTopBar } from "@/components/portal/portal-top-bar";

function workspace(id: string, name: string): WorkspaceContextValue["workspaces"][number] {
  return {
    id,
    name,
    ownerUserId: "u1",
    owned: true,
    isDefault: id === "w1",
    propertyIds: [],
    livePropertyCount: 0,
    propertyPermissions: {},
  } as WorkspaceContextValue["workspaces"][number];
}

function setWorkspaces(workspaces: WorkspaceContextValue["workspaces"]) {
  workspaceCtx.value = {
    workspaces,
    active: workspaces[0] ?? null,
    plan: null,
    error: null,
    loading: false,
    refresh: vi.fn(),
    mutate: vi.fn(),
    select: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  cleanup();
  pushMock.mockClear();
  workspaceCtx.value = null;
});

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu" }), { button: 0 });
}

describe("PortalTopBar account menu", () => {
  it("keeps Settings and Sign out, and drops Billing & plan, Switch workspace, and Help for a workspace portal", async () => {
    setWorkspaces([workspace("w1", "My workspace"), workspace("w2", "Ballard houses")]);
    render(<PortalTopBar kind="manager" basePath="/portal" name="Alex Rivera" email="alex@example.com" />);
    openMenu();

    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Sign out")).toBeInTheDocument();
    expect(document.querySelector('[data-attr="portal-role-switcher-stub"]')).not.toBeNull();
    expect(screen.queryByText("Billing & plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Switch workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Help")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Settings"));
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("/portal/profile"));
  });

  it("never shows Switch workspace, even with more than one workspace", async () => {
    setWorkspaces([workspace("w1", "My workspace"), workspace("w2", "Ballard houses")]);
    render(<PortalTopBar kind="manager" basePath="/portal" name="Alex Rivera" email="alex@example.com" />);
    openMenu();
    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Switch workspace")).not.toBeInTheDocument();
  });

  it("keeps the same shape for a non-workspace portal (resident)", async () => {
    setWorkspaces([workspace("w1", "My workspace"), workspace("w2", "Ballard houses")]);
    render(<PortalTopBar kind="resident" basePath="/resident" name="Jamie Lee" email="jamie@example.com" />);
    openMenu();
    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Billing & plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Switch workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Help")).not.toBeInTheDocument();
  });
});
