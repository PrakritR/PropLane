// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeNumberStage } from "@/components/marketing/home-number-stage";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import { PROPERTY_ROWS } from "@/components/marketing/site/product-mock/fixtures";

class Observer {
  static instances: Observer[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: IntersectionObserverCallback, public options: IntersectionObserverInit) { Observer.instances.push(this); }
  emit() { act(() => this.callback([], this as unknown as IntersectionObserver)); }
}
let position = 0;
let reduced = false;
const number = { phone: "+12065550123", smsHref: "sms:+12065550123?body=Hi%20PropLane" };
const stage = () => <PublicTextingProvider value={number}><HomeNumberStage /></PublicTextingProvider>;
beforeEach(() => {
  position = 0;
  reduced = false;
  Observer.instances = [];
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("innerHeight", 1000);
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = 100 + (Number(this.dataset.step ?? 0) - position) * 800;
    return { top, bottom: top + 800, left: 0, right: 400, width: 400, height: 800, x: 0, y: top, toJSON: () => ({}) };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Swiss number story", () => {
  it("ships exactly five readable beats and a real configured-number network without JavaScript", () => {
    const html = renderToStaticMarkup(stage());
    expect(html.match(/class="home-stage-scene"/g)).toHaveLength(5);
    for (const id of ["prospects", "residents", "vendors", "owners", "homes"]) expect(html).toContain(`id="how-${id}"`);
    expect(html).toContain("How it works");
    expect(html).toContain("October rent is due Oct 1");
    expect(html).toContain("Owner share");
    for (const home of PROPERTY_ROWS.slice(0, 3)) expect(html).toContain(home.title);
    expect(html).toContain(number.smsHref.replaceAll("&", "&amp;"));
    expect(html).not.toMatch(/Renters|renters|inert=/);
  });

  it("keeps the visible conversation, role rail, and caption on the same beat in both directions", () => {
    const { container } = render(stage());
    const observer = Observer.instances.findLast((entry) => entry.options.threshold === 0)!;
    const visible = () => container.querySelector('.home-stage-scene[data-active="true"]') as HTMLElement;
    expect(screen.getByRole("link", { name: /Prospects/ })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("link", { name: /Prospects/ })).toHaveAccessibleName("01 Prospects Ask about a room. Book the tour.");
    expect(visible()).toHaveTextContent("Could I tour it Thursday?");
    position = 1;
    observer.emit();
    expect(screen.getByRole("link", { name: /Residents/ })).toHaveAttribute("aria-current", "step");
    expect(within(visible()).getByRole("region", { name: "Resident’s phone Messages conversation" })).toBeInTheDocument();
    expect(visible()).toHaveTextContent("October rent is due Oct 1");
    expect(visible()).toHaveTextContent("Paid! The kitchen faucet is leaking");
    expect(visible()).not.toHaveTextContent("Could I tour");
    expect(container.querySelector(".home-stage-mobile-caption")).toHaveTextContent("Pay rent. Report a leak.");
    position = 2;
    observer.emit();
    expect(visible()).toHaveTextContent("$180");
    expect(visible()).not.toHaveTextContent("October rent");
    position = 4;
    observer.emit();
    expect(within(visible()).getByRole("img", { name: /3 homes connected to prospects/ })).toBeInTheDocument();
    expect(within(visible()).getByRole("link", { name: /Text/ })).toHaveAttribute("href", number.smsHref);
    position = 0;
    observer.emit();
    expect(screen.getByRole("link", { name: /Prospects/ })).toHaveAttribute("aria-current", "step");
    expect(visible()).toHaveTextContent("Could I tour it Thursday?");
    expect(visible()).not.toHaveTextContent("October rent");
  });

  it("keeps every phone readable with reduced motion and never invents an unavailable number", () => {
    reduced = true;
    const { container } = render(<HomeNumberStage />);
    expect(container.querySelector("[inert]")).toBeNull();
    expect(screen.getAllByRole("region", { name: /Messages conversation/ })).toHaveLength(4);
    expect(container.querySelector('[data-attr="home-network-number"]')).toBeNull();
    expect(container.querySelector(".swiss-network-hub")).toHaveTextContent("PropLane · One number");
  });

  it("reveals the active phone rail item horizontally without scrolling the document", () => {
    const documentScroll = vi.fn();
    vi.stubGlobal("scrollTo", documentScroll);
    const { container } = render(stage());
    const nav = screen.getByRole("navigation", { name: "Texting story sections" });
    const last = screen.getByRole("link", { name: /Every home/ });
    Object.defineProperties(nav, { clientWidth: { value: 343 }, scrollWidth: { value: 480 } });
    Object.defineProperty(nav, "getBoundingClientRect", { value: () => ({ left: 16, width: 343 }) });
    Object.defineProperty(last, "getBoundingClientRect", { value: () => ({ left: 390, width: 90 }) });
    position = 4;
    Observer.instances.findLast((entry) => entry.options.threshold === 0)!.emit();
    expect(nav.scrollLeft).toBe(247.5);
    expect(container.querySelector('.home-stage-scene[data-active="true"]')).toHaveTextContent("Sample homes");
    expect(documentScroll).not.toHaveBeenCalled();
  });
});
