// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ loading: true, error: null as string | null, active: null as null | { id: string }, workspaces: [] as Array<{ id: string; propertyIds: string[]; propertyLabels: Record<string, string> }> }));
vi.mock("@/components/portal/workspace-provider", () => ({ useWorkspaces: () => state }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "manager" }) }));
vi.mock("@/lib/manager-portfolio-access", () => ({ buildManagerPropertyFilterOptions: () => [] }));
import { SettingsPropertyScope } from "@/components/portal/settings-property-scope-picker";

afterEach(() => cleanup());

it("waits for workspace readiness, permits selection, and disables on error", () => {
  const { rerender } = render(<SettingsPropertyScope><span>Settings</span></SettingsPropertyScope>);
  const picker = screen.getByRole("button", { name: "Property" });
  expect(picker).toBeDisabled();
  fireEvent.click(picker);
  expect(screen.queryByRole("listbox")).toBeNull();
  state.loading = false;
  state.workspaces = [{ id: "w1", propertyIds: ["p1"], propertyLabels: { p1: "Fixture house" } }];
  state.active = { id: "w1" };
  rerender(<SettingsPropertyScope><span>Settings</span></SettingsPropertyScope>);
  expect(picker).toBeEnabled();
  fireEvent.click(picker);
  const option = screen.getByRole("option", { name: "Fixture house" });
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
  expect(picker).toHaveTextContent("Fixture house");
  state.error = "unavailable";
  rerender(<SettingsPropertyScope><span>Settings</span></SettingsPropertyScope>);
  expect(picker).toBeDisabled();
  state.error = null;
  state.active = null;
  rerender(<SettingsPropertyScope><span>Settings</span></SettingsPropertyScope>);
  expect(picker).toBeEnabled();
});
