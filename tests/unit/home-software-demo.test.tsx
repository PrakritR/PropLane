// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeSoftwareDemoPlayer } from "@/components/marketing/home-software-demo-player";
import { HOME_DEMO_CONTROL, HOME_DEMO_EVENT, HOME_DEMO_INTERACT, HOME_DEMO_READY } from "@/lib/demo/home-demo-embed";

class Observer {
  static instances: Observer[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: IntersectionObserverCallback, public options: IntersectionObserverInit) { Observer.instances.push(this); }
  emit(ratio = 1) { act(() => this.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
}
let motion = false;
const preload = () => Observer.instances.find((o) => o.options.rootMargin === "300px")!;
const viewport = () => Observer.instances.find((o) => Array.isArray(o.options.threshold))!;

beforeEach(() => {
  Observer.instances = [];
  motion = false;
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ get matches() { return motion; }, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("The sample cannot fetch"); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function frameOf(view: ReturnType<typeof render>) {
  const frame = view.container.querySelector("iframe")!;
  const spy = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  return { frame, spy };
}
function fromEmbed(frame: HTMLIFrameElement, data: unknown) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin, source: frame.contentWindow })); });
}

const portalLabel = (view: ReturnType<typeof render>) => view.container.querySelector('[data-attr="home-software-demo-portal"]')!.textContent;
const event = (portal: string, extra: Record<string, unknown> = {}) => ({ type: HOME_DEMO_EVENT, step: 1, done: false, typing: null, portal, phone: { label: "Jordan’s phone", items: [] }, ...extra });

describe("homepage Software demo", () => {
  it("renders the section as #dashboard, titled Software, with no chapter bar and no pause button, and no iframe until near", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    expect(view.container.querySelector("section#dashboard")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Software" })).toBeInTheDocument();
    // The one flow plays by itself: nothing to pick, nothing to pause.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: /(Play|Pause) demo/ })).toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();
    preload().emit();
    const frame = view.container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toMatch(/^\/demo\/home-embed\?/);
    expect(frame.getAttribute("src")).not.toContain("static=1");
    expect(frame.getAttribute("src")).not.toContain("chapter=");
  });

  it("keeps the Phone | Portal switch for a phone-sized screen", () => {
    render(<HomeSoftwareDemoPlayer />);
    expect(screen.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Portal" }));
    expect(screen.getByRole("button", { name: "Portal" })).toHaveAttribute("aria-pressed", "true");
  });

  it("draws the phone from what the embed reports, and ignores anything from another window", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame } = frameOf(view);
    fromEmbed(frame, event("resident", { step: 3, phone: { label: "Jordan’s phone", items: [{ kind: "out", text: "Hey, any houses?" }, { kind: "listings", ids: ["prop-willow"] }] } }));
    expect(screen.getByText("Hey, any houses?")).toBeInTheDocument();
    expect(screen.getByText("Willow Court")).toBeInTheDocument();
    expect(screen.getAllByText("Jordan’s phone").length).toBeGreaterThan(0);
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: event("resident", { phone: { label: "x", items: [{ kind: "out", text: "Forged" }] } }), origin: "https://evil.example", source: frame.contentWindow })); });
    expect(screen.queryByText("Forged")).toBeNull();
  });

  it("names the portal on screen beside Sample data, from what the embed reports", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame } = frameOf(view);
    // The journey opens in the prospect's own (resident) portal.
    expect(portalLabel(view)).toBe("Resident portal · Sample data");
    fromEmbed(frame, event("manager"));
    expect(portalLabel(view)).toBe("Manager portal · Sample data");
    fromEmbed(frame, event("vendor", { phone: { label: "Vendor’s phone", items: [] } }));
    expect(portalLabel(view)).toBe("Vendor portal · Sample data");
    expect(screen.getAllByText("Vendor’s phone").length).toBeGreaterThan(0);
    // An event with a forged portal leaves the label alone.
    fromEmbed(frame, event("owner"));
    expect(portalLabel(view)).toBe("Vendor portal · Sample data");
  });

  it("starts the embed and holds it on hover and when it leaves the screen, and resumes", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fromEmbed(frame, { type: HOME_DEMO_READY });
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "play" }, window.location.origin);
    const section = view.container.querySelector("section")!;
    expect(section).toHaveAttribute("data-playing", "true");
    fireEvent.mouseEnter(section);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "pause" }, window.location.origin);
    fireEvent.mouseLeave(section);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "play" }, window.location.origin);
    viewport().emit(0.1);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "pause" }, window.location.origin);
  });

  it("a press inside the portal pauses it, and moving off the section lets the journey go on (there is no pause button)", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    const section = view.container.querySelector("section")!;
    fromEmbed(frame, { type: HOME_DEMO_INTERACT });
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "pause" }, window.location.origin);
    expect(section).toHaveAttribute("data-playing", "false");
    fireEvent.mouseLeave(section);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "play" }, window.location.origin);
  });

  it("loops: once the journey has finished and held, the embed is told to start it over", () => {
    vi.useFakeTimers();
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fromEmbed(frame, event("manager", { step: 60, done: true, phone: { label: "Vendor’s phone", items: [] } }));
    act(() => { vi.advanceTimersByTime(3300); });
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "restart" }, window.location.origin);
    vi.useRealTimers();
  });

  it("reduced motion: a static embed, no autoplay, and the journey's end frame (manager portal, vendor's phone)", () => {
    motion = true;
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    expect(view.container.querySelector("iframe")!.getAttribute("src")).toContain("static=1");
    expect(view.container.querySelector("section")).toHaveAttribute("data-playing", "false");
    // Before the embed reports, the phone already shows the finished journey: the vendor's YES and the reply.
    expect(screen.getByText("It’s yours. We’ll send you the details.")).toBeInTheDocument();
    expect(portalLabel(view)).toBe("Manager portal · Sample data");
  });
});
