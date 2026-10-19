// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResidentLifecycleAtmosphere } from "@/components/marketing/resident-lifecycle-atmosphere";

let reduced = false;
let width = 1280;
const frame = vi.fn(() => 42);
const cancelFrame = vi.fn();
const disconnectResize = vi.fn();
const disconnectIntersection = vi.fn();
const removeMediaListener = vi.fn();
const drawing = {
  clearRect: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
  lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fillRect: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  width = 1280;
  reduced = false;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(drawing as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    width, height: 800, left: 0, top: 0, right: width, bottom: 800, x: 0, y: 0, toJSON: () => ({}),
  }));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("requestAnimationFrame", frame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: reduced || (query.includes("max-width: 639px") && width < 640),
    addEventListener: vi.fn(), removeEventListener: removeMediaListener,
  })));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnectResize; });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect = disconnectIntersection; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("homepage uses the production atmosphere with bounded motion", () => {
  it("draws the same waves and dots once on phones without starting an animation frame loop", () => {
    width = 375;
    const { container } = render(<ResidentLifecycleAtmosphere variant="page" staticBelow={640} />);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.firstElementChild).toHaveClass("rlp-atmosphere--page");
    expect(drawing.stroke).toHaveBeenCalled();
    expect(drawing.fillRect).toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
  });

  it("retains the static drawing for reduced motion on desktop", () => {
    reduced = true;
    render(<ResidentLifecycleAtmosphere variant="page" staticBelow={640} />);
    expect(drawing.stroke).toHaveBeenCalled();
    expect(drawing.fillRect).toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
  });

  it("keeps production desktop animation and cleans up its frame and observers", () => {
    const view = render(<ResidentLifecycleAtmosphere variant="page" staticBelow={640} />);
    expect(frame).toHaveBeenCalledOnce();
    view.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(disconnectResize).toHaveBeenCalledOnce();
    expect(disconnectIntersection).toHaveBeenCalledOnce();
    expect(removeMediaListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("leaves existing production callers unchanged unless they opt into the phone cutoff", () => {
    width = 375;
    render(<ResidentLifecycleAtmosphere />);
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(frame).toHaveBeenCalledOnce();
  });
});
