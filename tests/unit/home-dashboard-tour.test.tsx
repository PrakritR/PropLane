// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeDashboardTour } from "@/components/marketing/home-dashboard-tour";

let desktop = true;
let reduced = false;
let top = 64;
const listeners = new Set<() => void>();
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let observerCallback: IntersectionObserverCallback;
const disconnect = vi.fn();
const scrollTo = vi.fn();
const cancel = vi.fn((id: number) => frames.delete(id));
const tour = () => <HomeDashboardTour><div data-testid="dashboard-content">Real dashboard stays mounted</div></HomeDashboardTour>;
function flush() { act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); }); }
function near(value = true) { act(() => observerCallback([{ isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver)); }

beforeEach(() => {
  desktop = true; reduced = false; top = 64; frameId = 0;
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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ top, height: 4036, bottom: top + 4036, left: 0, right: 1440, width: 1440, x: 0, y: top, toJSON: () => ({}) }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Swiss dashboard scroll presentation", () => {
  it("highlights four beats bidirectionally without remounting the dashboard", () => {
    const { container } = render(tour());
    const content = screen.getByTestId("dashboard-content");
    near();
    expect(container.querySelector("section")).toHaveAttribute("data-beat", "all");
    for (const [position, beat] of [[-800, "rentals"], [-1600, "services"], [-2500, "payments"], [64, "all"]] as const) {
      top = position;
      fireEvent.scroll(window); flush();
      expect(container.querySelector("section")).toHaveAttribute("data-beat", beat);
      expect(screen.getByTestId("dashboard-content")).toBe(content);
    }
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("uses native page scrolling for the highlight controls", () => {
    render(tour()); near();
    fireEvent.click(screen.getByRole("button", { name: "Services" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1801, behavior: "smooth" });
  });

  it("keeps phone and reduced-motion presentations static with all content", () => {
    desktop = false;
    const { container } = render(tour()); near();
    expect(container.querySelector("section")).toHaveAttribute("data-enhanced", "false");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByTestId("dashboard-content")).toBeInTheDocument();
    act(() => { desktop = true; reduced = true; listeners.forEach((fn) => fn()); });
    expect(container.querySelector("section")).toHaveAttribute("data-enhanced", "false");
    expect(frames.size).toBe(0);
  });

  it("starts static if observers are unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(tour());
    expect(container.querySelector("section")).toHaveAttribute("data-enhanced", "false");
    expect(screen.getByTestId("dashboard-content")).toBeInTheDocument();
  });

  it("coalesces scroll frames only near the viewport and cleans pending work", () => {
    const { container, unmount } = render(tour());
    fireEvent.scroll(window);
    expect(frames.size).toBe(0);
    top = 829; near();
    const windowWrap = container.querySelector<HTMLElement>(".home-dashboard-window-wrap")!;
    expect(windowWrap.style.getPropertyValue("--dashboard-scale")).toBe("0.9");
    fireEvent.scroll(window); fireEvent.scroll(window);
    expect(frames.size).toBe(1);
    near(false);
    expect(cancel).toHaveBeenCalled();
    expect(windowWrap.style.getPropertyValue("--dashboard-scale")).toBe("");
    near();
    fireEvent.scroll(window);
    unmount();
    expect(frames.size).toBe(0);
    expect(listeners.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("removes transforms and highlight controls on motion preference changes", () => {
    const { container } = render(tour()); near();
    act(() => { reduced = true; listeners.forEach((fn) => fn()); });
    expect(container.querySelector("section")).toHaveAttribute("data-enhanced", "false");
    expect(container.querySelector<HTMLElement>(".home-dashboard-window-wrap")!.style.length).toBe(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
