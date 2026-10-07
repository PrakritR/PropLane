// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  filterPaletteActions,
  filterPaletteJumpItems,
  PortalCommandPalette,
  portalPaletteActions,
} from "@/components/portal/portal-command-palette";
import type { PortalJumpItem } from "@/components/portal/use-portal-jump-items";

afterEach(cleanup);

const JUMP: PortalJumpItem[] = [
  { section: "dashboard", label: "Dashboard", href: "/portal/dashboard", group: null },
  { section: "communication", label: "Communication", href: "/portal/communication/active", group: null },
  { section: "properties", label: "Properties", href: "/portal/properties/all", group: "Portfolio" },
  { section: "tours", label: "Tours", href: "/portal/tours", group: "Leasing" },
  { section: "payments", label: "Incoming payments", href: "/portal/payments/incoming/pending", group: "Money" },
];

function mount(over: Partial<React.ComponentProps<typeof PortalCommandPalette>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    jumpItems: JUMP,
    actions: portalPaletteActions("/portal", "manager"),
    onAsk: vi.fn(),
    onNavigate: vi.fn(),
    ...over,
  };
  render(<PortalCommandPalette {...props} />);
  return props;
}

const input = () => screen.getByRole("combobox", { name: "Ask PropLane or search" });

describe("palette filtering", () => {
  it("filters the portal's sections by label or sidebar heading", () => {
    expect(filterPaletteJumpItems(JUMP, "").map((i) => i.section)).toEqual(JUMP.map((i) => i.section));
    expect(filterPaletteJumpItems(JUMP, "prop").map((i) => i.section)).toEqual(["properties"]);
    expect(filterPaletteJumpItems(JUMP, "MONEY").map((i) => i.section)).toEqual(["payments"]);
    expect(filterPaletteJumpItems(JUMP, "zzz")).toEqual([]);
  });

  it("offers create actions to a manager only, and only entry points reachable by URL", () => {
    const manager = portalPaletteActions("/portal", "manager");
    expect(manager.map((a) => a.label)).toEqual(["New message", "New workspace"]);
    expect(manager[0]!.href).toBe("/portal/communication/active?compose=1");
    expect(portalPaletteActions("/resident", "resident")).toEqual([]);
    expect(portalPaletteActions("/vendor", "vendor")).toEqual([]);
    expect(filterPaletteActions(manager, "work").map((a) => a.id)).toEqual(["new-workspace"]);
  });
});

describe("PortalCommandPalette", () => {
  it("lists ASK first, then JUMP TO sections, then ACTIONS", () => {
    mount();
    const rows = Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.getAttribute("data-attr"));
    expect(rows[0]).toBe("portal-palette-ask");
    expect(rows.filter((r) => r === "portal-palette-jump")).toHaveLength(JUMP.length);
    expect(rows.at(-1)).toBe("portal-palette-action");
    expect(screen.getByText("Ask")).toBeTruthy();
    expect(screen.getByText("Jump to")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    // key hints
    expect(screen.getByText("move")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("close")).toBeTruthy();
  });

  it("the first option follows the query and Enter sends it to the assistant", () => {
    const props = mount();
    fireEvent.change(input(), { target: { value: "who is late on rent" } });
    expect(screen.getByText("Ask PropLane: who is late on rent")).toBeTruthy();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(props.onAsk).toHaveBeenCalledWith("who is late on rent");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("an empty query asks with no question", () => {
    const props = mount();
    fireEvent.click(document.querySelector('[data-attr="portal-palette-ask"]')!);
    expect(props.onAsk).toHaveBeenCalledWith("");
  });

  it("typing narrows JUMP TO and arrow keys + Enter navigate to the highlighted section", () => {
    const props = mount();
    fireEvent.change(input(), { target: { value: "to" } });
    // "Tours" and "Incoming payments"? only labels/headings containing "to": Tours
    const jumpRows = document.querySelectorAll('[data-attr="portal-palette-jump"]');
    expect(Array.from(jumpRows).map((r) => r.textContent)).toEqual(["Tours"]);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(props.onNavigate).toHaveBeenCalledWith("/portal/tours");
    expect(props.onAsk).not.toHaveBeenCalled();
  });

  it("ArrowUp from the first row wraps to the last, which is an action", () => {
    const props = mount();
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(props.onNavigate).toHaveBeenCalledWith("/portal/profile?tab=workspaces&new=1");
  });

  it("shows no JUMP TO group when nothing matches but always keeps Ask", () => {
    mount();
    fireEvent.change(input(), { target: { value: "qqqq" } });
    expect(screen.queryByText("Jump to")).toBeNull();
    expect(screen.getByText("Ask PropLane: qqqq")).toBeTruthy();
  });

  it("Escape closes the palette", () => {
    const props = mount();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
