import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GET_STARTED_HREF, MANAGER_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF } from "@/lib/marketing/public-contact";

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

  it("the navbar's own signup fallback is role-less, and audience pages carry the role", () => {
    // The live bar has one fallback and it is the generic one: it reads GET_STARTED_HREF and never a role.
    const navbar = read("src/components/layout/home-navbar.tsx");
    expect(navbar).toContain("GET_STARTED_HREF");
    expect(navbar).not.toContain("role=manager");
    expect(navbar).not.toContain("role=vendor");
    expect(navbar).not.toContain("role=resident");
  });

  it("PRP-313: manager and vendor entry pages skip the role picker on signup CTAs", () => {
    expect(read("src/app/(public)/partner/page.tsx")).toContain("MANAGER_GET_STARTED_HREF");
    expect(read("src/app/(public)/vendors/page.tsx")).toContain("VENDOR_GET_STARTED_HREF");
    expect(VENDOR_GET_STARTED_HREF).toContain("role=vendor");
  });

  it("no public marketing surface hard-codes manager signup behind a plain CTA", () => {
    for (const file of [
      "src/components/marketing/site/primitives.tsx",
      "src/components/marketing/site/final-cta.tsx",
      "src/app/(public)/docs/page.tsx",
      "src/components/marketing/home-pricing-compare.tsx",
    ]) {
      expect(read(file), file).not.toContain("role=manager");
    }
  });

  it("KEEPS the manager href for pricing, where the visitor has chosen a plan", () => {
    // Not a bug to fix later: a plan CTA carries a tier too, and stripping the
    // role there would lose the selection the visitor just made.
    expect(MANAGER_GET_STARTED_HREF).toContain("role=manager");
    const cards = read("src/components/marketing/site/pricing-cards.tsx");
    expect(cards).toContain("const CTA_BASE = MANAGER_GET_STARTED_HREF");
    expect(cards).toContain("export const TIER_CTA");
    // The home page's pricing section is the one plan surface now, and it takes the same tier CTAs.
    const home = read("src/components/marketing/home-pricing-compare-data.ts");
    expect(home).toContain('from "@/components/marketing/site/pricing-cards"');
    expect(home).toContain("TIER_CTA");
  });
});
