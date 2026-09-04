import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * PRP-125: the marketing site addressed only "managers", which reads as
 * excluding the individual landlord — who is the same buyer. The Product
 * dropdown, the /partner page it leads to, and the why-PropLane role card all
 * name both audiences now.
 *
 * Asserted against the source rather than a render because these are plain
 * string literals with no logic; a render test here would only prove React can
 * print a constant.
 */
describe("PRP-125: marketing copy addresses managers AND landlords", () => {
  it("names both audiences in the Product dropdown", () => {
    const navbar = read("src/components/layout/public-navbar.tsx");
    expect(navbar).toContain('title: "For managers & landlords"');
    // The residents/vendors entries are unchanged — this is not a blanket rename.
    expect(navbar).toContain('title: "For residents"');
    expect(navbar).toContain('title: "For vendors"');
  });

  it("names both on the /partner page it links to", () => {
    const partner = read("src/app/(public)/partner/page.tsx");
    expect(partner).toContain("For managers & landlords");
    expect(partner).toContain("property managers and landlords");
    expect(partner).toContain("Built for how managers and landlords actually work");
  });

  it("names both on the why-PropLane role card", () => {
    const why = read("src/app/(public)/why-proplane/page.tsx");
    expect(why).toContain('title: "Managers & landlords"');
    expect(why).toContain('cta: "For managers & landlords"');
  });
});
