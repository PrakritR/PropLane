// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeSoftwareDemoPlayer } from "@/components/marketing/home-software-demo-player";
import { SOFTWARE_DEMO_SCENE_MS, type SoftwareDemoScene } from "@/components/marketing/home-software-demo-scenes";

const approval = vi.hoisted(() => vi.fn());
vi.mock("@/components/marketing/home-iphone-phone", () => ({ HomeIphonePhone: ({ items }: { items: { text?: string }[] }) => <div>{items.map((item, index) => <p key={index}>{item.text}</p>)}</div> }));
vi.mock("@/components/marketing/home-software-demo-panels", () => ({ default: function Panels({ scene, onReady, onApprove }: { scene: SoftwareDemoScene; onReady(id: SoftwareDemoScene): void; onApprove(): void }) {
  useEffect(() => onReady(scene), [scene, onReady]);
  return <div data-testid="real-panel">{scene}{scene === "approve" && <button data-demo-target="comm-approve" onClick={() => { approval(); onApprove(); }}>Send approved draft</button>}</div>;
} }));
class Observer {
  static instances: Observer[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: IntersectionObserverCallback, public options: IntersectionObserverInit) { Observer.instances.push(this); }
  emit(ratio = 1) { act(() => this.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
}
let motion = false;
let hidden = false;
const motionListeners = new Set<() => void>();
const props = { request: "Can I tour?", draft: "Thursday at 5:30.", phoneScenes: Array.from({ length: 6 }, () => [{ kind: "out" as const, text: "Can I tour?" }]) };
const preload = () => Observer.instances.find((observer) => observer.options.rootMargin === "250px")!;
const viewport = () => Observer.instances.find((observer) => Array.isArray(observer.options.threshold))!;
const tick = async (ms = SOFTWARE_DEMO_SCENE_MS) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
async function mount() {
  const view = render(<HomeSoftwareDemoPlayer {...props} />);
  preload().emit();
  await act(async () => {});
  return { ...view, section: view.container.querySelector("section")! };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(window, "setTimeout"); motion = false; hidden = false; Observer.instances = []; motionListeners.clear(); approval.mockClear();
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("matchMedia", () => ({ get matches() { return motion; }, addEventListener: (_: string, fn: () => void) => motionListeners.add(fn), removeEventListener: (_: string, fn: () => void) => motionListeners.delete(fn) }));
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("The sample cannot fetch"); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("software story playback", () => {
  it("loads panels only nearby and plays the six ordered scenes through the real approval handler", async () => {
    const view = render(<HomeSoftwareDemoPlayer {...props} />);
    const section = view.container.querySelector("section")!;
    expect(screen.queryByTestId("real-panel")).toBeNull();
    await tick(20000);
    expect(section).toHaveAttribute("data-scene", "text");
    preload().emit(); await act(async () => {});
    viewport().emit(0.2); await tick();
    expect(section).toHaveAttribute("data-playing", "false");
    viewport().emit();
    for (const id of ["inbox", "draft", "approve", "tour", "paid"]) { await tick(); expect(section).toHaveAttribute("data-scene", id); }
    await tick();
    expect(section).toHaveAttribute("data-interactive", "true");
    expect(section).toHaveAttribute("data-scene", "paid");
    expect(section).toHaveAttribute("data-playing", "false");
    expect(approval).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pauses on hover and focus, resumes when both leave, and keeps explicit pause sticky", async () => {
    const { section } = await mount(); viewport().emit();
    fireEvent.mouseEnter(section); await tick(20000); expect(section).toHaveAttribute("data-scene", "text");
    fireEvent.focus(screen.getByRole("tab", { name: /Text arrives$/ }));
    fireEvent.mouseLeave(section); await tick(); expect(section).toHaveAttribute("data-scene", "text");
    fireEvent.blur(screen.getByRole("tab", { name: /Text arrives$/ }), { relatedTarget: document.body });
    await tick(); expect(section).toHaveAttribute("data-scene", "inbox");
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    await tick(20000); expect(section).toHaveAttribute("data-scene", "inbox");
    fireEvent.click(screen.getByRole("button", { name: "Play demo" }));
    await tick(); expect(section).toHaveAttribute("data-scene", "draft");
  });

  it("explicit Play resumes while its button retains focus, then a new focus interaction pauses", async () => {
    const { section } = await mount(); viewport().emit();
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    const play = screen.getByRole("button", { name: "Play demo" });
    act(() => play.focus()); fireEvent.mouseEnter(section); fireEvent.click(play);
    expect(play).toHaveFocus();
    await tick(); expect(section).toHaveAttribute("data-scene", "inbox");
    act(() => screen.getByRole("tab", { name: /Manager inbox$/ }).focus());
    await tick(15000); expect(section).toHaveAttribute("data-scene", "inbox");
  });

  it("stops offscreen and while the document is hidden, with no catch-up jump", async () => {
    const { section } = await mount(); viewport().emit(); await tick();
    viewport().emit(0); await tick(20000); expect(section).toHaveAttribute("data-scene", "inbox");
    viewport().emit(); act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    await tick(20000); expect(section).toHaveAttribute("data-scene", "inbox");
    act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    await tick(); expect(section).toHaveAttribute("data-scene", "draft");
  });

  it("provides static keyboard-selectable scenes without any timer under reduced motion", async () => {
    motion = true;
    const { section } = await mount(); viewport().emit();
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole("button", { name: /(?:Play|Pause) demo/ })).toBeNull();
    await tick(60000); expect(section).toHaveAttribute("data-scene", "text");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Text arrives$/ }), { key: "End" });
    expect(section).toHaveAttribute("data-scene", "paid");
    expect(screen.getByRole("tab", { name: /Rent paid$/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: /Rent paid$/ }), { key: "ArrowRight" });
    expect(section).toHaveAttribute("data-scene", "text");
    expect(window.setTimeout).not.toHaveBeenCalledWith(expect.any(Function), SOFTWARE_DEMO_SCENE_MS);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hands the same section to the selected portal and resumes the story explicitly", async () => {
    const { section } = await mount(); viewport().emit();
    fireEvent.click(screen.getByTestId("real-panel"));
    expect(section).toHaveAttribute("data-interactive", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Manager" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Resident" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Resident" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Vendor" })).toHaveFocus();
    expect(section).toHaveAttribute("id", "dashboard");
    expect(section).toHaveAttribute("data-interactive", "true");
    expect(screen.getByRole("tab", { name: "Vendor" })).toHaveAttribute("aria-selected", "true");
    await tick(20000); expect(section).toHaveAttribute("data-scene", "text");
    fireEvent.click(screen.getByRole("button", { name: "Play demo" }));
    expect(section).toHaveAttribute("data-interactive", "false");
    expect(screen.getByRole("tab", { name: "Manager" })).toHaveAttribute("aria-selected", "true");
    await tick(); expect(section).toHaveAttribute("data-scene", "inbox");
  });

  it("manual selection pauses autoplay and unmount cancels every scheduled advance", async () => {
    const { section, unmount } = await mount(); viewport().emit();
    fireEvent.click(screen.getByRole("tab", { name: /Tour booked$/ }));
    await tick(15000); expect(section).toHaveAttribute("data-scene", "tour");
    fireEvent.click(screen.getByRole("button", { name: "Play demo" }));
    unmount(); expect(vi.getTimerCount()).toBe(0); expect(motionListeners.size).toBe(0);
    expect(Observer.instances.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
  });
});
