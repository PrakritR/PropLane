import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateListingWizardStep } from "@/lib/listing-wizard-validation";
import { deriveListingLtFeeToggles } from "@/lib/listing-fee-term-toggles";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

/**
 * `validateListingWizardStep` only runs the short-term fee checks when
 * `stFeeToggles` is supplied. `goNext` supplied it; Submit did not (PRP-208).
 * Already-visited steps stay clickable, so the bypass was accidental as much as
 * deliberate: complete Pricing, go back, clear the nightly rate, click Submit —
 * and a short-term listing published with no nightly rate.
 *
 * That rate is not cosmetic. `resolveStayPricing` is the single decision for
 * which rate is active, and both the lease document and the charge ledger read
 * it, so a missing rate propagates into money.
 */
const PRICING_STEP = 4;

function shortTermSubmission() {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  sub.allowedLeaseTerms = ["short_term"];
  return sub;
}

describe("short-term fee checks only run when the toggles are passed", () => {
  it("misses the empty nightly rate when the toggles are omitted — the submit path's old shape", () => {
    const sub = shortTermSubmission();
    const errors = validateListingWizardStep(PRICING_STEP, sub, { entireHomeRent: 0 });
    // Nothing about a nightly rate: this is the hole, pinned so the fix is
    // demonstrably load-bearing rather than incidental.
    expect(Object.keys(errors).some((key) => /st|nightly|daily/i.test(key))).toBe(false);
  });

  it("catches it when they are, which is what Next always did", () => {
    const sub = shortTermSubmission();
    const errors = validateListingWizardStep(PRICING_STEP, sub, {
      entireHomeRent: 0,
      stFeeToggles: { rent: true },
      ltFeeToggles: deriveListingLtFeeToggles(sub),
    });
    expect(Object.keys(errors).length).toBeGreaterThan(0);
  });
});

describe("submit and the steps validate identically", () => {
  const FORM = readFileSync(
    join(process.cwd(), "src/components/portal/pro-add-listing-form.tsx"),
    "utf8",
  );

  it("submit passes the real toggles, not a derived guess", () => {
    const submit = FORM.slice(FORM.indexOf("const submitListing = async () => {"));
    const head = submit.slice(0, 1400);
    expect(head).toContain("const validateOpts = { isEditMode, entireHomeRent, stFeeToggles, ltFeeToggles }");
    expect(head).toContain("firstInvalidListingStep(sub, validateOpts, 5)");
    expect(head).toContain("validateListingWizardStep(i, sub, validateOpts)");
  });

  it("no submit-path validation call omits them", () => {
    const submit = FORM.slice(FORM.indexOf("const submitListing = async () => {"));
    expect(submit.slice(0, 1400)).not.toContain("{ isEditMode, entireHomeRent }");
  });
});
