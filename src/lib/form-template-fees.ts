/**
 * The fee a FORM carries: the application's Application fee and the lease's Lease fee
 * (captain, Oct 3 2026: "the application fee is set on the application, lease fees are set on the
 * lease, per lease type").
 *
 * This file only PICKS the template and turns its stored cents into the money string the one fee
 * resolver (`listing-placement-standard-fees.ts`) chains on. It never decides a charge:
 *
 *   room override -> THIS template fee -> listing-level / account / legacy fallbacks
 *
 * Storage (no migration, nothing destructive):
 *  - Application: `PropertyApplicationTemplate.feeCentsOverride` (cents; absent/null = no template fee,
 *    `0` is a real "free"). It already existed and already ranked below a room's fee at checkout.
 *  - Lease: `PropertyLeaseTemplate.leaseFeeCents`, the same shape.
 *
 * Which template applies to a placement: the applicant's own application template when the caller knows
 * it (the application row / the checkout selector); otherwise the form routed to the placement's lease
 * type. A lease follows its application's mapping first (an application maps to exactly ONE lease),
 * then the lease routed to the lease type.
 *
 * Pure. Runtime imports are limited to the template readers so the resolver can import this file.
 */
import { applicationFeeLeaseTypeKey } from "@/lib/listing-application-fee";
import { leaseIdForApplication, mappableApplicationTemplates } from "@/lib/application-lease-mapping";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  applicationFormVariantForTemplate,
  isApplicationTemplateOffered,
  readPropertyApplicationTemplates,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { AIRBNB_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

export type TemplateFeeKind = "applicationFee" | "leaseFee";

/** What picks the template. `leaseTerm` is the placement's stored term; `isStay` marks a short / Airbnb stay. */
export type FormTemplateSelector = {
  leaseTerm?: string | null;
  isStay: boolean;
  /** The application the applicant filled in (a selector into the stored templates, never an amount). */
  applicationTemplateId?: string | null;
  /** A lease chosen outright (the lease form being edited). */
  leaseTemplateId?: string | null;
};

type TemplateSource = Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates" | "propertyLeaseTemplates"> &
  Partial<
    Pick<ManagerListingSubmissionV1, "leaseConfigMode" | "leaseCustomKind" | "customLeaseTerms" | "leaseTemplateDocUrl" | "leaseTemplateDocName">
  >;

function stayKey(leaseTerm: string | null | undefined, isStay: boolean): "stay" | "airbnb" | "long" {
  const term = String(leaseTerm ?? "").trim();
  if (term === AIRBNB_LEASE_TERM) return "airbnb";
  if (isStay || term === SHORT_TERM_LEASE_TERM) return "stay";
  return "long";
}

/** The lease routed to a placement's lease type: exact routed term, else the seeded / kind default. */
function leaseForTerm(
  leases: readonly PropertyLeaseTemplate[],
  leaseTerm: string | null | undefined,
  isStay: boolean,
): PropertyLeaseTemplate | null {
  const offered = leases.filter((lease) => lease.offered !== false && lease.listingSeedKey !== "cosigner" && lease.listingSeedKey !== "cosigner-short-term");
  const term = String(leaseTerm ?? "").trim();
  const routed = term
    ? offered.filter((lease) => (lease.applicationLeaseTerms ?? []).includes(term) || (lease.applicationLeaseTerms ?? []).includes(applicationFeeLeaseTypeKey(term)))
    : [];
  const sorted = (rows: PropertyLeaseTemplate[]) => [...rows].sort((a, b) => a.label.localeCompare(b.label))[0] ?? null;
  if (routed.length > 0) return sorted(routed);
  const kind = stayKey(leaseTerm, isStay);
  if (kind === "airbnb") {
    return offered.find((lease) => lease.listingSeedKey === "airbnb") ?? null;
  }
  if (kind === "stay") {
    return (
      offered.find((lease) => lease.listingSeedKey === "short-term") ??
      sorted(offered.filter((lease) => lease.kind === "short-term" && lease.listingSeedKey !== "airbnb"))
    );
  }
  return offered.find((lease) => lease.listingSeedKey === "primary") ?? sorted(offered.filter((lease) => lease.kind === "long-term"));
}

export function applicationTemplateForPlacement(
  sub: TemplateSource | null | undefined,
  selector: FormTemplateSelector,
): PropertyApplicationTemplate | null {
  if (!sub) return null;
  const applications = readPropertyApplicationTemplates(sub);
  if (applications.length === 0) return null;
  const id = selector.applicationTemplateId?.trim();
  if (id) {
    const picked = applications.find((template) => template.id === id);
    if (picked) return picked;
  }
  const mappable = mappableApplicationTemplates(applications).filter(isApplicationTemplateOffered);
  const leases = readPropertyLeaseTemplates(sub);
  const lease = leaseForTerm(leases, selector.leaseTerm, selector.isStay);
  if (lease) {
    const catalog = { applications, leases };
    const mapped = mappable
      .filter((application) => leaseIdForApplication(catalog, application.id) === lease.id)
      .sort((a, b) => a.label.localeCompare(b.label))[0];
    if (mapped) return mapped;
  }
  const variant = selector.isStay ? "short_term" : "standard";
  return (
    mappable
      .filter((application) => applicationFormVariantForTemplate(application) === variant)
      .sort((a, b) => a.label.localeCompare(b.label))[0] ?? null
  );
}

export function leaseTemplateForPlacement(
  sub: TemplateSource | null | undefined,
  selector: FormTemplateSelector,
): PropertyLeaseTemplate | null {
  if (!sub) return null;
  const leases = readPropertyLeaseTemplates(sub);
  if (leases.length === 0) return null;
  const leaseId = selector.leaseTemplateId?.trim();
  if (leaseId) {
    const picked = leases.find((lease) => lease.id === leaseId);
    if (picked) return picked;
  }
  const applicationId = selector.applicationTemplateId?.trim();
  if (applicationId) {
    const applications = readPropertyApplicationTemplates(sub);
    const mappedId = leaseIdForApplication({ applications, leases }, applicationId);
    const mapped = mappedId ? leases.find((lease) => lease.id === mappedId) : undefined;
    if (mapped) return mapped;
  }
  return leaseForTerm(leases, selector.leaseTerm, selector.isStay);
}

/** Cents -> the money string the resolver chains on ("50", "37.5"). */
export function centsToMoneyText(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

/** A stored template fee in cents, or null when the template sets none (absent, null or non-finite). */
export function templateFeeCents(template: { feeCentsOverride?: number | null; leaseFeeCents?: number | null } | null | undefined, kind: TemplateFeeKind): number | null {
  if (!template) return null;
  const raw = kind === "applicationFee" ? template.feeCentsOverride : template.leaseFeeCents;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
}

/**
 * The template's fee for one placement as a raw money string, or undefined when its template sets none.
 * A stored 0 is returned as "0" - the template says this form is free, which beats every fallback.
 */
export function templateFeeRaw(
  sub: TemplateSource | null | undefined,
  kind: TemplateFeeKind,
  selector: FormTemplateSelector,
): string | undefined {
  const template =
    kind === "applicationFee" ? applicationTemplateForPlacement(sub, selector) : leaseTemplateForPlacement(sub, selector);
  const cents = templateFeeCents(template, kind);
  return cents === null ? undefined : centsToMoneyText(cents);
}
