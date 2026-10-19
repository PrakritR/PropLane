/**
 * The retained lifecycle demo is scroll-driven (portal redesign, captain 2026-10-07): a sticky frame pins the headline while the
 * window grows with a transform, the track is always frame + run (no layout jump), and a phone or reduced motion
 * gets the static, full-size window. These are source guards on the three pieces that must keep agreeing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");
const css = read("src/components/marketing/resident-lifecycle-hero.css");
const tsx = read("src/components/marketing/resident-lifecycle-prototypes.tsx");

describe("retained lifecycle demo grows on scroll", () => {
  it("pins the headline and window in a sticky frame inside a track that also holds the run", () => {
    expect(tsx).toMatch(/className="rlp-grow"/);
    expect(tsx).toMatch(/className="rlp-grow-frame"/);
    expect(tsx).toMatch(/className="rlp-grow-run"/);
    expect(css).toMatch(
      /\.rlp-grow-frame\s*\{[^}]*position:\s*sticky;[^}]*top:\s*var\(--rlp-hdr\)/,
    );
    expect(css).toMatch(/\.rlp-grow-run\s*\{[^}]*height:/);
  });

  it("grows by transform only, from a smaller scale to 1, so nothing in the layout moves", () => {
    expect(tsx).toMatch(/GROW_FROM\s*=\s*0\.\d+/);
    expect(tsx).toMatch(/setProperty\("--rlp-grow"/);
    expect(css).toMatch(
      /\.rlp-hero-stage\s*\{[^}]*transform:\s*scale\(var\(--rlp-grow/,
    );
    const stage = css.slice(
      css.indexOf(".rlp-story .rlp-hero-stage"),
      css.indexOf("}", css.indexOf(".rlp-story .rlp-hero-stage")),
    );
    expect(stage).not.toMatch(
      /\b(width|height|margin|top|left):\s*calc\(var\(--rlp-grow/,
    );
  });

  it("is static below md and under prefers-reduced-motion", () => {
    expect(css).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.rlp-grow-run\s*\{\s*display:\s*none/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.rlp-grow-frame\s*\{\s*position:\s*static/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.rlp-hero-stage\s*\{\s*transform:\s*none/,
    );
    expect(tsx).toMatch(/STATIC_BELOW\s*=\s*768/);
    expect(tsx).toMatch(/reduced \|\| window\.innerWidth < STATIC_BELOW/);
  });

  it("keeps the phone sticky and vertically centred in the viewport on the right, with no scroll-driven offset", () => {
    expect(tsx).not.toMatch(/--rlp-phone-top/);
    expect(css).toMatch(
      /\.rlp-story-phone-slot\s*\{\s*top:\s*max\(calc\(var\(--rlp-hdr\) \+ 12px\), calc\(50svh - /,
    );
    expect(
      read("src/components/marketing/resident-lifecycle-prototypes.css"),
    ).toMatch(/\.rlp-story-phone-slot\s*\{[^}]*position:\s*sticky/);
  });
});

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
