import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { doorCountForListing } from "@/lib/billing/door-count";
import { buildMockPropertyFromDraft, deriveLegacyFields, type ManagerPendingPropertyRow } from "@/lib/demo-property-pipeline";
import { listingPublicPathFor } from "@/lib/listing-slug";
import { scheduleListingChannelSync } from "@/lib/listing-channels/sync.server";
import { reconcileListingApplicationFormOnWrite } from "@/lib/listing-application-form-write.server";
import { normalizeListingPhotoUrl } from "@/lib/listing-media-placement.server";
import { reconcileListingServiceFeeOnWrite } from "@/lib/listing-service-fee-write.server";
import { MANAGER_PROPERTY_LIMIT_ERROR_CODE } from "@/lib/manager-access";
import { normalizeManagerListingSubmissionV1, withOfferedLeaseTermsFilled, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { assertManagerPropertyListingQuota } from "@/lib/manager-property-quota.server";
import { emptyLeaseTermsWrite } from "@/lib/property-records/listing-write-guards";

/**
 * Publish an owner's saved DRAFT listing as a live one, from a server caller with no browser (the by-text walkthrough's
 * PUBLISH). It is the Add property wizard's publish (`publishManagerListingSubmissionToServer` -> `POST /api/property-records`)
 * rebuilt over the same pieces, in the same order, so a listing posted from a phone is held to the wizard's rules:
 *
 *   ownership (the row's `manager_user_id` is the caller, never a body id) -> lease-term guard (`listing-write-guards`) ->
 *   the plan's listing cap (`assertManagerPropertyListingQuota`: Free's door cap, a pinned cap override, managed
 *   workspaces exempt) -> service-fee payer + application-form reconcile -> one draft -> live write with the SAME row shape
 *   (`deriveLegacyFields` + `buildMockPropertyFromDraft`, what `publicListingProjection` reads) -> listing-site sync.
 *
 * The write is compare-and-set on (id, owner, status = draft): a second PUBLISH, another account, or a row someone already
 * moved never changes it, and nothing here can create a row or touch another listing. An application-fee promo code is
 * never part of a texted draft, so that branch of the route does not apply.
 */

export type PublishMissing = "address" | "rent" | "availability" | "photo" | "lease_terms";

export type PublishListingResult =
  | { ok: true; propertyId: string; address: string; path: string; alreadyLive: boolean }
  | { ok: false; reason: "not_found" | "not_draft" | "incomplete"; missing?: PublishMissing[] }
  | { ok: false; reason: "plan_limit"; message: string; tier: string | null; limit: number; current: number; code: typeof MANAGER_PROPERTY_LIMIT_ERROR_CODE }
  | { ok: false; reason: "unavailable" };

type Row = Record<string, unknown>;

/** What a listing still lacks before it may go live. Pure; the by-text walkthrough asks for each, one per text. */
export function missingForPublish(submission: ManagerListingSubmissionV1): PublishMissing[] {
  const missing: PublishMissing[] = [];
  if (!submission.address.trim() && !submission.buildingName.trim()) missing.push("address");
  const rooms = submission.rooms.filter((room) => room.name.trim().length > 0);
  const priced = rooms.length > 0 ? rooms.every((room) => Number.isFinite(room.monthlyRent) && room.monthlyRent > 0) : false;
  if (!priced) missing.push("rent");
  if (rooms.length === 0 || rooms.some((room) => !String(room.availability ?? "").trim())) missing.push("availability");
  if (!(submission.housePhotoDataUrls ?? []).some((url) => normalizeListingPhotoUrl(url) !== null)) missing.push("photo");
  if (emptyLeaseTermsWrite(submission)) missing.push("lease_terms");
  return missing;
}

export async function publishOwnedDraftListing(
  db: SupabaseClient,
  input: { userId: string; propertyId: string },
): Promise<PublishListingResult> {
  const userId = input.userId.trim();
  const id = input.propertyId.trim();
  if (!userId || !id) return { ok: false, reason: "not_found" };

  const { data, error } = await db
    .from("manager_property_records")
    .select("manager_user_id, status, row_data, workspace_id")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("publish listing read failed", error.code ?? "unknown");
    return { ok: false, reason: "unavailable" };
  }
  const existing = data as Row | null;
  // Someone else's id is "not found": nothing about it is disclosed, and nothing of it is touched.
  if (!existing || String(existing.manager_user_id ?? "") !== userId) return { ok: false, reason: "not_found" };

  const rowData = existing.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data) ? (existing.row_data as Row) : null;
  const publicPath = (address: string) => listingPublicPathFor({ id, address });
  // A listing already live (a second PUBLISH): its row keeps only the legacy summary, so say what is true and change nothing.
  if (existing.status === "live") {
    const address = String(rowData?.address ?? "");
    return { ok: true, propertyId: id, address, path: publicPath(address), alreadyLive: true };
  }
  const rawSubmission = rowData?.submission;
  if (existing.status !== "draft" || !rawSubmission || typeof rawSubmission !== "object") return { ok: false, reason: "not_draft" };
  // A texted draft never named a lease type: write down what every screen already shows for such a listing (Long term alone,
  // `withOfferedLeaseTermsFilled`), exactly as the wizard does before its first save. Never anything wider.
  const submission = withOfferedLeaseTermsFilled(normalizeManagerListingSubmissionV1(rawSubmission as ManagerListingSubmissionV1));
  const legacy = deriveLegacyFields(submission);

  const missing = missingForPublish(submission);
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing };

  const workspaceId = typeof existing.workspace_id === "string" && existing.workspace_id.trim() ? existing.workspace_id.trim() : null;
  const quota = await assertManagerPropertyListingQuota(db, {
    ownerUserId: userId,
    recordId: id,
    nextStatus: "live",
    existingStatus: "draft",
    incomingDoors: doorCountForListing(submission).doors,
    workspaceId,
  });
  if (!quota.ok) {
    if (quota.status === 403) {
      return { ok: false, reason: "plan_limit", message: quota.error, tier: quota.tier, limit: quota.limit, current: quota.current, code: MANAGER_PROPERTY_LIMIT_ERROR_CODE };
    }
    console.error("publish listing quota unreadable");
    return { ok: false, reason: "unavailable" };
  }

  const pending: ManagerPendingPropertyRow = { ...legacy, id, submittedAt: new Date().toISOString(), submission, submittedByUserId: userId };
  const prop = { ...buildMockPropertyFromDraft(pending, id), adminPublishLive: true, managerUserId: userId };
  const liveRowData = { ...legacy, adminRefId: id, listingId: id, managerUserId: userId };
  let reconciled: { rowData: unknown; propertyData: unknown };
  try {
    const fee = await reconcileListingServiceFeeOnWrite(db, { ownerUserId: userId, rowData: liveRowData, propertyData: prop });
    reconciled = await reconcileListingApplicationFormOnWrite(db, { ownerUserId: userId, rowData: fee.rowData, propertyData: fee.propertyData });
  } catch (reconcileError) {
    console.error("publish listing reconcile failed", reconcileError instanceof Error ? reconcileError.name : "unknown");
    return { ok: false, reason: "unavailable" };
  }

  const { data: written, error: writeError } = await db
    .from("manager_property_records")
    .update({ status: "live", row_data: reconciled.rowData, property_data: reconciled.propertyData, edit_request_note: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("manager_user_id", userId)
    .eq("status", "draft")
    .select("id");
  if (writeError) {
    console.error("publish listing write failed", writeError.code ?? "unknown");
    return { ok: false, reason: "unavailable" };
  }
  if (!Array.isArray(written) || written.length === 0) {
    // Lost the race (a second PUBLISH, or the row changed): say what is true now, change nothing.
    const { data: now } = await db.from("manager_property_records").select("status").eq("id", id).eq("manager_user_id", userId).maybeSingle();
    if ((now as Row | null)?.status === "live") return { ok: true, propertyId: id, address: legacy.address, path: publicPath(legacy.address), alreadyLive: true };
    return { ok: false, reason: "not_draft" };
  }

  try {
    track("listing_published", userId, { property_id: id, channel: "sms" });
  } catch {
    /* analytics never fails a publish */
  }
  try {
    scheduleListingChannelSync(db, id);
  } catch {
    /* the cron retries */
  }
  return { ok: true, propertyId: id, address: legacy.address, path: publicPath(legacy.address), alreadyLive: false };
}
