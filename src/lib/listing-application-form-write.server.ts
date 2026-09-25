import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveSettingsScope } from "@/lib/settings/scope-resolver.server";
import {
  applyEffectiveApplicationForm,
  normalizeWorkspaceApplicationFormTemplate,
  type ListingApplicationFormFields,
  type WorkspaceApplicationFormTemplate,
} from "@/lib/rental-application/workspace-application-form";

const NAMESPACE = "applicationFormTemplate" as const;

async function resolveDefaultWorkspaceId(db: SupabaseClient, ownerUserId: string): Promise<string | null> {
  const { data, error } = await db
    .from("portal_workspaces")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("is_default", true)
    .maybeSingle();
  if (error || !data?.id) return null;
  return String(data.id);
}

/** Load the owner's workspace-wide application form template, or null when none has ever been saved. */
export async function loadWorkspaceApplicationFormTemplate(
  db: SupabaseClient,
  ownerUserId: string,
): Promise<WorkspaceApplicationFormTemplate | null> {
  const workspaceId = await resolveDefaultWorkspaceId(db, ownerUserId);
  if (!workspaceId) return null;
  const { value } = await resolveSettingsScope(
    db,
    { managerUserId: ownerUserId, workspaceId },
    NAMESPACE,
    { normalize: (raw) => normalizeWorkspaceApplicationFormTemplate(raw) },
  );
  return value ?? null;
}

function readSubmission(container: unknown, key: string): Record<string, unknown> | null {
  if (!container || typeof container !== "object" || Array.isArray(container)) return null;
  const submission = (container as Record<string, unknown>)[key];
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) return null;
  return submission as Record<string, unknown>;
}

function patchSubmission(container: unknown, key: string, resolvedFields: ListingApplicationFormFields): unknown {
  const submission = readSubmission(container, key);
  if (!submission) return container;
  const merged = { ...submission, ...resolvedFields };
  return { ...(container as Record<string, unknown>), [key]: merged };
}

/**
 * Re-derive a listing's application-form question set on every save (N037,
 * "copy the workspace Application form onto a listing when saved" —
 * `docs/agents/listing-wizard-defaults.md`-style: a one-time copy at write
 * time, not a live read at request time). Every reader of a listing's
 * question set — the public applicant wizard, the resident-wizard's Add
 * application/Add resident flow, `validateCustomFieldAnswers` — reads
 * `customApplicationFields`/`disabledStandardApplicationKeys` straight off
 * the stored `listingSubmission`/`submission`, never through
 * `resolveEffectiveApplicationForm`. A listing whose `applicationFormSource`
 * is `"workspace"` (the default — "follows the workspace form") therefore
 * needs the workspace template's CURRENT triplet baked onto its own stored
 * fields at write time, exactly the way `reconcileListingServiceFeeOnWrite`
 * re-derives the fee payer on every write.
 *
 * A listing that has opted into `applicationFormSource: "custom"` is left
 * untouched — its own fields are authoritative and this never overwrites
 * them. A property whose owner cannot be resolved, or who has never saved a
 * workspace form, is also left untouched (today's behavior, unaffected).
 */
export async function reconcileListingApplicationFormOnWrite(
  db: SupabaseClient,
  input: { ownerUserId: string | null; rowData: unknown; propertyData: unknown },
): Promise<{ rowData: unknown; propertyData: unknown }> {
  const { ownerUserId, rowData, propertyData } = input;
  if (!ownerUserId) return { rowData, propertyData };

  const rowSubmission = readSubmission(rowData, "submission");
  const propertySubmission = readSubmission(propertyData, "listingSubmission");
  if (!rowSubmission && !propertySubmission) return { rowData, propertyData };

  const claimed = (propertySubmission ?? rowSubmission)! as ListingApplicationFormFields;
  if (claimed.applicationFormSource === "custom") return { rowData, propertyData };

  const workspaceForm = await loadWorkspaceApplicationFormTemplate(db, ownerUserId);
  if (!workspaceForm) return { rowData, propertyData };

  const resolved = applyEffectiveApplicationForm(claimed, workspaceForm);
  const resolvedFields: ListingApplicationFormFields = {
    applicationFormSource: claimed.applicationFormSource,
    customApplicationFields: resolved.customApplicationFields,
    disabledStandardApplicationKeys: resolved.disabledStandardApplicationKeys,
    applicationConfigMode: resolved.applicationConfigMode,
    shortTermCustomApplicationFields: resolved.shortTermCustomApplicationFields,
    shortTermDisabledStandardApplicationKeys: resolved.shortTermDisabledStandardApplicationKeys,
    shortTermApplicationConfigMode: resolved.shortTermApplicationConfigMode,
    cosignerCustomApplicationFields: resolved.cosignerCustomApplicationFields,
    cosignerDisabledStandardApplicationKeys: resolved.cosignerDisabledStandardApplicationKeys,
    cosignerApplicationConfigMode: resolved.cosignerApplicationConfigMode,
  };

  return {
    rowData: patchSubmission(rowData, "submission", resolvedFields),
    propertyData: patchSubmission(propertyData, "listingSubmission", resolvedFields),
  };
}

/**
 * Re-copy the just-saved workspace form onto every listing that follows it
 * (N037: "when the workspace form is published, re-copy onto every listing
 * that follows it"). Called after `PATCH /api/portal/application-form`
 * persists. A listing already on `applicationFormSource: "custom"` is
 * skipped. Best-effort per row: one bad row never blocks the others.
 */
export async function recopyWorkspaceApplicationFormOntoFollowingListings(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceForm: WorkspaceApplicationFormTemplate,
): Promise<{ updated: number; failed: number }> {
  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", ownerUserId);
  if (error || !rows) return { updated: 0, failed: 0 };

  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const rowData = (row as { row_data: unknown }).row_data;
    const propertyData = (row as { property_data: unknown }).property_data;
    const rowSubmission = readSubmission(rowData, "submission");
    const propertySubmission = readSubmission(propertyData, "listingSubmission");
    if (!rowSubmission && !propertySubmission) continue;
    const claimed = (propertySubmission ?? rowSubmission)! as ListingApplicationFormFields;
    if (claimed.applicationFormSource === "custom") continue;

    const resolved = applyEffectiveApplicationForm(claimed, workspaceForm);
    const resolvedFields: ListingApplicationFormFields = {
      applicationFormSource: claimed.applicationFormSource,
      customApplicationFields: resolved.customApplicationFields,
      disabledStandardApplicationKeys: resolved.disabledStandardApplicationKeys,
      applicationConfigMode: resolved.applicationConfigMode,
      shortTermCustomApplicationFields: resolved.shortTermCustomApplicationFields,
      shortTermDisabledStandardApplicationKeys: resolved.shortTermDisabledStandardApplicationKeys,
      shortTermApplicationConfigMode: resolved.shortTermApplicationConfigMode,
      cosignerCustomApplicationFields: resolved.cosignerCustomApplicationFields,
      cosignerDisabledStandardApplicationKeys: resolved.cosignerDisabledStandardApplicationKeys,
      cosignerApplicationConfigMode: resolved.cosignerApplicationConfigMode,
    };
    const nextRowData = patchSubmission(rowData, "submission", resolvedFields);
    const nextPropertyData = patchSubmission(propertyData, "listingSubmission", resolvedFields);
    const { error: writeError } = await db
      .from("manager_property_records")
      .update({ row_data: nextRowData, property_data: nextPropertyData, updated_at: new Date().toISOString() })
      .eq("id", (row as { id: string }).id);
    if (writeError) failed += 1;
    else updated += 1;
  }
  return { updated, failed };
}
