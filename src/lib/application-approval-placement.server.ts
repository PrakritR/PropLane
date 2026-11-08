import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { approvalPlacementBlocker } from "@/lib/application-approval-placement";

/** Newly approved rows only; preserve edits to already-approved historic applications. */
export async function approvalPlacementServerBlocker(db: SupabaseClient, row: DemoApplicantRow, previous: DemoApplicantRow | null): Promise<string | null> {
  if (row.bucket !== "approved" || previous?.bucket === "approved") return null;
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  if (!propertyId || !row.managerUserId?.trim()) return "Assign a property before approving.";
  try {
    const { data, error } = await db.from("manager_property_records").select("property_data,row_data").eq("id", propertyId).eq("manager_user_id", row.managerUserId).maybeSingle();
    if (error || !data) return "Could not verify this property's pricing. Refresh and try again.";
    const raw = data.property_data?.listingSubmission ?? data.row_data?.listingSubmission ?? data.row_data?.submission;
    return approvalPlacementBlocker(row, raw as ManagerListingSubmissionV1 | undefined);
  } catch { return "Could not verify this property's pricing. Refresh and try again."; }
}
