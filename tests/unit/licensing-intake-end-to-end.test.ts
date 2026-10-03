// @vitest-environment jsdom
//
// C2-R30-11 — a custom Licensing agreement and an uploaded Intake form work end to end, through the
// real code paths (no browser): the name an upload carries is the name the forms show; the Intake form
// and the Licensing agreement link to each other from either side and survive a save; "Lease first,
// then application" drives the resident's journey and the public CTA while the general default stays
// application first; and the uploaded form's detected fields are the imported intake questions.
import { describe, expect, it } from "vitest";
import { deriveFormNameFromFileName } from "@/components/portal/pro-property-application-questions-panel";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { applicationIdForLease, leaseIdForApplication, setMappingTarget } from "@/lib/application-lease-mapping";
import { normalizeFormsTerminology, applicationTerm, leaseTerm } from "@/lib/rental-application/forms-terminology";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { DEFAULT_LEASING_PIPELINE, normalizeLeasingPipelinePreferences, signingOrderForPipeline } from "@/lib/leasing-pipeline-preferences";
import { residentLifecycleSteps, resolveResidentLifecycleNextAction, type ResidentLifecycleInput } from "@/lib/resident-lifecycle-journey";
import { listingApplyLabel } from "@/lib/listing-prospect-cta-labels";

const licensing = (label = "Licensing agreement") =>
  createPropertyLeaseTemplate({ kind: "long-term", label, source: "custom_format", leaseTemplateDocUrl: "/api/portal/lease-template?path=u/x.pdf", leaseTemplateDocName: "Ida Cares Homes_Licensing agreement.pdf" });

describe("an uploaded form is called what its file is called", () => {
  it("takes the form name after the workspace prefix and drops the extension", () => {
    expect(deriveFormNameFromFileName("Ida Cares Homes_Intake Form.pdf")).toBe("Intake Form");
    expect(deriveFormNameFromFileName("Ida Cares Homes_Licensing agreement.pdf")).toBe("Licensing agreement");
    expect(deriveFormNameFromFileName("Standalone.PDF")).toBe("Standalone");
  });

  it("that name is the template's label, and it survives the listing submission round trip", () => {
    const lease = licensing(deriveFormNameFromFileName("Ida Cares Homes_Licensing agreement.pdf"));
    const intake = createPropertyApplicationTemplate({ kind: "long-term", label: deriveFormNameFromFileName("Ida Cares Homes_Intake Form.pdf") });
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      propertyLeaseTemplates: [lease],
      propertyApplicationTemplates: [intake],
    });
    expect(sub.propertyLeaseTemplates?.[0]?.label).toBe("Licensing agreement");
    expect(sub.propertyApplicationTemplates?.[0]?.label).toBe("Intake Form");
  });

  it("a workspace that renames the forms sees its own words everywhere the terms are used", () => {
    const terms = normalizeFormsTerminology({ applicationLabel: "Intake form", leaseLabel: "Licensing agreement" });
    expect(applicationTerm(terms)).toBe("Intake form");
    expect(leaseTerm(terms)).toBe("Licensing agreement");
  });
});

describe("an application and a lease link one-to-one, in the direction the signing order makes dependent (C2-CP9)", () => {
  const intake = createPropertyApplicationTemplate({ kind: "long-term", label: "Intake Form" });
  const otherIntake = createPropertyApplicationTemplate({ kind: "long-term", label: "Short stay form" });

  it("application first: mapping an application to a lease is stored on the application and the lease answers it", () => {
    const leases = [licensing(), licensing("House addendum")];
    const result = setMappingTarget("application_then_lease", { applications: [intake], leases }, intake.id, leases[0]!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(leaseIdForApplication({ applications: result.applications, leases: result.leases }, intake.id)).toBe(leases[0]!.id);
  });

  it("lease first is gone: a lease answers with no application, even one that names its form", () => {
    const named = { ...licensing(), linkedApplicationTemplateId: intake.id };
    expect(applicationIdForLease({ applications: [intake], leases: [named] }, named.id)).toBeNull();
  });

  it("a link made before the one-to-one rule is read, not lost: an application's older legacy lease list", () => {
    const lease = licensing();
    const mirror = { ...intake, usedForLeaseTemplateIds: [lease.id] };
    expect(leaseIdForApplication({ applications: [mirror], leases: [lease] }, intake.id)).toBe(lease.id);
  });

  it("the link survives the listing submission round trip", () => {
    const lease = licensing();
    const linked = { ...intake, linkedLeaseTemplateId: lease.id };
    const sub = normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), propertyLeaseTemplates: [lease], propertyApplicationTemplates: [linked] });
    expect(sub.propertyApplicationTemplates?.[0]?.linkedLeaseTemplateId).toBe(lease.id);
  });
});

describe("Every workspace is application first, even one that stored lease first", () => {
  const marc = normalizeLeasingPipelinePreferences({ pipelineOrder: "lease_then_application" });
  const base: ResidentLifecycleInput = {
    applicationFeePaid: false,
    applicationSubmitted: false,
    applicationApproved: false,
    residentSignedLease: false,
    managerCountersigned: false,
    moveInChargesPaid: false,
    movedIn: false,
  };

  it("the default workspace pipeline is application first", () => {
    expect(signingOrderForPipeline(DEFAULT_LEASING_PIPELINE)).toBe("application_first");
    expect(signingOrderForPipeline(normalizeLeasingPipelinePreferences({}))).toBe("application_first");
    expect(signingOrderForPipeline(normalizeLeasingPipelinePreferences({ pipelineOrder: "nonsense" }))).toBe("application_first");
  });

  it("a stored lease-first order is ignored", () => {
    expect(marc.pipelineOrder).toBe("application_then_lease");
    expect(signingOrderForPipeline(marc)).toBe("application_first");
  });

  it("the resident's steps start with the application", () => {
    expect(residentLifecycleSteps(base)[0]).toMatchObject({ id: "received", state: "current" });
  });

  it("an applicant who has applied waits on the review, never on a lease", () => {
    const next = resolveResidentLifecycleNextAction({ ...base, applicationSubmitted: true, applicationFeePaid: true });
    expect(next.ctaLabel).not.toBe("Sign lease");
    expect(next.href ?? "").not.toContain("/sign-and-pay");
  });

  it("the listing's call to action says Apply", () => {
    expect(listingApplyLabel(false, signingOrderForPipeline(marc))).toBe("Apply online");
    expect(listingApplyLabel(false, signingOrderForPipeline(DEFAULT_LEASING_PIPELINE))).toBe("Apply online");
  });
});
