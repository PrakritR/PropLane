/** Source guards on the single-page homepage composition. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

// The full-viewport cover and two scroll stories precede service, pricing and contact.
describe("single-page homepage composition", () => {
  const home = read("src/app/(public)/page.tsx");
  it("uses the approved section order and one shared pricing source", () => {
    const order = [
      "<TextingHomeHero",
      "<HomeNumberStage",
      "<HomeSoftwareDemo",
      'id="service"',
      'id="pricing"',
      'id="contact"',
    ];
    const positions = order.map((item) => home.indexOf(item));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Pricing is the compare table; its cells come from the same rate card and COMPARE rows /pricing reads.
    expect(home).toContain("<HomePricingCompare");
    const compare = read("src/components/marketing/home-pricing-compare-data.ts");
    expect(compare).toContain('from "@/lib/billing/rate-card"');
    expect(compare).toContain('from "@/components/marketing/site/pricing-compare-data"');
    expect(home).toContain("<ManagedServiceForm");
    expect(home).not.toMatch(
      /TextingHomeLazy|texting-roles|texting-eyebrow|You stay in control/,
    );
  });
  it("uses the approved headline for the cover and metadata", () => {
    expect(HOME_HEADLINE).toBe("Your Housing Assistant");
    expect(home).toContain("title: HOME_HEADLINE");
    expect(read("src/components/marketing/texting-home-hero.tsx")).toContain(
      "aria-label={HOME_HEADLINE}",
    );
  });
  it("derives every operating figure from the captain's track-record source", () => {
    for (const field of ["homes", "roomsOccupied", "roomsTotal", "profit"])
      expect(home).toContain(`TRACK_RECORD.${field}`);
    expect(home).not.toMatch(/TRACK_RECORD_HOMES|5257|5259|4709/);
  });
  it("restores the production page atmosphere with static motion on phones", () => {
    expect(home).toContain('className="texting-home home-swiss home-wavy"');
    expect(home).toContain('<ResidentLifecycleAtmosphere variant="page" staticBelow={861} />');
    expect(read("src/components/marketing/home-scroll-stage.css")).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    );
  });
});
