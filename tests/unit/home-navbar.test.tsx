// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeNavbar } from "@/components/layout/home-navbar";
import { PublicFooterRoute } from "@/components/layout/public-footer-route";
import { PublicFooter } from "@/components/layout/public-footer";
import { PublicNavbar } from "@/components/layout/public-navbar";

const { route } = vi.hoisted(() => ({ route: { pathname: "/" } }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => { throw new Error("Home must not initialize auth"); } }));
let intersection: IntersectionObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();
const texting = { phone: "+12025550123", smsHref: "sms:+12025550123?body=Hi%20PropLane%2C%20show%20me%20the%20demo" };

beforeEach(() => {
  route.pathname = "/";
  observe.mockClear(); disconnect.mockClear();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("lightweight homepage chrome", () => {
  it("uses the lightweight home bar through the public wrapper without initializing auth", () => {
    render(<PublicNavbar texting={texting} />);
    expect(screen.getByRole("link", { name: "Text us" })).toHaveAttribute("href", texting.smsHref);
    expect(screen.queryByRole("button", { name: /resources/i })).not.toBeInTheDocument();
  });

  it("links phone visitors to the configured number and desktop visitors to the hero text panel", () => {
    render(<HomeNavbar texting={texting} />);
    expect(screen.getByRole("link", { name: "Text us" })).toHaveAttribute("href", texting.smsHref);
    expect(screen.getByRole("link", { name: "Text PropLane" })).toHaveAttribute("href", "#text-proplane");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth/sign-in");
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect([...nav.querySelectorAll(":scope > a")].map((link) => link.getAttribute("href"))).toEqual(["#how-it-works", "/service"]);
    expect(screen.queryByRole("button", { name: /search/i })).not.toBeInTheDocument();
  });

  it("opens Pricing and Why PropLane menus with every requested destination", () => {
    render(<HomeNavbar texting={texting} />);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const pricing = within(nav).getByText("Pricing", { selector: "summary" });
    fireEvent.click(pricing);
    expect(within(nav).getByRole("link", { name: "Software" })).toHaveAttribute("href", "/pricing");
    expect(within(nav).getByRole("link", { name: "Managed service" })).toHaveAttribute("href", "/pricing/service");
    fireEvent.click(within(nav).getByText("Why PropLane", { selector: "summary" }));
    for (const [name, href] of [["Overview", "/why-proplane"], ["Our track record", "/why-proplane/track-record"], ["How we manage", "/why-proplane/how-we-manage"], ["The software", "/why-proplane/software"]]) {
      expect(within(nav).getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(pricing.closest("details")?.nextElementSibling).toHaveAttribute("href", "/service");
  });

  it("closes an open home dropdown on Escape or an outside pointer and restores keyboard focus", () => {
    render(<HomeNavbar texting={texting} />);
    const summary = screen.getByText("Pricing", { selector: "summary" });
    const disclosure = summary.closest("details")!;
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute("open");
    const software = screen.getByRole("link", { name: "Software" });
    software.focus();
    fireEvent.keyDown(software, { key: "Escape" });
    expect(disclosure).not.toHaveAttribute("open");
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    fireEvent.pointerDown(document.body);
    expect(disclosure).not.toHaveAttribute("open");
  });

  it("shows all Why PropLane destinations inside the phone sheet", async () => {
    render(<HomeNavbar texting={texting} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const sheet = await screen.findByRole("dialog", { name: "PropLane" }, { timeout: 5000 });
    fireEvent.click(within(sheet).getByText("Why PropLane", { selector: "summary" }));
    for (const [name, href] of [["Overview", "/why-proplane"], ["Our track record", "/why-proplane/track-record"], ["How we manage", "/why-proplane/how-we-manage"], ["The software", "/why-proplane/software"]]) {
      expect(within(sheet).getByRole("link", { name })).toHaveAttribute("href", href);
    }
    fireEvent.click(within(sheet).getByRole("link", { name: "Overview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("uses Start free and a real signup link when the public number is unavailable", () => {
    render(<HomeNavbar texting={{ phone: null, smsHref: null }} />);
    expect(screen.queryByRole("link", { name: /Text/ })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "Start free" })) expect(link).toHaveAttribute("href", "/auth/create-account");
  });

  it("shows the bottom CTA only once the hero has passed above the viewport", () => {
    render(<><section id="home-hero">Hero</section><HomeNavbar texting={texting} /></>);
    expect(observe).toHaveBeenCalledWith(document.getElementById("home-hero"));
    const update = (isIntersecting: boolean, bottom: number) => act(() => {
      intersection([{ isIntersecting, boundingClientRect: { bottom } } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    update(false, 900);
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toBeNull();
    update(true, 500);
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toBeNull();
    update(false, -1);
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toHaveAttribute("href", texting.smsHref);
    update(true, 200);
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toBeNull();
  });

  it("attaches the observer when a streamed hero appears later", async () => {
    const view = render(<HomeNavbar texting={texting} />);
    expect(observe).not.toHaveBeenCalled();
    view.rerender(<><HomeNavbar texting={texting} /><section id="home-hero">Late hero</section></>);
    await waitFor(() => expect(observe).toHaveBeenCalledWith(document.getElementById("home-hero")));
  });

  it("opens an accessible full-height navigation sheet and closes after choosing a section", async () => {
    render(<HomeNavbar texting={texting} />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "PropLane" }, { timeout: 5000 });
    expect([...within(sheet).getByRole("navigation").querySelectorAll(":scope > a")].map((link) => link.getAttribute("href"))).toEqual(["#how-it-works", "/service", "/auth/sign-in"]);
    fireEvent.click(within(sheet).getByText("Pricing", { selector: "summary" }));
    expect(within(sheet).getByRole("link", { name: "Software" })).toHaveAttribute("href", "/pricing");
    expect(within(sheet).getByRole("link", { name: "Managed service" })).toHaveAttribute("href", "/pricing/service");
    fireEvent.click(within(sheet).getByRole("link", { name: "Managed service" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("gives every home footer anchor a minimum touch width", () => {
    const { container } = render(<PublicFooter />);
    const footer = container.querySelector("[data-home-footer]");
    expect(footer).toHaveClass("[&_a]:min-w-11");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveClass("min-h-12");
  });

  it("retains the full footer for other public pages", () => {
    const view = render(<PublicFooterRoute home={<span>Compact home footer</span>}><span>Full public footer</span></PublicFooterRoute>);
    expect(screen.getByText("Compact home footer")).toBeInTheDocument();
    expect(screen.queryByText("Full public footer")).not.toBeInTheDocument();
    route.pathname = "/features";
    view.rerender(<PublicFooterRoute home={<span>Compact home footer</span>}><span>Full public footer</span></PublicFooterRoute>);
    expect(screen.getByText("Full public footer")).toBeInTheDocument();
    expect(screen.queryByText("Compact home footer")).not.toBeInTheDocument();
  });

  it("closes the menu with Escape and restores focus to its trigger", async () => {
    render(<HomeNavbar texting={texting} />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    trigger.focus();
    fireEvent.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "PropLane" }, { timeout: 5000 });
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
