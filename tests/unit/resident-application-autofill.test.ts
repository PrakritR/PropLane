import { describe, expect, it } from "vitest";
import {
  autofillProfileIsEmpty,
  mergeAutofillIntoWizardState,
  pickAutofillProfileFromApplication,
} from "@/lib/rental-application/resident-application-autofill";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

describe("resident-application-autofill", () => {
  it("copies reusable fields but not property or lease dates", () => {
    const source = {
      ...createInitialRentalWizardState(),
      fullLegalName: "Alex Applicant",
      phone: "(206) 555-0100",
      employer: "Acme Co",
      propertyId: "prop-old",
      leaseStart: "2026-09-01",
      roomChoice1: "room-a",
      consentCredit: true,
      applicationFeeAcknowledged: true,
    };
    const profile = pickAutofillProfileFromApplication(source);
    expect(profile.fullLegalName).toBe("Alex Applicant");
    expect(profile.employer).toBe("Acme Co");
    expect("propertyId" in profile).toBe(false);
    expect("leaseStart" in profile).toBe(false);
    expect("consentCredit" in profile).toBe(false);
  });

  it("merges profile without overwriting property-specific answers", () => {
    const current = {
      ...createInitialRentalWizardState(),
      propertyId: "prop-new",
      leaseStart: "",
      fullLegalName: "",
    };
    const merged = mergeAutofillIntoWizardState(current, {
      fullLegalName: "Alex Applicant",
      employer: "Acme Co",
      leaseStart: "2025-01-01",
    });
    expect(merged.propertyId).toBe("prop-new");
    expect(merged.fullLegalName).toBe("Alex Applicant");
    expect(merged.employer).toBe("Acme Co");
    expect(merged.leaseStart).toBe("");
    expect(autofillProfileIsEmpty({})).toBe(true);
  });
});
