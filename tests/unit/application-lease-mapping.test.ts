import { describe, expect, it } from "vitest";
import {
  applicationIdForLease,
  collapseApplicationLeaseLinks,
  findMappingViolations,
  leaseIdForApplication,
  mappingRows,
  resolveLeaseForApplicationTemplate,
  setMappingTarget,
} from "@/lib/application-lease-mapping";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";
import {
  listLeaseTemplateGenerateChoices,
  resolvePropertyLeaseTemplateForApplication,
} from "@/lib/property-lease-template-sync";
import {
  createPropertyApplicationTemplate,
  type ApplicationTemplateQuestionConfig,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";

const lease = (label: string, kind: "long-term" | "short-term" | "custom" = "long-term", extra: Partial<PropertyLeaseTemplate> = {}) =>
  ({ ...createPropertyLeaseTemplate({ kind, label }), ...extra }) as PropertyLeaseTemplate;
const app = (label: string, extra: Partial<PropertyApplicationTemplate> = {}) =>
  ({ ...createPropertyApplicationTemplate({ kind: "long-term", label }), ...extra }) as PropertyApplicationTemplate;

const published = { version: 1, disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "standard" } as unknown as ApplicationTemplateQuestionConfig;

describe("application first: an application maps to exactly one lease", () => {
  const long = lease("Long-term lease");
  const short = lease("Short-term lease", "short-term");
  const standard = app("Standard application");
  const quick = app("Quick application");
  const catalog = { applications: [standard, quick], leases: [long, short] };

  it("maps each application to a single lease, and one lease may serve several applications", () => {
    const first = setMappingTarget("application_then_lease", catalog, standard.id, long.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = setMappingTarget("application_then_lease", { applications: first.applications, leases: first.leases }, quick.id, long.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const after = { applications: second.applications, leases: second.leases };
    expect(leaseIdForApplication(after, standard.id)).toBe(long.id);
    expect(leaseIdForApplication(after, quick.id)).toBe(long.id);
  });

  it("re-pointing an application replaces its lease; it never keeps two", () => {
    const first = setMappingTarget("application_then_lease", catalog, standard.id, long.id);
    if (!first.ok) throw new Error("expected ok");
    const moved = setMappingTarget("application_then_lease", { applications: first.applications, leases: first.leases }, standard.id, short.id);
    if (!moved.ok) throw new Error("expected ok");
    expect(leaseIdForApplication({ applications: moved.applications, leases: moved.leases }, standard.id)).toBe(short.id);
    const stored = moved.applications.find((a) => a.id === standard.id)!;
    expect(stored.linkedLeaseTemplateId).toBe(short.id);
    expect(stored.usedForLeaseTemplateIds).toEqual([short.id]);
  });

  it("refuses a second lease for an application instead of truncating it", () => {
    const refused = setMappingTarget("application_then_lease", catalog, standard.id, [long.id, short.id]);
    expect(refused).toEqual({ ok: false, error: "An application can only use one lease." });
  });

  it("refuses an unknown lease, a co-signer form as the dependent, and a co-signer addendum as the target", () => {
    const cosigner = app("Co-signer", { formVariant: "cosigner" });
    const addendum = lease("Addendum", "long-term", { listingSeedKey: "cosigner" });
    expect(setMappingTarget("application_then_lease", catalog, standard.id, "nope").ok).toBe(false);
    expect(setMappingTarget("application_then_lease", { applications: [cosigner], leases: [long] }, cosigner.id, long.id).ok).toBe(false);
    expect(setMappingTarget("application_then_lease", { applications: [standard], leases: [addendum] }, standard.id, addendum.id).ok).toBe(false);
  });

  it("clearing sticks: an explicit unmapped beats a lease that still names the application", () => {
    const named = lease("Names it", "long-term", { linkedApplicationTemplateId: standard.id });
    const cleared = setMappingTarget("application_then_lease", { applications: [standard], leases: [named] }, standard.id, null);
    if (!cleared.ok) throw new Error("expected ok");
    expect(leaseIdForApplication({ applications: cleared.applications, leases: cleared.leases }, standard.id)).toBeNull();
  });

  it("draws one row per application, each with a single Lease choice", () => {
    const rows = mappingRows("application_then_lease", catalog);
    expect(rows.map((r) => r.dependentLabel)).toEqual(["Standard application", "Quick application"]);
    expect(rows[0]!.targetOptions.map((o) => o.label)).toEqual(["Long-term lease", "Short-term lease"]);
  });
});

describe("lease first is gone: a lease maps to no application", () => {
  const standard = app("Standard application");
  const long = lease("Long-term lease", "long-term", { linkedApplicationTemplateId: standard.id });
  const catalog = { applications: [standard], leases: [long] };

  it("a lease never answers with an application, whatever it stored", () => {
    expect(applicationIdForLease(catalog, long.id)).toBeNull();
  });

  it("the lease -> application order maps application -> lease like every other order", () => {
    const next = setMappingTarget("lease_then_application", catalog, standard.id, long.id);
    if (!next.ok) throw new Error("expected ok");
    expect(leaseIdForApplication({ applications: next.applications, leases: next.leases }, standard.id)).toBe(long.id);
    expect(mappingRows("lease_then_application", catalog).map((r) => r.dependentLabel)).toEqual(["Standard application"]);
  });

  it("a mapping edit never writes a lease's application link", () => {
    const next = setMappingTarget("application_then_lease", catalog, standard.id, long.id);
    if (!next.ok) throw new Error("expected ok");
    expect(next.leases[0]!.linkedApplicationTemplateId).toBe(standard.id);
  });
});

describe("saving never keeps two links", () => {
  it("collapses legacy multi-lease applications to one, deterministically", () => {
    const l1 = lease("One");
    const l2 = lease("Two");
    const l3 = lease("Three");
    // Own link first, then the first lease naming it, then the first legacy id.
    const ownLink = app("Own", { linkedLeaseTemplateId: l2.id, usedForLeaseTemplateIds: [l1.id, l2.id, l3.id] });
    const named = app("Named", { usedForLeaseTemplateIds: [l3.id] });
    const legacy = app("Legacy", { usedForLeaseTemplateIds: [l3.id, l1.id] });
    const leases = [l1, l2, { ...l3, linkedApplicationTemplateId: named.id }];
    const result = collapseApplicationLeaseLinks([ownLink, named, legacy], leases);
    expect(result.changed).toBe(true);
    const byId = Object.fromEntries(result.applications.map((a) => [a.id, a]));
    expect(byId[ownLink.id]!.linkedLeaseTemplateId).toBe(l2.id);
    expect(byId[ownLink.id]!.usedForLeaseTemplateIds).toEqual([l2.id]);
    expect(byId[named.id]!.linkedLeaseTemplateId).toBe(l3.id);
    expect(byId[legacy.id]!.linkedLeaseTemplateId).toBe(l3.id);
    expect(byId[legacy.id]!.usedForLeaseTemplateIds).toEqual([l3.id]);
    expect(findMappingViolations("application_then_lease", { applications: result.applications, leases: result.leases }).every((v) => v.targetIds.length <= 1 || v.dependentId === named.id)).toBe(true);
  });

  it("releases links to deleted templates and leaves clean data untouched (same references)", () => {
    const keep = lease("Keep");
    const gone = app("Gone", { linkedLeaseTemplateId: "deleted-lease" });
    const orphan = lease("Orphan", "long-term", { linkedApplicationTemplateId: "deleted-app" });
    const result = collapseApplicationLeaseLinks([gone], [keep, orphan]);
    expect(result.applications[0]!.linkedLeaseTemplateId).toBeNull();
    // A stored lease -> application link is inert (lease first is gone): left alone, never read.
    expect(result.leases.find((l) => l.id === orphan.id)!.linkedApplicationTemplateId).toBe("deleted-app");
    const clean = { applications: [app("A", { linkedLeaseTemplateId: keep.id, usedForLeaseTemplateIds: [keep.id] })], leases: [keep] };
    const again = collapseApplicationLeaseLinks(clean.applications, clean.leases);
    expect(again.changed).toBe(false);
    expect(again.applications).toBe(clean.applications);
  });

  it("every normalise of a listing (the save path) enforces it", () => {
    const l1 = lease("One");
    const l2 = lease("Two");
    const multi = app("Multi", { usedForLeaseTemplateIds: [l1.id, l2.id] });
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      propertyLeaseTemplates: [l1, l2],
      propertyApplicationTemplates: [multi],
    });
    const saved = sub.propertyApplicationTemplates![0]!;
    expect(saved.linkedLeaseTemplateId).toBe(l1.id);
    expect(saved.usedForLeaseTemplateIds).toEqual([l1.id]);
  });
});

describe("the resident path", () => {
  it("an applicant always gets the lease their application maps to, whatever their term or stay kind says", () => {
    const primary = lease("Long-term lease", "long-term", { listingSeedKey: "primary" });
    const shortLease = lease("Short-term lease", "short-term", { listingSeedKey: "short-term" });
    const special = lease("Special lease", "custom");
    const mapped = app("Mapped application", { linkedLeaseTemplateId: special.id });
    const sub = { ...createDefaultListingSubmission(), propertyLeaseTemplates: [primary, shortLease, special], propertyApplicationTemplates: [mapped] };
    for (const application of [
      { leaseTerm: "12-Month", applicationTemplateId: mapped.id },
      { rentalType: "short_term" as const, applicationTemplateId: mapped.id },
    ]) {
      expect(resolvePropertyLeaseTemplateForApplication(sub, application)?.id).toBe(special.id);
    }
    expect(listLeaseTemplateGenerateChoices(sub, { leaseTerm: "12-Month", applicationTemplateId: mapped.id })[0]!.id).toBe(special.id);
  });

  it("an unmapped application falls back to the stay-kind default lease: short for short stays, else the long-term lease", () => {
    const primary = lease("Long-term lease", "long-term", { listingSeedKey: "primary" });
    const shortLease = lease("Short-term lease", "short-term", { listingSeedKey: "short-term" });
    const loose = app("Loose application");
    const sub = { ...createDefaultListingSubmission(), propertyLeaseTemplates: [shortLease, primary], propertyApplicationTemplates: [loose] };
    expect(resolvePropertyLeaseTemplateForApplication(sub, { leaseTerm: "12-Month", applicationTemplateId: loose.id })?.id).toBe(primary.id);
    expect(resolvePropertyLeaseTemplateForApplication(sub, { rentalType: "short_term", applicationTemplateId: loose.id })?.id).toBe(shortLease.id);
    expect(resolvePropertyLeaseTemplateForApplication(sub, { leaseTerm: "12-Month" })?.id).toBe(primary.id);
  });

  it("the property default lease is the explicit fallback when the caller knows it", () => {
    const a = lease("A");
    const b = lease("B");
    const loose = app("Loose");
    const catalog = { applications: [loose], leases: [a, b] };
    expect(resolveLeaseForApplicationTemplate(catalog, loose.id, b.id)?.id).toBe(b.id);
    expect(resolveLeaseForApplicationTemplate(catalog, loose.id)).toBeNull();
    expect(resolveLeaseForApplicationTemplate(catalog, loose.id, "missing")).toBeNull();
  });

  it("the applicant is served the mapped form even when its variant differs from the stay's", () => {
    const shortForm = app("Short stay form", { formVariant: "short_term", kind: "short-term", publishedQuestionConfig: published });
    const standard = app("Standard application", { publishedQuestionConfig: published });
    const sub = { ...createDefaultListingSubmission(), propertyApplicationTemplates: [standard, shortForm] };
    expect(applicationConfigForApplicant(sub, "standard", shortForm.id).templateId).toBe(shortForm.id);
    // A co-signer form is never served as a standard form.
    const cosigner = app("Co-signer", { formVariant: "cosigner", publishedQuestionConfig: published });
    const withCosigner = { ...sub, propertyApplicationTemplates: [standard, cosigner] };
    expect(applicationConfigForApplicant(withCosigner, "standard", cosigner.id).templateId).toBeUndefined();
  });
});
