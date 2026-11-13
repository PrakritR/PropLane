import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { phoneKeyOf } from "@/lib/sms/phone-key";
import type { ProspectContextInput } from "@/lib/prospect-spine/contracts";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export type HouseInfo = {
  id: string;
  label: string;
  workspaceId: string | null;
  ownerUserId: string;
  rooms: Array<{ id: string; label: string }>;
};

function houseFromRow(row: Row): HouseInfo {
  const data = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Row;
  const submission = (data.listingSubmission && typeof data.listingSubmission === "object" ? data.listingSubmission : {}) as Row;
  const rooms = Array.isArray(submission.rooms) ? (submission.rooms as Row[]) : [];
  return {
    id: str(row.id),
    label: str(data.buildingName) || str(data.address) || "",
    workspaceId: str(row.workspace_id) || null,
    ownerUserId: str(row.manager_user_id),
    rooms: rooms
      .map((room, index) => ({ id: str(room.id), label: str(room.name) || `Room ${index + 1}` }))
      .filter((room) => room.id),
  };
}

const HOUSE_COLUMNS = "id, manager_user_id, workspace_id, row_data";

/** One house by id. Null for none and for an unreadable row: the caller then writes the thread without a tag. */
export async function loadHouse(db: SupabaseClient, propertyId: string | null | undefined): Promise<HouseInfo | null> {
  const id = str(propertyId);
  if (!id) return null;
  try {
    const { data } = await db.from("manager_property_records").select(HOUSE_COLUMNS).eq("id", id).maybeSingle();
    return data ? houseFromRow(data as Row) : null;
  } catch {
    return null;
  }
}

/** Every house of one workspace (owner-scoped). */
export async function loadWorkspaceHouses(db: SupabaseClient, input: { workspaceId: string; ownerUserId: string }): Promise<HouseInfo[]> {
  try {
    const { data } = await db
      .from("manager_property_records")
      .select(HOUSE_COLUMNS)
      .eq("manager_user_id", input.ownerUserId)
      .eq("workspace_id", input.workspaceId)
      .limit(200);
    return ((data ?? []) as Row[]).map(houseFromRow);
  } catch {
    return [];
  }
}

/** "Room 4", "room #4", "rm 4", "bedroom 2" -> the room whose own label carries that number or letter. Ambiguity is no answer. */
export function roomFromText(text: string, rooms: ReadonlyArray<{ id: string; label: string }>): { id: string; label: string } | null {
  const match = /\b(?:room|rm|bedroom)\s*#?\s*(\d{1,2}|[a-z])\b/i.exec(String(text ?? ""));
  if (!match) return null;
  const token = match[1]!.toLowerCase();
  const hits = rooms.filter((room) => {
    const m = /\b(\d{1,2}|[a-z])\s*$/i.exec(room.label.trim());
    return m ? m[1]!.toLowerCase() === token : false;
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** The room of a house by its label (a resident's occupancy room name). */
export function roomByLabel(rooms: ReadonlyArray<{ id: string; label: string }>, label: string): { id: string; label: string } | null {
  const want = label.trim().toLowerCase();
  if (!want) return null;
  return rooms.find((room) => room.label.trim().toLowerCase() === want) ?? null;
}

/** A resident's CURRENT house and room: the occupancy snapshot (the Bookings reader), never a guess. Null when not a resident here. */
export async function residencyContext(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string; phoneE164: string },
): Promise<{ propertyId: string; roomLabel: string | null } | null> {
  try {
    const { findResidentCandidates } = await import("@/lib/one-number/router-lookups.server");
    const candidates = (await findResidentCandidates(db, input.phoneE164)).filter(
      (c) => c.workspaceId === input.workspaceId && c.ownerUserId === input.ownerUserId && c.propertyId,
    );
    const propertyIds = [...new Set(candidates.map((c) => c.propertyId as string))];
    if (propertyIds.length === 0) return null;
    const { loadHouseResidentCandidates } = await import("@/lib/house-groups/residents.server");
    const { pacificDayKey } = await import("@/lib/house-groups/time");
    const today = pacificDayKey(new Date());
    const key = phoneKeyOf(input.phoneE164);
    for (const propertyId of propertyIds) {
      const residents = await loadHouseResidentCandidates(db, { ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, propertyId, today }).catch(() => []);
      const me = residents.find((r) => r.phoneKey === key || phoneKeyOf(r.phoneE164) === key);
      if (me) return { propertyId, roomLabel: me.roomLabel || null };
    }
    // A resident of exactly one house whose room the snapshot could not name: the house alone, never a room guess.
    return propertyIds.length === 1 ? { propertyId: propertyIds[0]!, roomLabel: null } : null;
  } catch {
    return null;
  }
}

/**
 * Which house (and room) is this inbound about? Evidence only, in this order (design-1112 section 1.9 F2):
 *   1. the payload's property (a home lock or an entry code the router already honoured);
 *   2. a `(CODE)` / entry code in the body, when it belongs to this workspace;
 *   3. a house the text names (`identifyHome`: street number or the street's own words; ambiguity is no answer);
 *   4. the sender's current residency (property + room from the occupancy snapshot).
 * A room is the resident's own room, else "Room N" in the text for the chosen house. Nothing resolved = no property.
 */
export async function resolveInboundContext(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string; phoneE164: string; body: string; payloadPropertyId?: string | null },
): Promise<ProspectContextInput> {
  const empty: ProspectContextInput = { propertyId: null, source: "sms" };
  try {
    const phone = normalizeE164(input.phoneE164) ?? input.phoneE164;
    const houses = await loadWorkspaceHouses(db, { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId });
    const inWorkspace = (id: string | null | undefined) => (id ? houses.find((h) => h.id === id) ?? null : null);

    let chosen: HouseInfo | null = inWorkspace(input.payloadPropertyId?.trim());

    if (!chosen && input.body) {
      try {
        const { findEntryCodeCandidate } = await import("@/lib/one-number/router-lookups.server");
        const hit = await findEntryCodeCandidate(db, input.body);
        if (hit && hit.workspaceId === input.workspaceId) chosen = inWorkspace(hit.propertyId);
      } catch {
        /* a failed code lookup falls through to the next evidence */
      }
    }

    if (!chosen && input.body && houses.length > 0) {
      const { identifyHome } = await import("@/lib/prospect-replies/home-pick");
      // identifyHome only matches by the home's own words; the placeholder link satisfies its "sendable" filter and is never sent.
      const pick = identifyHome({
        message: input.body,
        homes: houses.filter((h) => h.label).map((h) => ({ propertyId: h.id, title: h.label, links: { listing: "https://proplane.app/match" } })),
      });
      if (pick.kind === "one" && pick.via === "named") chosen = inWorkspace(pick.home.propertyId);
    }

    const residency = await residencyContext(db, { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, phoneE164: phone });
    if (!chosen && residency) chosen = inWorkspace(residency.propertyId);
    if (!chosen) return empty;

    let room: { id: string; label: string } | null = null;
    if (residency && residency.propertyId === chosen.id && residency.roomLabel) {
      room = roomByLabel(chosen.rooms, residency.roomLabel) ?? { id: "", label: residency.roomLabel };
    }
    if (!room) room = roomFromText(input.body, chosen.rooms);
    return {
      propertyId: chosen.id,
      roomId: room?.id || null,
      roomLabel: room?.label || null,
      source: "sms",
    };
  } catch {
    return empty;
  }
}

/** The tag an alert or a thread header shows for a resolved context: "5259 Brooklyn Ave NE · Room 4", or null with no house. */
export async function contextTag(db: SupabaseClient, context: ProspectContextInput): Promise<string | null> {
  const house = await loadHouse(db, context.propertyId);
  if (!house?.label) return null;
  const { contextLabel } = await import("@/lib/prospect-spine/label");
  return contextLabel({ propertyLabel: house.label, roomLabel: context.roomLabel ?? null }) || null;
}
