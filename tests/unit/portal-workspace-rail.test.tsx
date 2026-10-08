// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceContextValue } from "@/components/portal/workspace-provider";

const showToast = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/portal/dashboard",
}));
const workspaceCtx: { value: WorkspaceContextValue | null } = { value: null };
vi.mock("@/components/portal/workspace-provider", () => ({ useWorkspaces: () => workspaceCtx.value }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "u1", email: "m@example.com", ready: true }),
}));
vi.mock("@/components/portal/portal-help-panel", () => ({
  PortalHelpPanel: ({ open }: { open: boolean }) => (open ? <div data-testid="help-panel" /> : null),
}));
vi.mock("@/components/layout/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/portal/portal-role-switcher", () => ({ PortalRoleSwitcher: () => null }));
vi.mock("@/components/portal/portal-sign-out-button", () => ({ PortalSignOutButton: () => null }));

import { PortalWorkspaceRail } from "@/components/portal/portal-workspace-rail";

function workspace(id: string, name: string, over: Record<string, unknown> = {}): WorkspaceContextValue["workspaces"][number] {
  return {
    id,
    name,
    ownerUserId: "u1",
    owned: true,
    isDefault: id === "w1",
    propertyIds: [],
    livePropertyCount: 2,
    propertyPermissions: {},
    ...over,
  } as WorkspaceContextValue["workspaces"][number];
}

function setWorkspaces(workspaces: WorkspaceContextValue["workspaces"], activeId = "w1", select = vi.fn().mockResolvedValue(undefined)) {
  workspaceCtx.value = {
    workspaces,
    active: workspaces.find((w) => w.id === activeId) ?? null,
    plan: null,
    error: null,
    loading: false,
    refresh: vi.fn(),
    mutate: vi.fn(),
    select,
  };
  return select;
}

afterEach(() => {
  cleanup();
  workspaceCtx.value = null;
  showToast.mockClear();
});

describe("PortalWorkspaceRail", () => {
  it("renders exactly one tile per workspace, from the same context the switcher reads", () => {
    setWorkspaces([workspace("w1", "Seattle Homes"), workspace("w2", "West Coast"), workspace("w3", "Ash Flats")]);
    render(<PortalWorkspaceRail kind="manager" basePath="/portal" name="Avery Morgan" email="a@example.com" />);
    const tiles = document.querySelectorAll('[data-attr="portal-rail-workspace"]');
    expect(tiles).toHaveLength(3);
    expect(Array.from(tiles).map((t) => t.textContent)).toEqual(["SH", "WC", "AF"]);
  });

  it("marks the active tile and switches workspace when another tile is clicked", () => {
    const select = setWorkspaces([workspace("w1", "Seattle Homes"), workspace("w2", "West Coast")]);
    render(<PortalWorkspaceRail kind="manager" basePath="/portal" name="Avery Morgan" email="a@example.com" />);
    const active = screen.getByRole("button", { name: "Switch workspace: Seattle Homes" });
    expect(active.getAttribute("aria-current")).toBe("true");
    fireEvent.click(active);
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace: West Coast" }));
    expect(select).toHaveBeenCalledWith("w2", undefined);
  });

  it("a shared workspace names its owner, like the switcher menu", () => {
    setWorkspaces([workspace("w1", "Seattle Homes"), workspace("w2", "My workspace", { owned: false, ownerName: "Kai" })]);
    render(<PortalWorkspaceRail kind="manager" basePath="/portal" name="A" email="a@example.com" />);
    expect(screen.getByRole("button", { name: "Switch workspace: My workspace (Kai)" })).toBeTruthy();
  });

  it("has a dashed + that runs the existing New workspace entry", () => {
    setWorkspaces([workspace("w1", "Seattle Homes")]);
    render(<PortalWorkspaceRail kind="manager" basePath="/portal" name="A" email="a@example.com" />);
    const add = screen.getByRole("link", { name: "New workspace" });
    expect(add.getAttribute("href")).toBe("/portal/profile?tab=workspaces&new=1");
  });

  it("opens the help panel from the help icon", () => {
    setWorkspaces([workspace("w1", "Seattle Homes")]);
    render(<PortalWorkspaceRail kind="manager" basePath="/portal" name="A" email="a@example.com" />);
    expect(screen.queryByTestId("help-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Help and feedback" }));
    expect(screen.getByTestId("help-panel")).toBeTruthy();
  });

  it("resident and vendor get one non-interactive tile and no workspace controls", () => {
    for (const kind of ["resident", "vendor"] as const) {
      setWorkspaces([workspace("w1", "Seattle Homes"), workspace("w2", "West Coast")]);
      const { unmount } = render(
        <PortalWorkspaceRail kind={kind} basePath={`/${kind}`} name="Jamie" email="j@example.com" />,
      );
      expect(document.querySelectorAll('[data-attr="portal-rail-workspace"]')).toHaveLength(0);
      expect(document.querySelectorAll('[data-attr="portal-rail-brand"]')).toHaveLength(1);
      expect(screen.queryByRole("link", { name: "New workspace" })).toBeNull();
      expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
      unmount();
    }
  });
});
