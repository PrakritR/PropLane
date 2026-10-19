// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeSoftwareDemoPlayer } from "@/components/marketing/home-software-demo-player";
import { HOME_DEMO_CONTROL, HOME_DEMO_EVENT, HOME_DEMO_INTERACT } from "@/lib/demo/home-demo-embed";

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

describe("homepage Software demo", () => {
  it("renders the section as #dashboard, titled Software, with three chapters and no iframe until near", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    expect(view.container.querySelector("section#dashboard")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Software" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["01Find a house", "02Vendor gets work", "03Photo by text"]);
    expect(view.container.querySelector("iframe")).toBeNull();
    preload().emit();
    const frame = view.container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toMatch(/^\/demo\/home-embed\?chapter=find/);
    expect(frame.getAttribute("src")).not.toContain("static=1");
  });

  it("draws the phone from what the embed reports, and ignores anything from another window or chapter", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame } = frameOf(view);
    fromEmbed(frame, { type: HOME_DEMO_EVENT, chapter: "find", step: 3, done: false, typing: null, phone: { label: "Prospect’s phone", items: [{ kind: "out", text: "Hey, any houses?" }, { kind: "listings", ids: ["prop-willow"] }] } });
    expect(screen.getByText("Hey, any houses?")).toBeInTheDocument();
    expect(screen.getByText("Willow Court")).toBeInTheDocument();
    fromEmbed(frame, { type: HOME_DEMO_EVENT, chapter: "photo", step: 1, done: false, typing: null, phone: { label: "Resident’s phone", items: [{ kind: "out", text: "Wrong chapter" }] } });
    expect(screen.queryByText("Wrong chapter")).toBeNull();
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: { type: HOME_DEMO_EVENT, chapter: "find", step: 4, done: false, typing: null, phone: { label: "x", items: [{ kind: "out", text: "Forged" }] } }, origin: "https://evil.example", source: frame.contentWindow })); });
    expect(screen.queryByText("Forged")).toBeNull();
  });

  it("selects a chapter by message once the embed has loaded", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { spy } = frameOf(view);
    fireEvent.click(screen.getByRole("tab", { name: /Vendor gets work/ }));
    expect(spy).toHaveBeenCalledWith({ type: HOME_DEMO_CONTROL, action: "select", chapter: "vendor" }, window.location.origin);
    expect(screen.getByRole("tab", { name: /Vendor gets work/ })).toHaveAttribute("aria-selected", "true");
  });

  it("pauses the embed on hover and when it leaves the screen, and resumes", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { spy } = frameOf(view);
    const section = view.container.querySelector("section")!;
    expect(section).toHaveAttribute("data-playing", "true");
    fireEvent.mouseEnter(section);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "pause" }, window.location.origin);
    fireEvent.mouseLeave(section);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "play" }, window.location.origin);
    viewport().emit(0.1);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "pause" }, window.location.origin);
  });

  it("a press inside the portal pauses and leaves a visible Play control that resumes", () => {
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fromEmbed(frame, { type: HOME_DEMO_INTERACT });
    const play = screen.getByRole("button", { name: "Play demo" });
    expect(play).toBeVisible();
    fireEvent.click(play);
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "play" }, window.location.origin);
    expect(screen.getByRole("button", { name: "Pause demo" })).toBeInTheDocument();
  });

  it("moves to the next chapter after one finishes, and loops", () => {
    vi.useFakeTimers();
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    const { frame, spy } = frameOf(view);
    fromEmbed(frame, { type: HOME_DEMO_EVENT, chapter: "find", step: 15, done: true, typing: null, phone: { label: "Prospect’s phone", items: [] } });
    act(() => { vi.advanceTimersByTime(3300); });
    expect(spy).toHaveBeenLastCalledWith({ type: HOME_DEMO_CONTROL, action: "select", chapter: "vendor" }, window.location.origin);
    vi.useRealTimers();
  });

  it("reduced motion: a static embed, no play button, no autoplay, chapters show their end state", () => {
    motion = true;
    const view = render(<HomeSoftwareDemoPlayer />);
    preload().emit(); viewport().emit();
    expect(view.container.querySelector("iframe")!.getAttribute("src")).toContain("static=1");
    expect(screen.queryByRole("button", { name: /(Play|Pause) demo/ })).toBeNull();
    expect(view.container.querySelector("section")).toHaveAttribute("data-playing", "false");
    // Before the embed reports, the phone already shows the chapter's finished thread.
    expect(screen.getByText("Your tour at 61 Willow Court is tomorrow at 5:30 PM. Reply C to reschedule.")).toBeInTheDocument();
  });
});
