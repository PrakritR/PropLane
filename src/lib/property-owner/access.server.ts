import "server-only";

import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { hasCoManagerPermissionLevel, type OwnerPermissionId } from "@/lib/co-manager-permissions";
import { NOT_PROPERTY_OWNER_LINK_FILTER } from "@/lib/co-manager-team-roles";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import { parseHouseScope, effectiveHouseIds } from "@/lib/workspaces/membership";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * Who is a Property owner, and over which houses.
 *
 * An owner is an accepted `account_link_invites` row with `team_role =
 * 'property_owner'`. Everything here is resolved from THAT row and the
 * authenticated user id, never from a request parameter: the houses, the
 * manager whose books they come from and which of the four owner keys are on
 * are all read from the membership. A request may only NARROW to a house the
 * membership already grants.
 */

export type OwnerHouseGrant = {
  propertyId: string;
  performance: boolean;
  statements: boolean;
  documents: boolean;
  messages: boolean;
};

export type OwnerGrant = {
  linkId: string;
  /** The manager (workspace owner) whose books the owner reads. Never sent to the browser. */
  managerUserId: string;
  houses: OwnerHouseGrant[];
};

const KEY_BY_FIELD: Record<Exclude<keyof OwnerHouseGrant, "propertyId">, OwnerPermissionId> = {
  performance: "ownerPerformance",
  statements: "ownerStatements",
  documents: "ownerDocuments",
  messages: "ownerMessages",
};

/** Every accepted Property owner membership of `userId`, with the houses it reaches right now. */
export async function loadOwnerGrants(db: SupabaseClient, userId: string): Promise<OwnerGrant[]> {
  const uid = userId.trim();
  if (!uid) return [];
  const { data: rows, error } = await db
    .from("account_link_invites")
    .select(`id, inviter_user_id, workspace_id, ${INVITE_PERMISSION_COLUMNS}`)
    .eq("invitee_user_id", uid)
    .eq("status", "accepted")
    // Strict equality: only an explicit property_owner row is an owner grant.
    .eq("team_role", "property_owner");
  if (error) throw new Error("Could not load owner access.");
  const links = rows ?? [];
  if (links.length === 0) return [];

  const inviterIds = [...new Set(links.map((l) => String(l.inviter_user_id ?? "").trim()).filter(Boolean))];
  const { data: profiles } = await db.from("profiles").select("id, email").in("id", [uid, ...inviterIds]);
  const emailById = new Map((profiles ?? []).map((p) => [String(p.id), String(p.email ?? "")]));

  const grants: OwnerGrant[] = [];
  for (const link of links) {
    const managerUserId = String(link.inviter_user_id ?? "").trim();
    if (!managerUserId) continue;
    if (isCrossSandboxPortalPair(emailById.get(uid) ?? "", emailById.get(managerUserId) ?? "")) continue;

    const assigned = Array.isArray(link.assigned_property_ids) ? link.assigned_property_ids.map(String) : [];
    const workspaceId = String(link.workspace_id ?? "").trim();
    // The manager's houses in this membership's workspace (or, for an older row
    // with no workspace, the assigned ids the manager actually owns).
    let query = db.from("manager_property_records").select("id").eq("manager_user_id", managerUserId);
    if (workspaceId) query = query.eq("workspace_id", workspaceId);
    else if (assigned.length > 0) query = query.in("id", assigned);
    const { data: owned, error: ownedError } = assigned.length === 0 && !workspaceId ? { data: [], error: null } : await query;
    if (ownedError) throw new Error("Could not load owner houses.");
    const reach = effectiveHouseIds({
      houseScope: parseHouseScope(link.house_scope),
      assignedPropertyIds: assigned,
      workspacePropertyIds: (owned ?? []).map((r) => String(r.id)),
    });

    const map = readPropertyPermissionsFromRow(link as Parameters<typeof readPropertyPermissionsFromRow>[0]);
    const houses: OwnerHouseGrant[] = [];
    for (const propertyId of reach) {
      const perms = map[propertyId];
      const grant: OwnerHouseGrant = {
        propertyId,
        performance: hasCoManagerPermissionLevel(perms, KEY_BY_FIELD.performance, "read"),
        statements: hasCoManagerPermissionLevel(perms, KEY_BY_FIELD.statements, "read"),
        documents: hasCoManagerPermissionLevel(perms, KEY_BY_FIELD.documents, "read"),
        messages: hasCoManagerPermissionLevel(perms, KEY_BY_FIELD.messages, "read"),
      };
      // A house with nothing on is not a grant at all.
      if (grant.performance || grant.statements || grant.documents || grant.messages) houses.push(grant);
    }
    grants.push({ linkId: String(link.id), managerUserId, houses });
  }
  return grants;
}

/** Houses (across memberships) where `field` is on, with the manager each belongs to. */
export function grantedHouses(
  grants: OwnerGrant[],
  field: Exclude<keyof OwnerHouseGrant, "propertyId">,
): { propertyId: string; managerUserId: string }[] {
  const out: { propertyId: string; managerUserId: string }[] = [];
  const seen = new Set<string>();
  for (const grant of grants) {
    for (const house of grant.houses) {
      if (!house[field] || seen.has(house.propertyId)) continue;
      seen.add(house.propertyId);
      out.push({ propertyId: house.propertyId, managerUserId: grant.managerUserId });
    }
  }
  return out;
}

export type OwnerAccessState = {
  /** Has at least one accepted Property owner membership. */
  hasOwnerAccess: boolean;
  /**
   * Has owner memberships and NOTHING else: no houses of their own, no teammate
   * membership, no manager plan. Such an account is shown only the owner portal
   * and is refused by the manager APIs.
   */
  ownerOnly: boolean;
  /** Messages is on for at least one granted house. */
  messagesOn: boolean;
};

const NONE: OwnerAccessState = { hasOwnerAccess: false, ownerOnly: false, messagesOn: false };

async function resolveOwnerAccessState(db: SupabaseClient, userId: string): Promise<OwnerAccessState> {
  const uid = userId.trim();
  if (!uid) return NONE;
  // One cheap read decides the overwhelmingly common case (a manager): no owner row.
  const { count, error } = await db
    .from("account_link_invites")
    .select("id", { count: "exact", head: true })
    .eq("invitee_user_id", uid)
    .eq("status", "accepted")
    .eq("team_role", "property_owner");
  if (error || !count) return NONE;

  const [own, teammate, purchase, roles] = await Promise.all([
    db.from("manager_property_records").select("id").eq("manager_user_id", uid).limit(1),
    db
      .from("account_link_invites")
      .select("id")
      .eq("invitee_user_id", uid)
      .eq("status", "accepted")
      .or(NOT_PROPERTY_OWNER_LINK_FILTER)
      .limit(1),
    db.from("manager_purchases").select("id").eq("user_id", uid).limit(1),
    db.from("profile_roles").select("role").eq("user_id", uid),
  ]);
  // Fail closed in the direction that withholds MANAGER surface: a read error is
  // treated as "has something else" only when it is certain; unknown stays
  // owner-only so an owner is never handed the manager shell by an outage.
  const hasOwn = (own.data ?? []).length > 0;
  const hasTeammate = (teammate.data ?? []).length > 0;
  const hasPurchase = (purchase.data ?? []).length > 0;
  const isAdmin = (roles.data ?? []).some((r) => String(r.role).toLowerCase() === "admin");
  const ownerOnly = !hasOwn && !hasTeammate && !hasPurchase && !isAdmin;

  let messagesOn = false;
  try {
    const grants = await loadOwnerGrants(db, uid);
    messagesOn = grantedHouses(grants, "messages").length > 0;
  } catch {
    messagesOn = false;
  }
  return { hasOwnerAccess: true, ownerOnly, messagesOn };
}

/** Request-cached for server components (layout + page ask the same question). */
export const getOwnerAccessState = cache(async (userId: string): Promise<OwnerAccessState> =>
  resolveOwnerAccessState(createSupabaseServiceRoleClient(), userId),
);

/** Uncached form for API routes that already hold a service client. */
export async function ownerAccessStateFor(db: SupabaseClient, userId: string): Promise<OwnerAccessState> {
  return resolveOwnerAccessState(db, userId);
}
