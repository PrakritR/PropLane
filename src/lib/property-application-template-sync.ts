import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { ApplicationFormVariant } from "@/lib/rental-application/application-field-catalog";
import {
  createPropertyApplicationTemplate,
  readPropertyApplicationTemplates,
  syncLegacyApplicationFieldsFromTemplates,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import type { PropertyLeaseListingSeedKey, PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";
import { buildLeaseTemplateSeeds } from "@/lib/property-lease-template-sync";

const COSIGNER_LONG_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "cosigner";
const COSIGNER_SHORT_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "cosigner-short-term";

type ApplicationTemplateSeed = {
  seedKey: PropertyLeaseListingSeedKey;
  kind: PropertyLeaseTemplateKind;
  label: string;
  formVariant: ApplicationFormVariant;
  applicationLeaseTerms: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Strip a legacy "(optional)" suffix from manager-facing application names. */
export function normalizePropertyApplicationTemplateLabel(label: string): string {
  return label.replace(/\s*\(optional\)\s*$/i, "").trim();
}

function defaultLabelForSeed(seed: ApplicationTemplateSeed): string {
  if (seed.seedKey === COSIGNER_LONG_TERM_SEED_KEY) return "Long-term co-signer application";
  if (seed.seedKey === COSIGNER_SHORT_TERM_SEED_KEY) return "Short-term co-signer application";
  if (seed.kind === "short-term") return "Short-term application";
  return "Long-term application";
}

function cosignerApplicationSeeds(
  leaseSeeds: ReturnType<typeof buildLeaseTemplateSeeds>,
): ApplicationTemplateSeed[] {
  const seen = new Set<PropertyLeaseTemplateKind>();
  const out: ApplicationTemplateSeed[] = [];
  for (const leaseSeed of leaseSeeds) {
    if (seen.has(leaseSeed.kind)) continue;
    seen.add(leaseSeed.kind);
    const seedKey =
      leaseSeed.kind === "short-term" ? COSIGNER_SHORT_TERM_SEED_KEY : COSIGNER_LONG_TERM_SEED_KEY;
    out.push({
      seedKey,
      kind: leaseSeed.kind,
      label: defaultLabelForSeed({
        seedKey,
        kind: leaseSeed.kind,
        label: leaseSeed.label,
        formVariant: "cosigner",
        applicationLeaseTerms:
          leaseSeed.kind === "short-term" ? leaseSeed.applicationLeaseTerms : [],
      }),
      formVariant: "cosigner" as ApplicationFormVariant,
      applicationLeaseTerms:
        leaseSeed.kind === "short-term" ? leaseSeed.applicationLeaseTerms : [],
    });
  }
  return out;
}

/** Every property keeps auto-seeded applications for each lease default plus long/short co-signer forms. */
export function buildApplicationTemplateSeeds(
  sub: Parameters<typeof buildLeaseTemplateSeeds>[0],
): ApplicationTemplateSeed[] {
  const leaseSeeds = buildLeaseTemplateSeeds(sub);
  return [
    ...leaseSeeds.map((seed) => ({
      seedKey: seed.seedKey,
      kind: seed.kind,
      label: defaultLabelForSeed({
        seedKey: seed.seedKey,
        kind: seed.kind,
        label: seed.label,
        formVariant: seed.kind === "short-term" ? "short_term" : "standard",
        applicationLeaseTerms: seed.applicationLeaseTerms,
      }),
      formVariant: (seed.kind === "short-term" ? "short_term" : "standard") as ApplicationFormVariant,
      applicationLeaseTerms: seed.applicationLeaseTerms,
    })),
    ...cosignerApplicationSeeds(leaseSeeds),
  ];
}

function adoptLegacyDefaultTemplate(
  existing: PropertyApplicationTemplate[],
  seed: ApplicationTemplateSeed,
): PropertyApplicationTemplate | null {
  if (existing.length !== 1) return null;
  const only = existing[0]!;
  if (only.listingSeedKey) return null;
  if (only.id !== "app-tpl-default" && existing.some((t) => t.listingSeedKey)) return null;
  return {
    ...only,
    listingSeedKey: seed.seedKey,
    kind: seed.kind,
    formVariant: seed.formVariant,
    applicationLeaseTerms: seed.applicationLeaseTerms,
    label: only.label.trim() === "Primary application" ? defaultLabelForSeed(seed) : only.label,
    updatedAt: nowIso(),
  };
}

/** Merge auto-seeded application templates from listing offered terms with manager-owned rows. */
export function syncPropertyApplicationTemplatesFromListing(
  sub: ManagerListingSubmissionV1,
): ManagerListingSubmissionV1 {
  const autoSeed = sub.propertyApplicationTemplatesExplicit !== true;
  const seeds = buildApplicationTemplateSeeds(sub);
  const existing = readPropertyApplicationTemplates(sub);
  if (!autoSeed && existing.length === 0) {
    return syncLegacyApplicationFieldsFromTemplates(sub, []);
  }
  const adoptedLegacyIds = new Set<string>();
  const seededExisting = existing.filter((t) => Boolean(t.listingSeedKey));

  const nextSeeded: PropertyApplicationTemplate[] = [];

  for (const seed of seeds) {
    const legacyAdopted =
      seededExisting.length === 0 && adoptedLegacyIds.size === 0
        ? adoptLegacyDefaultTemplate(existing, seed)
        : null;
    const prev = seededExisting.find((t) => t.listingSeedKey === seed.seedKey) ?? legacyAdopted;

    if (prev) {
      if (legacyAdopted) adoptedLegacyIds.add(legacyAdopted.id);
      const defaultLabel = defaultLabelForSeed(seed);
      const normalizedPrevLabel = normalizePropertyApplicationTemplateLabel(prev.label);
      nextSeeded.push({
        ...prev,
        kind: seed.kind,
        formVariant: seed.formVariant,
        listingSeedKey: seed.seedKey,
        applicationLeaseTerms: seed.applicationLeaseTerms,
        label:
          normalizedPrevLabel && normalizedPrevLabel !== defaultLabel ? normalizedPrevLabel : defaultLabel,
        updatedAt: nowIso(),
      });
    } else if (autoSeed) {
      const created = createPropertyApplicationTemplate({
        kind: seed.kind,
        label: defaultLabelForSeed(seed),
        listingSeedKey: seed.seedKey,
        applicationLeaseTerms: seed.applicationLeaseTerms,
        formVariant: seed.formVariant,
      });
      nextSeeded.push(created);
    }
  }

  const manual = existing.filter((t) => !t.listingSeedKey && !adoptedLegacyIds.has(t.id));
  const merged = [...nextSeeded, ...manual];
  const hasShortTerm = merged.some((t) => t.formVariant === "short_term");
  return syncLegacyApplicationFieldsFromTemplates(
    {
      ...sub,
      shortTermRentalsAllowed: hasShortTerm || Boolean(sub.shortTermRentalsAllowed),
    },
    merged,
  );
}

export function submissionAfterRemovingApplicationTemplate(
  sub: ManagerListingSubmissionV1,
  templates: PropertyApplicationTemplate[],
): ManagerListingSubmissionV1 {
  const hasShortTerm = templates.some((t) => t.formVariant === "short_term");
  let next = syncLegacyApplicationFieldsFromTemplates(
    { ...sub, propertyApplicationTemplatesExplicit: true },
    templates,
  );
  if (!hasShortTerm && next.shortTermRentalsAllowed) {
    const allowed = (next.allowedLeaseTerms ?? []).filter((t) => t !== SHORT_TERM_LEASE_TERM);
    next = {
      ...next,
      shortTermRentalsAllowed: false,
      allowedLeaseTerms: allowed,
    };
  }
  return next;
}

/** Prospect-facing read: honors a manager-cleared list; otherwise auto-seeds defaults. */
export function readPropertyApplicationTemplatesForProspect(
  sub: ManagerListingSubmissionV1,
): PropertyApplicationTemplate[] {
  if (sub.propertyApplicationTemplatesExplicit === true) {
    return readPropertyApplicationTemplates(sub);
  }
  return readPropertyApplicationTemplates(syncPropertyApplicationTemplatesFromListing(sub));
}

export function propertyAcceptingOnlineApplications(
  sub: ManagerListingSubmissionV1 | undefined,
): boolean {
  if (!sub || sub.v !== 1) return true;
  return readPropertyApplicationTemplatesForProspect(sub).length > 0;
}
