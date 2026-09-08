import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("PRP-431 / PRP-432 guest Stripe finalize + in-account confirmations", () => {
  const WIZARD = read("src/components/marketing/rental-application-wizard.tsx");
  const INLINE = read("src/components/marketing/application-fee-inline-payment.tsx");
  const VERIFY = read("src/app/api/stripe/application-fee-verify/route.ts");
  const WEBHOOK = read("src/app/api/stripe/webhook/route.ts");
  const TOUR_MODAL = read("src/components/portal/resident-schedule-tour-modal.tsx");
  const TOUR_FLOW = read("src/components/marketing/tour-schedule-flow.tsx");

  it("stashes fee identity before minting Stripe Checkout", () => {
    expect(INLINE).toContain("rememberApplicationFeeCheckoutResume");
  });

  it("rehydrates fee return from sessionStorage and shows finish when server promoted", () => {
    expect(WIZARD).toContain("loadApplicationFeeCheckoutResume");
    expect(WIZARD).toContain("applicationPromoted");
    expect(WIZARD).toContain("setPostSubmit");
    expect(WIZARD).toContain("rememberApplicationFeeSubmitConfirm");
    expect(WIZARD).toContain("loadApplicationFeeSubmitConfirm");
    // Guest return may lack form email — still accept server promote.
    expect(WIZARD).toContain("identityOk");
  });

  it("promotes Incomplete applications on verify and webhook after fee paid", () => {
    expect(VERIFY).toContain("promoteIncompleteApplicationAfterFeePaid");
    expect(WEBHOOK).toContain("promoteIncompleteApplicationAfterFeePaid");
  });

  it("keeps the resident tour modal open so confirmation is visible", () => {
    expect(TOUR_MODAL).toContain("onSuccessDismiss={handleClose}");
    const successIdx = TOUR_MODAL.indexOf("onSuccess={() => {");
    const dismissIdx = TOUR_MODAL.indexOf("onSuccessDismiss={handleClose}");
    expect(successIdx).toBeGreaterThan(-1);
    expect(dismissIdx).toBeGreaterThan(successIdx);
    const successBlock = TOUR_MODAL.slice(successIdx, dismissIdx);
    expect(successBlock).not.toContain("handleClose()");
    expect(TOUR_FLOW).toContain('data-attr="tour-success-done"');
  });
});
