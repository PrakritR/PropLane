// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeNumberStage, firstExchange } from "@/components/marketing/home-number-stage";
import { HomeSoftwareDemo, SOFTWARE_PORTALS } from "@/components/marketing/home-software-demo";
import { HomePricingCompare } from "@/components/marketing/home-pricing-compare";
import { HOME_COMPARE_ROWS, HOME_PLAN_COLUMNS, PLAN_CARD_POINTS, planCardPoints } from "@/components/marketing/home-pricing-compare-data";
import { HomeNavbar } from "@/components/layout/home-navbar";
import { HomeJoinFree } from "@/components/marketing/home-join-free";
import { publicTextingConfig } from "@/lib/marketing/public-texting";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";

class Observer {
  static instances: Observer[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: IntersectionObserverCallback, public options?: IntersectionObserverInit) { Observer.instances.push(this); }
}
beforeEach(() => {
  Observer.instances = [];
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
const number = { phone: "+12065550123", smsHref: "sms:+12065550123?body=Hi%20PropLane" };

describe("small-screen How it works (up to 1024px)", () => {
  it("lists the five roles in order, each with its caption and exactly two bubbles", () => {
    const { container } = render(<PublicTextingProvider value={number}><HomeNumberStage /></PublicTextingProvider>);
    const list = container.querySelector(".home-how-list") as HTMLElement;
    expect(within(list).getByRole("heading", { level: 2, name: "How it works" })).toBeInTheDocument();
    const roles = [...list.querySelectorAll(".home-how-role")];
    expect(roles.map((role) => role.querySelector("h3")!.textContent)).toEqual(["Prospects", "Residents", "Vendors", "Managers", "Owners"]);
    expect(roles.map((role) => role.querySelector(":scope > p")!.textContent)).toEqual([
      "Ask about a room. Book the tour.",
      "Pay rent. Report a leak.",
      "Accept the job. Keep everyone posted.",
      "Ask about your houses and prospects.",
      "Ask how your home is doing.",
    ]);
    for (const role of roles) expect(role.querySelectorAll(".home-how-bubble")).toHaveLength(2);
    // Derived from the desktop phones' own items: the prospect's first question and PropLane's first answer.
    expect(roles[0]).toHaveTextContent("Could I tour it Thursday?");
    expect(roles[3]).toHaveTextContent("Any new prospects for Willow Court?");
    expect(roles[3]).toHaveTextContent("2 new inquiries for Room 3.");
    expect(roles[4].querySelector(".home-how-bubble--out")).toHaveTextContent(/^How is .* doing\?$/);
  });

  it("has no phone frame, no network diagram and no Every home item in the list", () => {
    const { container } = render(<HomeNumberStage />);
    const list = container.querySelector(".home-how-list") as HTMLElement;
    expect(list.querySelector(".home-iphone, svg, .swiss-number-network")).toBeNull();
    expect(list).not.toHaveTextContent("Every home");
    expect(list).not.toHaveTextContent(/Sample/);
  });

  it("keeps the #how anchor on the wrapper and the desktop stage intact beside the list", () => {
    const { container } = render(<HomeNumberStage />);
    expect(container.querySelectorAll("#how")).toHaveLength(1);
    expect(container.querySelector("#how > .home-how-wide section.home-number-stage")).not.toBeNull();
    expect(container.querySelector("#how-owners")).not.toBeNull();
    expect(container.querySelector("#how-owners-list")).not.toBeNull();
    expect(container.querySelectorAll('.home-stage-scene')).toHaveLength(6);
  });

  it("firstExchange takes the first sent message and the first answer in thread order", () => {
    const items = [{ kind: "in", text: "a" }, { kind: "out", text: "b" }, { kind: "in", text: "c" }, { kind: "out", text: "d" }] as const;
    expect(firstExchange([...items]).map((item) => item.text)).toEqual(["a", "b"]);
    expect(firstExchange([{ kind: "out", text: "only" }]).map((item) => item.text)).toEqual(["only"]);
  });
});

describe("small-screen Software (up to 1024px)", () => {
  it("shows three portal cards, one line each, and keeps #dashboard on the wrapper", () => {
    const { container } = render(<HomeSoftwareDemo />);
    expect(container.querySelectorAll("#dashboard")).toHaveLength(1);
    const cards = [...container.querySelectorAll(".home-software-card")];
    expect(cards.map((card) => card.querySelector("h3")!.textContent)).toEqual(["Resident", "Property", "Vendor"]);
    expect(cards.map((card) => card.querySelector("p")!.textContent)).toEqual([
      "Find a home, pay rent, request a service.",
      "Leasing, rent, services and messages for every house.",
      "Get jobs by text, schedule visits, get paid.",
    ]);
    expect(SOFTWARE_PORTALS).toHaveLength(3);
    for (const card of cards) expect(card.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".home-software-compact")!.querySelector("img, iframe")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2, name: "Software" })).toHaveLength(2);
  });

  it("does not mount the iframe on load: the live player sits in the desktop-only wrapper and waits for its observer", () => {
    const { container } = render(<HomeSoftwareDemo />);
    expect(container.querySelector(".home-software-wide section#software-demo")).not.toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    const css = readFileSync("src/components/marketing/home-small.css", "utf8");
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*\.home-software-wide \{ display: none; \}/);
  });
});

describe("small-screen Pricing (up to 1024px)", () => {
  it("draws one card per plan with its name, price and three key points from the rate-card rows", () => {
    const { container } = render(<HomePricingCompare titleId="t" />);
    const cards = [...container.querySelectorAll(".home-plan-card")];
    expect(cards).toHaveLength(HOME_PLAN_COLUMNS.length);
    HOME_PLAN_COLUMNS.forEach((plan, index) => {
      const card = cards[index] as HTMLElement;
      expect(card.querySelector("h3")).toHaveTextContent(plan.name);
      expect(card.querySelector(".home-plan-price strong")).toHaveTextContent(plan.monthly.price);
      if (plan.annual.price !== plan.monthly.price) expect(card.querySelector(".home-plan-price.is-annual strong")).toHaveTextContent(plan.annual.price);
      const points = [...card.querySelectorAll(".home-plan-points li")].map((li) => li.textContent);
      expect(points).toHaveLength(PLAN_CARD_POINTS);
      expect(points).toEqual(planCardPoints(index));
      // Every point is a row of the compare table that this plan actually has.
      for (const point of points) {
        const row = HOME_COMPARE_ROWS.find((entry) => point === entry.label || point!.startsWith(`${entry.label}: `))!;
        expect(row.cells[index]).not.toBe(false);
        expect(point).toBe(row.cells[index] === true ? row.label : `${row.label}: ${row.cells[index]}`);
      }
    });
    expect(planCardPoints(0)[0]).toBe(`Residents included: ${HOME_COMPARE_ROWS[0].cells[0]}`);
  });

  it("keeps the compare table behind a Compare plans button, closed by default, opening in place", () => {
    const { container } = render(<HomePricingCompare titleId="t" />);
    const button = screen.getByRole("button", { name: "Compare plans" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    const reveal = container.querySelector(".home-compare-reveal")!;
    expect(reveal).toHaveAttribute("data-open", "false");
    expect(button.getAttribute("aria-controls")).toBe(reveal.querySelector(".home-compare-panel")!.id);
    expect(reveal.querySelector(".home-compare-panel [role='table']")).not.toBeNull();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(reveal).toHaveAttribute("data-open", "true");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    // The button is a button, not a link: /pricing redirects back to /#pricing.
    expect(button.closest("a")).toBeNull();
  });

  it("hides the small-screen blocks on desktop and the desktop table's wrapper adds no styling", () => {
    const css = readFileSync("src/components/marketing/home-small.css", "utf8");
    expect(css).toMatch(/^\.home-how-list,\s*\n\.home-software-compact,\s*\n\.home-plan-cards,\s*\n\.home-compare-toggle \{ display: none; \}/m);
    // Nothing outside a max-width media query may restyle the desktop.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    let outside = "";
    let media = false;
    for (let i = 0; i < bare.length; i += 1) {
      if (depth === 0 && bare.startsWith("@media", i)) media = true;
      if (!media) outside += bare[i];
      if (bare[i] === "{") depth += 1;
      if (bare[i] === "}") { depth -= 1; if (depth === 0) media = false; }
    }
    expect(outside.replace(/\s+/g, " ").trim()).toBe(".home-how-list, .home-software-compact, .home-plan-cards, .home-compare-toggle { display: none; }");
    expect(css.match(/@media \((?:max|min)-width: \d+px\)/g)).toEqual(["@media (max-width: 1024px)", "@media (max-width: 1024px)", "@media (max-width: 1024px)", "@media (max-width: 640px)"]);
  });
});

describe("phone (640px and below)", () => {
  const css = readFileSync("src/components/marketing/home-small.css", "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 640px)"));

  it("draws only the hero, Contact, Join free and the footer: How it works, Software, Service and Pricing are display:none", () => {
    for (const hidden of [".home-how", ".home-software", "#service", "#pricing"]) expect(phone).toContain(`.texting-home.home-swiss ${hidden}`);
    expect(phone).toMatch(/display: none;/);
    for (const kept of ["#contact", "home-join", "#number", "home-hero"]) expect(phone).not.toContain(kept);
  });

  it("puts Book a demo and Portal in the bar with no Menu button on a phone", () => {
    render(<HomeNavbar texting={publicTextingConfig("+12025550123")} />);
    const portal = document.querySelector('[data-attr="home-nav-portal-phone"]') as HTMLAnchorElement;
    expect(portal).toHaveTextContent("Portal");
    expect(portal).toHaveAttribute("href", "/auth/sign-in");
    expect(portal.parentElement).toBe(document.querySelector('[data-attr="home-nav-book-demo-mobile"]')!.parentElement);
    const barCss = readFileSync("src/components/layout/home-navbar.module.css", "utf8");
    const phoneBar = barCss.slice(barCss.indexOf("@media (max-width: 640px)"));
    expect(phoneBar).toMatch(/\.menuButton \{\s*display: none;/);
    expect(phoneBar).toMatch(/\.phonePortal \{\s*display: inline-flex;/);
    expect(phoneBar).toMatch(/padding-inline: 16px/);
    expect(barCss.slice(0, barCss.indexOf("@media"))).toMatch(/\.phonePortal \{\s*display: none;/);
  });

  it("keeps Sign up free on the right of its row at tablet and phone", () => {
    const { container } = render(<HomeJoinFree />);
    const rows = [...container.querySelectorAll(".home-join-rows li")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([...row.children].map((child) => child.className)).toEqual(["home-join-role", "home-join-line", "home-join-actions"]);
      expect(row.querySelector(".home-join-actions a")).toHaveTextContent("Sign up free");
    }
    expect(css).toContain('grid-template-areas: "role actions" "line actions"');
    expect(css).toMatch(/\.home-join-actions \{ grid-area: actions; align-self: center; justify-content: flex-end;/);
    expect(css).toMatch(/\.home-join-cta \{ min-height: 48px;/);
  });
});
