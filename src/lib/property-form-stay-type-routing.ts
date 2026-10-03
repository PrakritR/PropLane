import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import {
  applicationIdForLease,
  leaseIdForApplication,
  setMappingTarget,
  type MappingCatalog,
  type MappingSigningOrder,
} from "@/lib/application-lease-mapping";
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import type { PropertyLeaseTemplate, PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";

/** Stay / lease types the listing actually offers (workspace + property terms). */
export function offeredStayTypeTerms(sub: ManagerListingSubmissionV1): string[] {
  return resolveAllowedLeaseTerms(sub);
}

export function leaseTemplateIdForStayTerm(
  templates: readonly PropertyLeaseTemplate[],
  term: string,
): string | null {
  const matches = templates.filter((row) => (row.applicationLeaseTerms ?? []).includes(term));
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => a.label.localeCompare(b.label))[0]!.id;
}

/** Move one applicant stay choice onto exactly one lease template. */
export function assignStayTermToLeaseTemplate(
  templates: readonly PropertyLeaseTemplate[],
  term: string,
  targetLeaseId: string | null,
): PropertyLeaseTemplate[] {
  return templates.map((row) => {
    const terms = [...(row.applicationLeaseTerms ?? [])];
    const had = terms.includes(term);
    if (targetLeaseId && row.id === targetLeaseId) {
      if (!had) terms.push(term);
      return { ...row, applicationLeaseTerms: terms.length ? terms : undefined };
    }
    if (had) {
      const next = terms.filter((value) => value !== term);
      return { ...row, applicationLeaseTerms: next.length ? next : undefined };
    }
    return row;
  });
}

/** Keep stored `kind` aligned with which stay types route here. */
export function deriveLeaseKindFromStayTerms(terms: readonly string[]): PropertyLeaseTemplateKind {
  if (terms.includes(SHORT_TERM_LEASE_TERM) || terms.includes(AIRBNB_LEASE_TERM)) return "short-term";
  if (terms.includes(CUSTOM_LEASE_TERM)) return "custom";
  return "long-term";
}

export function stayTypeLabelForLeaseKindDisplay(
  terms: readonly string[],
  offered: readonly string[],
): string {
  const active = offered.filter((term) => terms.includes(term));
  if (active.length === 0) return "Not assigned";
  return active.join(", ");
}

export function applicationIdForStayTerm(
  catalog: MappingCatalog,
  order: MappingSigningOrder,
  leases: readonly PropertyLeaseTemplate[],
  term: string,
): string | null {
  const leaseId = leaseTemplateIdForStayTerm(leases, term);
  if (!leaseId) return null;
  if (order === "lease_then_application") {
    return applicationIdForLease(catalog, leaseId);
  }
  const apps = catalog.applications.filter(
    (app) => leaseIdForApplication(catalog, app.id) === leaseId,
  );
  if (apps.length === 1) return apps[0]!.id;
  return apps.sort((a, b) => a.label.localeCompare(b.label))[0]?.id ?? null;
}

export function applyApplicationLinkForStayTerm(
  order: MappingSigningOrder,
  catalog: MappingCatalog,
  leases: readonly PropertyLeaseTemplate[],
  term: string,
  applicationId: string | null,
): { applications: PropertyApplicationTemplate[]; leases: PropertyLeaseTemplate[] } | { error: string } {
  const leaseId = leaseTemplateIdForStayTerm(leases, term);
  if (!leaseId) return { error: "Pick a lease for this stay type first." };
  if (order === "lease_then_application") {
    const result = setMappingTarget(order, catalog, leaseId, applicationId);
    if (!result.ok) return { error: result.error };
    return { applications: result.applications, leases: result.leases };
  }
  if (!applicationId) {
    const linked = catalog.applications.find((app) => leaseIdForApplication(catalog, app.id) === leaseId);
    if (!linked) return { applications: [...catalog.applications], leases: [...leases] };
    const result = setMappingTarget(order, catalog, linked.id, null);
    if (!result.ok) return { error: result.error };
    return { applications: result.applications, leases: result.leases };
  }
  const result = setMappingTarget(order, catalog, applicationId, leaseId);
  if (!result.ok) return { error: result.error };
  return { applications: result.applications, leases: result.leases };
}
