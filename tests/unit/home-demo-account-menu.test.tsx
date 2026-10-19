// @vitest-environment jsdom
//
// The home demo window mirrors the real portal's top bar (captain 2026-10-07): "Ask PropLane"
// for every portal, no bell, and the avatar pill opens an account menu that lists the OTHER
// portals using the product's own labels (`portalSwitchTargets`), not a switcher bar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ResidentLifecycleWorkspace } from "@/components/marketing/resident-lifecycle-workspace";
import { DEMO_TABS, type DemoPortal } from "@/components/marketing/site/product-mock/demo-nav";
import { PORTAL_META } from "@/components/marketing/resident-lifecycle-script";

beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Sample account actions must not fetch"); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PORTALS: DemoPortal[] = ["manager", "resident", "vendor"];

function mount(portal: DemoPortal, onSwitchPortal?: (portal: DemoPortal) => void, onSelect = vi.fn()) {
  return render(
    <ResidentLifecycleWorkspace
      portal={portal}
      tabs={DEMO_TABS[portal]}
      active={DEMO_TABS[portal][0]!.id}
      onSelect={onSelect}
      onSwitchPortal={onSwitchPortal}
      panel
    >
      <div>Sample portal content</div>
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


describe("sample account actions", () => {
  it.each(PORTALS)("%s Settings opens a local profile and returns to a real sidebar page", (portal) => {
    const onSelect = vi.fn();
    const { container } = mount(portal, undefined, onSelect);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onSelect).toHaveBeenLastCalledWith("profile");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText(PORTAL_META[portal].profile.email)).toBeInTheDocument();
    expect(screen.queryByText("Sample portal content")).toBeNull();
    const first = DEMO_TABS[portal][0]!;
    fireEvent.click(within(container.querySelector(".rlp-nav") as HTMLElement).getByRole("button", { name: first.label, exact: true }));
    expect(onSelect).toHaveBeenLastCalledWith(first.id, undefined);
    expect(screen.getByText("Sample portal content")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to sample" }));
    expect(screen.getByText("Sample portal content")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(PORTALS)("%s ends only this sample session and can resume", (portal) => {
    mount(portal);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(screen.getByRole("status")).toHaveTextContent("Sample session ended");
    expect(screen.queryByText("Sample portal content")).toBeNull();
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume sample" }));
    expect(screen.getByText("Sample portal content")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens the one existing sample workspace through a native selector", () => {
    mount("manager");
    const selector = screen.getByRole("combobox", { name: "Workspace" });
    const options = within(selector).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(PORTAL_META.manager.workspace);
    expect(selector).toHaveValue(PORTAL_META.manager.workspace);
    expect(fetch).not.toHaveBeenCalled();
  });
});
