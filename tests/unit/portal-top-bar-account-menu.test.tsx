// @vitest-environment jsdom
//
// C004: Settings lives only in the avatar/account menu (never the sidebar),
// and that menu also carries Billing & plan, Switch workspace, and Help —
// the full set the spec names, alongside the existing Appearance/role-switch
// items this test must not regress.
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
vi.mock("@/components/portal/assistant-layout-controls", () => ({
  AssistantDockExpandButton: () => null,
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
  it("keeps Settings only in the account menu, and adds Billing & plan and Help for a workspace portal", async () => {
    setWorkspaces([workspace("w1", "My workspace")]);
    render(<PortalTopBar kind="manager" basePath="/portal" name="Alex Rivera" email="alex@example.com" />);
    openMenu();

    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Billing & plan")).toBeInTheDocument();
    expect(screen.getByText("Help")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Billing & plan"));
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("/portal/profile"));
  });

  it("only offers Switch workspace when the account has more than one workspace", async () => {
    setWorkspaces([workspace("w1", "My workspace")]);
    render(<PortalTopBar kind="manager" basePath="/portal" name="Alex Rivera" email="alex@example.com" />);
    openMenu();
    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Switch workspace")).not.toBeInTheDocument();

    cleanup();
    setWorkspaces([workspace("w1", "My workspace"), workspace("w2", "Ballard houses")]);
    render(<PortalTopBar kind="manager" basePath="/portal" name="Alex Rivera" email="alex@example.com" />);
    openMenu();
    expect(await screen.findByText("Switch workspace")).toBeInTheDocument();
  });

  it("never shows Billing & plan or Switch workspace for a non-workspace portal (resident)", async () => {
    setWorkspaces([workspace("w1", "My workspace"), workspace("w2", "Ballard houses")]);
    render(<PortalTopBar kind="resident" basePath="/resident" name="Jamie Lee" email="jamie@example.com" />);
    openMenu();
    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Billing & plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Switch workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Help")).toBeInTheDocument();
  });
});
