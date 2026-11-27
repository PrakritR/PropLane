import "server-only";

import { asStringArray, INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { hasCoManagerPermissionLevelForProperty } from "@/lib/co-manager-permissions";
import type { SupabaseClient } from "@supabase/supabase-js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * WS4(shared-avail): every manager who MAY host a tour on this property — the
 * owner, plus every accepted co-manager assigned to it who holds `calendar` or
 * `applications` at `edit`.
 *
 * This is the enumeration counterpart to `managerMayHostPropertyTour`
 * (`public-tour-booking-guard.ts`), which only answers "may THIS ONE manager
 * host" — `listOpenTourSlots` needs the whole roster so a co-manager's painted
 * availability can be unioned into what the public grid offers, and
 * `createTourInquiry` needs it so the set that can SEE a pending request
 * matches the set that can CLAIM it. Before this moved server-side, the only
 * forward enumeration was `listPropertyCalendarPeers` — a CLIENT module
 * (`co-manager-calendar.ts`) reading browser/demo storage, unusable from here.
 *
 * `managerMayHostPropertyTour` now delegates its co-manager half to this
 * function so the single-candidate check and the full roster can never drift.
 *
 * Any failure to read the link table degrades to owner-only — a widened host
 * roster is a widened surface for taking a stranger to somebody's house, so an
 * unreadable grant table must never be read as "everyone qualifies".
 */
export async function listPropertyTourHostUserIds(
  db: SupabaseClient,
  input: { propertyId: string; ownerUserId: string },
): Promise<string[]> {
  try {
    return await listPropertyTourHostUserIdsOrThrow(db, input);
  } catch {
    // The link table may not exist in every environment; absent grants widen nothing.
    const ownerUserId = input.ownerUserId.trim();
    return ownerUserId ? [ownerUserId] : [];
  }
}

/** The same roster, but an unreadable link table throws instead of narrowing to the owner. */
export async function listPropertyTourHostUserIdsOrThrow(
  db: SupabaseClient,
  input: { propertyId: string; ownerUserId: string },
): Promise<string[]> {
  const propertyId = input.propertyId.trim();
  const ownerUserId = input.ownerUserId.trim();
  const hosts = new Set<string>();
  if (ownerUserId) hosts.add(ownerUserId);
  if (!propertyId || !ownerUserId) return [...hosts];

  const { data: links, error } = await db
    .from("account_link_invites")
    .select(`invitee_user_id, ${INVITE_PERMISSION_COLUMNS}`)
    .eq("status", "accepted")
    .eq("inviter_user_id", ownerUserId);

  if (error) throw new Error("account_link_invites unreadable");

  for (const row of links ?? []) {
    const inviteeUserId = linkHostForProperty(row, propertyId);
    if (inviteeUserId) hosts.add(inviteeUserId);
  }

  return [...hosts];
}

/** The invitee of an accepted link row when it lets them host a tour on `propertyId`, else "". */
function linkHostForProperty(row: unknown, propertyId: string): string {
  const inviteeUserId = text((row as { invitee_user_id?: unknown }).invitee_user_id);
  if (!inviteeUserId) return "";
  if (!asStringArray((row as { assigned_property_ids?: unknown }).assigned_property_ids).includes(propertyId)) return "";
  const permissions = readPropertyPermissionsFromRow(row as Parameters<typeof readPropertyPermissionsFromRow>[0]);
  const mayAct =
    hasCoManagerPermissionLevelForProperty(permissions, propertyId, "calendar", "edit") ||
    hasCoManagerPermissionLevelForProperty(permissions, propertyId, "applications", "edit");
  return mayAct ? inviteeUserId : "";
}

/**
 * The same roster for many houses (house id -> owner id) in ONE link-table read across their owners. An unreadable
 * link table throws.
 */
export async function listTourHostUserIdsByHouseOrThrow(
  db: SupabaseClient,
  ownersByHouse: ReadonlyMap<string, string>,
): Promise<Map<string, Set<string>>> {
  const roster = new Map<string, { ownerUserId: string; hosts: Set<string> }>();
  for (const [house, owner] of ownersByHouse) {
    const propertyId = house.trim();
    const ownerUserId = owner.trim();
    if (!propertyId) continue;
    roster.set(propertyId, { ownerUserId, hosts: new Set(ownerUserId ? [ownerUserId] : []) });
  }
  const owners = [...new Set([...roster.values()].map((entry) => entry.ownerUserId).filter(Boolean))];
  if (owners.length > 0) {
    const { data: links, error } = await db
      .from("account_link_invites")
      .select(`inviter_user_id, invitee_user_id, ${INVITE_PERMISSION_COLUMNS}`)
      .eq("status", "accepted")
      .in("inviter_user_id", owners);
    if (error) throw new Error("account_link_invites unreadable");
    for (const row of links ?? []) {
      const inviter = text((row as { inviter_user_id?: unknown }).inviter_user_id);
      if (!inviter) continue;
      for (const [propertyId, entry] of roster) {
        if (entry.ownerUserId !== inviter) continue;
        const host = linkHostForProperty(row, propertyId);
        if (host) entry.hosts.add(host);
      }
    }
  }
  return new Map([...roster].map(([propertyId, entry]) => [propertyId, entry.hosts]));
}
