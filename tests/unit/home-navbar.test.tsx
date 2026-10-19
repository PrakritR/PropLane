// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeNavbar } from "@/components/layout/home-navbar";
import { PublicNavbar } from "@/components/layout/public-navbar";
import { publicTextingConfig } from "@/lib/marketing/public-texting";

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@/components/marketing/fonts/home-swiss-font", () => ({ homeSwissFont: { variable: "swiss-font" } }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => { throw new Error("Public navigation must not initialize auth"); } }));
let observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit }[] = [];
const observe = vi.fn();
const disconnect = vi.fn();
const texting = publicTextingConfig("+12025550123");
const desktopPaths = ["/#how", "/#dashboard", "/#service", "/#pricing", "/#contact"];

beforeEach(() => {
  route.pathname = "/";
  observers = [];
  observe.mockClear(); disconnect.mockClear();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { observers.push({ callback, options }); }
    observe = observe; disconnect = disconnect;
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const update = (id: string, isIntersecting: boolean, bottom: number) => act(() => {
  observers.find((observer) => !observer.options?.rootMargin)!.callback([{ target: document.getElementById(id), isIntersecting, boundingClientRect: { bottom } } as IntersectionObserverEntry], {} as IntersectionObserver);
});

describe("simple public navigation", () => {
  it("uses five direct links, then Start free and Portal at the far right on the homepage, without auth or menus", () => {
    render(<PublicNavbar texting={texting} />);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(desktopPaths);
    // The homepage cover's own button texts the number (captain #19), so the bar offers Start free.
    const text = document.querySelector('[data-attr="home-nav-text-desktop"]')!;
    expect(text).toHaveAttribute("href", "/auth/create-account");
    expect(text).toHaveTextContent("Start free");
    expect(document.querySelector('[data-attr="home-nav-text-mobile"]')).toHaveTextContent("Start free");
    expect(text.nextElementSibling).toHaveTextContent("Portal");
    expect(screen.getByRole("link", { name: "Portal" })).toHaveAttribute("href", "/auth/sign-in");
    expect(screen.queryByRole("button", { name: /search|pricing|why proplane|product|resources/i })).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });

  it("uses the same simple bar and real pricing route on other public pages", () => {
    route.pathname = "/blog";
    render(<PublicNavbar texting={texting} />);
    expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/#pricing");
    expect(document.querySelector('[data-attr="home-nav-text-desktop"]')).toHaveAttribute("href", texting.smsHref);
    expect(document.querySelector('[data-attr="home-nav-text-desktop"]')).toHaveTextContent("(202) 555-0123");
    expect(screen.getByRole("link", { name: "Portal" })).toHaveAttribute("href", "/auth/sign-in");
    expect(screen.queryByRole("button", { name: /resources|product/i })).not.toBeInTheDocument();
  });

  it("offers Start free when no shared number is configured", () => {
    render(<HomeNavbar texting={{ phone: null, smsHref: null }} />);
    for (const link of screen.getAllByRole("link", { name: "Start free" })) expect(link).toHaveAttribute("href", "/auth/create-account");
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it("shows the sticky number after the hero, including while contact is in view", () => {
    render(<><section id="home-hero" /><section id="home-close" /><HomeNavbar texting={texting} /></>);
    expect(observe).toHaveBeenCalledWith(document.getElementById("home-hero"));
    update("home-hero", false, 900);
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toBeNull();
    update("home-hero", false, -1);
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toHaveAttribute("aria-label", "Text (202) 555-0123");
    expect(document.querySelector('[data-attr="home-nav-text-desktop"]')).toHaveTextContent("Start free");
    update("home-close", true, 700);
    expect(document.querySelector('[data-attr="home-sticky-text"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toHaveAttribute("href", texting.smsHref);
    update("home-hero", true, 500);
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toBeNull();
  });

  it("observes a streamed hero when it arrives", async () => {
    const view = render(<HomeNavbar texting={texting} />);
    expect(observe).not.toHaveBeenCalled();
    view.rerender(<><HomeNavbar texting={texting} /><section id="home-hero" /><section id="home-close" /></>);
    await waitFor(() => expect(observe).toHaveBeenCalledWith(document.getElementById("home-hero")));
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("opens the section anchors and Blog in the phone sheet, hides the sticky bar, and closes after navigation", async () => {
    render(<><section id="home-hero" /><section id="home-close" /><HomeNavbar texting={texting} /></>);
    update("home-hero", false, -1);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const sheet = await screen.findByRole("dialog", { name: "PropLane" }, { timeout: 5000 });
    expect(document.querySelector('[data-attr="home-sticky-text"]')).toBeNull();
    expect(within(within(sheet).getByRole("navigation")).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([...desktopPaths, "/blog", "/auth/sign-in"]);
    expect(within(sheet).getByRole("link", { name: "Text (202) 555-0123" })).toHaveAttribute("href", texting.smsHref);
    fireEvent.click(within(sheet).getByRole("link", { name: "Pricing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("highlights the current section as the reader scrolls in either direction", () => {
    render(<><section id="home-hero" /><section id="how" /><section id="dashboard" /><section id="service" /><section id="pricing" /><section id="contact" /><HomeNavbar texting={texting} /></>);
    const activeObserver = observers.find((observer) => observer.options?.rootMargin)!;
    const active = (id: string) => act(() => activeObserver.callback([{ target: document.getElementById(id), isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    active("pricing");
    expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("aria-current", "location");
    active("dashboard");
    expect(screen.getByRole("link", { name: "Software" })).toHaveAttribute("aria-current", "location");
    active("how");
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("aria-current", "location");
    expect(screen.getByRole("link", { name: "Pricing" })).not.toHaveAttribute("aria-current");
    update("home-hero", true, 700);
    expect(screen.getByRole("link", { name: "How it works" })).not.toHaveAttribute("aria-current");
  });

  it("sizes the active band from viewport height and reobserves sections on resize", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("innerWidth", 1920);
    const view = render(<><section id="how" /><section id="dashboard" /><HomeNavbar texting={texting} /></>);
    expect(observers.at(-1)?.options?.rootMargin).toBe("-160px 0px -520px 0px");
    observe.mockClear();
    vi.stubGlobal("innerHeight", 600);
    fireEvent(window, new Event("resize"));
    expect(observers.at(-1)?.options?.rootMargin).toBe("-120px 0px -390px 0px");
    expect(observe).toHaveBeenCalledWith(document.getElementById("how"));
    expect(observe).toHaveBeenCalledWith(document.getElementById("dashboard"));
    expect(disconnect).toHaveBeenCalledTimes(1);
    view.unmount();
    const observerCount = observers.length;
    fireEvent(window, new Event("resize"));
    expect(observers).toHaveLength(observerCount);
  });

  it("closes the phone sheet with Escape and restores trigger focus", async () => {
    render(<HomeNavbar texting={texting} />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    trigger.focus(); fireEvent.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "PropLane" }, { timeout: 5000 });
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
