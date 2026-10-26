import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { parseRoomChoiceValue } from "@/lib/rental-application/room-choice-value";
import { needsShortStayPricingCheck, shortStayPricingBlocker, type ShortStayPricingPlacement } from "@/lib/short-stay-pricing-gate";

/** Caller supplies the already-authorized owning manager, never a body-derived grant. */
export async function loadShortStayPricingSubmission(db: SupabaseClient, row: ShortStayPricingPlacement, managerUserId: string | null | undefined) {
  if (!needsShortStayPricingCheck(row)) return undefined;
  const propertyId = row.assignedPropertyId || row.propertyId || row.application?.propertyId || parseRoomChoiceValue(row.assignedRoomChoice || row.roomChoice || row.application?.roomChoice1 || "").propertyId;
  if (!managerUserId || !propertyId) return "unplaced";
  try {
    const { data, error } = await db.from("manager_property_records").select("property_data,row_data").eq("id", propertyId).eq("manager_user_id", managerUserId).maybeSingle();
    if (error) return "unreadable";
    const raw = data?.property_data?.listingSubmission ?? data?.row_data?.listingSubmission ?? data?.row_data?.submission;
    return raw ? normalizeManagerListingSubmissionV1(raw) : null;
  } catch { return "unreadable"; }
}

/** New approvals only: historical approved/signed records are not repriced by a metadata write. */
export async function shortStayApprovalBlocker(db: SupabaseClient, next: DemoApplicantRow, previous: DemoApplicantRow | null): Promise<string | null> {
  if (next.bucket !== "approved" || previous?.bucket === "approved" || !needsShortStayPricingCheck(next)) return null;
  return shortStayPricingBlocker(next, await loadShortStayPricingSubmission(db, next, next.managerUserId));
}
