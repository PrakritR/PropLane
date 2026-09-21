// @vitest-environment jsdom
/**
 * `variant="single-workspace"` — Communication's scope control. A work
 * number and a work email belong to exactly one workspace at a time, never
 * several, so this is a plain single-select bound directly to the global
 * workspace switcher (`useWorkspaces().select`) — not the multi-select
 * every other scoped module uses, and no houses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const mockSelect = vi.fn().mockResolvedValue(undefined);
const mockWorkspaces = {
  workspaces: [
    { id: "ws-1", name: "Ash Flats", propertyIds: ["prop-1"] },
    { id: "ws-2", name: "Cedar Row", propertyIds: ["prop-3"] },
  ],
  active: { id: "ws-1", name: "Ash Flats" },
  loading: false,
  select: mockSelect,
};

vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => mockWorkspaces,
}));

import { SettingsScopeBar } from "@/components/portal/settings-scope-bar";

function tap(target: HTMLElement) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

afterEach(() => {
  cleanup();
  mockSelect.mockClear();
});

describe("SettingsScopeBar (single-workspace — Communication)", () => {
  it("shows the active workspace, one at a time, no multi-select affordance", () => {
    const { container } = render(<SettingsScopeBar variant="single-workspace" />);
    expect(screen.getByRole("button", { name: "Workspace" }).textContent).toContain("Ash Flats");
    expect(container.querySelector("select")).toBeNull();
    // A single-select trigger, not a checkbox multi-select: no "listbox" aria-multiselectable.
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const listbox = screen.getByRole("listbox", { name: "Workspace" });
    expect(listbox.getAttribute("aria-multiselectable")).not.toBe("true");
  });

  it("no houses are offered — only workspace names", () => {
    render(<SettingsScopeBar variant="single-workspace" />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const listbox = screen.getByRole("listbox", { name: "Workspace" });
    expect(within(listbox).getByRole("option", { name: "Ash Flats" })).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: "Cedar Row" })).toBeTruthy();
    expect(within(listbox).queryAllByRole("checkbox").length).toBe(0);
  });

  it("picking a workspace calls the global switcher's select(), the one source of truth", () => {
    render(<SettingsScopeBar variant="single-workspace" />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const listbox = screen.getByRole("listbox", { name: "Workspace" });
    tap(within(listbox).getByRole("option", { name: "Cedar Row" }));
    expect(mockSelect).toHaveBeenCalledWith("ws-2", { href: false });
  });
});
