import "server-only";

import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { hasCoManagerPermissionLevel, type OwnerPermissionId } from "@/lib/co-manager-permissions";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
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

/**
 * Accepted Property owner memberships this manager granted, as invitee user
 * ids. A candidate list only: `managerMayMessageOwner` decides each one.
 */
export async function ownerInviteeIdsForManagers(db: SupabaseClient, managerIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const inviters = [...new Set(managerIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (inviters.length === 0) return out;
  const { data, error } = await db
    .from("account_link_invites")
    .select("invitee_user_id, team_role")
    .in("inviter_user_id", inviters)
    .eq("status", "accepted")
    .eq("team_role", "property_owner");
  if (error) return out;
  for (const row of (data ?? []) as { invitee_user_id?: unknown }[]) {
    const id = String(row.invitee_user_id ?? "").trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * The inbox scope the owner Messages page reads
 * (`loadOwnerConversations`). The owner's copy of a manager's reply must be
 * written HERE, whatever the legacy singular `profiles.role` column says: an
 * owner who signed up as a resident years ago still keeps
 * `profiles.role = "resident"`, and `scopeForRole` would file the reply in
 * their resident inbox, where the owner portal never looks. It is the manager
 * scope on purpose - reading the manager INBOX PAGE is refused separately
 * (`refuseOwnerOnly` on `/api/portal-inbox-threads`).
 */
export const OWNER_MESSAGE_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

/**
 * Of these recipient user ids, the ones that are Property owners of the
 * sending manager's OWN membership with Messages on. Resolved from the
 * membership, never from a request or from `profiles.role`.
 */
export async function ownerMessagingRecipientIdsForManager(
  db: SupabaseClient,
  managerUserId: string,
  recipientUserIds: (string | null | undefined)[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const manager = String(managerUserId ?? "").trim();
  const ids = [...new Set(recipientUserIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (!manager || ids.length === 0) return out;
  const candidates = await ownerInviteeIdsForManagers(db, [manager]);
  if (candidates.size === 0) return out;
  for (const id of ids) {
    if (!candidates.has(id)) continue;
    if (await managerMayMessageOwner(db, manager, id)) out.add(id);
  }
  return out;
}

/**
 * Re-scope the inbox copy of any recipient who is a Property owner of this
 * sender's own membership. Every other recipient is returned untouched, so a
 * resident stays in the resident scope and a vendor in the vendor scope.
 */
export async function applyOwnerMessageInboxScope<T extends { userId: string | null; scope: string }>(
  db: SupabaseClient,
  sender: { userId: string; role: string | null | undefined },
  recipients: T[],
): Promise<T[]> {
  const role = String(sender.role ?? "").trim().toLowerCase();
  if (!["manager", "owner", "pro"].includes(role)) return recipients;
  const owners = await ownerMessagingRecipientIdsForManager(db, sender.userId, recipients.map((r) => r.userId));
  if (owners.size === 0) return recipients;
  return recipients.map((recipient) =>
    recipient.userId && owners.has(recipient.userId) ? { ...recipient, scope: OWNER_MESSAGE_INBOX_SCOPE } : recipient,
  );
}

/**
 * May this manager write to this Property owner's thread? Only when the owner's
 * OWN membership has Messages on for a house of this manager's. Resolved from
 * the membership (`loadOwnerGrants`), never from the request: it is the mirror
 * of `sendOwnerMessage`, so the thread the owner opened can be answered and
 * nothing else about the owner is reachable.
 */
export async function managerMayMessageOwner(
  db: SupabaseClient,
  managerUserId: string,
  ownerUserId: string,
): Promise<boolean> {
  const manager = managerUserId.trim();
  const owner = ownerUserId.trim();
  if (!manager || !owner) return false;
  try {
    const grants = await loadOwnerGrants(db, owner);
    return grantedHouses(grants, "messages").some((house) => house.managerUserId === manager);
  } catch {
    return false;
  }
}

export type OwnerAccessState = {
  /** Has at least one accepted (not revoked) Property owner membership. */
  hasOwnerAccess: boolean;
  /**
   * Signed up through an owner invite (membership active or since revoked) and has NOTHING else: no houses of their own, no teammate
   * membership, no manager plan. Such an account is shown only the owner portal
   * and is refused by the manager APIs.
   */
  ownerOnly: boolean;
  /** Messages is on for at least one granted house. */
  messagesOn: boolean;
};

const NONE: OwnerAccessState = { hasOwnerAccess: false, ownerOnly: false, messagesOn: false };

/** The owner membership could not be read, so nothing may be decided from it. */
export class OwnerAccessUnavailableError extends Error {
  constructor() {
    super("Could not verify your account.");
    this.name = "OwnerAccessUnavailableError";
  }
}

async function resolveOwnerAccessState(db: SupabaseClient, userId: string): Promise<OwnerAccessState> {
  const uid = userId.trim();
  if (!uid) return NONE;
  // One cheap read decides the overwhelmingly common case (a manager): no owner row.
  // Owner ORIGIN is any accepted or since-revoked (`cancelled`) owner row: a
  // revoked owner keeps the manager role row from owner sign-up, and must stay
  // owner-only (an empty owner portal) rather than fall into the manager shell.
  // Pending / declined rows prove nothing and never count.
  const { data: ownerRows, error } = await db
    .from("account_link_invites")
    .select("id, status")
    .eq("invitee_user_id", uid)
    .eq("team_role", "property_owner")
    .in("status", ["accepted", "cancelled"]);
  // A read error is not "no owner row": answering NONE would hand an owner-only
  // account the manager shell and let `refuseOwnerOnly` wave it through. The
  // callers turn this into a denial (503 / no manager context), never access.
  if (error) throw new OwnerAccessUnavailableError();
  if (!ownerRows || ownerRows.length === 0) return NONE;
  const hasActiveOwner = ownerRows.some((r) => r.status === "accepted");

  const [own, teammate, purchase, roles] = await Promise.all([
    db.from("manager_property_records").select("id").eq("manager_user_id", uid).limit(1),
    // No `.limit`: the owner rows are filtered out of the result, so a limit of 1
    // could be spent on one of them and hide a real teammate row behind it.
    db
      .from("account_link_invites")
      .select("id, team_role")
      .eq("invitee_user_id", uid)
      .eq("status", "accepted")
      .then((r) => withoutOwnerLinks(r)),
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
  return { hasOwnerAccess: hasActiveOwner, ownerOnly, messagesOn };
}

/** Request-cached for server components (layout + page ask the same question). */
export const getOwnerAccessState = cache(async (userId: string): Promise<OwnerAccessState> =>
  resolveOwnerAccessState(createSupabaseServiceRoleClient(), userId),
);

/** Uncached form for API routes that already hold a service client. */
export async function ownerAccessStateFor(db: SupabaseClient, userId: string): Promise<OwnerAccessState> {
  return resolveOwnerAccessState(db, userId);
}

/**
 * "Withhold the manager surface from this account?" - true for an owner-only
 * account AND for a membership that could not be read at all. Every
 * manager-side caller asks this instead of reading `ownerOnly` directly, so a
 * transient `account_link_invites` failure denies rather than either handing
 * over the manager surface or throwing an uncaught error into a page render.
 * The callers that must tell the two apart (`refuseOwnerOnly`: 403 vs 503)
 * catch `OwnerAccessUnavailableError` themselves.
 */
export async function withholdManagerSurface(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    return (await ownerAccessStateFor(db, userId)).ownerOnly;
  } catch {
    return true;
  }
}
