import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { propertyHasOwnRoomPricing } from "@/lib/property-pricing-override-count";

function submissionFromPropertyRow(row: { property_data?: unknown; row_data?: unknown }): unknown {
  const pd = row.property_data;
  if (pd && typeof pd === "object" && !Array.isArray(pd)) {
    const listingSubmission = (pd as { listingSubmission?: unknown }).listingSubmission;
    if (listingSubmission) return listingSubmission;
  }
  const rd = row.row_data;
  if (rd && typeof rd === "object" && !Array.isArray(rd)) {
    const listingSubmission = (rd as { listingSubmission?: unknown }).listingSubmission;
    if (listingSubmission) return listingSubmission;
  }
  return null;
}

/** How many properties in a workspace use their own room pricing (C2-PS4). */
export async function countWorkspacePropertiesWithOwnPricing(
  db: SupabaseClient,
  managerUserId: string,
  workspaceId: string,
): Promise<number> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("property_data,row_data,workspace_id")
    .eq("manager_user_id", managerUserId)
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  let count = 0;
  for (const row of data ?? []) {
    const raw = submissionFromPropertyRow(row);
    if (!raw) continue;
    const sub = normalizeManagerListingSubmissionV1(raw);
    if (propertyHasOwnRoomPricing(sub)) count += 1;
  }
  return count;
}
