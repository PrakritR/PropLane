import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("PRP-427 guest Stripe apply finish + multi-property waive", () => {
  const WIZARD = read("src/components/marketing/rental-application-wizard.tsx");
  const CHECKOUT = read("src/app/api/stripe/application-fee-checkout/route.ts");
  const SETTINGS = read("src/components/portal/pro-portal-settings-panels.tsx");
  const MODAL = read("src/components/portal/pro-portal-settings-modal.tsx");

  it("renders the finish panel before the manager-link gate", () => {
    const finishIdx = WIZARD.indexOf("{postSubmit ? (");
    const gateIdx = WIZARD.indexOf("Open your manager’s apply link");
    expect(finishIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(finishIdx).toBeLessThan(gateIdx);
  });

  it("stamps propertyId on Stripe application-fee return URLs", () => {
    expect(CHECKOUT).toContain("propertyId=${pidQ}&fee_checkout=return&session_id={CHECKOUT_SESSION_ID}");
    expect(CHECKOUT).toContain("propertyId=${pidQ}&fee_checkout=success&session_id={CHECKOUT_SESSION_ID}");
  });

  it("marks the fee paid only after finalize returns ok (client path)", () => {
    expect(WIZARD).toContain("const submitted = await finalizeApplicationSubmit(feeStepUserId)");
    expect(WIZARD).toContain("if (!submitted.ok)");
    const submitIdx = WIZARD.indexOf("const submitted = await finalizeApplicationSubmit(feeStepUserId)");
    const markIdx = WIZARD.indexOf(
      "const marked = markApplicationFeePaidAfterStripe(em, sessionPid, feeStepUserId)",
      submitIdx,
    );
    expect(submitIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(submitIdx);
  });

  it("offers multi-select properties with Select all for the waive code", () => {
    expect(SETTINGS).toContain("CheckboxMultiSelect");
    expect(SETTINGS).toContain('data-attr="manager-settings-properties-select-all"');
    expect(SETTINGS).toContain("Select all");
    expect(MODAL).toContain("onPropertyIdsChange");
    expect(MODAL).toContain("onWaiverCodeCommit");
  });
});
