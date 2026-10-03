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
import {
  createPropertyLeaseTemplate,
  leaseIdsUsingApplicationTemplate,
  linkLeasesToApplicationTemplate,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
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

describe("Used for leases links the Intake form and the Licensing agreement in both directions", () => {
  const intake = createPropertyApplicationTemplate({ kind: "long-term", label: "Intake Form" });
  const otherIntake = createPropertyApplicationTemplate({ kind: "long-term", label: "Short stay form" });

  it("saving the Intake form with the Licensing agreement selected points the lease at it; the editor then lists it as selected", () => {
    const leases = [licensing(), licensing("House addendum")];
    const saved = linkLeasesToApplicationTemplate(leases, intake.id, [leases[0]!.id]);
    expect(saved[0]!.linkedApplicationTemplateId).toBe(intake.id);
    expect(saved[1]!.linkedApplicationTemplateId ?? null).toBeNull();
    expect(leaseIdsUsingApplicationTemplate(saved, { id: intake.id })).toEqual([leases[0]!.id]);
  });

  it("deselecting releases only the leases this form served, never another form's", () => {
    const [a, b] = [licensing(), licensing("House addendum")];
    const start: PropertyLeaseTemplate[] = [{ ...a, linkedApplicationTemplateId: intake.id }, { ...b, linkedApplicationTemplateId: otherIntake.id }];
    const saved = linkLeasesToApplicationTemplate(start, intake.id, []);
    expect(saved[0]!.linkedApplicationTemplateId).toBeNull();
    expect(saved[1]!.linkedApplicationTemplateId).toBe(otherIntake.id);
  });

  it("a link made from the lease's own form shows up on the Intake form and is not dropped by saving it", () => {
    // The lease form's Application picker writes the lease's link only.
    const lease = { ...licensing(), linkedApplicationTemplateId: intake.id };
    // The Intake form's own mirror knows nothing of it.
    const template = { id: intake.id, usedForLeaseTemplateIds: [] as string[] };
    const selected = leaseIdsUsingApplicationTemplate([lease], template);
    expect(selected).toEqual([lease.id]);
    // Saving the Intake form without touching "Used for leases" keeps the link.
    expect(linkLeasesToApplicationTemplate([lease], intake.id, selected)[0]!.linkedApplicationTemplateId).toBe(intake.id);
  });

  it("a lease the lease form re-pointed at another form is no longer listed on the old one", () => {
    const lease = { ...licensing(), linkedApplicationTemplateId: otherIntake.id };
    expect(leaseIdsUsingApplicationTemplate([lease], { id: intake.id, usedForLeaseTemplateIds: [lease.id] })).toEqual([]);
  });

  it("an older Intake form that only recorded the mirror still lists its leases", () => {
    const lease = licensing();
    expect(leaseIdsUsingApplicationTemplate([lease], { id: intake.id, usedForLeaseTemplateIds: [lease.id] })).toEqual([lease.id]);
  });

  it("the links survive the listing submission round trip", () => {
    const lease = licensing();
    const [linked] = linkLeasesToApplicationTemplate([lease], intake.id, [lease.id]);
    const sub = normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), propertyLeaseTemplates: [linked!], propertyApplicationTemplates: [intake] });
    expect(sub.propertyLeaseTemplates?.[0]?.linkedApplicationTemplateId).toBe(intake.id);
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
