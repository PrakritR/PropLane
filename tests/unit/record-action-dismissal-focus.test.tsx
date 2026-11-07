// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
const surface = vi.hoisted(() => ({ value: "sheet" }));
vi.mock("@/components/ui/portal-surface", () => ({ usePortalSurface: () => surface.value }));
afterEach(() => { cleanup(); surface.value = "sheet"; });
function Harness() {
  return <><button>Outside target</button><RecordActionContext.Provider value={{ scope: "row", clear: () => {}, actions: <><button>Edit</button><button>Duplicate</button></> }}><RecordActionMenu label="Fixture" activate={() => {}} /></RecordActionContext.Provider></>;
}
async function open() {
  const trigger = screen.getByRole("button", { name: "Actions for Fixture" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await screen.findByRole("menu");
  // Radix attaches outside listeners after the opening event has finished.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return trigger;
}
describe("row menu dismissal focus", () => {
  it("restores trigger focus when a sheet backdrop dismisses the nonmodal menu", async () => {
    render(<Harness />);
    const trigger = await open();
    const backdrop = screen.getByTestId("dropdown-menu-backdrop");
    expect(backdrop.hasAttribute("data-menu-sheet-backdrop")).toBe(true);
    fireEvent.pointerDown(backdrop, { pointerType: "touch" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it("does not steal focus from a genuine desktop outside target", async () => {
    surface.value = "popover";
    render(<Harness />);
    const trigger = await open();
    expect(screen.getByTestId("dropdown-menu-backdrop").hasAttribute("data-menu-sheet-backdrop")).toBe(false);
    const outside = screen.getByRole("button", { name: "Outside target" });
    fireEvent.pointerDown(outside, { pointerType: "mouse" });
    outside.focus();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(outside));
    expect(document.activeElement).not.toBe(trigger);
  });
});
