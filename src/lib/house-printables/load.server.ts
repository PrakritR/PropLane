import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveListingCtaSmsPhone } from "@/lib/listing-cta-phone.server";
import { resolveSharedLineNumberFor } from "@/lib/one-number/display-number.server";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { getAcceptedCoManagerInviterIds } from "@/lib/sms/manager-workspace-role.server";

export type HouseRecord = {
  propertyId: string;
  ownerUserId: string;
  /** The workspace that holds the house; decides which number the printable shows. */
  workspaceId?: string | null;
  submission: ManagerListingSubmissionV1;
  updatedAt: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The property behind a printable, read with the service role so the caller
 * decides authorization: the manager routes check {@link managerMayPrintHouse},
 * the public page only ever reaches this through a resolved token.
 */
export async function loadHouseRecord(db: SupabaseClient, propertyId: string): Promise<HouseRecord | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, workspace_id, row_data, property_data, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const raw =
    asObject(asObject(data.property_data)?.listingSubmission) ?? asObject(asObject(data.row_data)?.submission);
  if (!raw) return null;
  return {
    propertyId: String(data.id),
    ownerUserId: String(data.manager_user_id ?? ""),
    workspaceId: typeof data.workspace_id === "string" && data.workspace_id.trim() ? data.workspace_id.trim() : null,
    submission: normalizeManagerListingSubmissionV1(raw as unknown as ManagerListingSubmissionV1),
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
  };
}

/** The owner, or a co-manager the owner accepted into the workspace. */
export async function managerMayPrintHouse(
  db: SupabaseClient,
  userId: string,
  ownerUserId: string,
): Promise<boolean> {
  if (!ownerUserId) return false;
  if (userId === ownerUserId) return true;
  const inviters = await getAcceptedCoManagerInviterIds(db, userId);
  return inviters.includes(ownerUserId);
}

/**
 * The number a house's printable and public page say to text, or null for no button: the PropLane line
 * while the house's workspace is on it (number model, Oct 18), else the owner's Twilio work number.
 */
export async function loadHouseOwnerSmsPhone(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId?: string | null,
): Promise<string | null> {
  if (!ownerUserId) return null;
  const onLine = await resolveSharedLineNumberFor(db, ownerUserId, workspaceId ?? null);
  if (onLine) return onLine;
  const { data } = await db
    .from("profiles")
    .select("phone, phone_verified_at, sms_from_number")
    .eq("id", ownerUserId)
    .maybeSingle();
  return resolveListingCtaSmsPhone(data ?? null);
}
