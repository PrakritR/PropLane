import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import {
  leaseIdForApplication,
  mappableApplicationTemplates,
  setMappingTarget,
  type MappingCatalog,
  type MappingSigningOrder,
} from "@/lib/application-lease-mapping";
import {
  publishedQuestionConfigVersionForTemplate,
  readPropertyApplicationTemplates,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { normalizeApplicationLeaseTerm } from "@/lib/resident-manual-lease-terms";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
  sortLeaseTermsCanonical,
} from "@/lib/rental-application/lease-terms";

const MONTH_TO_MONTH_LEASE_TERM = "Month-to-Month";
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
  // Custom dates and month-to-month are options ON a long-term lease, never a lease kind of their own.
  return "long-term";
}

/** The two options a long-term lease can add: "Allow custom dates" and "Allow month-to-month". */
export type LeaseOptionKey = "custom" | "monthToMonth";

export const LEASE_OPTION_TERM: Record<LeaseOptionKey, string> = {
  custom: CUSTOM_LEASE_TERM,
  monthToMonth: MONTH_TO_MONTH_LEASE_TERM,
};

/** Only a long-term lease carries the two options; Short term / Airbnb leases hide them. */
export function leaseTermsAllowOptions(terms: readonly string[]): boolean {
  return !terms.includes(SHORT_TERM_LEASE_TERM) && !terms.includes(AIRBNB_LEASE_TERM);
}

/** The checkbox state of a lease, read from the stored `applicationLeaseTerms`. */
export function leaseOptionFlags(terms: readonly string[]): Record<LeaseOptionKey, boolean> {
  return {
    custom: terms.includes(CUSTOM_LEASE_TERM),
    monthToMonth: terms.includes(MONTH_TO_MONTH_LEASE_TERM),
  };
}

/**
 * Turn one option on or off for one lease. The stored term is the same `applicationLeaseTerms`
 * entry the old Used-for card edited ("Custom", "Month-to-Month"), so stored data keeps its meaning
 * and a term still routes to exactly one lease. A lease whose only term was an option keeps
 * "Long-term" as its base, unless another lease already owns it.
 */
export function setLeaseOptionOnTemplates(
  templates: readonly PropertyLeaseTemplate[],
  leaseId: string,
  option: LeaseOptionKey,
  on: boolean,
): PropertyLeaseTemplate[] {
  const term = LEASE_OPTION_TERM[option];
  const moved = assignStayTermToLeaseTemplate(templates, term, on ? leaseId : null);
  const mine = moved.find((row) => row.id === leaseId);
  if (!mine) return moved;
  const terms = mine.applicationLeaseTerms ?? [];
  const hasBase = terms.some(
    (t) => t !== CUSTOM_LEASE_TERM && t !== MONTH_TO_MONTH_LEASE_TERM && t !== SHORT_TERM_LEASE_TERM && t !== AIRBNB_LEASE_TERM,
  );
  const baseOwnedElsewhere = moved.some(
    (row) => row.id !== leaseId && (row.applicationLeaseTerms ?? []).includes(LONG_TERM_LEASE_TERM),
  );
  if (hasBase || baseOwnedElsewhere || !leaseTermsAllowOptions(terms)) return moved;
  return moved.map((row) =>
    row.id === leaseId ? { ...row, applicationLeaseTerms: [LONG_TERM_LEASE_TERM, ...terms] } : row,
  );
}

/**
 * The listing's allowed terms after a lease's options changed: a term some lease still holds is
 * allowed, a touched term no lease holds any more is dropped. This is what the applicant's
 * "Which lease are you applying for?" and the pricing popup read, so Custom / Month-to-Month
 * keep being offered exactly while a lease allows them.
 */
export function allowedTermsAfterLeaseOptions(
  currentAllowed: readonly string[],
  templates: readonly PropertyLeaseTemplate[],
  touched: readonly LeaseOptionKey[],
): string[] {
  const held = (term: string) => templates.some((row) => (row.applicationLeaseTerms ?? []).includes(term));
  const next = new Set(currentAllowed);
  for (const option of touched) {
    const term = LEASE_OPTION_TERM[option];
    if (held(term)) next.add(term);
    else next.delete(term);
  }
  if (touched.some((o) => next.has(LEASE_OPTION_TERM[o])) && !next.has(LONG_TERM_LEASE_TERM)) {
    next.add(LONG_TERM_LEASE_TERM);
  }
  return sortLeaseTermsCanonical([...next]);
}

/**
 * The ONE derivation of "what type of lease is this": group the stay types it is
 * mapped to (the same `applicationLeaseTerms` the Used-for card edits) into
 * Long-term / Short term / Airbnb. Long-term, Month-to-Month, Custom and the
 * fixed lengths are all long-term leases; the Used-for card carries the finer
 * per-stay-type detail. Both the lease list row and the Edit lease popup read
 * this, so the two can never disagree. `fallback` covers a lease with no
 * mapping yet (its seed / kind label).
 */
export function stayTypeLabelForLeaseKindDisplay(
  terms: readonly string[],
  offered: readonly string[],
  fallback?: string | null,
): string {
  const active = offered.filter((term) => terms.includes(term));
  if (active.length === 0) return fallback?.trim() || "Not assigned";
  const groups: string[] = [];
  const push = (label: string) => {
    if (!groups.includes(label)) groups.push(label);
  };
  if (active.some((term) => term !== SHORT_TERM_LEASE_TERM && term !== AIRBNB_LEASE_TERM)) push("Long-term");
  if (active.includes(SHORT_TERM_LEASE_TERM)) push("Short term");
  if (active.includes(AIRBNB_LEASE_TERM)) push("Airbnb");
  return groups.join(", ");
}

export function applicationIdForStayTerm(
  catalog: MappingCatalog,
  _order: MappingSigningOrder,
  leases: readonly PropertyLeaseTemplate[],
  term: string,
): string | null {
  const leaseId = leaseTemplateIdForStayTerm(leases, term);
  if (!leaseId) return null;
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

/**
 * "Which lease are you applying for?" drives the application form. The lease type the applicant
 * picked routes to ONE lease (`applicationLeaseTerms`), and the application form mapped to that
 * lease (`linkedLeaseTemplateId`) is the form they fill in. Returns that form's pin (id + current
 * published version), or null when no published form is mapped to the lease for this type - the
 * caller then keeps the stay kind's default form.
 */
export function applicationPinForStayTerm(
  sub: Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates" | "propertyLeaseTemplates">,
  term: string,
): { templateId: string; templateVersion: number } | null {
  const cleanTerm = normalizeApplicationLeaseTerm(term.trim());
  if (!cleanTerm) return null;
  const leases = readPropertyLeaseTemplates(sub);
  const applications = readPropertyApplicationTemplates(sub);
  const leaseId = leaseTemplateIdForStayTerm(leases, cleanTerm);
  if (!leaseId) return null;
  const catalog: MappingCatalog = { applications, leases };
  const mapped = mappableApplicationTemplates(applications)
    .filter((app) => leaseIdForApplication(catalog, app.id) === leaseId)
    .filter((app) => Boolean(app.publishedQuestionConfig))
    .sort((a, b) => a.label.localeCompare(b.label))[0];
  if (!mapped) return null;
  const published = publishedQuestionConfigVersionForTemplate(mapped);
  if (!published) return null;
  return { templateId: mapped.id, templateVersion: published.version };
}
