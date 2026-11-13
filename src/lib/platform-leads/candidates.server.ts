import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelRoomCandidate } from "@/lib/channel-calendar/channel-listing-match";

type Row = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * EVERY room the workspace lists, as match candidates (a lead names its listing by an ad title, an address or a room, and
 * the prospect has no calendar connection to read it from). One candidate per room; a house with no structured rooms is one
 * whole-house candidate. Never throws: an unreadable table matches nothing, and the mail is still stored.
 */
export async function loadLeadRoomCandidates(db: SupabaseClient, input: { ownerUserId: string; workspaceId: string | null }): Promise<ChannelRoomCandidate[]> {
  try {
    let query = db.from("manager_property_records").select("id, workspace_id, property_data, row_data").eq("manager_user_id", input.ownerUserId).limit(300);
    if (input.workspaceId) query = query.eq("workspace_id", input.workspaceId);
    const { data, error } = await query;
    if (error) return [];
    const out: ChannelRoomCandidate[] = [];
    for (const raw of (data ?? []) as Row[]) {
      const property = (raw.property_data ?? raw.row_data ?? {}) as Row;
      const submission = (property.listingSubmission ?? {}) as Row;
      const propertyId = text(raw.id);
      const label = text(submission.buildingName) || text(property.buildingName) || text(property.title) || text(submission.address) || text(property.address) || propertyId;
      const adTitle = text(property.alsoListedAs) || null;
      const rooms = Array.isArray(submission.rooms) ? (submission.rooms as Row[]) : [];
      if (rooms.length === 0) {
        out.push({ propertyId, propertyLabel: label, roomId: propertyId, roomLabel: "Whole house", adTitle, reservationCodes: [] });
        continue;
      }
      rooms.forEach((room, index) => {
        const id = text(room.id);
        if (!id) return;
        out.push({ propertyId, propertyLabel: label, roomId: id, roomLabel: text(room.name) || `Room ${index + 1}`, adTitle, reservationCodes: [] });
      });
    }
    return out;
  } catch {
    return [];
  }
}
