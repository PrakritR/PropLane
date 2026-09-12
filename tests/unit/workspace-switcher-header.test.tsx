// @vitest-environment jsdom
//
// The sidebar's first block is the workspace, not the product: avatar, name,
// role and property count, and a menu that ends with "New workspace · 1 of 3"
// so the plan cap is visible before the click.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceContextValue } from "@/components/portal/workspace-provider";

const ctx: { value: WorkspaceContextValue | null } = { value: null };
vi.mock("@/components/portal/workspace-provider", () => ({ useWorkspaces: () => ctx.value }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));

import { WorkspaceSwitcher, workspaceInitials } from "@/components/portal/workspace-switcher";

function workspace(id: string, name: string, owned = true, propertyIds: string[] = []) {
  return {
    id,
    name,
    ownerUserId: "u1",
    owned,
    isDefault: id === "w1",
    propertyIds,
    propertyPermissions: {},
  } as WorkspaceContextValue["workspaces"][number];
}

function setContext(over: Partial<WorkspaceContextValue> = {}) {
  const w1 = workspace("w1", "My workspace", true, ["p1", "p2", "p3"]);
  const w2 = workspace("w2", "Ballard houses", false, ["p9"]);
  ctx.value = {
    workspaces: [w1, w2],
    active: w1,
    plan: {
      tier: "business",
      unknown: false,
      workspaceLimit: 3,
      propertyLimit: 20,
      recordsPerWorkspace: 10,
      teamLimit: 20,
      usage: { workspaces: 1, properties: 3, team: 0, vendors: 0 },
    },
    error: null,
    loading: false,
    refresh: vi.fn(),
    mutate: vi.fn(),
    select: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

afterEach(() => cleanup());

describe("workspaceInitials", () => {
  it("takes the first letter of the first two words, or two letters of one", () => {
    expect(workspaceInitials("My workspace")).toBe("MW");
    expect(workspaceInitials("Ballard")).toBe("BA");
    expect(workspaceInitials("  ")).toBe("W");
  });
});

describe("the header switcher", () => {
  it("names the workspace with its role and property count", () => {
    setContext();
    render(<WorkspaceSwitcher />);
    const trigger = screen.getByRole("button", { name: "Switch workspace: My workspace" });
    expect(trigger.textContent).toContain("MW");
    expect(trigger.textContent).toContain("Owner · 3 properties");
  });

  it("lists every workspace, then settings, invite, and New workspace with the cap", async () => {
    setContext();
    render(<WorkspaceSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch workspace: My workspace" }), { button: 0 });
    const items = await screen.findAllByRole("menuitem");
    const labels = items.map((el) => el.textContent?.replace(/\s+/g, " ").trim());
    expect(labels[0]).toContain("My workspace");
    expect(labels[0]).toContain("Owned");
    expect(labels[1]).toContain("Ballard houses");
    expect(labels[1]).toContain("Shared");
    expect(labels[2]).toBe("Workspace settings");
    expect(labels[3]).toBe("Invite a manager");
    expect(labels[4]).toMatch(/^New workspace\s*1 of 3$/);
    expect(document.querySelector('[data-attr="workspace-switcher-new"]')?.getAttribute("href")).toBe(
      "/portal/profile?tab=workspaces&new=1",
    );
  });

  it("greys New workspace at the cap rather than hiding it", async () => {
    setContext({
      plan: {
        tier: "free",
        unknown: false,
        workspaceLimit: 1,
        propertyLimit: 1,
        recordsPerWorkspace: 10,
        teamLimit: 0,
        usage: { workspaces: 1, properties: 1, team: 0, vendors: 0 },
      },
    });
    render(<WorkspaceSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch workspace: My workspace" }), { button: 0 });
    const item = (await screen.findAllByRole("menuitem")).at(-1)!;
    expect(item.textContent).toContain("1 of 1");
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("collapsed, it is the avatar alone with the name as its label", () => {
    setContext();
    render(<WorkspaceSwitcher compact />);
    const trigger = screen.getByRole("button", { name: "Switch workspace: My workspace" });
    expect(trigger.textContent).toBe("MW");
  });
});
