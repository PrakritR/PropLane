/** @vitest-environment jsdom */
/**
 * Inside the resident portal the person booking a tour is already signed in.
 * The details step was still telling them no account is required, offering a
 * sign-in link, and re-asking for SMS consent they gave when the account was
 * created — an already-ticked box they cannot meaningfully act on is furniture,
 * not consent.
 *
 * A visitor with no account still sees both, because for them it IS the first
 * time.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src/components/marketing/tour-schedule-flow.tsx"), "utf8");

describe("tour details step", () => {
  it("gates the no-account copy on being signed out", () => {
    expect(SRC).toMatch(/\{signedIn \? null : \([\s\S]{0,200}No account is required to book a tour/);
  });

  it("gates the SMS consent tick on being signed out", () => {
    expect(SRC).toMatch(/\{signedIn \? null : \([\s\S]{0,200}SmsConsentCheckbox/);
  });

  it("submits consent as given for a signed-in resident", () => {
    // The tick is not rendered for them, so the default must not be "declined".
    expect(SRC).toContain("useState(signedIn)");
  });

  it("takes signedIn from the resolved session, not a prop default", () => {
    expect(SRC).toContain("signedIn={Boolean(signedInUserId)}");
  });
});
