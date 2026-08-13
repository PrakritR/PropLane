import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { ApplicationFormVariant } from "@/lib/rental-application/application-field-catalog";
import {
  createPropertyApplicationTemplate,
  readPropertyApplicationTemplates,
  syncLegacyApplicationFieldsFromTemplates,
  withPropertyApplicationTemplatesExplicit,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import type { PropertyLeaseListingSeedKey, PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";
import { buildLeaseTemplateSeeds } from "@/lib/property-lease-template-sync";

const COSIGNER_LONG_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "cosigner";
const COSIGNER_SHORT_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "cosigner-short-term";

export type ApplicationTemplateSeed = {
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

/**
 * PropLane default applications this property does NOT currently carry.
 *
 * Auto-seeding stops for good once a manager deletes an application
 * (`propertyApplicationTemplatesExplicit`), which is what makes Delete stick —
 * the same opt-in rule the lease twin got. Without a way to add a default back,
 * that decision is one-way: a manager who removes the PropLane application can
 * never recover it. This is the list the Application tab offers, exactly as
 * `availableLeaseTemplateSeeds` does for leases.
 */
export function availableApplicationTemplateSeeds(
  sub: ManagerListingSubmissionV1,
): ApplicationTemplateSeed[] {
  const present = new Set(
    readPropertyApplicationTemplates(sub)
      .map((t) => t.listingSeedKey)
      .filter(Boolean),
  );
  return buildApplicationTemplateSeeds(sub).filter((seed) => !present.has(seed.seedKey));
}

/** Add one PropLane default application. Returns the updated submission. */
export function addApplicationTemplateFromSeed(
  sub: ManagerListingSubmissionV1,
  seedKey: PropertyLeaseListingSeedKey,
): ManagerListingSubmissionV1 {
  const seed = buildApplicationTemplateSeeds(sub).find((s) => s.seedKey === seedKey);
  if (!seed) return sub;
  const existing = readPropertyApplicationTemplates(sub);
  // Two rows carrying one seed key would give the applicant-form router two
  // equally valid matches for the same lease term.
  if (existing.some((t) => t.listingSeedKey === seedKey)) return sub;
  const created = createPropertyApplicationTemplate({
    kind: seed.kind,
    label: defaultLabelForSeed(seed),
    listingSeedKey: seed.seedKey,
    applicationLeaseTerms: seed.applicationLeaseTerms,
    formVariant: seed.formVariant,
  });
  // Stay EXPLICIT. Adding one default by hand is curation, not a request to
  // resume auto-seeding — dropping the flag here would silently restore every
  // other default the manager had deleted.
  return withPropertyApplicationTemplatesExplicit(sub, [...existing, created]);
}

/**
 * A seeded row carries no manager-authored content of its own — the question
 * sets live per form variant on the submission — so a renamed label is the only
 * thing a manager can lose when its seed key leaves the catalog.
 */
function applicationTemplateHasManagerEdits(template: PropertyApplicationTemplate): boolean {
  const label = normalizePropertyApplicationTemplateLabel(template.label);
  if (!label || !template.listingSeedKey) return false;
  return (
    label !==
    defaultLabelForSeed({
      seedKey: template.listingSeedKey,
      kind: template.kind,
      label,
      formVariant: template.formVariant,
      applicationLeaseTerms: template.applicationLeaseTerms ?? [],
    })
  );
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
  const consumedIds = new Set<string>();
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
      consumedIds.add(prev.id);
      const defaultLabel = defaultLabelForSeed(seed);
      const trimmedPrevLabel = prev.label.trim();
      const normalizedForDefaultCheck = normalizePropertyApplicationTemplateLabel(trimmedPrevLabel);
      const label =
        normalizedForDefaultCheck && normalizedForDefaultCheck !== defaultLabel
          ? trimmedPrevLabel
          : defaultLabel;
      nextSeeded.push({
        ...prev,
        kind: seed.kind,
        formVariant: seed.formVariant,
        listingSeedKey: seed.seedKey,
        applicationLeaseTerms: seed.applicationLeaseTerms,
        label,
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

  const manual = existing.filter((t) => !t.listingSeedKey && !consumedIds.has(t.id));
  // Same rule as the lease twin (`syncPropertyLeaseTemplatesFromListing`): a seed
  // key the catalog no longer offers — the retired bundle formats, a legacy
  // per-term key — must not take a row the manager renamed with it. Untouched
  // defaults carry nothing and are left behind.
  const preservedSeeded = existing.filter(
    (t) =>
      Boolean(t.listingSeedKey) &&
      !consumedIds.has(t.id) &&
      applicationTemplateHasManagerEdits(t),
  );
  const merged = [...nextSeeded, ...manual, ...preservedSeeded];
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
