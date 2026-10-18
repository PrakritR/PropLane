// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeScrollStage, useHomeStageVisibility } from "@/components/marketing/home-scroll-stage";

class Observer {
  static instances: Observer[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: IntersectionObserverCallback, public options: IntersectionObserverInit) {
    Observer.instances.push(this);
  }
  emit(intersecting = true) {
    act(() => this.callback([{ isIntersecting: intersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
}

let reduced = false;
let position = 0;
const listeners = new Set<() => void>();
const scrollTo = vi.fn();
function Content({ name }: { name: string }) {
  const state = useHomeStageVisibility();
  return <div><button>{name} action</button><output data-testid={`${name}-state`}>{JSON.stringify(state)}</output></div>;
}
const steps = [
  { id: "one", label: "First", content: <Content name="First" /> },
  { id: "two", label: "Second", content: <Content name="Second" /> },
  { id: "three", label: "Second", content: <Content name="Third" /> },
];
const stage = () => <HomeScrollStage id="how" title="Our story" steps={steps} />;
function stepObserver() { return Observer.instances.findLast((observer) => observer.options.threshold === 0)!; }

beforeEach(() => {
  reduced = false;
  position = 0;
  listeners.clear();
  Observer.instances = [];
  scrollTo.mockClear();
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("innerHeight", 1000);
  vi.stubGlobal("scrollY", 200);
  vi.stubGlobal("scrollTo", scrollTo);
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return reduced; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = 100 + (Number(this.dataset.step ?? 0) - position) * 800;
    return { top, bottom: top + 800, left: 0, right: 400, width: 400, height: 800, x: 0, y: top, toJSON: () => ({}) };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("homepage native scroll stages", () => {
  it("ships every scene and usable anchor destinations without JavaScript", () => {
    const html = renderToStaticMarkup(stage());
    expect(html).toContain('data-enhanced="false"');
    for (const step of steps) expect(html).toContain(`id="how-${step.id}"`);
    expect(html).toContain("Third action");
    expect(html).not.toContain("inert=");
    expect(html).not.toContain('aria-hidden="true"');
    expect(Observer.instances).toHaveLength(0);
  });

  it("tracks forward and reverse scroll from geometry, with inactive controls inert", () => {
    const { container } = render(stage());
    const scenes = container.querySelectorAll(".home-stage-scene");
    expect(screen.getByRole("button", { name: "First action" })).toBeInTheDocument();
    expect(scenes[1]).toHaveAttribute("inert");
    expect(stepObserver().options.rootMargin).toBe("-499px 0px -499px 0px");
    position = 2;
    stepObserver().emit();
    expect(scenes[2]).not.toHaveAttribute("inert");
    expect(scenes[0]).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "First action" })).toBeNull();
    expect(screen.getByRole("link", { name: "Second" })).toHaveAttribute("aria-current", "step");
    expect(screen.getAllByRole("link")).toHaveLength(2);
    position = 0;
    stepObserver().emit(false);
    expect(scenes[0]).not.toHaveAttribute("inert");
    expect(screen.getByRole("link", { name: "First" })).toHaveAttribute("aria-current", "step");
  });

  it("uses smooth native scrolling for plain rail clicks and preserves modified links", () => {
    render(stage());
    const link = screen.getByRole("link", { name: "Second" });
    expect(link).toHaveAttribute("href", "#how-two");
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      expect(fireEvent.click(link, { [key]: true })).toBe(true);
    }
    expect(scrollTo).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(scrollTo).toHaveBeenCalledWith({ top: 620, behavior: "smooth" });
  });

  it("shares proximity and restores all readable scenes when reduced motion changes", () => {
    const { container } = render(stage());
    const proximity = Observer.instances[0];
    proximity.emit();
    expect(screen.getByTestId("First-state")).toHaveTextContent('"near":true');
    proximity.emit(false);
    expect(screen.getByTestId("First-state")).toHaveTextContent('"near":false');
    const scrolling = stepObserver();
    act(() => { reduced = true; listeners.forEach((listener) => listener()); });
    expect(container.querySelector("section")).toHaveAttribute("data-enhanced", "false");
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(container.querySelector("[inert]")).toBeNull();
    expect(container.querySelector(".home-stage-markers")).toBeNull();
    expect(container.querySelector("#how-three")).toBeInTheDocument();
    expect(scrolling.disconnect).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Second" }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("starts static with reduced motion or without observer support", () => {
    reduced = true;
    const first = render(stage());
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(Observer.instances).toHaveLength(1);
    first.unmount();
    vi.stubGlobal("IntersectionObserver", undefined);
    reduced = false;
    render(stage());
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(Observer.instances).toHaveLength(1);
  });

  it("can stack real panels on phones and restore the native stage at desktop widths", () => {
    let desktop = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query === "(min-width: 861px)" && desktop; },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    const { container } = render(<HomeScrollStage id="dashboard" title="The software" steps={steps} enhanceOnMobile={false} />);
    expect(container.querySelector("section")).toHaveAttribute("data-enhanced", "false");
    expect(screen.getAllByRole("button")).toHaveLength(3);
    act(() => { desktop = true; listeners.forEach((listener) => listener()); });
    expect(container.querySelector("section")).toHaveAttribute("data-enhanced", "true");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    act(() => { desktop = false; listeners.forEach((listener) => listener()); });
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("recomputes the activation band on resize and cleans observers and listeners", () => {
    const { unmount } = render(stage());
    const old = stepObserver();
    vi.stubGlobal("innerHeight", 800);
    fireEvent(window, new Event("resize"));
    expect(old.disconnect).toHaveBeenCalledOnce();
    expect(stepObserver().options.rootMargin).toBe("-399px 0px -399px 0px");
    unmount();
    expect(listeners.size).toBe(0);
    expect(Observer.instances.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
    const count = Observer.instances.length;
    fireEvent(window, new Event("resize"));
    expect(Observer.instances).toHaveLength(count);
  });
});
