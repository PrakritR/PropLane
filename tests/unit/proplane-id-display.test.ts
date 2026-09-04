import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatProplaneIdForDisplay, generateAxisId, proplaneIdLookupVariants } from "@/lib/manager-id";

/**
 * A field captioned "PropLane ID" must never read AXIS to the person whose id
 * it is. Accounts created before the rebrand still STORE an `AXIS-` value —
 * every lookup accepts both prefixes, and renaming the stored id is a migration
 * (lease ids and charge references derive from it), not a label change — so the
 * fix is at the point of display, which also covers production without touching
 * a single row.
 */
describe("PropLane ID display", () => {
  it("shows a legacy AXIS id as PropLane", () => {
    expect(formatProplaneIdForDisplay("AXIS-TESTRSID")).toBe("PROPLANE-TESTRSID");
  });

  it("leaves a PropLane id alone", () => {
    expect(formatProplaneIdForDisplay("PROPLANE-TESTRSID")).toBe("PROPLANE-TESTRSID");
  });

  it("mints new ids as PropLane", () => {
    expect(generateAxisId()).toMatch(/^PROPLANE-[0-9A-F]{8}$/);
  });

  it("still looks a legacy id up under both prefixes", () => {
    const variants = proplaneIdLookupVariants("AXIS-TESTRSID");
    expect(variants).toContain("AXIS-TESTRSID");
    expect(variants).toContain("PROPLANE-TESTRSID");
  });

  /** The two profile surfaces that render the id to its owner. */
  const ID_SURFACES = [
    join("src", "components", "portal", "portal-profile-client.tsx"),
    join("src", "components", "portal", "resident-profile-panel.tsx"),
  ];

  it("renders the id through the formatter on every profile surface", () => {
    for (const file of ID_SURFACES) {
      const source = readFileSync(file, "utf8");
      const idRenders = source.match(/(?:value|idValue)=\{[^}]*(?:idValue|axisId)[^}]*\}/g) ?? [];
      expect(idRenders.length).toBeGreaterThan(0);
      for (const render of idRenders) {
        expect(render).toContain("formatProplaneIdForDisplay");
      }
    }
  });
});
