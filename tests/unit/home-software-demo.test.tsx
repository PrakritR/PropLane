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
/** Whether the visitor's pointer can hover. A tap on a touch screen emits mouse events with no mouseleave. */
let hoverCapable = true;
const preload = () => Observer.instances.find((o) => o.options.rootMargin === "300px")!;
const viewport = () => Observer.instances.find((o) => Array.isArray(o.options.threshold))!;

beforeEach(() => {
  Observer.instances = [];
  motion = false;
  hoverCapable = true;
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query.includes("hover") ? hoverCapable : motion; },
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
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

/** The last jump the player posted (it may be followed by a play/pause once the hold lifts). */
const lastJump = (spy: { mock: { calls: unknown[][] } }) => [...spy.mock.calls].reverse().map((call) => call[0] as { action?: string }).find((message) => message.action === "jump");

/** The switcher's active segment (the portal on screen). */
const portalLabel = (_view: ReturnType<typeof render>) => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")!.textContent;
const event = (portal: string, extra: Record<string, unknown> = {}) => ({ type: HOME_DEMO_EVENT, step: 1, done: false, typing: null, portal, phone: { label: "Jordan’s phone", items: [] }, ...extra });

describe("homepage Software demo", () => {
  it("renders the section as #dashboard, titled Software, with no chapter bar and no pause button, and no iframe until near", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    expect(view.container.querySelector("section#dashboard")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Software" })).toBeInTheDocument();
    // The one flow plays by itself: no chapter bar, nothing to pause. The only tabs are the three portals.
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Resident", "Property", "Vendor"]);
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

  it("the switcher marks the portal on screen, from what the embed reports", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame } = frameOf(view);
    // The journey opens in the prospect's own (resident) portal.
    expect(portalLabel(view)).toBe("Resident");
    fromEmbed(frame, event("manager"));
    expect(portalLabel(view)).toBe("Property");
    fromEmbed(frame, event("vendor", { phone: { label: "Vendor’s phone", items: [] } }));
    expect(portalLabel(view)).toBe("Vendor");
    expect(screen.getAllByText("Vendor’s phone").length).toBeGreaterThan(0);
    // An event with a forged portal leaves the label alone.
    fromEmbed(frame, event("owner"));
    expect(portalLabel(view)).toBe("Vendor");
  });

  it("shows no 'Sample …' label anywhere (captain #24)", () => {
    const { container } = render(<HomeSoftwareDemoPlayer />);
    expect(container).not.toHaveTextContent(/Sample/);
  });

  it("choosing a portal jumps the run to that portal's first step, switches the phone view to Portal, and the phone follows", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fromEmbed(frame, { type: HOME_DEMO_READY });
    fireEvent.mouseEnter(view.container.querySelector("section")!);
    fireEvent.click(screen.getByRole("tab", { name: "Vendor" }));
    // Hovering the section held the run; choosing a portal lets it go on, so the jump is not paused.
    expect(lastJump(spy)).toEqual({ type: HOME_DEMO_CONTROL, action: "jump", portal: "vendor", paused: false });
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "play" }, window.location.origin);
    expect(screen.getByRole("tab", { name: "Vendor" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Portal" })).toHaveAttribute("aria-pressed", "true");
    expect(view.container.querySelector("section")).toHaveAttribute("data-playing", "true");
    expect(screen.getAllByText("Vendor’s phone").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Property" }));
    expect(lastJump(spy)).toEqual({ type: HOME_DEMO_CONTROL, action: "jump", portal: "manager", paused: false });
    expect(screen.getByRole("tab", { name: "Property" })).toHaveAttribute("data-attr", "home-demo-portal-property");
  });

  it("a portal chosen before the embed's listener is up is sent when it says it is ready", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fireEvent.click(screen.getByRole("tab", { name: "Vendor" }));
    expect(lastJump(spy)).toBeUndefined();
    fromEmbed(frame, { type: HOME_DEMO_READY });
    expect(lastJump(spy)).toEqual({ type: HOME_DEMO_CONTROL, action: "jump", portal: "vendor", paused: false });
  });

  it("the switcher is a tablist with roving focus and arrow keys", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fromEmbed(frame, { type: HOME_DEMO_READY });
    expect(screen.getByRole("tab", { name: "Resident" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Vendor" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Resident" }), { key: "ArrowRight" });
    expect(lastJump(spy)).toMatchObject({ portal: "manager" });
    expect(screen.getByRole("tab", { name: "Property" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Property" }), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Resident" }), { key: "ArrowLeft" });
    expect(lastJump(spy)).toMatchObject({ portal: "vendor" });
    // Focus inside the switcher does not hold the run.
    expect(view.container.querySelector("section")).toHaveAttribute("data-playing", "true");
    fromEmbed(frame, event("resident"));
    expect(screen.getByRole("tab", { name: "Resident" })).toHaveAttribute("aria-selected", "true");
  });

  it("reduced motion: choosing a portal draws the end of that portal's part (no autoplay), and the phone follows", () => {
    motion = true;
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fromEmbed(frame, { type: HOME_DEMO_READY });
    fireEvent.click(screen.getByRole("tab", { name: "Resident" }));
    expect(lastJump(spy)).toEqual({ type: HOME_DEMO_CONTROL, action: "jump", portal: "resident", paused: true });
    expect(screen.getByRole("tab", { name: "Resident" })).toHaveAttribute("aria-selected", "true");
    expect(view.container.querySelector("section")).toHaveAttribute("data-playing", "false");
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

  it("a tap on a touch screen never leaves the journey paused for good", () => {
    // A tap fires mouseenter/mousemove with no mouseleave behind it, so a hover pause on a phone or a hybrid
    // laptop stuck the Software demo until the visitor happened to tap a portal segment.
    hoverCapable = false;
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fromEmbed(frame, { type: HOME_DEMO_READY });
    const section = view.container.querySelector("section")!;
    fireEvent.mouseEnter(section);
    fireEvent.mouseMove(view.container.querySelector(".home-software-demo-body")!);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "play" }, window.location.origin);
    expect(section).toHaveAttribute("data-playing", "true");
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
    expect(portalLabel(view)).toBe("Property");
  });
});
