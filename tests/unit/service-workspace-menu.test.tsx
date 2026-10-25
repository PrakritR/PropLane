// @vitest-environment jsdom
/**
 * The phone's workspace menu for the admin portal and service mode (the desktop rail is hidden below lg): an admin
 * gets PropLane, every service workspace and New workspace; a helper gets only their workspaces. In service mode it
 * is also the phone's only way back to the viewer's own Property portal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { openServiceWorkspace, switchToPropertyPortal } = vi.hoisted(() => ({
  openServiceWorkspace: vi.fn(async () => null),
  switchToPropertyPortal: vi.fn(async () => null),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock("@/lib/service/open-service-workspace", () => ({ openServiceWorkspace, switchToPropertyPortal }));
vi.mock("@/components/portal/admin-new-service-workspace", () => ({
  AdminNewServiceWorkspace: ({ open }: { open: boolean }) => (open ? <div role="dialog">New workspace form</div> : null),
}));

import { ServiceWorkspaceMenu } from "@/components/portal/service-workspace-menu";
import type { ServiceShellData } from "@/lib/service/service-mode";

afterEach(() => {
  cleanup();
  openServiceWorkspace.mockClear();
  switchToPropertyPortal.mockClear();
});

const WORKSPACES = [
  { id: "ws-ambika", name: "Ambika", city: "Seattle" },
  { id: "ws-vinod", name: "Vinod", city: null },
];

/** A menu row by its label (the trigger repeats the current name, so a plain text query is ambiguous). */
const row = (label: string) => screen.queryByRole("menuitem", { name: new RegExp(`^${label}`) });

function shell(overrides: Partial<ServiceShellData>): ServiceShellData {
  return { workspaces: WORKSPACES, isAdmin: true, activeId: null, propertyPortalWorkspaceId: null, ...overrides };
}

describe("ServiceWorkspaceMenu", () => {
  it("shows PropLane, both workspaces and New workspace for an admin", async () => {
    render(<ServiceWorkspaceMenu service={shell({})} />);
    expect(screen.getByRole("button", { name: "Switch workspace: PropLane" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    await screen.findByRole("menu");
    expect(row("PropLane")).toBeTruthy();
    expect(row("Ambika")).toBeTruthy();
    expect(row("Vinod")).toBeTruthy();
    expect(row("New workspace")).toBeTruthy();
    expect(within(row("Ambika")!).getByText("Seattle")).toBeTruthy();
  });

  it("opens a workspace through the shared open, and skips the active one", async () => {
    render(<ServiceWorkspaceMenu service={shell({ activeId: "ws-vinod" })} />);
    expect(screen.getByRole("button", { name: "Switch workspace: Vinod" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    await screen.findByRole("menu");
    await userEvent.click(row("Vinod")!);
    expect(openServiceWorkspace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    await screen.findByRole("menu");
    await userEvent.click(row("Ambika")!);
    expect(openServiceWorkspace).toHaveBeenCalledWith("ws-ambika", undefined, { isAdmin: true });
  });

  it("opens the new-workspace form from the menu", async () => {
    render(<ServiceWorkspaceMenu service={shell({})} />);
    await userEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    await screen.findByRole("menu");
    await userEvent.click(row("New workspace")!);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("a helper in service mode gets the way back to their own Property portal", async () => {
    render(<ServiceWorkspaceMenu service={shell({ isAdmin: false, activeId: "ws-ambika", propertyPortalWorkspaceId: "ws-own" })} />);
    await userEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    await screen.findByRole("menu");
    await userEvent.click(row("Switch to Property portal")!);
    expect(switchToPropertyPortal).toHaveBeenCalledWith("ws-own");
  });

  it("no own workspace, no Property portal row", async () => {
    render(<ServiceWorkspaceMenu service={shell({ activeId: "ws-ambika" })} />);
    await userEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    await screen.findByRole("menu");
    expect(row("Switch to Property portal")).toBeNull();
  });

  it("leaves PropLane and New workspace out for a helper", async () => {
    render(<ServiceWorkspaceMenu service={shell({ isAdmin: false, activeId: "ws-ambika" })} />);
    await userEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    await screen.findByRole("menu");
    expect(row("Vinod")).toBeTruthy();
    expect(row("PropLane")).toBeNull();
    expect(row("New workspace")).toBeNull();
  });
});
