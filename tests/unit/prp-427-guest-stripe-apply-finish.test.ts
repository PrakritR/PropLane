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
  // PLAN-0920-0845 phase D moved the property multi-select itself out of this panel
  // (its own "Applies to" row, `PropertyScopeRow`, is gone) and into the module's
  // own `SettingsScopeBar`, mounted once per module by the host.
  const SETTINGS = read("src/components/portal/settings-scope-bar.tsx");
  // The Applications panel's property-selection wiring moved out of the modal into
  // `SettingsModulePage`, the one component both the dialog and the standalone
  // `/portal/settings/<tab>` page render — see that file's own header comment.
  const MODULE_PAGE = read("src/components/portal/settings-module-page.tsx");

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

  // Stripe-return submission is server-owned. Behavioral coverage now lives in
  // rental-wizard-public-resume.test.tsx, "Stripe return verification recovery":
  // failed verification can retry, and paid-but-unpromoted returns preserve the
  // receipt without submitting the identity-only form restored after Checkout.

  it("offers multi-select properties without Select all or Clear", () => {
    expect(SETTINGS).toContain("CheckboxMultiSelect");
    expect(SETTINGS).not.toContain("Select all");
    expect(SETTINGS).not.toContain("Clear");
    expect(SETTINGS).not.toContain("menuFooter");
    expect(SETTINGS).not.toContain('data-attr="settings-scope-properties-select-all"');
    expect(MODULE_PAGE).toContain("onPropertyIdsChange");
    expect(MODULE_PAGE).toContain("onWaiverCodeCommit");
  });
});
