import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GET_STARTED_HREF, MANAGER_GET_STARTED_HREF } from "@/lib/marketing/public-contact";

/**
 * PRP-307. A generic "Get started" must not decide the visitor's role for them.
 *
 * This is invisible in the product until a real person clicks it: the signup
 * succeeds, the account is simply the wrong KIND, and they only find out once
 * they are inside the wrong portal. A build catches none of it, which is why
 * the hrefs are asserted here.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the generic Get started CTA lands on the role picker", () => {
  it("GET_STARTED_HREF carries no role", () => {
    expect(GET_STARTED_HREF).toBe("/auth/create-account");
    expect(GET_STARTED_HREF).not.toContain("role=");
  });

  it("the navbar fallback is role-less, and /rent keeps its resident answer", () => {
    const navbar = read("src/components/layout/public-navbar.tsx");
    // The /rent branch is deliberate: a visitor browsing homes has already
    // told us what they are.
    expect(navbar).toContain('"/auth/create-account?mode=create&role=resident"');
    // The fallback — every other page, including the landing page — must not.
    expect(navbar).toContain(': "/auth/create-account";');
  });

  it("the shared marketing CTA pair defaults to the picker", () => {
    expect(read("src/components/marketing/marketing-cta.tsx")).toContain(
      "primaryHref = GET_STARTED_HREF",
    );
  });

  it("no public marketing surface hard-codes manager signup behind a plain CTA", () => {
    for (const file of [
      "src/components/marketing/landing-home-sections.tsx",
      "src/components/marketing/landing-demo-hero.tsx",
      "src/app/(public)/docs/page.tsx",
      "src/app/(public)/reviews/page.tsx",
    ]) {
      expect(read(file), file).not.toContain("role=manager");
    }
  });

  it("KEEPS the manager href for pricing, where the visitor has chosen a plan", () => {
    // Not a bug to fix later: a plan CTA carries a tier too, and stripping the
    // role there would lose the selection the visitor just made.
    expect(MANAGER_GET_STARTED_HREF).toContain("role=manager");
    expect(read("src/app/(public)/pricing/page.tsx")).toContain("MANAGER_GET_STARTED_HREF");
  });
});
