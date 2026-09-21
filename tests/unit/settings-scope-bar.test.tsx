// @vitest-environment jsdom
/**
 * `SettingsScopeBar` (PLAN-0920-0845 phase D, PLAN-0920-1944) — workspace +
 * properties picker per settings module. The workspace select is Settings-only:
 * it never calls the portal header `WorkspaceSwitcher`'s `select()`. Houses
 * come from the workspace payload even when the local property store is empty.
 * The properties menu has no Select all / Clear footer.
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
    {
      id: "ws-empty",
      name: "Empty workspace",
      propertyIds: [],
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

function Harness({
  initialWorkspaceId = "",
  options = [
    { id: "prop-1", label: "Ballard House" },
    { id: "prop-2", label: "Fremont Duplex" },
  ],
}: {
  initialWorkspaceId?: string;
  options?: { id: string; label: string }[];
}) {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  return (
    <SettingsPropertyScopeProvider
      workspaceId={workspaceId}
      onWorkspaceIdChange={setWorkspaceId}
      propertyIds={propertyIds}
      onPropertyIdsChange={setPropertyIds}
      options={options}
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

  it("picking a workspace tags Workspace and never calls the portal switcher", () => {
    render(<Harness />);
    const listbox = openMenu("Workspace");
    tap(within(listbox).getByRole("option", { name: "Ash Flats" }));
    expect(screen.getByRole("button", { name: "Workspace" }).textContent).toContain("Ash Flats");
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("picking All workspaces never calls select()", () => {
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

  it("properties menu has no Select all or Clear", () => {
    render(<Harness />);
    openMenu("Properties");
    expect(screen.queryByText("Select all")).toBeNull();
    expect(screen.queryByText("Clear")).toBeNull();
  });

  it("lists houses from the workspace payload when the local store is empty", () => {
    render(<Harness initialWorkspaceId="ws-1" options={[]} />);
    const listbox = openMenu("Properties");
    expect(within(listbox).getByRole("option", { name: "Ballard House" })).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: "Fremont Duplex" })).toBeTruthy();
  });

  it("an empty workspace keeps the properties pill and says there are no houses", () => {
    render(<Harness initialWorkspaceId="ws-empty" options={[]} />);
    expect(screen.getByRole("button", { name: "Properties" })).toBeTruthy();
    const listbox = openMenu("Properties");
    expect(within(listbox).getByText("No houses in this workspace")).toBeTruthy();
    expect(screen.queryByText("Select all")).toBeNull();
    expect(screen.queryByText("Clear")).toBeNull();
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
