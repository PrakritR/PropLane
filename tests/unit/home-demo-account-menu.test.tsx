// @vitest-environment jsdom
//
// The home demo window mirrors the real portal's top bar (captain 2026-10-07): "Ask PropLane"
// for every portal, no bell, and the avatar pill opens an account menu that lists the OTHER
// portals using the product's own labels (`portalSwitchTargets`), not a switcher bar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ResidentLifecycleWorkspace } from "@/components/marketing/resident-lifecycle-workspace";
import { DEMO_TABS, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";

afterEach(cleanup);

const PORTALS: DemoPortal[] = ["manager", "resident", "vendor"];

function mount(portal: DemoPortal, onSwitchPortal?: (portal: DemoPortal) => void) {
  return render(
    <ResidentLifecycleWorkspace
      portal={portal}
      tabs={DEMO_TABS[portal]}
      active={DEMO_TABS[portal][0]!.id}
      onSelect={() => {}}
      onSwitchPortal={onSwitchPortal}
      panel
    >
      <div />
    </ResidentLifecycleWorkspace>,
  );
}

describe("home demo window top bar", () => {
  it.each(PORTALS)("%s: Ask PropLane with its shortcut, and no notifications bell", (portal) => {
    mount(portal);
    expect(screen.getByRole("button", { name: /Ask PropLane/ })).toBeTruthy();
    expect(screen.getByText("⌘K")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /notifications/i })).toBeNull();
  });

  it("the account menu lists the other portals with the real labels and switches on click", () => {
    const onSwitch = vi.fn();
    mount("manager", onSwitch);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = screen.getByRole("menu", { name: "Account" });
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim());
    expect(items).toEqual(["Settings", "Switch to Resident portal", "Switch to Vendor portal", "Sign out"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Switch to Resident portal" }));
    expect(onSwitch).toHaveBeenCalledWith("resident");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("never lists the current portal, and Escape closes the menu", () => {
    mount("vendor", vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("menuitem", { name: /Switch to Vendor portal/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Switch to Property portal" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a frame without a switch handler lists no portals", () => {
    mount("manager");
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("menuitem", { name: /Switch to/ })).toBeNull();
  });
});
