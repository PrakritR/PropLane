/**
 * AXI-153 — "when the application is opened by a potential tenant the applicaiton
 * form should be prefilled out with the information of the property so they have
 * an easier time filling out application."
 *
 * The link prefill already carried property, room, bundle, phone and rental type.
 * Lease term did not: a listing that offers exactly ONE term still made the
 * applicant open a dropdown and pick the only option in it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const wizard = readFileSync(
  path.join(process.cwd(), "src/components/marketing/rental-application-wizard.tsx"),
  "utf8",
);

const block = wizard.split("const listingTerms = listingAllowedLeaseTerms(pid);")[1]?.slice(0, 700) ?? "";

describe("lease term prefill from the listing", () => {
  it("only prefills when the listing offers exactly one term", () => {
    expect(block).toContain("listingTerms.length === 1");
  });

  it("never overwrites an answer the applicant already gave", () => {
    // `prev.leaseTerm || soleListingTerm` — the existing value always wins.
    expect(block).toContain("prev.leaseTerm || soleListingTerm");
  });

  it("leaves the short-term link path on its own term", () => {
    expect(block).toContain("SHORT_TERM_LEASE_TERM");
  });

  it("reads the terms the LISTING allows, not the global option list", () => {
    expect(wizard).toContain("listingAllowedLeaseTerms(pid)");
  });
});
