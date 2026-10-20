import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_ROLES } from "@/lib/marketing/home-roles";
import { MARKETING_REDIRECTS } from "@/lib/seo/marketing-routes";

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
  it("names every audience once, in the one shared role list", () => {
    // The Product dropdown that used to carry "Managers & landlords" is gone with the rest of the mega menu;
    // `HOME_ROLES` (captain #27) is now the single list the hero strip, How it works and the auth panel read.
    expect(HOME_ROLES.map((role) => role.label)).toEqual(["Prospects", "Residents", "Vendors", "Managers", "Owners"]);
  });

  it("names both on the /partner page it links to", () => {
    const partner = read("src/app/(public)/partner/page.tsx");
    expect(partner).toContain("For managers & landlords");
    expect(partner).toContain("Built for how managers and landlords actually work");
  });

  it("keeps the former Why page on the single-page service section, with no page left behind it", () => {
    // The route is served by the config redirect alone; a page file here would be unreachable dead code.
    expect(existsSync(join(process.cwd(), "src/app/(public)/why-proplane/page.tsx"))).toBe(false);
    expect(MARKETING_REDIRECTS).toEqual(
      expect.arrayContaining([{ source: "/why-proplane", destination: "/#service", statusCode: 307 }]),
    );
  });
});
