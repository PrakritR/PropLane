import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LEASE_PICK_OPTIONS,
  leasePickFromStored,
  leasePickSummary,
  normalizeLeasePick,
  storedTermsFromLeasePick,
} from "@/lib/rental-application/lease-terms";
import { leaseTermsPatchForTypes, createDefaultListingSubmission } from "@/lib/manager-listing-submission";

/**
 * Every lease-type picker offers two types, Long-term and Short-term. Custom dates and Month-to-month are
 * indented checkboxes under Long-term, shown only while it is ticked (captain, Oct 8 2026). Only the picker
 * moved: the stored terms are unchanged.
 */
describe("the lease picker is two types with children under Long-term", () => {
  it("has exactly two top-level options, Long-term and Short-term, and two children under Long-term", () => {
    expect(LEASE_PICK_OPTIONS.filter((o) => !o.parent).map((o) => o.label)).toEqual(["Long-term", "Short-term"]);
    expect(LEASE_PICK_OPTIONS.filter((o) => o.parent === "long_term").map((o) => o.label)).toEqual(["Custom dates", "Month-to-month"]);
  });

  it("a listing storing Custom + Month-to-Month opens with Long-term and both children ticked", () => {
    expect(leasePickFromStored(["Custom", "Month-to-Month"])).toEqual(["long_term", "custom", "month_to_month"]);
    expect(leasePickFromStored(["Long-term", "Custom", "Short-Term Stay"])).toEqual(["long_term", "custom", "short_term"]);
    expect(leasePickFromStored(["12-Month"])).toEqual(["long_term"]);
    expect(leasePickFromStored(["Airbnb"])).toEqual(["short_term"]);
  });

  it("unticking Long-term clears the children, and the stored terms stay the existing ones", () => {
    expect(normalizeLeasePick(["custom", "month_to_month", "short_term"])).toEqual(["short_term"]);
    expect(storedTermsFromLeasePick(["long_term", "custom", "month_to_month", "short_term"])).toEqual([
      "Long-term",
      "Month-to-Month",
      "Custom",
      "Short-Term Stay",
    ]);
    expect(storedTermsFromLeasePick(["short_term", "custom"])).toEqual(["Short-Term Stay"]);
    // A retired fixed length keeps answering for Long-term.
    expect(storedTermsFromLeasePick(["long_term"], ["12-Month"])).toEqual(["12-Month"]);
  });

  it("the closed caption names the children under their parent", () => {
    expect(leasePickSummary(["long_term", "custom", "short_term"])).toBe("Long-term (Custom dates), Short-term");
    expect(leasePickSummary(["short_term"])).toBe("Short-term");
  });

  it("unticking Custom dates removes Custom from the listing; unticking Long-term removes all three", () => {
    const sub = { ...createDefaultListingSubmission(), allowedLeaseTerms: ["Long-term", "Custom", "Month-to-Month"], shortTermRentalsAllowed: true };
    expect(leaseTermsPatchForTypes(sub, ["long_term", "month_to_month", "short_term"]).allowedLeaseTerms).toEqual([
      "Long-term",
      "Month-to-Month",
      "Short-Term Stay",
    ]);
    expect(leaseTermsPatchForTypes(sub, normalizeLeasePick(["custom", "short_term"])).allowedLeaseTerms).toEqual(["Short-Term Stay"]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("no picker lists Custom or Month-to-month as a top-level option", () => {
  const root = join(process.cwd(), "src");
  const pickers = [
    "components/portal/listing-wizard-v2/listing-editor.tsx",
    "components/portal/listing-wizard-v2/wizard-primitives.tsx",
    "components/portal/pro-add-listing-form.tsx",
  ];

  it("every manager picker is built from LEASE_PICK_OPTIONS", () => {
    for (const file of pickers) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src, file).toContain("LEASE_PICK_OPTIONS");
    }
  });

  it("no component maps the flat four-type LEASE_TYPES list into a picker's options", () => {
    const offenders = walk(join(root, "components")).filter((file) => /options=\{LEASE_TYPES\.map\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the applicant offers Long-term / Short-term at the top level only", async () => {
    const { applicantTermOptions } = await import("@/lib/rental-application/applicant-lease-term");
    const all = ["Long-term", "Custom", "Month-to-Month", "Short-Term Stay"];
    expect(applicantTermOptions(all).map((o) => o.label)).toEqual(["Long-term", "Short-term"]);
  });
});
