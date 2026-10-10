import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";

/**
 * Who may speak for a house's occupancy: property id -> the user ids whose rows count there.
 *
 * Occupancy is read by PROPERTY, not by `manager_user_id` (a co-manager's resident still holds the
 * owner's room). That left the stamp unchecked, so a row any manager wrote naming a house they do
 * not manage published that house's rooms as occupied. A row counts for a house only when its
 * author is that house's owner or a teammate the owner linked to it (accepted membership that
 * assigns the house). A property-owner (investor) link is never an author.
 */
export type OccupancyAuthors = Map<string, Set<string>>;

const ID_CHUNK = 100;

export async function loadOccupancyAuthors(db: SupabaseClient, propertyIds: readonly string[]): Promise<OccupancyAuthors> {
  const ids = [...new Set(propertyIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  const authors: OccupancyAuthors = new Map();
  if (ids.length === 0) return authors;
  const ownerByProperty = new Map<string, string>();
  for (let at = 0; at < ids.length; at += ID_CHUNK) {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, manager_user_id")
      .in("id", ids.slice(at, at + ID_CHUNK));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ id?: unknown; manager_user_id?: unknown }>) {
      const id = String(row.id ?? "").trim();
      const owner = String(row.manager_user_id ?? "").trim();
      if (!id || !owner) continue;
      ownerByProperty.set(id, owner);
      authors.set(id, new Set([owner]));
    }
  }
  const owners = [...new Set(ownerByProperty.values())];
  for (let at = 0; at < owners.length; at += ID_CHUNK) {
    const { data, error } = withoutOwnerLinks(
      await db
        .from("account_link_invites")
        .select("inviter_user_id, invitee_user_id, assigned_property_ids, team_role")
        .eq("status", "accepted")
        .in("inviter_user_id", owners.slice(at, at + ID_CHUNK)),
    );
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{
      inviter_user_id?: unknown;
      invitee_user_id?: unknown;
      assigned_property_ids?: unknown;
    }>) {
      const inviter = String(row.inviter_user_id ?? "").trim();
      const invitee = String(row.invitee_user_id ?? "").trim();
      if (!inviter || !invitee || !Array.isArray(row.assigned_property_ids)) continue;
      for (const assigned of row.assigned_property_ids) {
        const propertyId = typeof assigned === "string" ? assigned.trim() : "";
        // The link only reaches a house its own inviter owns.
        if (propertyId && ownerByProperty.get(propertyId) === inviter) authors.get(propertyId)?.add(invitee);
      }
    }
  }
  return authors;
}

/**
 * Whether a row stamped `managerUserId` may hold a room of `propertyId`. A row with no stamp is a
 * legacy row no writer can produce any more (every manager write stamps the owner or the writer).
 */
export function occupancyAuthorTrusted(
  authors: OccupancyAuthors,
  propertyId: string,
  managerUserId: unknown,
): boolean {
  const author = String(managerUserId ?? "").trim();
  if (!author) return true;
  return authors.get(propertyId.trim())?.has(author) === true;
}
