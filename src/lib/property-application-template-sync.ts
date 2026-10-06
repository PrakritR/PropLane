import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ApplicationFormVariant } from "@/lib/rental-application/application-field-catalog";
import {
  createPropertyApplicationTemplate,
  readPropertyApplicationTemplates,
  seededApplicationTemplateId,
  syncLegacyApplicationFieldsFromTemplates,
  withPropertyApplicationTemplatesExplicit,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import type { PropertyLeaseListingSeedKey, PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";
import { SHORT_STAY_SEED_KEYS, buildLeaseTemplateSeeds } from "@/lib/property-lease-template-sync";

const COSIGNER_SEED_KEY: PropertyLeaseListingSeedKey = "cosigner";
/** Retired — one co-signer application covers every stay type; kept for legacy rows. */
const COSIGNER_SHORT_TERM_SEED_KEY: PropertyLeaseListingSeedKey = "cosigner-short-term";
const AIRBNB_SEED_KEY: PropertyLeaseListingSeedKey = "airbnb";
/**
 * Names the Airbnb application shipped under as a PropLane default before it got its own. A stored `airbnb`
 * row still carrying one is an untouched default, so it takes the current name. This is the ONLY seed whose
 * old default names are recognized: every other row is judged against its current default alone, so a name
 * the manager chose is never rewritten.
 */
const AIRBNB_RETIRED_DEFAULT_LABELS: readonly string[] = ["Short-term application"];

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
  if (seed.seedKey === COSIGNER_SEED_KEY || seed.seedKey === COSIGNER_SHORT_TERM_SEED_KEY) {
    return "Co-signer application";
  }
  // An Airbnb stay is a short-term stay, so both seeds are `kind: "short-term"` - but they add different
  // forms, and two rows reading "Short-term application" are two rows the manager cannot tell apart.
  if (seed.seedKey === AIRBNB_SEED_KEY) return "Airbnb application";
  if (seed.kind === "short-term") return "Short-term application";
  return "Long-term application";
}

/**
 * Every label this seed has EVER shipped as a default, not just the current one.
 *
 * The two co-signer forms were consolidated into one, so a property seeded
 * before that still carries "Long-term co-signer application" / "Short-term
 * co-signer application". Those are untouched defaults, not manager edits —
 * and `applicationTemplateHasManagerEdits` is what decides whether a row with a
 * retired seed key is preserved. Judging them against the current label alone
 * marks them edited, so the retired `cosigner-short-term` row is kept forever
 * and the property shows a stale duplicate co-signer application it has no way
 * to remove.
 */
function shippedDefaultLabelsForSeed(seed: ApplicationTemplateSeed): string[] {
  if (seed.seedKey === COSIGNER_SEED_KEY || seed.seedKey === COSIGNER_SHORT_TERM_SEED_KEY) {
    return [
      "Co-signer application",
      "Long-term co-signer application",
      "Short-term co-signer application",
    ];
  }
  if (seed.seedKey === AIRBNB_SEED_KEY) return ["Airbnb application", ...AIRBNB_RETIRED_DEFAULT_LABELS];
  return [defaultLabelForSeed(seed)];
}

/**
 * The single co-signer application every property is seeded with.
 *
 * A plain constant: `buildLeaseTemplateSeeds` always returns seeds, so the
 * old "no lease seeds means no co-signer seed" branch was unreachable and its
 * parameter unused — a variability that no longer exists.
 */
const COSIGNER_APPLICATION_SEED: ApplicationTemplateSeed = {
  seedKey: COSIGNER_SEED_KEY,
  kind: "long-term",
  label: "Co-signer application",
  formVariant: "cosigner" as ApplicationFormVariant,
  applicationLeaseTerms: [],
};

/** Every property keeps auto-seeded applications for each lease default plus one co-signer form. */
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
    COSIGNER_APPLICATION_SEED,
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
    id: seededApplicationTemplateId(seed.seedKey),
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
  const shipped = shippedDefaultLabelsForSeed({
    seedKey: template.listingSeedKey,
    kind: template.kind,
    label,
    formVariant: template.formVariant,
    applicationLeaseTerms: template.applicationLeaseTerms ?? [],
  });
  return !shipped.includes(label);
}

/**
 * The row as a live default again: the stay it was hidden for is allowed, so the `offered` value it held
 * when it was hidden comes back — a default the manager had deliberately switched off stays off, and one
 * hidden before that value was recorded reads as offered, exactly as before.
 */
function withoutStayHidden(template: PropertyApplicationTemplate): PropertyApplicationTemplate {
  if (!template.stayHidden) return template;
  const { stayHidden: _hidden, stayHiddenOffered: priorOffered, ...rest } = template;
  return { ...rest, offered: priorOffered ?? true };
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
      const retiredDefaults =
        prev !== legacyAdopted && prev.listingSeedKey === AIRBNB_SEED_KEY ? AIRBNB_RETIRED_DEFAULT_LABELS : [];
      const label =
        normalizedForDefaultCheck &&
        normalizedForDefaultCheck !== defaultLabel &&
        !retiredDefaults.includes(normalizedForDefaultCheck)
          ? trimmedPrevLabel
          : defaultLabel;
      nextSeeded.push({
        ...withoutStayHidden(prev),
        kind: seed.kind,
        formVariant: seed.formVariant,
        listingSeedKey: seed.seedKey,
        applicationLeaseTerms: seed.applicationLeaseTerms,
        label,
        updatedAt: nowIso(),
      });
    } else if (autoSeed) {
      const created = createPropertyApplicationTemplate({
        id: seededApplicationTemplateId(seed.seedKey),
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
  // A short-stay default the property does not offer (it only allows long term): an untouched one is KEPT,
  // switched off and marked `stayHidden`, so nothing is deleted and it does not hold a Short term tab open.
  // One the manager renamed was already preserved above, as it is.
  const preservedIds = new Set(preservedSeeded.map((t) => t.id));
  const stayHidden = existing
    .filter(
      (t) =>
        Boolean(t.listingSeedKey) &&
        SHORT_STAY_SEED_KEYS.has(t.listingSeedKey!) &&
        !consumedIds.has(t.id) &&
        !preservedIds.has(t.id),
    )
    // Already hidden: keep the `offered` value recorded when it was FIRST hidden, or a second sync would
    // record the hidden row's own `offered: false` and lose what the manager had chosen.
    .map((t) => (t.stayHidden ? t : { ...t, offered: false, stayHidden: true, stayHiddenOffered: t.offered !== false }));
  const merged = [...nextSeeded, ...manual, ...preservedSeeded, ...stayHidden];
  // A short-term form now exists only on a property that allows that stay, and its presence still says nothing
  // about the stays on offer: leave `shortTermRentalsAllowed` to the listing ("Stays you offer"). Forcing it on
  // here flipped a long-term-only listing to short-term the moment any application was saved.
  return syncLegacyApplicationFieldsFromTemplates(sub, merged);
}

export function submissionAfterRemovingApplicationTemplate(
  sub: ManagerListingSubmissionV1,
  templates: PropertyApplicationTemplate[],
): ManagerListingSubmissionV1 {
  // Deleting an application never changes which stays the property offers ("Stays you offer" owns that). It used
  // to switch short stays off when the last short-term application went, which now would also remove the Short
  // term tab and the Quick add that brings the default back.
  return syncLegacyApplicationFieldsFromTemplates(
    { ...sub, propertyApplicationTemplatesExplicit: true },
    templates,
  );
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
