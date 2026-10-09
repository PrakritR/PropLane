/**
 * The PropLane mark is the house mark (rounded house/chevron outline with an X). A paper plane, or
 * any lucide Send / Plane glyph, must never stand for PropLane: brand, attribution and "PropLane
 * does this" rows draw the canonical house mark. A Send icon that means "send a message" stays.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

/** Files whose icons stand for PropLane itself (brand, attribution, PropLane-owned rows). */
const BRAND_FILES = [
  "src/components/brand/axis-logo.tsx",
  "src/components/marketing/listed-with-proplane-band.tsx",
  /** The home page window's top strip, rail and assistant panel: PropLane there is the house mark. */
  "src/components/marketing/resident-lifecycle-workspace.tsx",
  "src/components/portal/listing-sites-panel.tsx",
  "src/lib/listing-attribution.ts",
  "src/lib/promotion-flyer.ts",
  "src/lib/manager-application-pdf.ts",
  "scripts/generate-brand-assets.mjs",
];

const PLANE_ICON = /\b(Send|SendHorizontal|Plane|PlaneTakeoff|PlaneLanding|Navigation2?)\b/;

function lucideImportedNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
    for (const n of m[1]!.split(",")) names.push(n.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, ""));
  }
  return names;
}

describe("PropLane brand uses the house mark, never a plane", () => {
  for (const file of BRAND_FILES) {
    it(`${file} imports no Send/Plane icon and draws no plane glyph or emoji`, () => {
      const source = read(file);
      expect(lucideImportedNames(source).filter((n) => PLANE_ICON.test(n))).toEqual([]);
      expect(source).not.toMatch(/paper-?plane|PaperPlane|✈|🛩/i);
    });
  }

  it("the Listed with PropLane row is the house mark", () => {
    const source = read("src/components/portal/integrations-posting-panel.tsx");
    expect(source).toMatch(/name="Show Listed with PropLane"/);
    const row = source.slice(source.lastIndexOf("<IntegrationRow", source.indexOf('name="Show Listed with PropLane"')));
    expect(row.slice(0, row.indexOf("name="))).toContain("icon={ProPlaneMarkIcon}");
  });

  it("the Listed with PropLane band draws the house glyph", () => {
    expect(read("src/components/marketing/listed-with-proplane-band.tsx")).toContain("<AxisLogoGlyph");
  });

  it("every mark rendering derives from the canonical paths", () => {
    const logo = read("src/components/brand/axis-logo.tsx");
    expect(logo).toContain("PROPLANE_MARK_PATHS");
    expect(logo).toContain("export function ProPlaneMarkIcon");
    expect(logo).not.toMatch(/<path\s+d="/);
  });

  it("the committed docs call the mark the house mark", () => {
    const agents = read("AGENTS.md");
    expect(agents).toContain("Mark is the house mark");
    expect(agents).not.toMatch(/Mark is the paper-plane glyph/);
  });
});
