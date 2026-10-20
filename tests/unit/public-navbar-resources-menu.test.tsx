// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * The bar used to carry Product / Pricing / Why PropLane / Resources dropdowns over separate pages. The home
 * page owns that content now (`MARKETING_REDIRECTS`), so the live bar is five section links and no menus. This
 * pins the reading: a dropdown or a link back to a retired route is the regression to catch.
 */
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => {
    throw new Error("Public navigation must not initialize auth");
  },
}));
vi.mock("@/components/marketing/fonts/home-swiss-font", () => ({ homeSwissFont: { variable: "swiss-font" } }));

let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
}));

import { PublicNavbar } from "@/components/layout/public-navbar";
import { publicTextingConfig } from "@/lib/marketing/public-texting";
import { MARKETING_REDIRECTS } from "@/lib/seo/marketing-routes";

const texting = publicTextingConfig("+12065550123");

beforeEach(() => {
  mockPathname = "/";
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public navbar reading", () => {
  it("is five home-section links: How it works, Software, Service, Pricing, Contact", () => {
    render(<PublicNavbar texting={texting} />);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "How it works",
      "Software",
      "Service",
      "Pricing",
      "Contact",
    ]);
    expect(within(nav).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/#how",
      "/#dashboard",
      "/#service",
      "/#pricing",
      "/#contact",
    ]);
  });

  it("opens no dropdown: Pricing, Why PropLane, Product and Resources are not menus any more", () => {
    render(<PublicNavbar texting={texting} />);
    expect(screen.queryByRole("button", { name: /^pricing$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^why proplane$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^product$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resources/i })).toBeNull();
    expect(document.querySelector("#axis-public-navbar details")).toBeNull();
  });

  it("never links a route the home page took over", () => {
    for (const pathname of ["/", "/blog"]) {
      mockPathname = pathname;
      render(<PublicNavbar texting={texting} />);
      const hrefs = [...document.querySelectorAll("#axis-public-navbar a")].map((a) => a.getAttribute("href") ?? "");
      for (const { source } of MARKETING_REDIRECTS) {
        expect(hrefs, `${pathname} must not link ${source}`).not.toContain(source);
      }
      cleanup();
    }
  });
});
