import {
  readAllExtraListings,
  readAllPendingManagerProperties,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  updateExtraListingFromSubmission,
  updateExtraListingFromSubmissionOnServer,
  updatePendingManagerProperty,
  updatePendingManagerPropertyOnServer,
} from "@/lib/demo-property-pipeline";
import { updateRequestChangeProperty } from "@/lib/demo-admin-property-inventory";
import { collectLinkedPropertyIds } from "@/lib/manager-portfolio-access";
import { parseMonthlyRent } from "@/lib/listings-search";
import {
  legacyAdminFieldsToSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  createPropertyLeaseTemplate,
  readPropertyLeaseTemplates,
  syncLegacyLeaseFieldsFromTemplates,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";
import { leaseSourceFromDraft } from "@/lib/property-lease-source";
import type { MockProperty } from "@/data/types";
import type { ManagerPendingPropertyRow } from "@/lib/demo-property-pipeline";

export type ManagerPropertySaveTarget = {
  mode: "pending" | "listing" | "requestChange";
  saveId: string;
};

function submissionForListedEdit(p: MockProperty): ManagerListingSubmissionV1 {
  if (p.listingSubmission) return normalizeManagerListingSubmissionV1(p.listingSubmission);
  const rentNum = parseMonthlyRent(String(p.rentLabel ?? "")) ?? 0;
  return normalizeManagerListingSubmissionV1(
    legacyAdminFieldsToSubmission({
      buildingName: p.buildingName,
      address: p.address,
      zip: p.zip,
      neighborhood: p.neighborhood,
      unitLabel: p.unitLabel,
      beds: p.beds,
      baths: p.baths,
      monthlyRent: rentNum,
      petFriendly: p.petFriendly,
      tagline: p.tagline,
    }),
  );
}

function submissionForPendingEdit(row: ManagerPendingPropertyRow): ManagerListingSubmissionV1 {
  const raw = row.submission ? row.submission : legacyAdminFieldsToSubmission(row);
  return normalizeManagerListingSubmissionV1(raw);
}

export type LeaseConfigFields = Pick<
  ManagerListingSubmissionV1,
  "leaseConfigMode" | "leaseCustomKind" | "customLeaseTerms" | "leaseTemplateDocUrl" | "leaseTemplateDocName"
>;

export type ApplicationConfigFields = Pick<
  ManagerListingSubmissionV1,
  | "disabledStandardApplicationKeys"
  | "customApplicationFields"
  | "applicationConfigMode"
  | "shortTermDisabledStandardApplicationKeys"
  | "shortTermCustomApplicationFields"
  | "shortTermApplicationConfigMode"
  | "cosignerDisabledStandardApplicationKeys"
  | "cosignerCustomApplicationFields"
  | "cosignerApplicationConfigMode"
>;

export function applicationConfigFieldsFromSubmission(sub: ManagerListingSubmissionV1): ApplicationConfigFields {
  return {
    disabledStandardApplicationKeys: sub.disabledStandardApplicationKeys ?? [],
    customApplicationFields: sub.customApplicationFields ?? [],
    applicationConfigMode: sub.applicationConfigMode ?? "standard",
    // The short-term form is configured independently; carry its slice too so a
    // bulk edit applies BOTH forms' settings to every selected property.
    shortTermDisabledStandardApplicationKeys: sub.shortTermDisabledStandardApplicationKeys ?? [],
    shortTermCustomApplicationFields: sub.shortTermCustomApplicationFields ?? [],
    shortTermApplicationConfigMode: sub.shortTermApplicationConfigMode ?? "standard",
    cosignerDisabledStandardApplicationKeys: sub.cosignerDisabledStandardApplicationKeys ?? [],
    cosignerCustomApplicationFields: sub.cosignerCustomApplicationFields ?? [],
    cosignerApplicationConfigMode: sub.cosignerApplicationConfigMode ?? "standard",
  };
}

export function persistManagerListingSubmission(
  saveTarget: ManagerPropertySaveTarget,
  managerUserId: string,
  next: ManagerListingSubmissionV1,
): boolean {
  if (saveTarget.mode === "pending") {
    return updatePendingManagerProperty(saveTarget.saveId, next, managerUserId);
  }
  if (saveTarget.mode === "listing") {
    return updateExtraListingFromSubmission(saveTarget.saveId, managerUserId, next);
  }
  return updateRequestChangeProperty(saveTarget.saveId, managerUserId, next);
}

/** Server-confirmed persist — use for lease/application edits that must survive reload. */
export async function persistManagerListingSubmissionOnServer(
  saveTarget: ManagerPropertySaveTarget,
  managerUserId: string,
  next: ManagerListingSubmissionV1,
): Promise<boolean> {
  if (saveTarget.mode === "pending") {
    return updatePendingManagerPropertyOnServer(saveTarget.saveId, next, managerUserId);
  }
  if (saveTarget.mode === "listing") {
    return updateExtraListingFromSubmissionOnServer(saveTarget.saveId, managerUserId, next);
  }
  return persistManagerListingSubmission(saveTarget, managerUserId, next);
}

/** Apply the same lease configuration fields to each property id (demo + live). */
export function persistLeaseConfigToPropertyIds(
  managerUserId: string,
  propertyIds: string[],
  leaseFields: LeaseConfigFields,
  leaseKind?: PropertyLeaseTemplateKind,
): { saved: number; failed: number } {
  let saved = 0;
  let failed = 0;
  for (const propertyId of propertyIds) {
    const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
    if (!hit) {
      failed += 1;
      continue;
    }
    let next: ManagerListingSubmissionV1;
    if (!leaseKind) {
      next = { ...hit.sub, ...leaseFields };
    } else {
      const templates = readPropertyLeaseTemplates(hit.sub);
      const seedKey: "short-term" | "primary" = leaseKind === "short-term" ? "short-term" : "primary";
      const index = templates.findIndex((template) => template.listingSeedKey === seedKey || template.kind === leaseKind);
      const updated = {
        ...leaseFields,
        kind: leaseKind,
        updatedAt: new Date().toISOString(),
      };
      const nextTemplates = index === -1
        ? [
            ...templates,
            {
              ...createPropertyLeaseTemplate({ kind: leaseKind, source: leaseSourceFromDraft(leaseFields) }),
              ...updated,
              listingSeedKey: seedKey,
            },
          ]
        : templates.map((template, templateIndex) =>
            templateIndex === index ? { ...template, ...updated } : template,
          );
      next = syncLegacyLeaseFieldsFromTemplates(hit.sub, nextTemplates);
    }
    if (persistManagerListingSubmission(hit.saveTarget, managerUserId, next)) {
      saved += 1;
    } else {
      failed += 1;
    }
  }
  return { saved, failed };
}

/** Apply the same application question config to each property id (demo + live). */
export function persistApplicationConfigToPropertyIds(
  managerUserId: string,
  propertyIds: string[],
  configFields: ApplicationConfigFields,
): { saved: number; failed: number } {
  let saved = 0;
  let failed = 0;
  for (const propertyId of propertyIds) {
    const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
    if (!hit) {
      failed += 1;
      continue;
    }
    const next: ManagerListingSubmissionV1 = {
      ...hit.sub,
      ...configFields,
    };
    if (persistManagerListingSubmission(hit.saveTarget, managerUserId, next)) {
      saved += 1;
    } else {
      failed += 1;
    }
  }
  return { saved, failed };
}

export function resolveManagerListingSubmissionForPropertyId(
  managerUserId: string | null,
  propertyId: string,
): { sub: ManagerListingSubmissionV1; saveTarget: ManagerPropertySaveTarget } | null {
  const saveTarget = resolvePropertySaveTargetById(managerUserId, propertyId);
  if (!saveTarget || !managerUserId) return null;
  const id = propertyId.trim();
  const listing =
    readExtraListingsForUser(managerUserId).find((p) => p.id === id) ??
    readAllExtraListings().find((p) => p.id === id);
  if (listing) {
    return { sub: submissionForListedEdit(listing), saveTarget };
  }
  const pending =
    readPendingManagerPropertiesForUser(managerUserId).find((p) => p.id === id) ??
    readAllPendingManagerProperties().find((p) => p.id === id);
  if (pending) {
    return { sub: submissionForPendingEdit(pending), saveTarget };
  }
  return null;
}

/**
 * Maps the pieces the admin property table already resolves per-row (portal
 * submission save mode, admin bucket, listing id) onto the {mode, saveId}
 * shape the property editor panels persist through. Pure extraction of the
 * decision logic previously inlined in manager-house-properties-panel.tsx.
 */
export function resolvePropertySaveTarget(input: {
  portalSaveMode?: "pending" | "listing" | "requestChange";
  portalSaveId?: string;
  bucket?: number | null;
  adminRefId?: string | null;
  listingId?: string | null;
}): ManagerPropertySaveTarget | null {
  const { portalSaveMode, portalSaveId, bucket, adminRefId, listingId } = input;
  if (portalSaveMode && portalSaveId) return { mode: portalSaveMode, saveId: portalSaveId };
  if (bucket === 0 && adminRefId) return { mode: "pending", saveId: adminRefId };
  if (listingId?.trim()) return { mode: "listing", saveId: listingId.trim() };
  return null;
}

/**
 * Resolves a save target from just a propertyId, as selected in the manager
 * "Add request" modal's property dropdown — those options only ever come
 * from a manager's listed properties or pending drafts (never a property
 * mid-request-change), so this never returns "requestChange".
 */
export function resolvePropertySaveTargetById(
  managerUserId: string | null,
  propertyId: string,
): ManagerPropertySaveTarget | null {
  const id = propertyId.trim();
  if (!managerUserId || !id) return null;
  if (readExtraListingsForUser(managerUserId).some((p) => p.id === id)) {
    return resolvePropertySaveTarget({ listingId: id });
  }
  if (readAllExtraListings().some((p) => p.id === id) || collectLinkedPropertyIds(managerUserId).has(id)) {
    return resolvePropertySaveTarget({ listingId: id });
  }
  if (readPendingManagerPropertiesForUser(managerUserId).some((p) => p.id === id)) {
    return resolvePropertySaveTarget({ bucket: 0, adminRefId: id });
  }
  if (readAllPendingManagerProperties().some((p) => p.id === id)) {
    return resolvePropertySaveTarget({ bucket: 0, adminRefId: id });
  }
  return null;
}
