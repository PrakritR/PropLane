/**
 * AXI-166 — "it was automatically on (whole house lease)-8000. It should give me
 * the option of which one I want to pick or have it for none."
 *
 * Nothing in the client auto-selects a bundle; it arrives pre-filled from an
 * "Apply for this bundle" link (`?bundle=`), which is intended. The gap was that
 * the field's helper text always read as an invitation — "choose a bundle… or
 * leave as none" — even when one was already chosen, so a pre-filled field
 * looked like a decision made for the applicant rather than a changeable one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const steps = readFileSync(
  path.join(process.cwd(), "src/components/marketing/rental-wizard-steps.tsx"),
  "utf8",
);

describe("lease bundle field", () => {
  it("keeps a None option that opts out of the bundle", () => {
    const select = steps.split('data-wizard-field="bundleId"')[1]?.slice(0, 2600) ?? "";
    expect(select).toContain('<option value="">');
    expect(select).toContain("apply for individual rooms");
  });

  it("tells the applicant a selected bundle is still changeable", () => {
    const hint = steps.split('data-wizard-field="bundleId"')[1]?.slice(0, 2600) ?? "";
    expect(hint).toContain("bundleSelected");
    expect(hint).toContain("You&apos;re applying for this bundle".replace("&apos;", "'"));
  });

  it("still shows the invitation copy when nothing is selected", () => {
    const hint = steps.split('data-wizard-field="bundleId"')[1]?.slice(0, 2600) ?? "";
    expect(hint).toContain("This listing offers bundle pricing");
  });

  it("never auto-selects a bundle on a property or lease-term change", () => {
    // Both handlers clear it; only an explicit link param or a click sets one.
    expect(steps).toContain('bundleId: ""');
    expect(steps).toContain("keepBundle");
  });
});
