// @vitest-environment jsdom
/**
 * The admin Settings scope dropdown (plan admin-team-1027, A7): PropLane first for an Overall admin, then each workspace
 * the viewer can open; choosing a workspace runs the authorized open and lands back in Settings; a workspace admin sees
 * only their own workspaces and no PropLane scope.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { openServiceWorkspace, showToast } = vi.hoisted(() => ({
  openServiceWorkspace: vi.fn(async (_id: string, navigate: (href: string) => void) => {
    navigate("/portal/dashboard");
    return null;
  }),
  showToast: vi.fn(),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }), useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/service/open-service-workspace", () => ({ openServiceWorkspace }));

import { SettingsScopeSwitcher } from "@/components/portal/settings-scope-switcher";
import { adminTeamRowSummary } from "@/components/portal/admin-team-pane";
import type { SettingsScope } from "@/lib/admin-team/settings-scope";

afterEach(() => {
  cleanup();
  openServiceWorkspace.mockClear();
  showToast.mockClear();
});

const WORKSPACES = [
  { id: "ws-ambika", name: "1. Ambika", city: "Seattle" },
  { id: "ws-vinod", name: "2. Vinod", city: null },
];

const options = () => screen.getAllByRole("option").map((o) => o.textContent?.replace("✓", "").trim());

describe("SettingsScopeSwitcher", () => {
  it("lists PropLane, then each workspace, for an Overall admin, starting on the scope they came from", async () => {
    const scope: SettingsScope = { overall: true, workspaces: WORKSPACES, currentWorkspaceId: null };
    render(<SettingsScopeSwitcher scope={scope} />);
    const trigger = document.querySelector('[data-attr="settings-scope-select"]') as HTMLElement;
    expect(trigger.textContent).toContain("PropLane");
    await userEvent.click(trigger);
    expect(options()).toEqual(["PropLane", "1. Ambika · Seattle", "2. Vinod"]);
  });

  it("shows a workspace admin only their own workspace, with no PropLane scope", async () => {
    const scope: SettingsScope = { overall: false, workspaces: [WORKSPACES[0]!], currentWorkspaceId: "ws-ambika" };
    render(<SettingsScopeSwitcher scope={scope} />);
    await userEvent.click(document.querySelector('[data-attr="settings-scope-select"]') as HTMLElement);
    expect(options()).toEqual(["1. Ambika · Seattle"]);
  });

  it("choosing another workspace runs the authorized open (as a non-admin through the ordinary switch) and returns to Settings", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
    const scope: SettingsScope = { overall: true, workspaces: WORKSPACES, currentWorkspaceId: "ws-ambika" };
    render(<SettingsScopeSwitcher scope={scope} />);
    await userEvent.click(document.querySelector('[data-attr="settings-scope-select"]') as HTMLElement);
    await userEvent.click(screen.getByRole("option", { name: "2. Vinod" }));
    expect(openServiceWorkspace).toHaveBeenCalledWith("ws-vinod", expect.any(Function), { isAdmin: true });
    // The open's own landing is ignored: Settings is where the switch stays.
    expect(assign).toHaveBeenCalledWith("/portal/profile?tab=workspaces");
  });

  it("choosing PropLane goes to PropLane Settings without opening a workspace", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
    const scope: SettingsScope = { overall: true, workspaces: WORKSPACES, currentWorkspaceId: "ws-ambika" };
    render(<SettingsScopeSwitcher scope={scope} />);
    await userEvent.click(document.querySelector('[data-attr="settings-scope-select"]') as HTMLElement);
    await userEvent.click(screen.getByRole("option", { name: "PropLane" }));
    expect(openServiceWorkspace).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/admin/profile?tab=profile");
  });
});

describe("admin team rows", () => {
  it("say the role and where, in one line, with no pill", () => {
    expect(adminTeamRowSummary({ role: "overall_admin", state: "active", seats: [] })).toBe("Overall admin · all workspaces");
    expect(
      adminTeamRowSummary({
        role: "property_manager",
        state: "active",
        seats: [{ linkId: "l", workspaceId: "w", workspaceName: "1. Ambika", role: "property_manager", status: "accepted", houseScope: "selected", assignedPropertyIds: ["a", "b", "c"], houseCount: 3 }],
      }),
    ).toBe("Property manager · 1. Ambika (3 houses)");
    expect(adminTeamRowSummary({ role: "overall_admin", state: "invited", seats: [] })).toBe("Invited · Overall admin · all workspaces");
  });
});
