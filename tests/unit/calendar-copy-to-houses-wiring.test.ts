/**
 * Portfolio calendar wires copy-to-houses when a single source house is in scope.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/portal/portal-calendar.tsx", "utf8");

describe("portal calendar copy to houses wiring", () => {
  it("uses shared copy helpers and passes destination houses to the grid", () => {
    expect(src).toContain("buildCalendarCopyDestinationHouses");
    expect(src).toContain("resolveCalendarCopySourcePropertyId");
    expect(src).toContain("otherProperties={portal === \"manager\" ? copyDestinationHouses : undefined}");
    expect(src).toContain("availabilityCopySourcePropertyId");
  });
});
