import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CO_MANAGER_PERMISSION_OPTIONS,
  type CoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

/**
 * The owner of record of a PropLane Service workspace sees EVERY page of that workspace, view only (captain's
 * decision 4 of `service-owner-1025`): houses, residents, rent, services, payouts.
 *
 * The seat itself is a `property_owner` row (owner keys only, no module grant), and nothing is written into it. The
 * wide reach is DERIVED here, at read time, from two server-side facts: the accepted seat is flagged
 * `is_owner_of_record` and its workspace is `is_service`. A demoted or removed owner (the flag cleared, the seat no
 * longer accepted, the workspace no longer a service workspace) resolves to nothing on the very next read.
 *
 * The derived grant is the READ level of every module on every house of the workspace. It never carries edit or
 * delete, and the managed read-only lock (`managedReadOnlyWorkspaceIds`: every accepted `property_owner` seat) still
 * refuses every write on top of it, the manager agent's included.
 *
 * Only readers that turn a viewer's seats into house and module ACCESS use this (`loadWorkspaces`, the linked
 * property and permission collectors, the linked-owner scope). Every teammate-style reader (recipients, team lists,
 * pickers, team chat) keeps `withoutOwnerLinks`, so the owner never appears as a teammate.
 */

export type DerivedServiceOwnerSeat = {
  /** `account_link_invites.id` of the seat. */
  id: string;
  /** The workspace owner (the manager whose houses these are). */
  inviter_user_id: string;
  invitee_user_id: string;
  workspace_id: string;
  team_role: "property_owner";
  house_scope: "all";
  assigned_property_ids: string[];
  property_co_manager_permissions: PropertyCoManagerPermissions;
  co_manager_permissions: CoManagerPermissions;
  workspace_permissions: Record<string, never>;
};

/** Every module at view: read, and no alerts (an owner is not an operational recipient). */
export function serviceOwnerViewGrant(): CoManagerPermissions {
  const grant: CoManagerPermissions = {};
  for (const { id } of CO_MANAGER_PERMISSION_OPTIONS) grant[id] = { read: true, notification: false };
  return grant;
}

/**
 * A project that predates the flag columns (or the table) has no such seat: that one error shape is an empty answer.
 * The SQLSTATE (or PostgREST code) decides it and nothing else - a message test also matched PostgREST's transient
 * "could not query the database for the schema cache", which would turn a hiccup into "this viewer has no seat" and
 * silently strip an owner of record of their whole workspace instead of failing the read.
 */
function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  const code = String(error?.code ?? "");
  return code === "42703" || code === "42P01" || code === "PGRST205" || code === "PGRST204";
}

/**
 * The viewer's derived owner-of-record seats on service workspaces. `strict` is for gates that act on the ABSENCE of
 * a grant: a failed read throws instead of reading as "no seat". A database that predates the flag columns has no
 * such seat, so that one error shape is an empty answer.
 */
export async function loadServiceOwnerSeats(
  db: SupabaseClient,
  userId: string,
  options: { strict?: boolean } = {},
): Promise<DerivedServiceOwnerSeat[]> {
  try {
    return await readServiceOwnerSeats(db, userId, options);
  } catch (error) {
    // The caller appends these to the viewer's ordinary links: a failure here must not discard those.
    if (options.strict) throw error;
    console.error("Service owner seat lookup failed.", { userId, message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

async function readServiceOwnerSeats(
  db: SupabaseClient,
  userId: string,
  options: { strict?: boolean },
): Promise<DerivedServiceOwnerSeat[]> {
  const uid = userId.trim();
  if (!uid) return [];
  const fail = (message: string): DerivedServiceOwnerSeat[] => {
    if (options.strict) throw new Error(message);
    console.error(message, { userId: uid });
    return [];
  };

  const seatsRes = await db
    .from("account_link_invites")
    .select("id, inviter_user_id, workspace_id")
    .eq("invitee_user_id", uid)
    .eq("status", "accepted")
    .eq("team_role", "property_owner")
    .eq("is_owner_of_record", true);
  if (seatsRes.error) return isMissingColumn(seatsRes.error) ? [] : fail("Service owner seat lookup failed.");
  const seats = ((seatsRes.data ?? []) as { id?: unknown; inviter_user_id?: unknown; workspace_id?: unknown }[])
    .map((s) => ({
      id: String(s.id ?? "").trim(),
      owner: String(s.inviter_user_id ?? "").trim(),
      workspaceId: String(s.workspace_id ?? "").trim(),
    }))
    .filter((s) => s.id && s.owner && s.workspaceId);
  if (seats.length === 0) return [];

  const workspacesRes = await db
    .from("portal_workspaces")
    .select("id, owner_user_id, is_service")
    .in("id", [...new Set(seats.map((s) => s.workspaceId))]);
  if (workspacesRes.error) return isMissingColumn(workspacesRes.error) ? [] : fail("Service owner workspace lookup failed.");
  const serviceOwnerByWorkspace = new Map<string, string>();
  for (const w of (workspacesRes.data ?? []) as { id?: unknown; owner_user_id?: unknown; is_service?: unknown }[]) {
    if (w.is_service === true) serviceOwnerByWorkspace.set(String(w.id ?? ""), String(w.owner_user_id ?? ""));
  }
  // The seat must have been written by the workspace's own owner (a seat can't be pointed at someone else's houses).
  const live = seats.filter((s) => serviceOwnerByWorkspace.get(s.workspaceId) === s.owner);
  if (live.length === 0) return [];

  const housesRes = await db
    .from("manager_property_records")
    .select("id, manager_user_id, workspace_id")
    .in("workspace_id", [...new Set(live.map((s) => s.workspaceId))]);
  if (housesRes.error) return fail("Service owner houses lookup failed.");
  const houses = (housesRes.data ?? []) as { id?: unknown; manager_user_id?: unknown; workspace_id?: unknown }[];

  return live.map((seat) => {
    const ids = [
      ...new Set(
        houses
          .filter((h) => String(h.workspace_id ?? "") === seat.workspaceId && String(h.manager_user_id ?? "") === seat.owner)
          .map((h) => String(h.id ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const perHouse: PropertyCoManagerPermissions = {};
    for (const id of ids) perHouse[id] = serviceOwnerViewGrant();
    return {
      id: seat.id,
      inviter_user_id: seat.owner,
      invitee_user_id: uid,
      workspace_id: seat.workspaceId,
      team_role: "property_owner" as const,
      house_scope: "all" as const,
      assigned_property_ids: ids,
      property_co_manager_permissions: perHouse,
      co_manager_permissions: serviceOwnerViewGrant(),
      workspace_permissions: {},
    };
  });
}
