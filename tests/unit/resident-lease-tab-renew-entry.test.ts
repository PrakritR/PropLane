/**
 * The resident Lease TAB must carry the extend/renew entry point.
 *
 * It used to live only in the footer of a signed lease's detail page, so a
 * resident who opened Lease and saw a list had no way in — which is what "improve
 * the extend lease feature on the resident side lease tab" was about.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/portal/resident-lease-panel.tsx", "utf8");
const modal = readFileSync("src/components/portal/lease-amend-move-out-modal.tsx", "utf8");

describe("resident lease tab renewal entry", () => {
  it("renders the renewal banner in the LIST branch, not only the detail footer", () => {
    const listBranch = panel.slice(panel.indexOf("if (!leaseDetailId)"));
    expect(listBranch).toContain('data-attr="resident-lease-renewal-banner"');
    expect(listBranch).toContain('data-attr="resident-lease-renew-open"');
  });

  it("the banner's button opens the same modal the detail Renew button does", () => {
    expect(panel).toContain("setShowMoveOutModal(true)");
    expect(panel).toContain("residentLeaseRenewalStatus");
  });

  it("hides the button while a renewal is already out for signature", () => {
    // There is nothing to request; the resident's job is to sign what exists.
    expect(panel).toContain('renewalStatus.kind !== "awaiting_signature"');
  });

  it("states up front that the lease has to be re-signed", () => {
    expect(modal).toContain('data-attr="lease-amend-resign-notice"');
    expect(modal).toContain("sign the updated lease before it takes effect");
  });

  it("previews the payments before the resident confirms", () => {
    expect(modal).toContain('data-attr="lease-renew-payment-preview"');
    expect(modal).toContain("leaseRenewalPaymentPreview");
  });

  it("tells a rollover resident that doing nothing is an option", () => {
    expect(modal).toContain('data-attr="lease-amend-rollover-note"');
    expect(modal).toContain("listingRollsOverToMonthToMonth");
  });
});
