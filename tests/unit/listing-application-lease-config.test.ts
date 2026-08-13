import { describe, expect, it } from "vitest";
import {
  activeCustomLeaseTerms,
  activeLeaseTemplateDoc,
  createDefaultListingSubmission,
  listingUsesStandardApplication,
  normalizeCustomApplicationFields,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  customFieldsForWizardStep,
  listingCustomApplicationFields,
} from "@/lib/rental-application/custom-fields";
import {
  applicationWizardStepForSection,
  RENTAL_APPLICATION_SECTIONS,
} from "@/lib/rental-application/application-sections";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import { buildAiGeneratedLeaseHtml, type LeaseGenerationContext } from "@/lib/generated-lease";

function generatedLeaseHtml(ctx: LeaseGenerationContext): string {
  const outcome = buildAiGeneratedLeaseHtml(ctx);
  if (outcome.kind !== "generated") throw new Error(outcome.error);
  return outcome.html;
}

function subWith(patch: Partial<ManagerListingSubmissionV1>): ManagerListingSubmissionV1 {
  return { ...createDefaultListingSubmission(), ...patch };
}

function leaseCtx(submission: ManagerListingSubmissionV1 | undefined): LeaseGenerationContext {
  return {
    application: {
      fullLegalName: "Test Resident",
      leaseTerm: "12-Month",
      leaseStart: "2026-08-01",
      leaseEnd: "2027-07-31",
    },
    leasedRoom: undefined,
    listingProperty: undefined,
    submission,
    generatedAtIso: "2026-07-03T00:00:00.000Z",
  };
}

describe("application section catalog", () => {
  // The "cosigner_intent" section was removed from the product — it is gone
  // from src entirely, not renumbered — so it is no longer asserted here.
  it("maps every section to a valid applicant wizard step (household before property)", () => {
    for (const section of RENTAL_APPLICATION_SECTIONS) {
      expect(section.wizardStep).toBeGreaterThanOrEqual(1);
      expect(section.wizardStep).toBeLessThanOrEqual(10);
    }
    expect(RENTAL_APPLICATION_SECTIONS.find((s) => s.id === "household")?.wizardStep).toBe(1);
    expect(RENTAL_APPLICATION_SECTIONS.find((s) => s.id === "personal")?.wizardStep).toBe(2);
    expect(RENTAL_APPLICATION_SECTIONS.find((s) => s.id === "property")?.wizardStep).toBe(3);
  });

  // Additional details is step 8 (consent is 9) since the wizard was renumbered.
  it("routes untagged and unknown sections to the Additional details step", () => {
    expect(applicationWizardStepForSection(undefined)).toBe(8);
    expect(applicationWizardStepForSection("bogus")).toBe(8);
    expect(applicationWizardStepForSection("household")).toBe(1);
    expect(applicationWizardStepForSection("property")).toBe(3);
  });
});

describe("custom application field sections", () => {
  const fields = [
    { id: "a", key: "a", label: "Move-in window?", type: "text", required: true, options: [], section: "property" },
    { id: "b", key: "b", label: "Hear about us?", type: "select", required: false, options: ["Friend"], section: "additional" },
    { id: "c", key: "c", label: "Legacy question", type: "text", required: false, options: [] },
  ];

  it("normalizes valid sections and drops invalid ones", () => {
    const normalized = normalizeCustomApplicationFields([
      ...fields,
      { id: "d", key: "d", label: "Bad section", type: "text", required: false, options: [], section: "nope" },
    ]);
    expect(normalized.find((f) => f.id === "a")?.section).toBe("property");
    expect(normalized.find((f) => f.id === "c")?.section).toBeUndefined();
    expect(normalized.find((f) => f.id === "d")?.section).toBeUndefined();
  });

  it("asks each question on its section's step; untagged fall back to Additional details (step 8)", () => {
    const normalized = normalizeCustomApplicationFields(fields);
    expect(customFieldsForWizardStep(normalized, 3).map((f) => f.id)).toEqual(["a"]);
    expect(customFieldsForWizardStep(normalized, 8).map((f) => f.id)).toEqual(["b", "c"]);
    expect(customFieldsForWizardStep(normalized, 4)).toEqual([]);
  });

  it("ignores custom questions when the property uses the standard application", () => {
    const sub = subWith({
      customApplicationFields: normalizeCustomApplicationFields(fields),
      applicationConfigMode: "custom",
    });
    expect(listingCustomApplicationFields(sub)).toHaveLength(3);
    sub.applicationConfigMode = "standard";
    expect(listingUsesStandardApplication(sub)).toBe(false);
    expect(listingCustomApplicationFields(sub)).toHaveLength(3);
    sub.customApplicationFields = [];
    expect(listingUsesStandardApplication(sub)).toBe(true);
    expect(listingCustomApplicationFields(sub)).toEqual([]);
    // Legacy submissions (no mode) keep applying their questions.
    sub.applicationConfigMode = undefined;
    sub.customApplicationFields = normalizeCustomApplicationFields(fields);
    expect(listingCustomApplicationFields(sub)).toHaveLength(3);
  });
});

describe("custom lease config helpers", () => {
  it("activates custom terms only for mode=custom kind=terms", () => {
    expect(activeCustomLeaseTerms(subWith({ customLeaseTerms: "X" }))).toBe("");
    expect(activeCustomLeaseTerms(subWith({ leaseConfigMode: "custom", customLeaseTerms: " X " }))).toBe("X");
    expect(
      activeCustomLeaseTerms(subWith({ leaseConfigMode: "custom", leaseCustomKind: "document", customLeaseTerms: "X" })),
    ).toBe("");
  });

  it("activates the template doc only for mode=custom kind=document with a url", () => {
    expect(activeLeaseTemplateDoc(subWith({ leaseTemplateDocUrl: "u" }))).toBeNull();
    expect(
      activeLeaseTemplateDoc(subWith({ leaseConfigMode: "custom", leaseCustomKind: "document", leaseTemplateDocUrl: "" })),
    ).toBeNull();
    expect(
      activeLeaseTemplateDoc(
        subWith({
          leaseConfigMode: "custom",
          leaseCustomKind: "document",
          leaseTemplateDocUrl: "https://x/lease.pdf",
          leaseTemplateDocName: "My lease.pdf",
        }),
      ),
    ).toEqual({ url: "https://x/lease.pdf", name: "My lease.pdf" });
  });

  it("survives normalization round-trips", () => {
    const normalized = normalizeManagerListingSubmissionV1(
      subWith({
        applicationConfigMode: "custom",
        leaseConfigMode: "custom",
        leaseCustomKind: "document",
        leaseTemplateDocUrl: "https://x/lease.pdf",
        leaseTemplateDocName: "My lease.pdf",
        customLeaseTerms: "Keep it clean.",
      }),
    );
    expect(normalized.applicationConfigMode).toBe("custom");
    expect(normalized.leaseConfigMode).toBe("custom");
    expect(normalized.leaseCustomKind).toBe("document");
    expect(normalized.leaseTemplateDocUrl).toBe("https://x/lease.pdf");
    expect(normalized.customLeaseTerms).toBe("Keep it clean.");
  });
});

describe("lease generation with custom config", () => {
  it("renders custom terms as an addendum in the generated lease", () => {
    const sub = subWith({
      leaseConfigMode: "custom",
      leaseCustomKind: "terms",
      customLeaseTerms: "Parking: one assigned spot.\n\nNo smoking <anywhere>.",
    });
    const html = buildLeaseHtml(leaseCtx(sub), SEATTLE_LEASE_CONFIG);
    expect(html).toContain("Additional Provisions from Property Manager");
    expect(html).toContain("Parking: one assigned spot.");
    expect(html).toContain("No smoking &lt;anywhere&gt;.");
  });

  it("omits the addendum for standard-lease properties", () => {
    const html = buildLeaseHtml(leaseCtx(subWith({ customLeaseTerms: "Ignored." })), SEATTLE_LEASE_CONFIG);
    expect(html).not.toContain("Additional Provisions from Property Manager");
    expect(html).not.toContain("Ignored.");
  });

  it("uses the manager template document as the lease, regardless of jurisdiction", () => {
    const sub = subWith({
      leaseConfigMode: "custom",
      leaseCustomKind: "document",
      leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/lease-template.pdf",
      leaseTemplateDocName: "House lease.pdf",
    });
    const html = generatedLeaseHtml(leaseCtx(sub));
    expect(html).toContain("lease-template.pdf");
    expect(html).toContain("House lease.pdf");
    expect(html).toContain("TERMS RIDER");
    expect(html).toContain("Test Resident");
    expect(html).toContain("Electronic Signature");
  });

  it("returns an unsupported jurisdiction outcome for the standard generated lease", () => {
    expect(buildAiGeneratedLeaseHtml(leaseCtx(subWith({})))).toEqual({
      kind: "unsupported_jurisdiction",
      error: expect.stringMatching(/California and Washington/),
    });
  });
});
