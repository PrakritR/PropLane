// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * The public bar used to resolve a Supabase session and point "Portal" at the signed-in role's home. The live
 * bar (`HomeNavbar`, behind `PublicNavbar`) deliberately does not: it is one static link to sign-in, so the
 * marketing pages never boot auth. This pins that — a reintroduced role lookup fails on the mocked client.
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

describe("public navbar portal link", () => {
  it("reads \"Portal\" and goes to sign-in, on the homepage and on every other public page", () => {
    for (const pathname of ["/", "/blog", "/about"]) {
      mockPathname = pathname;
      render(<PublicNavbar texting={texting} />);
      const links = screen.getAllByRole("link", { name: "Portal" });
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link).toHaveAttribute("href", "/auth/sign-in");
      cleanup();
    }
  });

  it("carries no signed-out Log in / Start free pair any more", () => {
    render(<PublicNavbar texting={texting} />);
    expect(screen.queryByRole("link", { name: /log in/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /start free/i })).toBeNull();
  });
});
