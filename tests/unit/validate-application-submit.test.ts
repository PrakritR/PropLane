import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { customApplicationConfigWithAllStandardQuestions } from "@/lib/rental-application/application-field-catalog";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import {
  findDisabledApplicationFieldViolation,
  residentApplicationScreeningAllowed,
  sanitizeApplicationFormForListing,
  validateResidentApplicationSubmit,
} from "@/lib/rental-application/validate-application-submit";
import { STANDARD_APPLICATION_FIELD_CATALOG } from "@/lib/rental-application/application-field-catalog";
import { validateResidentApplicationRowForPersistence } from "@/lib/rental-application/validate-application-submit.server";

function createFullApplicationListingSubmission() {
  return {
    ...createDefaultListingSubmission(),
    ...customApplicationConfigWithAllStandardQuestions(),
  };
}

function validSubmittedApplication() {
  return {
    ...createInitialRentalWizardState(),
    applyingAsGroup: "no" as const,
    hasCosigner: "no" as const,
    propertyId: "prop-1",
    roomChoice1: "prop-1",
    leaseTerm: "12-Month",
    leaseStart: "2027-08-01",
    leaseEnd: "2028-07-31",
    fullLegalName: "Jordan Lee",
    dateOfBirth: "1995-01-15",
    ssn: "123-45-6789",
    driversLicense: "WA1234567",
    phone: "(206) 555-0100",
    email: "jordan@example.com",
    currentStreet: "100 Main St",
    currentCity: "Seattle",
    currentState: "WA",
    currentZip: "98101",
    noPreviousAddress: true,
    notEmployed: false,
    employer: "Axis Housing",
    monthlyIncome: "5,000",
    ref1Name: "Sam Rivera",
    ref1Relationship: "Friend",
    ref1Phone: "(206) 555-0101",
    occupancyCount: "1",
    evictionHistory: "no" as const,
    bankruptcyHistory: "no" as const,
    criminalHistory: "no" as const,
    consentCredit: true,
    consentTruth: true,
    digitalSignature: "Jordan Lee",
    dateSigned: "2026-07-07",
  };
}

describe("validate-application-submit", () => {
  it("rejects values for disabled built-in application fields", () => {
    const leaseTermDef = STANDARD_APPLICATION_FIELD_CATALOG.find((d) => d.label === "Lease term")!;
    const sub = {
      ...createDefaultListingSubmission(),
      disabledStandardApplicationKeys: [leaseTermDef.standardKey],
    };
    const violation = findDisabledApplicationFieldViolation(
      { leaseTerm: "12 months" },
      sub,
    );
    expect(violation).toContain("does not accept");
  });

  it("allows in-progress drafts without full wizard validation", () => {
    const result = validateResidentApplicationSubmit({
      application: { propertyId: "prop-1" },
      property: { id: "prop-1", listingSubmission: createDefaultListingSubmission() },
      inProgress: true,
    });
    expect(result).toEqual({ ok: true });
  });

  it("enforces listing field config on submitted applications", () => {
    const leaseTermDef = STANDARD_APPLICATION_FIELD_CATALOG.find((d) => d.label === "Lease term")!;
    const sub = {
      ...createDefaultListingSubmission(),
      disabledStandardApplicationKeys: [leaseTermDef.standardKey],
    };
    const result = validateResidentApplicationSubmit({
      application: validSubmittedApplication(),
      property: { id: "prop-1", listingSubmission: sub },
      inProgress: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not accept");
    }
  });

  it("requires enabled fields before accepting a submitted application", () => {
    const application = validSubmittedApplication();
    application.fullLegalName = "";
    const result = validateResidentApplicationSubmit({
      application,
      property: { id: "prop-1", listingSubmission: createDefaultListingSubmission() },
      inProgress: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns the same field-level error used by step validation", () => {
    const application = validSubmittedApplication();
    application.fullLegalName = "";
    const property = { id: "prop-1", listingSubmission: createDefaultListingSubmission() };
    const result = validateResidentApplicationSubmit({ application, property, inProgress: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe(2);
      expect(result.fieldErrors.fullLegalName).toBe("Full name is required.");
    }
  });

  it("blocks a required manager question attached to the Review step", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom" as const,
      customApplicationFields: [
        {
          id: "caf-review",
          key: "review-confirmation",
          label: "Confirm the information above",
          type: "checkbox" as const,
          required: true,
          options: [],
          section: "review" as const,
        },
      ],
    };
    const result = validateResidentApplicationSubmit({
      application: validSubmittedApplication(),
      property: { id: "prop-1", listingSubmission: sub },
      inProgress: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe(10);
      expect(result.fieldErrors["custom:review-confirmation"]).toBe(
        "This box must be checked to continue.",
      );
    }
  });

  it("keeps client and server validation aligned on the same submitted fixture", async () => {
    const application = validSubmittedApplication();
    application.email = "not-an-email";
    const property = {
      id: "prop-1",
      listingSubmission: createDefaultListingSubmission(),
    };
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { property_data: property }, error: null }),
          }),
        }),
      }),
    };

    const clientResult = validateResidentApplicationSubmit({
      application,
      property,
      inProgress: false,
    });
    const serverResult = await validateResidentApplicationRowForPersistence(db as never, {
      id: "PROPLANE-VALIDATION1",
      name: "Jordan Lee",
      property: "Test property",
      propertyId: property.id,
      stage: "Submitted",
      bucket: "pending",
      email: application.email,
      detail: "Submitted",
      application,
    });

    expect(clientResult.ok).toBe(false);
    expect(serverResult.ok).toBe(false);
    if (!clientResult.ok && !serverResult.ok) {
      expect(serverResult.step).toBe(clientResult.step);
      expect(serverResult.fieldErrors).toEqual(clientResult.fieldErrors);
      expect(serverResult.error).toBe(clientResult.error);
    }
  });

  it("rejects a forged short-term submission when the listing does not permit short-term stays", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      shortTermRentalsAllowed: false,
      disabledStandardApplicationKeys: ["property-rental-type-standard-or-short-term"],
    };
    const application = {
      ...validSubmittedApplication(),
      rentalType: "short_term" as const,
      shortTermCheckInTime: "15:00",
      shortTermCheckOutTime: "11:00",
      shortTermRulesAck: true,
      // A real short-term application never carries these — the short-term form
      // does not ask them — so clear them, otherwise the (correct) field-accept
      // guard rejects the forgery first and this test would no longer exercise
      // the short-term PERMISSION gate specifically.
      ssn: "",
      driversLicense: "",
      currentStreet: "",
      currentCity: "",
      currentState: "",
      currentZip: "",
      employer: "",
      monthlyIncome: "",
      ref1Name: "",
      ref1Relationship: "",
      ref1Phone: "",
      occupancyCount: "",
      evictionHistory: null,
      bankruptcyHistory: null,
      criminalHistory: null,
      consentCredit: false,
    };
    const result = validateResidentApplicationSubmit({
      application,
      property: { id: "prop-1", listingSubmission: sub },
      inProgress: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not allow short-term stays");
    }
  });

  it("does not allow screening when credit consent is disabled for the listing", () => {
    const consentDef = STANDARD_APPLICATION_FIELD_CATALOG.find(
      (d) => d.label === "Credit & background check consent",
    )!;
    const sub = {
      ...createDefaultListingSubmission(),
      disabledStandardApplicationKeys: [consentDef.standardKey],
    };
    const application = validSubmittedApplication();
    application.consentCredit = true;
    expect(residentApplicationScreeningAllowed(sub, application)).toBe(false);
    const result = validateResidentApplicationSubmit({
      application,
      property: { id: "prop-1", listingSubmission: sub },
      inProgress: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not accept");
    }
  });

  it("sanitizes long-term answers out of a short-term submission but keeps what the short-term form asked", () => {
    // Someone fills the full long-term form, then switches to a short-term stay.
    // The submitted snapshot must NOT carry the sensitive fields the short-term
    // form never asked (privacy), while the fields it DID ask must survive.
    const sub = {
      ...createDefaultListingSubmission(),
      shortTermRentalsAllowed: true,
      customApplicationFields: [
        { id: "caf-lt", key: "pet-breed", label: "Pet breed", type: "text" as const, required: false, options: [], section: "additional" },
      ],
      shortTermCustomApplicationFields: [
        { id: "caf-st", key: "arrival-notes", label: "Arrival notes", type: "text" as const, required: false, options: [], section: "property" },
      ],
    };
    const filledLongTerm = {
      ...validSubmittedApplication(),
      rentalType: "short_term" as const,
      shortTermCheckInTime: "15:00",
      shortTermCheckOutTime: "11:00",
      shortTermRulesAck: true,
      customFieldAnswers: [
        { key: "pet-breed", label: "Pet breed", type: "text" as const, value: "Corgi" },
        { key: "arrival-notes", label: "Arrival notes", type: "text" as const, value: "Arriving after 9pm" },
      ],
    };

    const sanitized = sanitizeApplicationFormForListing(filledLongTerm, sub);

    // Sensitive long-term-only fields the short-term form never asks: cleared.
    expect(sanitized.ssn).toBe("");
    expect(sanitized.driversLicense).toBe("");
    expect(sanitized.employer).toBe("");
    expect(sanitized.monthlyIncome).toBe("");
    expect(sanitized.ref1Name).toBe("");
    expect(sanitized.currentStreet).toBe("");
    expect(sanitized.consentCredit).toBe(false);
    // A manager custom question asked only on the long-term form: its answer is dropped.
    expect(sanitized.customFieldAnswers.some((a) => a.key === "pet-breed")).toBe(false);

    // Fields the short-term form DID ask: retained (losing one would be its own bug).
    expect(sanitized.fullLegalName).toBe("Jordan Lee");
    expect(sanitized.email).toBe("jordan@example.com");
    expect(sanitized.phone).toBe("(206) 555-0100");
    expect(sanitized.leaseStart).toBe("2027-08-01");
    expect(sanitized.shortTermCheckInTime).toBe("15:00");
    expect(sanitized.shortTermCheckOutTime).toBe("11:00");
    expect(sanitized.shortTermRulesAck).toBe(true);
    expect(sanitized.digitalSignature).toBe("Jordan Lee");
    expect(sanitized.consentTruth).toBe(true);
    // A custom question the short-term form DID ask: its answer survives.
    expect(sanitized.customFieldAnswers).toEqual([
      { key: "arrival-notes", label: "Arrival notes", type: "text", value: "Arriving after 9pm" },
    ]);
  });

  it("leaves a long-term submission fully intact (nothing sanitized away)", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      customApplicationFields: [
        { id: "caf-lt", key: "pet-breed", label: "Pet breed", type: "text" as const, required: false, options: [], section: "additional" },
      ],
    };
    const longTerm = {
      ...validSubmittedApplication(),
      customFieldAnswers: [{ key: "pet-breed", label: "Pet breed", type: "text" as const, value: "Corgi" }],
    };
    const sanitized = sanitizeApplicationFormForListing(longTerm, sub);
    expect(sanitized.ssn).toBe(longTerm.ssn);
    expect(sanitized.employer).toBe(longTerm.employer);
    expect(sanitized.ref1Name).toBe(longTerm.ref1Name);
    expect(sanitized.consentCredit).toBe(true);
    expect(sanitized.customFieldAnswers).toEqual(longTerm.customFieldAnswers);
  });

  it("keeps custom answers when the listing submission cannot be resolved at submit", () => {
    // The listing may be gone from the extras cache at final submit (e.g. the
    // manager unlisted it mid-application). The asked-question set is then
    // unknowable, so no custom answer may be dropped.
    const form = {
      ...validSubmittedApplication(),
      rentalType: "short_term" as const,
      shortTermCheckInTime: "15:00",
      shortTermCheckOutTime: "11:00",
      shortTermRulesAck: true,
      customFieldAnswers: [
        { key: "arrival-notes", label: "Arrival notes", type: "text" as const, value: "Arriving after 9pm" },
      ],
    };
    const sanitized = sanitizeApplicationFormForListing(form, undefined);
    expect(sanitized.customFieldAnswers).toEqual(form.customFieldAnswers);

    const longTerm = {
      ...validSubmittedApplication(),
      customFieldAnswers: [{ key: "pet-breed", label: "Pet breed", type: "text" as const, value: "Corgi" }],
    };
    expect(sanitizeApplicationFormForListing(longTerm, undefined)).toBe(longTerm);
  });

  const sampleAttachment = {
    storagePath: "application/PROPLANE-ABC123/idFront-1-uuid.jpg",
    fileName: "front.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1234,
    uploadedAt: "2026-07-27T00:00:00.000Z",
  };

  it("keeps ID + income photos on a long-term submission where those questions are enabled", () => {
    const form = {
      ...validSubmittedApplication(),
      idPhotoFront: { ...sampleAttachment },
      idPhotoBack: { ...sampleAttachment, storagePath: "application/PROPLANE-ABC123/idBack-1-uuid.jpg" },
      incomeProofPhotos: [{ ...sampleAttachment, storagePath: "application/PROPLANE-ABC123/income-1-uuid.jpg" }],
    };
    const sanitized = sanitizeApplicationFormForListing(form, createFullApplicationListingSubmission());
    expect(sanitized.idPhotoFront).not.toBeNull();
    expect(sanitized.idPhotoBack).not.toBeNull();
    expect(sanitized.incomeProofPhotos).toHaveLength(1);
  });

  it("strips ID + income photos from a SHORT-TERM submission (the other variant asked for them)", () => {
    const form = {
      ...validSubmittedApplication(),
      rentalType: "short_term" as const,
      idPhotoFront: { ...sampleAttachment },
      idPhotoBack: { ...sampleAttachment, storagePath: "application/PROPLANE-ABC123/idBack-1-uuid.jpg" },
      incomeProofPhotos: [{ ...sampleAttachment, storagePath: "application/PROPLANE-ABC123/income-1-uuid.jpg" }],
    };
    // Short-term default config disables the driver's-license and employment
    // questions, which carry the photo wizard keys — so the photos strip too.
    const sanitized = sanitizeApplicationFormForListing(form, createDefaultListingSubmission());
    expect(sanitized.idPhotoFront).toBeNull();
    expect(sanitized.idPhotoBack).toBeNull();
    expect(sanitized.incomeProofPhotos).toEqual([]);
  });

  it("flags a short-term submission that still carries an ID photo, but not an empty income list", () => {
    const sub = createDefaultListingSubmission();
    // Start from a form already sanitized for short-term, so the ONLY disabled
    // field left to (re)introduce is the photo — isolating the photo behavior
    // from the many other fields short-term omits.
    const cleanBase = sanitizeApplicationFormForListing(
      { ...validSubmittedApplication(), rentalType: "short_term" as const },
      sub,
    );
    expect(findDisabledApplicationFieldViolation(cleanBase, sub)).toBeNull();
    // An empty income list stays unfilled (not a violation).
    expect(findDisabledApplicationFieldViolation({ ...cleanBase, incomeProofPhotos: [] }, sub)).toBeNull();
    // A populated ID photo on a short-term form IS a disallowed field.
    expect(
      findDisabledApplicationFieldViolation({ ...cleanBase, idPhotoFront: { ...sampleAttachment } }, sub),
    ).not.toBeNull();
  });
});
