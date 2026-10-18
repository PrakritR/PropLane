// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeDashboardTour } from "@/components/marketing/home-dashboard-tour";

let desktop = true;
let reduced = false;
let top = 0;
const listeners = new Set<() => void>();
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let observerCallback: IntersectionObserverCallback;
const disconnect = vi.fn();
const scrollTo = vi.fn();
const cancel = vi.fn((id: number) => frames.delete(id));
const portals = ["manager", "resident", "vendor", "owner"] as const;
const tour = () => <HomeDashboardTour steps={portals.map((id) => ({ id, label: id, caption: id + " workspace", content: <div data-testid={id + "-content"}>{id} real content</div> }))} />;
function flush() { act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); }); }
function near(value = true) { act(() => observerCallback([{ isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver)); }

beforeEach(() => {
  desktop = true; reduced = false; top = 0; frameId = 0;
  frames.clear(); listeners.clear(); disconnect.mockClear(); scrollTo.mockClear(); cancel.mockClear();
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("scrollY", 200);
  vi.stubGlobal("scrollTo", scrollTo);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query.includes("min-width") ? desktop : reduced; },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ top, height: 4100, bottom: top + 4100, left: 0, right: 1440, width: 1440, x: 0, y: top, toJSON: () => ({}) }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("software role switch", () => {
  it("syncs four portals bidirectionally with desktop scrolling", () => {
    render(tour()); near();
    for (const [position, role] of [[0, "manager"], [-810, "resident"], [-1610, "vendor"], [-2500, "owner"], [0, "manager"]] as const) {
      top = position; fireEvent.scroll(window); flush();
      expect(screen.getByRole("tab", { name: role })).toHaveAttribute("aria-selected", "true");
      expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
      expect(screen.getByRole("tabpanel")).toHaveTextContent(role + " real content");
    }
  });
  it("uses native page scroll for desktop tab changes", () => {
    render(tour()); near();
    fireEvent.click(screen.getByRole("tab", { name: "vendor" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1801, behavior: "smooth" });
  });
  it.each(["phone", "reduced motion"])("keeps all role tabs functional in one frame with %s", (mode) => {
    desktop = mode !== "phone"; reduced = mode === "reduced motion";
    const { container } = render(tour()); near();
    expect(container.querySelector("section")).toHaveAttribute("data-enhanced", "false");
    fireEvent.click(screen.getByRole("tab", { name: "owner" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("owner real content");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector("#software-panel-manager")).toHaveAttribute("inert");
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("tab", { name: "owner" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "manager" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("manager real content");
  });
  it("has working tabs without IntersectionObserver support", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(tour());
    fireEvent.click(screen.getByRole("tab", { name: "resident" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("resident real content");
  });
  it("coalesces scroll work near the viewport and cleans pending frames", () => {
    const { unmount } = render(tour());
    fireEvent.scroll(window); expect(frames.size).toBe(0);
    near(); fireEvent.scroll(window); fireEvent.scroll(window);
    expect(frames.size).toBe(1);
    near(false); expect(cancel).toHaveBeenCalled();
    near(); fireEvent.scroll(window); unmount();
    expect(frames.size).toBe(0);
    expect(listeners.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
