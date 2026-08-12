import {
  resolveAllowedLeaseTerms,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { normalizeApplicationLeaseTerm } from "@/lib/resident-manual-lease-terms";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import {
  createPropertyLeaseTemplate,
  readPropertyLeaseTemplates,
  syncLegacyLeaseFieldsFromTemplates,
  type PropertyLeaseListingSeedKey,
  type PropertyLeaseTemplate,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";

type LeaseTemplateSeed = {
  seedKey: PropertyLeaseListingSeedKey;
  kind: PropertyLeaseTemplateKind;
  label: string;
  applicationLeaseTerms: string[];
};

const LONG_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "primary";
const SHORT_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "short-term";
export const BUNDLE_LONG_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "bundle-primary";
export const BUNDLE_SHORT_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "bundle-short-term";

export type LeaseTemplateScenarioId =
  | "individual-long"
  | "individual-short"
  | "bundle-long"
  | "bundle-short"
  | "custom";

export function leaseTemplateScenarioLabel(id: LeaseTemplateScenarioId): string {
  switch (id) {
    case "individual-long":
      return "Individual room · Long-term";
    case "individual-short":
      return "Individual · Short-term";
    case "bundle-long":
      return "Lease bundle · Long-term";
    case "bundle-short":
      return "Lease bundle · Short-term";
    case "custom":
      return "Custom lease builder";
    default:
      return "Lease";
  }
}

/** Legacy per-term seed keys collapsed into the single long-term default. */
const LEGACY_LONG_TERM_SEED_KEYS: PropertyLeaseListingSeedKey[] = [
  "fixed-term",
  "fixed-3-month",
  "fixed-9-month",
  "fixed-12-month",
  "month-to-month",
  "custom-term",
];

function nowIso(): string {
  return new Date().toISOString();
}

function longTermApplicationLeaseTerms(
  sub: Pick<ManagerListingSubmissionV1, "allowedLeaseTerms" | "leaseTermsBody" | "shortTermRentalsAllowed">,
): string[] {
  const allowed = resolveAllowedLeaseTerms(sub).filter((t) => t !== SHORT_TERM_LEASE_TERM);
  return allowed.length > 0 ? allowed : ["12-Month"];
}

/**
 * The default lease formats a property can hold: long-term and short-term.
 * Nothing creates these on a manager's behalf — a property starts with none and
 * gains one only through `addLeaseTemplateFromSeed`.
 */
export function buildLeaseTemplateSeeds(
  sub: Pick<
    ManagerListingSubmissionV1,
    | "allowedLeaseTerms"
    | "leaseTermsBody"
    | "shortTermRentalsAllowed"
    | "rooms"
    | "entireHomeMonthlyRent"
    | "listingPlaceCategoryId"
  >,
): LeaseTemplateSeed[] {
  const longTerms = longTermApplicationLeaseTerms(sub);
  return [
    {
      seedKey: LONG_TERM_SEED_KEY,
      kind: "long-term",
      label: "Long-term lease",
      applicationLeaseTerms: longTerms,
    },
    {
      seedKey: SHORT_TERM_SEED_KEY,
      kind: "short-term",
      label: "Short-term lease",
      applicationLeaseTerms: [SHORT_TERM_LEASE_TERM],
    },
  ];
}

function defaultLabelForLeaseTemplate(template: PropertyLeaseTemplate): string {
  if (template.listingSeedKey === BUNDLE_LONG_TERM_SEED_KEY) return "Lease bundle · Long-term";
  if (template.listingSeedKey === BUNDLE_SHORT_TERM_SEED_KEY) return "Lease bundle · Short-term";
  if (template.listingSeedKey === SHORT_TERM_SEED_KEY || template.kind === "short-term") {
    return "Short-term lease";
  }
  return "Long-term lease";
}

function templateHasManagerEdits(template: PropertyLeaseTemplate): boolean {
  const label = template.label.trim();
  if (label && label !== defaultLabelForLeaseTemplate(template)) return true;
  return (
    template.leaseConfigMode === "custom" ||
    Boolean(template.customLeaseTerms?.trim()) ||
    Boolean(template.leaseTemplateHtmlOverride?.trim()) ||
    Boolean(template.leaseTemplateDocUrl?.trim())
  );
}

/** When collapsing legacy per-term seeds, keep the richest long-term row. */
function adoptPreviousLongTermTemplate(existing: PropertyLeaseTemplate[]): PropertyLeaseTemplate | null {
  const individualLongKeys = new Set<PropertyLeaseListingSeedKey>([
    LONG_TERM_SEED_KEY,
    ...LEGACY_LONG_TERM_SEED_KEYS,
  ]);
  const candidates = existing.filter(
    (t) => t.listingSeedKey && individualLongKeys.has(t.listingSeedKey),
  );
  if (candidates.length === 0) return null;

  const edited = candidates.find(templateHasManagerEdits);
  if (edited) return edited;

  for (const key of [LONG_TERM_SEED_KEY, ...LEGACY_LONG_TERM_SEED_KEYS]) {
    const hit = candidates.find((t) => t.listingSeedKey === key);
    if (hit) return hit;
  }

  return candidates[0] ?? null;
}

function defaultLabelForSeed(seed: LeaseTemplateSeed): string {
  return seed.label;
}

function adoptLegacyDefaultTemplate(
  existing: PropertyLeaseTemplate[],
  seed: LeaseTemplateSeed,
): PropertyLeaseTemplate | null {
  if (existing.length !== 1) return null;
  const only = existing[0]!;
  if (only.listingSeedKey) return null;
  if (only.id !== "lease-tpl-default" && existing.some((t) => t.listingSeedKey)) return null;
  return {
    ...only,
    listingSeedKey: seed.seedKey,
    kind: seed.kind,
    applicationLeaseTerms: seed.applicationLeaseTerms,
    label: only.label.trim() === "Primary lease" ? seed.label : only.label,
    updatedAt: nowIso(),
  };
}

function adoptPreviousSeededTemplate(
  existing: PropertyLeaseTemplate[],
  seededExisting: PropertyLeaseTemplate[],
  seed: LeaseTemplateSeed,
): PropertyLeaseTemplate | null {
  const direct = seededExisting.find((t) => t.listingSeedKey === seed.seedKey);
  if (direct) return direct;

  if (seed.seedKey === LONG_TERM_SEED_KEY) {
    return adoptPreviousLongTermTemplate(existing);
  }
  if (seed.seedKey === SHORT_TERM_SEED_KEY) {
    return seededExisting.find((t) => t.listingSeedKey === SHORT_TERM_SEED_KEY) ?? null;
  }
  if (seed.seedKey === BUNDLE_LONG_TERM_SEED_KEY) {
    return seededExisting.find((t) => t.listingSeedKey === BUNDLE_LONG_TERM_SEED_KEY) ?? null;
  }
  if (seed.seedKey === BUNDLE_SHORT_TERM_SEED_KEY) {
    return seededExisting.find((t) => t.listingSeedKey === BUNDLE_SHORT_TERM_SEED_KEY) ?? null;
  }

  return null;
}

/**
 * Merge auto-seeded lease templates from listing offered terms with manager-owned templates.
 * Seeded rows are matched by `listingSeedKey`; manual rows (no key) are preserved.
 */
export function syncPropertyLeaseTemplatesFromListing(
  sub: ManagerListingSubmissionV1,
): ManagerListingSubmissionV1 {
  const seeds = buildLeaseTemplateSeeds(sub);
  const existing = readPropertyLeaseTemplates(sub);
  const adoptedLegacyIds = new Set<string>();
  const consumedIds = new Set<string>();
  const seededExisting = existing.filter((t) => Boolean(t.listingSeedKey));

  const nextSeeded: PropertyLeaseTemplate[] = [];

  for (const seed of seeds) {
    const legacyAdopted =
      seededExisting.length === 0 && adoptedLegacyIds.size === 0
        ? adoptLegacyDefaultTemplate(existing, seed)
        : null;
    const prev =
      adoptPreviousSeededTemplate(existing, seededExisting, seed) ?? legacyAdopted;

    if (prev) {
      if (legacyAdopted) adoptedLegacyIds.add(legacyAdopted.id);
      consumedIds.add(prev.id);
      const defaultLabel = defaultLabelForSeed(seed);
      nextSeeded.push({
        ...prev,
        kind: seed.kind,
        listingSeedKey: seed.seedKey,
        applicationLeaseTerms: seed.applicationLeaseTerms,
        label: prev.label.trim() && prev.label !== defaultLabel ? prev.label : defaultLabel,
        updatedAt: nowIso(),
      });
    }
    // Deliberately NO else-branch. Sync refreshes templates a manager already
    // has; it never conjures one. Auto-creating every seed on every sync is why
    // each property showed the same four rows and why Delete could not work —
    // the next sync simply recreated whatever was removed. A property with no
    // templates is now a real, stable state, and adding one is an explicit act
    // (`addLeaseTemplateFromSeed`).
  }

  const manual = existing.filter((t) => !t.listingSeedKey && !consumedIds.has(t.id));
  // A seed key that is no longer on offer (the retired bundle formats, a legacy
  // per-term key the collapse did not adopt) still points at a row the manager
  // may have written a lease into. Dropping it would take their custom terms,
  // uploaded document, or HTML override with it, so anything they edited is
  // carried over. Untouched defaults carry nothing and are left behind.
  const preservedSeeded = existing.filter(
    (t) => Boolean(t.listingSeedKey) && !consumedIds.has(t.id) && templateHasManagerEdits(t),
  );
  const merged = [...nextSeeded, ...manual, ...preservedSeeded];
  return syncLegacyLeaseFieldsFromTemplates(sub, merged);
}

export function formatApplicationLeaseTermsLabel(terms: string[] | undefined): string | null {
  const clean = (terms ?? []).filter((t) => t.trim());
  if (clean.length === 0) return null;
  return clean.join(" · ");
}

/** Pick the property lease template that best matches an applicant's lease-term choice. */
export function resolvePropertyLeaseTemplateForApplication(
  sub: ManagerListingSubmissionV1,
  application: Pick<Partial<RentalWizardFormState>, "leaseTerm" | "rentalType" | "bundleId">,
): PropertyLeaseTemplate | null {
  const templates = readPropertyLeaseTemplates(sub);
  if (templates.length === 0) return null;

  const bundleApplication = applicationUsesBundleLeaseTemplate(application);
  const shortTermTemplate =
    templates.find((t) =>
      t.listingSeedKey === (bundleApplication ? BUNDLE_SHORT_TERM_SEED_KEY : SHORT_TERM_SEED_KEY),
    ) ?? templates.find((t) => t.kind === "short-term");
  const longTermTemplate =
    templates.find((t) =>
      t.listingSeedKey === (bundleApplication ? BUNDLE_LONG_TERM_SEED_KEY : LONG_TERM_SEED_KEY),
    ) ??
    templates.find((t) => t.kind === "long-term") ??
    templates[0]!;

  if (application.rentalType === "short_term") {
    return shortTermTemplate ?? longTermTemplate;
  }

  const term = normalizeApplicationLeaseTerm(application.leaseTerm ?? "");

  if (term === SHORT_TERM_LEASE_TERM) {
    return shortTermTemplate ?? longTermTemplate;
  }

  if (term) {
    const explicit = templates.filter((t) => (t.applicationLeaseTerms ?? []).includes(term));
    if (explicit.length === 1) return explicit[0]!;
    if (explicit.length > 1) {
      const bundleScoped = bundleApplication
        ? explicit.filter((t) => t.listingSeedKey?.startsWith("bundle-"))
        : explicit.filter((t) => !t.listingSeedKey?.startsWith("bundle-"));
      if (bundleScoped.length === 1) return bundleScoped[0]!;
      return [...explicit].sort((a, b) => a.label.localeCompare(b.label))[0]!;
    }
  }

  return longTermTemplate;
}

export function applicationUsesBundleLeaseTemplate(
  application: Pick<Partial<RentalWizardFormState>, "bundleId">,
  leaseKind?: "individual" | "joint_bundle",
): boolean {
  return Boolean(application.bundleId?.trim()) || leaseKind === "joint_bundle";
}

export function resolveLeaseTemplateScenarioForApplication(
  application: Pick<Partial<RentalWizardFormState>, "leaseTerm" | "rentalType" | "bundleId">,
  leaseKind?: "individual" | "joint_bundle",
): LeaseTemplateScenarioId {
  const bundle = applicationUsesBundleLeaseTemplate(application, leaseKind);
  const short =
    application.rentalType === "short_term" ||
    normalizeApplicationLeaseTerm(application.leaseTerm ?? "") === SHORT_TERM_LEASE_TERM;
  if (bundle) return short ? "bundle-short" : "bundle-long";
  return short ? "individual-short" : "individual-long";
}

/** The scenario a stored template answers — by seed key when it has one, else by kind. */
export function leaseTemplateScenarioForTemplate(
  template: PropertyLeaseTemplate,
): LeaseTemplateScenarioId {
  if (template.kind === "custom") return "custom";
  switch (template.listingSeedKey) {
    case BUNDLE_LONG_TERM_SEED_KEY:
      return "bundle-long";
    case BUNDLE_SHORT_TERM_SEED_KEY:
      return "bundle-short";
    case SHORT_TERM_SEED_KEY:
      return "individual-short";
    default:
      break;
  }
  return template.kind === "short-term" ? "individual-short" : "individual-long";
}

/** Scenarios a bundle/short default falls back to when the property has no such template. */
function leaseTemplateScenarioFallbacks(
  scenario: LeaseTemplateScenarioId,
): LeaseTemplateScenarioId[] {
  switch (scenario) {
    case "bundle-long":
      return ["individual-long", "individual-short"];
    case "bundle-short":
      return ["individual-short", "bundle-long", "individual-long"];
    case "individual-short":
      return ["individual-long"];
    case "individual-long":
      return ["individual-short"];
    default:
      return [];
  }
}

export type LeaseTemplateGenerateChoice = {
  /** Stable selection key for the picker — the template's own id. */
  id: string;
  scenario: LeaseTemplateScenarioId;
  template: PropertyLeaseTemplate;
  label: string;
};

/**
 * One row per lease template the property actually holds, the best match for
 * this application first. A property with no templates returns [] — generation
 * then falls back to the property's own lease terms, exactly as approval-time
 * auto-generation already does.
 */
export function listLeaseTemplateGenerateChoices(
  sub: ManagerListingSubmissionV1,
  application: Pick<Partial<RentalWizardFormState>, "leaseTerm" | "rentalType" | "bundleId">,
  leaseKind?: "individual" | "joint_bundle",
): LeaseTemplateGenerateChoice[] {
  const templates = readPropertyLeaseTemplates(sub);
  const rows: LeaseTemplateGenerateChoice[] = templates.map((template) => {
    const scenario = leaseTemplateScenarioForTemplate(template);
    return {
      id: template.id,
      scenario,
      template,
      label: template.label.trim() || leaseTemplateScenarioLabel(scenario),
    };
  });

  const defaultScenario = resolveLeaseTemplateScenarioForApplication(application, leaseKind);
  for (const scenario of [defaultScenario, ...leaseTemplateScenarioFallbacks(defaultScenario)]) {
    const idx = rows.findIndex((r) => r.scenario === scenario);
    if (idx < 0) continue;
    if (idx > 0) {
      const [hit] = rows.splice(idx, 1);
      rows.unshift(hit!);
    }
    break;
  }
  return rows;
}

/** Overlay the matched lease template onto legacy top-level lease fields for generation. */
export function submissionWithLeaseTemplateForApplication(
  sub: ManagerListingSubmissionV1,
  application: Pick<Partial<RentalWizardFormState>, "leaseTerm" | "rentalType" | "bundleId">,
): ManagerListingSubmissionV1 {
  const template = resolvePropertyLeaseTemplateForApplication(sub, application);
  if (!template) return sub;
  const templates = readPropertyLeaseTemplates(sub);
  const rest = templates.filter((t) => t.id !== template.id);
  return syncLegacyLeaseFieldsFromTemplates(sub, [template, ...rest]);
}

/** Pin a specific property lease template before generation. */
export function submissionWithLeaseTemplateById(
  sub: ManagerListingSubmissionV1,
  templateId: string,
): ManagerListingSubmissionV1 {
  const templates = readPropertyLeaseTemplates(sub);
  const template = templates.find((t) => t.id === templateId);
  if (!template) return sub;
  const rest = templates.filter((t) => t.id !== templateId);
  return syncLegacyLeaseFieldsFromTemplates(sub, [template, ...rest]);
}


/**
 * The default lease templates a manager can add. Nothing creates these on their
 * behalf — see `syncPropertyLeaseTemplatesFromListing`.
 */
export function availableLeaseTemplateSeeds(
  sub: ManagerListingSubmissionV1,
): LeaseTemplateSeed[] {
  const present = new Set(
    readPropertyLeaseTemplates(sub)
      .map((t) => t.listingSeedKey)
      .filter(Boolean),
  );
  return buildLeaseTemplateSeeds(sub).filter((seed) => !present.has(seed.seedKey));
}

/** Add one default template to the property. Returns the updated submission. */
export function addLeaseTemplateFromSeed(
  sub: ManagerListingSubmissionV1,
  seedKey: PropertyLeaseListingSeedKey,
): ManagerListingSubmissionV1 {
  const seed = buildLeaseTemplateSeeds(sub).find((s) => s.seedKey === seedKey);
  if (!seed) return sub;
  const existing = readPropertyLeaseTemplates(sub);
  // Adding the same default twice would give the applicant-term router two
  // equally valid matches for one lease term.
  if (existing.some((t) => t.listingSeedKey === seedKey)) return sub;
  const created = createPropertyLeaseTemplate({
    kind: seed.kind,
    label: seed.label,
    source: "axis_default",
  });
  return syncLegacyLeaseFieldsFromTemplates(sub, [
    ...existing,
    { ...created, listingSeedKey: seed.seedKey, applicationLeaseTerms: seed.applicationLeaseTerms },
  ]);
}
