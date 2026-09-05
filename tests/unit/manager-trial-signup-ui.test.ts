import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/components/auth/manager-trial-signup-form.tsx"),
  "utf8",
);

describe("manager trial signup UI (pricing / create-account)", () => {
  it("keeps the standard OAuth + fields form when the user already has manager access", () => {
    expect(source).toContain("PricingAppleContinueButton");
    expect(source).toContain('AuthDivider label="or enter your details"');
    expect(source).toContain("Set up property manager");
    expect(source).not.toContain("AuthAlreadyHaveRolePanel");
    expect(source).not.toContain("AuthSignedInRoleBanner");
  });

  it("does not use bordered info callout panels for loading or ready states", () => {
    expect(source).toContain("AuthLoadingCard");
    expect(source).not.toMatch(/rounded-2xl border border-border bg-card\/50/);
  });

  it("does not show a signed-in banner under the create form", () => {
    expect(source).not.toContain("Signed in as");
    expect(source).not.toContain("Continue to your portal");
  });

  it("offers a plain footer link back to the existing portal", () => {
    expect(source).toContain("Already managing a property?");
    expect(source).toContain("manager-trial-signup-go-to-existing-portal");
  });

  it("does not spin on Finishing sign-in when the server already provisioned the trial", () => {
    expect(source).toContain("goToManagerAccountSetup");
    expect(source).toContain("redirectingToSetup");
    expect(source).toContain("googleReturn && !accountReadyReturn");
    expect(source).not.toContain("manager-trial-signup-go-to-portal");
    expect(source).not.toContain("manager-trial-signup-create-another");
  });
});
