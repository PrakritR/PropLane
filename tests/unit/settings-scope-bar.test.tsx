// @vitest-environment jsdom
/**
 * `SettingsScopeBar` (PLAN-0920-0845 phase D) — one workspace + properties
 * picker per settings module, and the tag that reads what is actually
 * selected: Account (all workspaces, no houses), Workspace (one workspace,
 * no houses), or "Own values on N properties" once houses are picked.
 * Picking a real workspace calls the same global `select()` the top-left
 * `WorkspaceSwitcher` uses, so the two stay in sync (AGENTS.md § Icon
 * chrome: one property control in module chrome, never a second picker).
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const mockSelect = vi.fn().mockResolvedValue(undefined);
const mockWorkspaces = {
  workspaces: [
    {
      id: "ws-1",
      name: "Ash Flats",
      propertyIds: ["prop-1", "prop-2"],
      propertyLabels: { "prop-1": "Ballard House", "prop-2": "Fremont Duplex" },
    },
  ],
  active: null,
  loading: false,
  select: mockSelect,
};

vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => mockWorkspaces,
}));

import { SettingsScopeBar } from "@/components/portal/settings-scope-bar";
import { SettingsPropertyScopeProvider } from "@/components/portal/settings-property-scope";

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("listbox", { name });
}

function tap(target: HTMLElement) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

function Harness({ initialWorkspaceId = "" }: { initialWorkspaceId?: string }) {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  return (
    <SettingsPropertyScopeProvider
      workspaceId={workspaceId}
      onWorkspaceIdChange={setWorkspaceId}
      propertyIds={propertyIds}
      onPropertyIdsChange={setPropertyIds}
      options={[
        { id: "prop-1", label: "Ballard House" },
        { id: "prop-2", label: "Fremont Duplex" },
      ]}
    >
      <SettingsScopeBar />
    </SettingsPropertyScopeProvider>
  );
}

afterEach(() => {
  cleanup();
  mockSelect.mockClear();
});

describe("SettingsScopeBar", () => {
  it("defaults to All workspaces and tags Account", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Workspace" }).textContent).toContain("All workspaces");
    expect(screen.getByText("Account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset to workspace" })).toBeNull();
  });

  it("picking a workspace tags Workspace and calls the global switcher's own select()", () => {
    render(<Harness />);
    const listbox = openMenu("Workspace");
    tap(within(listbox).getByRole("option", { name: "Ash Flats" }));
    expect(screen.getByRole("button", { name: "Workspace" }).textContent).toContain("Ash Flats");
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(mockSelect).toHaveBeenCalledWith("ws-1", { href: false });
  });

  it("picking All workspaces never calls select() — there is no real 'no workspace' global state", () => {
    render(<Harness initialWorkspaceId="ws-1" />);
    expect(screen.getByText("Workspace")).toBeTruthy();
    const listbox = openMenu("Workspace");
    tap(within(listbox).getByRole("option", { name: "All workspaces" }));
    expect(mockSelect).not.toHaveBeenCalled();
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("picking a property tags Own values on 1 property and shows Reset", () => {
    render(<Harness />);
    const listbox = openMenu("Properties");
    tap(within(listbox).getByRole("option", { name: "Ballard House" }));
    expect(screen.getByText("Own values on 1 property")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset to workspace" })).toBeTruthy();
  });

  it("picking two properties tags Own values on 2 properties", () => {
    render(<Harness />);
    let listbox = openMenu("Properties");
    tap(within(listbox).getByRole("option", { name: "Ballard House" }));
    listbox = screen.getByRole("listbox", { name: "Properties" });
    tap(within(listbox).getByRole("option", { name: "Fremont Duplex" }));
    expect(screen.getByText("Own values on 2 properties")).toBeTruthy();
  });

  it("Reset clears the property selection back to the bar's workspace tag", () => {
    render(<Harness />);
    const listbox = openMenu("Properties");
    tap(within(listbox).getByRole("option", { name: "Ballard House" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to workspace" }));
    expect(screen.queryByRole("button", { name: "Reset to workspace" })).toBeNull();
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("property menu has no Select all or Clear", () => {
    render(<Harness />);
    const listbox = openMenu("Properties");
    expect(within(listbox).queryByText("Select all")).toBeNull();
    expect(within(listbox).queryByText("Clear")).toBeNull();
    expect(within(listbox).getByText("Ballard House")).toBeTruthy();
  });

  it("workspace-only variant has no properties picker or Reset", () => {
    function WorkspaceOnlyHarness() {
      const [workspaceId, setWorkspaceId] = useState("");
      const [propertyIds, setPropertyIds] = useState<string[]>([]);
      return (
        <SettingsPropertyScopeProvider
          workspaceId={workspaceId}
          onWorkspaceIdChange={setWorkspaceId}
          propertyIds={propertyIds}
          onPropertyIdsChange={setPropertyIds}
          options={[]}
        >
          <SettingsScopeBar variant="workspace-only" />
        </SettingsPropertyScopeProvider>
      );
    }
    render(<WorkspaceOnlyHarness />);
    expect(screen.queryByRole("button", { name: "Properties" })).toBeNull();
    expect(screen.getByRole("button", { name: "Workspace" })).toBeTruthy();
  });
});
