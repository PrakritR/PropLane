import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import { COMPARE } from "@/components/marketing/site/pricing-compare-data";

/**
 * Captain 2026-09-25 (per-resident billing): copy never says "doors" — the
 * price is per resident. Integrator review 2026-09-26 found it had crept
 * back into the home pricing teaser's headline and the /pricing page. This
 * pins both contracts: no rendered pricing copy says "door"/"doors" (the
 * `RATE_CARD.*Doors` FIELD NAMES are a separate, internal identifier and are
 * deliberately excluded — this guards user-facing strings, not the schema),
 * and the teaser headline's three numbers are always read from `RATE_CARD`,
 * never hand-typed.
 */

const TARGET_FILES = [
  "src/components/marketing/site/pricing-compare-data.tsx",
  "src/components/marketing/site/pricing-teaser.tsx",
  "src/app/(public)/pricing/page.tsx",
  "src/components/marketing/landing-home-sections.tsx",
];

/** Strips `//` and `/* *‍/` comments so a doc-comment mentioning "door" (an
 * internal note about the `RATE_CARD` field name) never trips this guard —
 * it only ever sees code, i.e. the actual rendered/returned strings. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("public pricing copy never says \"door\"", () => {
  it.each(TARGET_FILES)("%s has no rendered \"door\"/\"doors\" wording", (relPath) => {
    const code = stripComments(readFileSync(join(process.cwd(), relPath), "utf8"));
    const hits = code.match(/\bdoors?\b/gi) ?? [];
    expect(hits).toEqual([]);
  });

  it("the compare table's labels and cells never say \"door\"", () => {
    const strings: string[] = [];
    for (const group of COMPARE) {
      strings.push(group.group);
      for (const row of group.rows) {
        strings.push(row.label);
        for (const cell of row.cells) if (typeof cell === "string") strings.push(cell);
      }
    }
    const hits = strings.filter((s) => /\bdoors?\b/i.test(s));
    expect(hits).toEqual([]);
  });

  it("the compare table says residents, not doors", () => {
    const labels = COMPARE.flatMap((g) => g.rows.map((r) => r.label));
    expect(labels).toContain("Residents included");
    expect(labels).toContain("Extra resident price");
  });
});

describe("the home pricing teaser's headline numbers come from RATE_CARD", () => {
  it("matches the exact free/pro/business resident counts and prices", () => {
    const path = join(process.cwd(), "src/components/marketing/site/pricing-teaser.tsx");
    const code = readFileSync(path, "utf8");
    const titleMatch = code.match(/title=\{`([^`]*)`\}/);
    expect(titleMatch, "expected SiteIntro's `title` template literal in pricing-teaser.tsx").toBeTruthy();
    const literal = titleMatch![1]!
      .replace(/\$\{formatRateCardUsd\(RATE_CARD\.pro\.floorMonthlyCents\)\}/, formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents))
      .replace(/\$\{formatRateCardUsd\(RATE_CARD\.business\.floorMonthlyCents\)\}/, formatRateCardUsd(RATE_CARD.business.floorMonthlyCents))
      .replace(/\$\{RATE_CARD\.free\.includedDoors\}/, String(RATE_CARD.free.includedDoors))
      .replace(/\$\{RATE_CARD\.pro\.includedDoors\}/, String(RATE_CARD.pro.includedDoors))
      .replace(/\$\{RATE_CARD\.business\.includedDoors\}/, String(RATE_CARD.business.includedDoors));
    // Every `${...}` placeholder must have resolved above — a literal `${`
    // left in the string means the headline used a different expression
    // than the one this test derives, i.e. a hand-typed number crept back in.
    expect(literal).not.toMatch(/\$\{/);
    expect(literal).toBe(
      `Free for up to ${RATE_CARD.free.includedDoors} residents. ${formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents)}/mo for up to ${RATE_CARD.pro.includedDoors}. ${formatRateCardUsd(RATE_CARD.business.floorMonthlyCents)}/mo for up to ${RATE_CARD.business.includedDoors}.`,
    );
  });
});
