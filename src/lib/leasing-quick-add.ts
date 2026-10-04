/**
 * One pattern for applications, leases and move-in forms (captain, Oct 3 2026).
 *
 * Every card (PropLane defaults included) has Edit / Duplicate / Delete, deleting a default is allowed,
 * and the bottom of every list has a "Quick add" row of the PropLane defaults the property does NOT
 * currently carry. This file is the ONE helper that answers "which defaults are missing" (and adds one),
 * used by the wizard's Application / Lease / Move-in steps and by the property tabs, so the two surfaces
 * can never disagree.
 *
 * Also the default setup of a brand-new property: Long-term application -> Long-term lease, Short-term
 * application -> Short-term lease, Co-signer application -> no lease, and a Move-in checklist for every
 * lease type. Nothing here sends anything: a move-in form auto-sends only once the manager has SAVED
 * the property (the server ignores a list that was never stored).
 *
 * Pure: takes the listing submission, returns the next one.
 */
import { isAddendumLeaseTemplate, isCosignerApplicationTemplate, leaseLinkFields } from "@/lib/application-lease-mapping";
import { MOVE_IN_FORM_STARTERS, newMoveInFormTemplate, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import type { MoveInFormStarterKey, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  addApplicationTemplateFromSeed,
  availableApplicationTemplateSeeds,
  syncPropertyApplicationTemplatesFromListing,
} from "@/lib/property-application-template-sync";
import {
  applicationFormVariantForTemplate,
  readPropertyApplicationTemplates,
  withPropertyApplicationTemplatesExplicit,
  type ApplicationAppliesTo,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  addLeaseTemplateFromSeed,
  availableLeaseTemplateSeeds,
  buildLeaseTemplateSeeds,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import {
  readPropertyLeaseTemplates,
  type PropertyLeaseListingSeedKey,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";

export type QuickAddKind = "application" | "lease" | "movein";

/** One PropLane default the property does not carry: `key` is a listing seed key or a move-in starter key. */
export type QuickAddEntry = { key: string; label: string };

/** The PropLane default applications this property does not currently carry ("Long-term application" ...). */
export function missingApplicationDefaults(sub: ManagerListingSubmissionV1): QuickAddEntry[] {
  return availableApplicationTemplateSeeds(syncPropertyApplicationTemplatesFromListing(sub)).map((seed) => ({
    key: seed.seedKey,
    label: seed.label,
  }));
}

/** The PropLane default leases this property does not currently carry ("Long-term lease", "Short-term lease"). */
export function missingLeaseDefaults(sub: ManagerListingSubmissionV1): QuickAddEntry[] {
  return availableLeaseTemplateSeeds(syncPropertyLeaseTemplatesFromListing(sub)).map((seed) => ({
    key: seed.seedKey,
    label: seed.label,
  }));
}

/** The move-in starters this property does not currently carry (matched on the form's starter key). */
export function missingMoveInStarters(sub: ManagerListingSubmissionV1 | { moveInFormTemplates?: unknown }): QuickAddEntry[] {
  const present = new Set(
    readMoveInFormTemplates(sub)
      .map((template) => template.starterKey)
      .filter((key): key is MoveInFormStarterKey => Boolean(key)),
  );
  return MOVE_IN_FORM_STARTERS.filter((starter) => starter.starterKey && !present.has(starter.starterKey)).map((starter) => ({
    key: starter.starterKey!,
    label: starter.name,
  }));
}

/** "Quick add" entries for one list, in the order the list shows them. */
export function missingDefaultsFor(kind: QuickAddKind, sub: ManagerListingSubmissionV1): QuickAddEntry[] {
  if (kind === "application") return missingApplicationDefaults(sub);
  if (kind === "lease") return missingLeaseDefaults(sub);
  return missingMoveInStarters(sub);
}

/* ───────────────────────────── adding one default ───────────────────────────── */

/** Seed keys whose application and lease are the same lease type, so they link by default. */
const LINKED_SEEDS: ReadonlySet<PropertyLeaseListingSeedKey> = new Set(["primary", "short-term", "airbnb"]);

/**
 * Points every application of a lease-bearing seed at the lease of the same seed, when it has none.
 * Co-signer applications never map to a lease. An application that already names a live lease keeps it.
 */
function withDefaultLeaseLinks(sub: ManagerListingSubmissionV1): ManagerListingSubmissionV1 {
  const applications = readPropertyApplicationTemplates(sub);
  const leases = readPropertyLeaseTemplates(sub);
  if (applications.length === 0 || leases.length === 0) return sub;
  const leaseIds = new Set(leases.map((lease) => lease.id));
  let changed = false;
  const next = applications.map((application) => {
    const seed = application.listingSeedKey;
    if (isCosignerApplicationTemplate(application) || !seed || !LINKED_SEEDS.has(seed)) return application;
    const current = application.linkedLeaseTemplateId?.trim();
    if (current && leaseIds.has(current)) return application;
    const lease = leases.find((row) => row.listingSeedKey === seed);
    if (!lease) return application;
    changed = true;
    return { ...application, ...leaseLinkFields(lease.id) };
  });
  return changed ? withPropertyApplicationTemplatesExplicit(sub, next) : sub;
}

/**
 * The lease a NEW application starts linked to: Long-term (Standard) -> the Long-term lease, Short-term ->
 * the Short-term lease, Co-signer -> none. Null when the property has no lease of that type (the application
 * then falls back to the property's default lease, exactly as an unmapped application always did).
 */
export function defaultLeaseIdForApplication(
  application: Pick<PropertyApplicationTemplate, "kind" | "listingSeedKey" | "formVariant"> &
    Partial<Pick<PropertyApplicationTemplate, "appliesTo">>,
  leases: readonly PropertyLeaseTemplate[],
): string | null {
  // "Applies to" is asked first on a new application and the lease follows it: a Both application is for
  // either stay, so it links to no lease of its own (the applicant's pick routes the lease).
  if (application.appliesTo === "both") return null;
  const variant =
    application.appliesTo === "short_term"
      ? "short_term"
      : application.appliesTo === "long_term"
        ? "standard"
        : applicationFormVariantForTemplate(application);
  if (variant === "cosigner") return null;
  const seeds: PropertyLeaseListingSeedKey[] = variant === "short_term" ? ["short-term", "airbnb"] : ["primary"];
  for (const seed of seeds) {
    const hit = leases.find((lease) => lease.listingSeedKey === seed);
    if (hit) return hit.id;
  }
  const kind = variant === "short_term" ? "short-term" : "long-term";
  return leases.find((lease) => lease.kind === kind && !isAddendumLeaseTemplate(lease))?.id ?? null;
}

/**
 * A new application with the PropLane defaults a fresh one starts from: Form type Standard, the default
 * lease of its type, and PropLane's Co-signer application as its co-signer form.
 */
export function applicationWithDefaultLinks(
  application: PropertyApplicationTemplate,
  catalog: { applications: readonly PropertyApplicationTemplate[]; leases: readonly PropertyLeaseTemplate[] },
): PropertyApplicationTemplate {
  if (isCosignerApplicationTemplate(application)) return application;
  const leaseId = defaultLeaseIdForApplication(application, catalog.leases);
  const cosigner = catalog.applications.find((row) => isCosignerApplicationTemplate(row));
  return {
    ...application,
    ...leaseLinkFields(leaseId),
    ...(cosigner ? { linkedCosignerApplicationTemplateId: cosigner.id } : {}),
  };
}

/**
 * A NEW application, once the manager has said who it is for ("Applies to", asked first): the section it
 * lands in, the form variant and kind that go with the stay, and the lease and co-signer links that default
 * from that answer. Long term and Both are the standard form; Short term is the short-term form.
 */
export function applicationForAppliesTo(
  application: PropertyApplicationTemplate,
  appliesTo: ApplicationAppliesTo,
  catalog: { applications: readonly PropertyApplicationTemplate[]; leases: readonly PropertyLeaseTemplate[] },
): PropertyApplicationTemplate {
  const short = appliesTo === "short_term";
  const staged: PropertyApplicationTemplate = {
    ...application,
    appliesTo,
    kind: short ? "short-term" : "long-term",
    formVariant: short ? "short_term" : "standard",
  };
  return applicationWithDefaultLinks(staged, catalog);
}

/** Re-adds one PropLane default application, linked to the default lease of its type when that lease exists. */
export function submissionWithApplicationDefault(
  sub: ManagerListingSubmissionV1,
  seedKey: PropertyLeaseListingSeedKey,
): ManagerListingSubmissionV1 {
  const base = sub.propertyApplicationTemplatesExplicit ? sub : syncPropertyApplicationTemplatesFromListing(sub);
  const added = addApplicationTemplateFromSeed(base, seedKey);
  return added === base ? sub : withDefaultLeaseLinks(added);
}

/** Re-adds one PropLane default lease, and links the applications of its type that have no lease. */
export function submissionWithLeaseDefault(
  sub: ManagerListingSubmissionV1,
  seedKey: PropertyLeaseListingSeedKey,
): ManagerListingSubmissionV1 {
  const base = syncPropertyLeaseTemplatesFromListing(sub);
  const added = addLeaseTemplateFromSeed(base, seedKey);
  return added === base ? sub : withDefaultLeaseLinks(added);
}

/**
 * Adds one move-in starter as the manager's own form. It sends only when the manager says so
 * (`manual`), the same rule the chooser and the wizard already apply to a form added by hand.
 */
export function submissionWithMoveInStarter(
  sub: ManagerListingSubmissionV1,
  starterKey: MoveInFormStarterKey,
): ManagerListingSubmissionV1 {
  const templates = readMoveInFormTemplates(sub);
  if (templates.some((template) => template.starterKey === starterKey)) return sub;
  const created: MoveInFormTemplate = { ...newMoveInFormTemplate("built", starterKey), trigger: "manual" };
  return { ...sub, moveInFormTemplates: [...templates, created] };
}

/* ───────────────────────────── a new property's defaults ───────────────────────────── */

/**
 * The starting leasing setup of a brand-new property:
 *  - Long-term application -> Long-term lease, Short-term application -> Short-term lease, the
 *    Co-signer application -> no lease (an explicit "no lease", not the property default);
 *  - a Move-in checklist for every lease type, stored with the starter's own Sends. It sends itself
 *    only after the manager saves the property: the server ignores a move-in list that was never stored.
 * A property that already has any stored application, lease or move-in form is left exactly as it is.
 */
export function submissionWithDefaultLeasingSetup(sub: ManagerListingSubmissionV1): ManagerListingSubmissionV1 {
  const hasStored =
    readPropertyApplicationTemplates(sub).length > 0 ||
    readPropertyLeaseTemplates(sub).length > 0 ||
    Array.isArray((sub as { moveInFormTemplates?: unknown }).moveInFormTemplates);
  if (hasStored) return sub;
  let next = withPropertyApplicationTemplatesExplicit(
    sub,
    readPropertyApplicationTemplates(syncPropertyApplicationTemplatesFromListing(sub)),
  );
  for (const seed of buildLeaseTemplateSeeds(next)) next = addLeaseTemplateFromSeed(next, seed.seedKey);
  next = withDefaultLeaseLinks(next);
  // The co-signer form rides with the main application; "no lease" is stated, not left to the property default.
  const current = readPropertyApplicationTemplates(next);
  const cosigner = current.find((application) => isCosignerApplicationTemplate(application));
  const applications = current.map((application) =>
    isCosignerApplicationTemplate(application)
      ? { ...application, linkedLeaseTemplateId: null }
      : cosigner
        ? { ...application, linkedCosignerApplicationTemplateId: cosigner.id }
        : application,
  );
  next = withPropertyApplicationTemplatesExplicit(next, applications);
  // "All" lease types is the absence of a lease-type restriction (`MoveInFormTemplate.leaseType`).
  const checklist = newMoveInFormTemplate("built", "move-in-checklist");
  return { ...next, moveInFormTemplates: [checklist] };
}
