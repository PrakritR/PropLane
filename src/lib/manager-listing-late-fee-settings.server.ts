import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export type LateFeeValue = {
  amount: string;
  graceDays: number;
};

/**
 * Late fee amount + grace days live on each LISTING
 * (`ManagerListingSubmissionV1.lateFeeAmount` / `.lateFeeGraceDays`) — there is
 * no workspace or account rung above it (PLAN-0920-0845 phase E, captain's
 * build note: "EXCEPT late fees, which live on each listing"). A
 * workspace-wide edit from the Payments settings scope bar therefore fans the
 * SAME value out to every listing the bar resolved, through this one patch —
 * the same `row_data`/`property_data` submission-patch shape
 * `applyPropertyServiceFeePayersToListings` already uses for the processing-fee
 * payer (`manager-manual-payment-settings.server.ts`).
 *
 * Ids are re-authorized here, not trusted from the caller: the `SELECT` is
 * scoped to `manager_user_id = managerUserId`, so an id this manager does not
 * own simply will not come back. When ANY requested id is missing from that
 * result, NOTHING is written — `missingPropertyIds` comes back non-empty and
 * the whole batch is rejected together, never a partial fan-out.
 */
export async function applyLateFeeToListings(
  db: SupabaseClient,
  managerUserId: string,
  propertyIds: string[],
  lateFee: LateFeeValue,
): Promise<{ listingsUpdated: number; missingPropertyIds: string[] }> {
  const ids = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { listingsUpdated: 0, missingPropertyIds: [] };

  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", managerUserId)
    .in("id", ids);
  if (error) throw error;

  const foundIds = new Set((rows ?? []).map((row) => String((row as { id: string }).id)));
  const missingPropertyIds = ids.filter((id) => !foundIds.has(id));
  if (missingPropertyIds.length > 0) return { listingsUpdated: 0, missingPropertyIds };

  let listingsUpdated = 0;
  for (const row of rows ?? []) {
    const rowData = asObject((row as { row_data?: unknown }).row_data);
    const propertyData = asObject((row as { property_data?: unknown }).property_data);
    const submission = (propertyData.listingSubmission ?? rowData.submission) as
      | ManagerListingSubmissionV1
      | undefined;
    if (!submission || typeof submission !== "object") continue;
    const nextSubmission: ManagerListingSubmissionV1 = {
      ...submission,
      lateFeeAmount: lateFee.amount,
      lateFeeGraceDays: lateFee.graceDays,
    };
    const nextPropertyData = propertyData.listingSubmission
      ? { ...propertyData, listingSubmission: nextSubmission }
      : propertyData;
    const nextRowData = rowData.submission ? { ...rowData, submission: nextSubmission } : rowData;
    const { error: updateError } = await db
      .from("manager_property_records")
      .update({ row_data: nextRowData, property_data: nextPropertyData, updated_at: new Date().toISOString() })
      .eq("id", (row as { id: string }).id);
    if (updateError) throw updateError;
    listingsUpdated += 1;
  }
  return { listingsUpdated, missingPropertyIds: [] };
}
