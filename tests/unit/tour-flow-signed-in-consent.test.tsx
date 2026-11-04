/** @vitest-environment jsdom */
/**
 * "Your details" in the tour flow. A visitor with no account has none of the contact form: the step IS the
 * account step (Apple / Google / email), and nothing is written before sign-in. A signed-in resident already
 * has an account and has already consented, so the step shows only their prefilled details and one button.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src/components/marketing/tour-schedule-flow.tsx"), "utf8");

describe("tour details step", () => {
  it("never tells a visitor that no account is needed", () => {
    expect(SRC).not.toContain("No account is required to book a tour");
  });

  it("sends a signed-out visitor to the account step instead of the contact form", () => {
    expect(SRC).toMatch(/if \(!signedIn\) \{\s*return <TourAccountStep pub/);
  });

  it("carries the pick through sign-in on `next`", () => {
    expect(SRC).toContain("tourSchedulePath({");
    expect(SRC).toContain("<ResidentAppleSignUpButton nextPath={accountNext} />");
    expect(SRC).toContain("residentCreateAccountHref(accountNext)");
  });

  it("does not render the SMS consent tick (consent was given when the account was created)", () => {
    expect(SRC).not.toContain("<SmsConsentCheckbox");
  });

  it("submits consent as given for a signed-in resident", () => {
    // The tick is not rendered for them, so the default must not be "declined".
    expect(SRC).toContain("useState(signedIn)");
  });

  it("takes signedIn from the resolved session, not a prop default", () => {
    expect(SRC).toContain("signedIn={Boolean(signedInUserId)}");
  });
});
