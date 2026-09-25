import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  applyEffectiveApplicationForm,
  type WorkspaceApplicationFormTemplate,
} from "@/lib/rental-application/workspace-application-form";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Push a newly-saved workspace application-form template onto every listing
 * in this workspace that is currently FOLLOWING it (`applicationFormSource
 * !== "custom"`), copying the resolved triplet onto that listing's own
 * stored submission — the "Default card" copy-on-save pattern
 * (`docs/agents/listing-wizard-defaults.md` § Workspace application form),
 * decided over the alternative of leaving the workspace form a pure live
 * read: a listing's application should not silently change under an
 * applicant mid-apply just because the manager edited the workspace form
 * later, and a listing's own snapshot is authoritative once copied.
 *
 * This is ADDITIVE, not a replacement for the live-read resolution every
 * other reader still does (`publicListingProjection`,
 * `validate-application-submit.server.ts`, the listing editor's own
 * preview via `resolveEffectiveApplicationForm` /
 * `applyEffectiveApplicationForm`) — those stay exactly as they are and
 * remain the defensive fallback for any listing this push misses (one
 * created between two workspace saves, or predating this feature), so
 * nothing regresses even if a listing is somehow skipped here.
 *
 * Mirrors `applyPropertyServiceFeePayersToListings`
 * (`manager-manual-payment-settings.server.ts`): read every workspace row
 * once, patch the stored submission under whichever key it actually lives
 * at — `row_data.submission` for a pending row, `property_data.listingSubmission`
 * for a live/review row — and write back only the rows that changed.
 * Scoped by `workspace_id` (never `manager_user_id`) so a co-manager's save
 * still reaches every listing in the same workspace, and a listing in a
 * different workspace is never touched.
 */
export async function pushWorkspaceApplicationFormToFollowingListings(
  db: SupabaseClient,
  workspaceId: string,
  template: WorkspaceApplicationFormTemplate,
): Promise<{ listingsUpdated: number }> {
  const id = workspaceId.trim();
  if (!id) return { listingsUpdated: 0 };

  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("workspace_id", id);
  if (error) throw error;

  let listingsUpdated = 0;
  for (const row of rows ?? []) {
    const rowData = asObject(row.row_data);
    const propertyData = asObject(row.property_data);
    const submission = (propertyData.listingSubmission ?? rowData.submission) as
      | ManagerListingSubmissionV1
      | undefined;
    if (!submission || typeof submission !== "object") continue;
    // Never touch a listing that opted into its own independent copy.
    if (submission.applicationFormSource === "custom") continue;

    const nextSubmission = applyEffectiveApplicationForm(submission, template);
    const nextPropertyData = propertyData.listingSubmission
      ? { ...propertyData, listingSubmission: nextSubmission }
      : propertyData;
    const nextRowData = rowData.submission ? { ...rowData, submission: nextSubmission } : rowData;

    const { error: updateError } = await db
      .from("manager_property_records")
      .update({
        row_data: nextRowData,
        property_data: nextPropertyData,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updateError) throw updateError;
    listingsUpdated += 1;
  }
  return { listingsUpdated };
}
