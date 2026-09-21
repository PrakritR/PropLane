// @vitest-environment jsdom
/**
 * `SettingsScopeBar` — ONE multi-select box per settings module (the
 * captain: "choose which workspace and which property — the dropdown
 * should be a multi-select box"). Every workspace is a selectable group
 * header ("All houses in this workspace"), its houses listed beneath it;
 * checking the header selects every house under it, and a selection can
 * span several workspaces. `variant="workspace-only"` (Notifications) keeps
 * the same multi-select but drops the house rows. `variant="single-workspace"`
 * (Communication) is a plain single-select bound to the global workspace
 * switcher, never a multi-select — see `settings-scope-single-workspace.test.tsx`.
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
      id: "ws-2",
      name: "Cedar Row",
      propertyIds: ["prop-3", "prop-4"],
      propertyLabels: { "prop-3": "Cedar Cottage", "prop-4": "Cedar Annex" },
    },
  ],
  active: { id: "ws-1", name: "Ash Flats" },
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
  initialWorkspaceIds = [],
  initialPropertyIds = [],
  variant = "full" as const,
}: {
  initialWorkspaceIds?: string[];
  initialPropertyIds?: string[];
  variant?: "full" | "workspace-only";
}) {
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(initialWorkspaceIds);
  const [propertyIds, setPropertyIds] = useState<string[]>(initialPropertyIds);
  return (
    <SettingsPropertyScopeProvider
      workspaceIds={workspaceIds}
      onWorkspaceIdsChange={setWorkspaceIds}
      propertyIds={propertyIds}
      onPropertyIdsChange={setPropertyIds}
      options={[
        { id: "prop-1", label: "Ballard House" },
        { id: "prop-2", label: "Fremont Duplex" },
        { id: "prop-3", label: "Cedar Cottage" },
      ]}
    >
      <SettingsScopeBar variant={variant} />
    </SettingsPropertyScopeProvider>
  );
}

afterEach(() => {
  cleanup();
  mockSelect.mockClear();
});

describe("SettingsScopeBar (full — multi-select workspaces and houses)", () => {
  it("defaults to the current active workspace, all its houses", () => {
    render(<Harness />);
    expect(screen.getByText("Applies to · Ash Flats · all houses")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workspaces and properties" }).textContent).toContain(
      "Ash Flats · all houses",
    );
  });

  it("is a single dropdown with no native <select>", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector("select")).toBeNull();
  });

  it("checking a workspace header selects every house under it, alongside the default workspace already implied", () => {
    render(<Harness />);
    const listbox = openMenu("Workspaces and properties");
    // Both groups offer "All houses in this workspace" — pick Cedar Row's explicitly.
    // Ash Flats is already checked (today's default), so this adds a second whole workspace.
    const cedarHeader = within(listbox)
      .getAllByRole("option", { name: "All houses in this workspace" })
      .find((el) => el.closest("div")?.textContent?.includes("Cedar Row"));
    expect(cedarHeader).toBeTruthy();
    tap(cedarHeader!);
    expect(screen.getByText("Applies to · 2 workspaces")).toBeTruthy();
  });

  it("picking one house across a different workspace than the default reads N houses in M workspaces", () => {
    render(<Harness initialWorkspaceIds={["ws-1"]} />);
    const listbox = openMenu("Workspaces and properties");
    tap(within(listbox).getByRole("option", { name: "Cedar Cottage" }));
    expect(screen.getByText("Applies to · 3 houses in 2 workspaces")).toBeTruthy();
  });

  it("checking every house of a workspace one at a time promotes back to its header", () => {
    render(<Harness initialPropertyIds={["prop-3"]} />);
    const listbox = openMenu("Workspaces and properties");
    tap(within(listbox).getByRole("option", { name: "Cedar Annex" }));
    // Both of Cedar Row's houses are now individually checked — promotes to the workspace header.
    expect(screen.getByText("Applies to · Cedar Row · all houses")).toBeTruthy();
  });

  it("unchecking one house out of a fully-selected workspace demotes header to its siblings", () => {
    render(<Harness initialWorkspaceIds={["ws-1"]} />);
    const listbox = openMenu("Workspaces and properties");
    // Ballard House shows checked (implied by the Ash Flats header); uncheck it.
    tap(within(listbox).getByRole("option", { name: "Ballard House" }));
    expect(screen.getByText("Applies to · 1 house")).toBeTruthy();
  });

  it("Reset clears back to the active workspace", () => {
    render(<Harness initialPropertyIds={["prop-1"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspaces and properties" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to current workspace" }));
    expect(screen.getByText("Applies to · Ash Flats · all houses")).toBeTruthy();
  });
});

describe("SettingsScopeBar (workspace-only — Notifications)", () => {
  it("offers workspace headers with no house rows", () => {
    render(<Harness variant="workspace-only" />);
    const listbox = openMenu("Workspaces");
    expect(within(listbox).queryByRole("option", { name: "Ballard House" })).toBeNull();
    expect(within(listbox).getAllByRole("option", { name: "All houses in this workspace" }).length).toBe(2);
  });

  it("still supports picking several workspaces at once, on top of the default active one", () => {
    render(<Harness variant="workspace-only" />);
    // Ash Flats is already checked (today's default) — checking Cedar Row too spans both.
    const listbox = openMenu("Workspaces");
    const cedarHeader = within(listbox)
      .getAllByRole("option", { name: "All houses in this workspace" })
      .find((el) => el.closest("div")?.textContent?.includes("Cedar Row"));
    tap(cedarHeader!);
    expect(screen.getByText("Applies to · 2 workspaces")).toBeTruthy();
  });
});
