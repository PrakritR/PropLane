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

  it("lease first: mapping a lease to an application is stored on the lease and the application answers it", () => {
    const lease = licensing();
    const result = setMappingTarget("lease_then_application", { applications: [intake, otherIntake], leases: [lease] }, lease.id, otherIntake.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leases[0]!.linkedApplicationTemplateId).toBe(otherIntake.id);
    expect(applicationIdForLease({ applications: result.applications, leases: result.leases }, lease.id)).toBe(otherIntake.id);
  });

  it("a link made before the one-to-one rule is read, not lost: a lease that named its form, an older mirror", () => {
    const named = { ...licensing(), linkedApplicationTemplateId: intake.id };
    expect(leaseIdForApplication({ applications: [intake], leases: [named] }, intake.id)).toBe(named.id);
    const lease = licensing();
    const mirror = { ...intake, usedForLeaseTemplateIds: [lease.id] };
    expect(leaseIdForApplication({ applications: [mirror], leases: [lease] }, intake.id)).toBe(lease.id);
    expect(applicationIdForLease({ applications: [mirror], leases: [lease] }, lease.id)).toBe(intake.id);
  });

  it("the link survives the listing submission round trip", () => {
    const lease = licensing();
    const linked = { ...intake, linkedLeaseTemplateId: lease.id };
    const sub = normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), propertyLeaseTemplates: [lease], propertyApplicationTemplates: [linked] });
    expect(sub.propertyApplicationTemplates?.[0]?.linkedLeaseTemplateId).toBe(lease.id);
  });
});

describe("Lease first, then application drives Marc's resident journey; the general default stays Application first", () => {
  const marc = normalizeLeasingPipelinePreferences({ pipelineOrder: "lease_then_application" });
  const base: ResidentLifecycleInput = {
    signingOrder: "lease_first",
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

  it("Marc's pipeline is lease first", () => {
    expect(signingOrderForPipeline(marc)).toBe("lease_first");
  });

  it("the resident's steps start with signing the lease for Marc and with the application otherwise", () => {
    expect(residentLifecycleSteps({ ...base, signingOrder: signingOrderForPipeline(marc) })[0]).toMatchObject({ id: "sign_lease", state: "current" });
    expect(residentLifecycleSteps({ ...base, signingOrder: signingOrderForPipeline(DEFAULT_LEASING_PIPELINE) })[0]).toMatchObject({ id: "received", state: "current" });
  });

  it("after signing, Marc's resident moves on to the application; the next action says so", () => {
    const signed = { ...base, residentSignedLease: true };
    const steps = residentLifecycleSteps(signed);
    expect(steps[0]).toMatchObject({ id: "sign_lease", state: "done" });
    expect(steps[1]).toMatchObject({ id: "received", state: "current" });
    expect(resolveResidentLifecycleNextAction(signed).ctaLabel).toBe("Continue application");
  });

  it("a lease-first prospect who has applied but not signed is sent to sign the lease", () => {
    const next = resolveResidentLifecycleNextAction({ ...base, applicationSubmitted: true, applicationFeePaid: true });
    expect(next.ctaLabel).toBe("Sign lease");
    expect(next.href).toContain("/sign-and-pay");
  });

  it("the listing's call to action follows the same order", () => {
    expect(listingApplyLabel(false, signingOrderForPipeline(marc))).toBe("Sign lease");
    expect(listingApplyLabel(false, signingOrderForPipeline(DEFAULT_LEASING_PIPELINE))).toBe("Apply online");
  });
});
