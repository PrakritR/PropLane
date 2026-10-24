// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * The public bar used to resolve a Supabase session and point "Portal" at the signed-in role's home. The live
 * bar (`HomeNavbar`, behind `PublicNavbar`) deliberately does not boot auth: signed out it shows Get started (the
 * portal chooser), and only the session cookie's presence (or the portal's signed-in flag) turns it into Portal,
 * to sign-in (captain #29). This pins that — a reintroduced role lookup fails on the mocked client.
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
  document.cookie = "sb-emstjswhotsnyksqhqyf-auth-token.0=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  window.localStorage.clear();
});

describe("public navbar portal link", () => {
  it("reads \"Get started\" and goes to the portal chooser for a signed-out visitor, on every public page", () => {
    for (const pathname of ["/", "/blog", "/about"]) {
      mockPathname = pathname;
      render(<PublicNavbar texting={texting} />);
      const links = screen.getAllByRole("link", { name: /^Get started/ });
      expect(links).toHaveLength(2);
      for (const link of links) expect(link).toHaveAttribute("href", "/auth/create-account");
      expect(screen.queryByRole("link", { name: /^Portal/ })).toBeNull();
      cleanup();
    }
  });

  it("reads \"Portal\" and goes straight to /auth/continue once the browser holds a session cookie", async () => {
    document.cookie = "sb-emstjswhotsnyksqhqyf-auth-token.0=base64-abc; path=/";
    for (const pathname of ["/", "/blog"]) {
      mockPathname = pathname;
      render(<PublicNavbar texting={texting} />);
      const links = await screen.findAllByRole("link", { name: /^Portal/ });
      expect(links).toHaveLength(2);
      for (const link of links) expect(link).toHaveAttribute("href", "/auth/continue");
      expect(screen.queryByRole("link", { name: /^Get started/ })).toBeNull();
      cleanup();
    }
  });

  it("reads \"Portal\" when the portal's signed-in flag is set", async () => {
    window.localStorage.setItem("axis:signed_in", "1");
    render(<PublicNavbar texting={texting} />);
    expect(await screen.findAllByRole("link", { name: /^Portal/ })).toHaveLength(2);
  });

  it("carries no Log in / Start free pair any more", () => {
    render(<PublicNavbar texting={texting} />);
    expect(screen.queryByRole("link", { name: /log in/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /start free/i })).toBeNull();
  });
});
