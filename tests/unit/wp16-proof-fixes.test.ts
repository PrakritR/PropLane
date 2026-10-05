/**
 * Fixes from the real-browser proof of the application / listing / calendar surfaces:
 *  - a co-signer=Yes answer owes the property's DEFAULT co-signer form when the template links none;
 *  - legacy lease-term text ("12 months", "nightly") reads as the lease type it stands for, and an empty set
 *    reads as Long term, so the stays the editor shows are the stays that save;
 *  - the people row never labels someone with a raw account id;
 *  - an application heading counts only the applications drawn in a visible stay section.
 */
import { describe, expect, it } from "vitest";
import { evaluateLinkedFormRules } from "@/lib/application-linked-form-requests";
import { COSIGNER_QUESTION_STANDARD_KEY } from "@/lib/application-linked-forms";
import {
  createDefaultListingSubmission,
  resolveAllowedLeaseTerms,
  resolveOfferedLeaseTermsOrDefault,
} from "@/lib/manager-listing-submission";
import { countRowsInVisibleSections, listingOfferedStays } from "@/lib/listing-stays";
import {
  applicationAppliesTo,
  cosignerTemplateIdOwedByApplication,
  createPropertyApplicationTemplate,
  type ApplicationTemplateQuestionConfig,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { staysOfAppliesTo } from "@/lib/property-application-templates";
import { normalizeLegacyLeaseTerm, normalizeLegacyLeaseTerms } from "@/lib/rental-application/lease-terms";
import { buildCalendarPeople, calendarPersonLabel } from "@/lib/calendar-people";

const published = {
  version: 1,
  disabledStandardApplicationKeys: [],
  customApplicationFields: [],
  applicationConfigMode: "standard",
} as unknown as ApplicationTemplateQuestionConfig;

const form = (label: string, kind: "long-term" | "short-term", extra: Partial<PropertyApplicationTemplate> = {}) =>
  ({ ...createPropertyApplicationTemplate({ kind, label }), publishedQuestionConfig: published, ...extra }) as PropertyApplicationTemplate;

describe("co-signer form: Property default", () => {
  const standard = form("Standard", "long-term", { linkedCosignerApplicationTemplateId: null });
  const cosigner = form("Co-signer", "long-term", { formVariant: "cosigner" });
  const submission = { propertyApplicationTemplates: [standard, cosigner] };

  it("a null link falls back to the property's default co-signer template", () => {
    expect(cosignerTemplateIdOwedByApplication(standard, submission)).toBe(cosigner.id);
  });

  it("an explicit link wins over the default", () => {
    const other = form("Other co-signer", "long-term", { formVariant: "cosigner" });
    const linked = { ...standard, linkedCosignerApplicationTemplateId: other.id };
    expect(cosignerTemplateIdOwedByApplication(linked, { propertyApplicationTemplates: [linked, cosigner, other] })).toBe(other.id);
  });

  it("is long term only, and the co-signer form itself never owes one", () => {
    const short = form("Short", "short-term", { appliesTo: "short_term" });
    expect(applicationAppliesTo(short, [])).toBe("short_term");
    expect(cosignerTemplateIdOwedByApplication(short, { propertyApplicationTemplates: [short, cosigner] })).toBeNull();
    expect(cosignerTemplateIdOwedByApplication(cosigner, submission)).toBeNull();
  });

  it("owes nothing when the property has no published co-signer template", () => {
    expect(cosignerTemplateIdOwedByApplication(standard, { propertyApplicationTemplates: [standard] })).toBeNull();
  });

  it("answering Yes to Co-signer planned then owes the default co-signer form", () => {
    const linked = cosignerTemplateIdOwedByApplication(standard, submission);
    const matches = evaluateLinkedFormRules({
      questions: [{ key: COSIGNER_QUESTION_STANDARD_KEY, label: "Co-signer planned", standardKey: COSIGNER_QUESTION_STANDARD_KEY }],
      application: { hasCosigner: "yes" },
      linkedCosignerApplicationTemplateId: linked,
    });
    expect(matches.map((match) => match.rule.formRef.id)).toEqual([cosigner.id]);
    const no = evaluateLinkedFormRules({
      questions: [{ key: COSIGNER_QUESTION_STANDARD_KEY, label: "Co-signer planned", standardKey: COSIGNER_QUESTION_STANDARD_KEY }],
      application: { hasCosigner: "no" },
      linkedCosignerApplicationTemplateId: linked,
    });
    expect(no).toEqual([]);
  });
});

describe("legacy lease terms", () => {
  it("reads retired and free-text values as the lease type they stand for", () => {
    expect(normalizeLegacyLeaseTerm("12 months")).toBe("Long-term");
    expect(normalizeLegacyLeaseTerm("6 months")).toBe("Long-term");
    expect(normalizeLegacyLeaseTerm("month-to-month")).toBe("Long-term");
    expect(normalizeLegacyLeaseTerm("custom")).toBe("Long-term");
    expect(normalizeLegacyLeaseTerm("nightly")).toBe("Short-Term Stay");
    expect(normalizeLegacyLeaseTerm("Weekly")).toBe("Short-Term Stay");
    expect(normalizeLegacyLeaseTerm("short-term")).toBe("Short-Term Stay");
    expect(normalizeLegacyLeaseTerm("airbnb")).toBe("Airbnb");
    expect(normalizeLegacyLeaseTerm("   ")).toBeNull();
    expect(normalizeLegacyLeaseTerm(7)).toBeNull();
  });

  it("keeps every already-known term exactly as stored", () => {
    expect(normalizeLegacyLeaseTerms(["12-Month", "Month-to-Month", "Custom", "Short-Term Stay"])).toEqual([
      "12-Month",
      "Month-to-Month",
      "Custom",
      "Short-Term Stay",
    ]);
    expect(normalizeLegacyLeaseTerms(["12 months", "6 months"])).toEqual(["Long-term"]);
  });

  it("a legacy-only listing offers Long term, matching what Basics shows", () => {
    const sub = { ...createDefaultListingSubmission(), allowedLeaseTerms: ["12 months"], shortTermRentalsAllowed: false };
    expect(resolveAllowedLeaseTerms(sub)).toEqual(["Long-term"]);
    expect(listingOfferedStays(sub)).toEqual({ long_term: true, short_term: false });
  });

  it("legacy short-stay words turn Short term on when the listing allows short stays", () => {
    const sub = { ...createDefaultListingSubmission(), allowedLeaseTerms: ["12 months", "nightly"], shortTermRentalsAllowed: true };
    expect(listingOfferedStays(sub)).toEqual({ long_term: true, short_term: true });
  });

  it("an empty set still defaults to Long term", () => {
    const sub = { ...createDefaultListingSubmission(), allowedLeaseTerms: [], shortTermRentalsAllowed: false };
    expect(resolveOfferedLeaseTermsOrDefault(sub)).toEqual(["Long-term"]);
    expect(listingOfferedStays(sub)).toEqual({ long_term: true, short_term: false });
  });
});

describe("the people row never shows an account id", () => {
  const uuid = "3f2b8c1e-9d4a-4e7b-8a21-5c6d7e8f9a0b";

  it("uses the display name, else the email's local part, else Co-manager", () => {
    expect(calendarPersonLabel({ userId: uuid, label: "Maya Chen" })).toBe("Maya Chen");
    expect(calendarPersonLabel({ userId: uuid, label: uuid, name: "Maya Chen" })).toBe("Maya Chen");
    expect(calendarPersonLabel({ userId: uuid, label: uuid, name: "", email: "maya.chen@example.com" })).toBe("maya.chen");
    expect(calendarPersonLabel({ userId: uuid, label: "maya@example.com" })).toBe("maya");
    expect(calendarPersonLabel({ userId: uuid, label: uuid })).toBe("Co-manager");
    expect(calendarPersonLabel({ userId: "user-7", label: "user-7" })).toBe("Co-manager");
  });

  it("derives initials from the same label, never from a uuid", () => {
    const people = buildCalendarPeople([
      { userId: "self", label: "You", isSelf: true },
      { userId: uuid, label: uuid, isSelf: false },
      { userId: "u2", label: "maya@example.com", isSelf: false },
    ]);
    expect(people.map((person) => person.label)).toEqual(["You", "Co-manager", "maya"]);
    expect(people.map((person) => person.initials)).toEqual(["YO", "CM", "MA"]);
    expect(people.some((person) => person.label.includes(uuid))).toBe(false);
  });
});

describe("application heading count", () => {
  const longApp = form("Long", "long-term", { appliesTo: "long_term" });
  const shortApp = form("Short", "short-term", { appliesTo: "short_term" });
  const bothApp = form("Both", "long-term", { appliesTo: "both" });
  const rows = [longApp, shortApp, bothApp];
  const sectionsOf = (template: PropertyApplicationTemplate) => staysOfAppliesTo(applicationAppliesTo(template, []));

  it("skips an application whose only stay is not offered", () => {
    const longOnly = { ...createDefaultListingSubmission(), shortTermRentalsAllowed: false, allowedLeaseTerms: ["Long-term"] };
    expect(countRowsInVisibleSections(longOnly, rows, sectionsOf)).toBe(2);
  });

  it("counts a both-stays application once when both stays are offered", () => {
    const both = { ...createDefaultListingSubmission(), allowedLeaseTerms: ["Long-term", "Short-Term Stay"], shortTermRentalsAllowed: true };
    expect(countRowsInVisibleSections(both, rows, sectionsOf)).toBe(3);
  });
});
