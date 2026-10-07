import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { leasingPlusMenuEntries } from "@/lib/leasing-plus-menu";
import { missingApplicationDefaults, missingLeaseDefaults } from "@/lib/leasing-quick-add";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { withPropertyApplicationTemplatesExplicit } from "@/lib/property-application-templates";

describe("the round + on Applications and Leases is a menu: blank first, then presets", () => {
  const bare = withPropertyApplicationTemplatesExplicit(
    { ...createDefaultListingSubmission(), allowedLeaseTerms: ["Long-term", "Short-Term Stay"], shortTermRentalsAllowed: true },
    [],
  );

  it("lists the blank item first, then each missing preset in order", () => {
    const presets = missingLeaseDefaults(bare, "long_term");
    expect(presets.length).toBeGreaterThan(0);
    const entries = leasingPlusMenuEntries("Add lease", presets);
    expect(entries[0]).toMatchObject({ kind: "blank", label: "Add lease" });
    expect(entries.slice(1).map((e) => e.label)).toEqual(presets.map((p) => p.label));
    expect(entries.slice(1).every((e) => e.kind === "preset")).toBe(true);
  });

  it("is just the blank item when no preset is missing", () => {
    expect(leasingPlusMenuEntries("Add application", [])).toEqual([{ kind: "blank", key: "__blank", label: "Add application" }]);
    expect(missingApplicationDefaults(bare, "long_term").length).toBeGreaterThan(0);
  });

  it("neither property tab renders the separate Quick add row any more", () => {
    for (const file of ["pro-property-application-questions-panel", "pro-property-lease-panel"]) {
      const src = readFileSync(`src/components/portal/${file}.tsx`, "utf8");
      expect(src).not.toContain("LeasingQuickAddRow");
      expect(src).toContain("leasingPlusMenuEntries");
    }
  });
});
