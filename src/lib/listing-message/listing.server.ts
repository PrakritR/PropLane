import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { asProperty } from "@/lib/public-listings.server";

export type MessageListing = {
  propertyId: string;
  workspaceId: string;
  ownerUserId: string;
  propertyLabel: string;
  roomId: string | null;
  roomLabel: string | null;
};

export type MessageListingResult =
  | { ok: true; listing: MessageListing }
  | { ok: false; reason: "not_found" | "room_not_found" };

/**
 * The home (and room) a public message is about, re-derived from the database. The request names only ids: the
 * workspace and the owner come from the row, the home must be a LIVE listing outside any test namespace, and a room
 * must be one of THAT listing's rooms. Read only: the locked live listings are never written from here.
 */
export async function loadMessageListing(
  db: SupabaseClient,
  input: { propertyId: string; roomId: string | null },
): Promise<MessageListingResult> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, workspace_id, property_data, status, test_workspace_id")
    .eq("id", input.propertyId)
    .eq("status", "live")
    .is("test_workspace_id", null)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "not_found" };
  const row = data as Record<string, unknown>;
  const ownerUserId = String(row.manager_user_id ?? "").trim();
  if (!ownerUserId) return { ok: false, reason: "not_found" };
  const property = asProperty(row.property_data, String(row.id));
  if (!property) return { ok: false, reason: "not_found" };
  const workspaceId = await resolveWorkspaceForProperty(db, String(row.id), ownerUserId);
  if (!workspaceId) return { ok: false, reason: "not_found" };

  let roomId: string | null = null;
  let roomLabel: string | null = null;
  if (input.roomId) {
    const submission = property.listingSubmission;
    const rooms = submission && submission.v === 1 && Array.isArray(submission.rooms) ? submission.rooms : [];
    const room = rooms.find((r) => r && String(r.id) === input.roomId);
    if (!room) return { ok: false, reason: "room_not_found" };
    roomId = String(room.id);
    roomLabel = String(room.name ?? "").trim() || null;
  }
  return {
    ok: true,
    listing: {
      propertyId: String(row.id),
      workspaceId,
      ownerUserId,
      propertyLabel: property.buildingName || property.title || property.address,
      roomId,
      roomLabel,
    },
  };
}
