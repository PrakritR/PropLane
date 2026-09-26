import { describe, expect, it } from "vitest";
import {
  autofillProfileIsEmpty,
  mergeAutofillIntoWizardState,
  mergeAuthenticatedApplicantIdentity,
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

  it("fills only blank answers and keeps applicant edits", () => {
    const current = { ...createInitialRentalWizardState(), fullLegalName: "Applicant typed", phone: "", email: "" };
    const merged = mergeAutofillIntoWizardState(current, { fullLegalName: "Old answer", phone: "2065550100" });
    expect(merged.fullLegalName).toBe("Applicant typed");
    expect(merged.phone).toBe("2065550100");
    const identity = mergeAuthenticatedApplicantIdentity(merged, {
      fullLegalName: "Account name", phone: "2065550199", email: "account@example.com",
    });
    expect(identity.fullLegalName).toBe("Applicant typed");
    expect(identity.phone).toBe("2065550100");
    expect(identity.email).toBe("account@example.com");
  });
});
