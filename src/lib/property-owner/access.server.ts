import "server-only";

import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { hasCoManagerPermissionLevel, type OwnerPermissionId } from "@/lib/co-manager-permissions";
import { stampTeamRoleOnProperties, withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import { effectiveHouseIds } from "@/lib/workspaces/membership";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { listManagedWorkspacesForOwner } from "@/lib/owner-management/policies.server";

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

/**
 * The PropLane Service workspaces `userId` still OWNS as a client (admin Service tab, "attach"): the owner of an
 * `is_service` workspace that is not the service owner's own IS its owner of record, so the owner portal reads their
 * workspace's books with no membership row. Read tolerantly: before the migration that adds `is_service` the read
 * errors and nobody qualifies, so every other account is unaffected. The service owner (who owns the workspaces
 * PropLane created) never qualifies.
 */
async function ownedServiceWorkspaceIds(db: SupabaseClient, uid: string): Promise<string[]> {
  const { data, error } = await db.from("portal_workspaces").select("id").eq("owner_user_id", uid).eq("is_service", true);
  if (error || !data || data.length === 0) return [];
  const settings = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  // Fail closed: if the service owner cannot be read we cannot tell the client from PropLane itself.
  if (settings.error) return [];
  if (String((settings.data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "") === uid) return [];
  return data.map((r) => String(r.id));
}

/** Every accepted Property owner membership of `userId`, with the houses it reaches right now. */
export async function loadOwnerGrants(db: SupabaseClient, userId: string): Promise<OwnerGrant[]> {
  const uid = userId.trim();
  if (!uid) return [];
  const ownServiceGrants = await loadOwnServiceWorkspaceGrants(db, uid);
  const { data: rows, error } = await db
    .from("account_link_invites")
    .select(`id, inviter_user_id, workspace_id, ${INVITE_PERMISSION_COLUMNS}`)
    .eq("invitee_user_id", uid)
    .eq("status", "accepted")
    // Strict equality: only an explicit property_owner row is an owner grant.
    .eq("team_role", "property_owner");
  if (error) throw new Error("Could not load owner access.");
  const links = rows ?? [];
  if (links.length === 0) return ownServiceGrants;

  // The owner of record of a PropLane Service workspace (admin Service tab) is an owner of EVERY house in that
  // workspace, including houses added after the invite. Read tolerantly: before the migration that adds the flag
  // the read errors and nobody is flagged, so every other owner is unaffected.
  const flaggedRes = await db
    .from("account_link_invites")
    .select("id")
    .eq("invitee_user_id", uid)
    .eq("status", "accepted")
    .eq("team_role", "property_owner")
    .eq("is_owner_of_record", true);
  const ownerOfRecordLinkIds = new Set(flaggedRes.error ? [] : (flaggedRes.data ?? []).map((r) => String(r.id)));

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
    const ownedIds = (owned ?? []).map((r) => String(r.id));
    const ofRecord = ownerOfRecordLinkIds.has(String(link.id)) && Boolean(workspaceId);
    const reach = effectiveHouseIds({
      // An owner is never "all houses": a legacy "all" row reaches only its
      // assigned houses, never the workspace's later-added ones. The owner of
      // record of a service workspace is the one exception (its whole workspace).
      houseScope: "selected",
      assignedPropertyIds: ofRecord ? [...new Set([...assigned, ...ownedIds])] : assigned,
      workspacePropertyIds: ownedIds,
    });

    // Forced to "selected" so the flat all-houses fallback never turns owner keys
    // on for a house with no per-house entry.
    const stored = readPropertyPermissionsFromRow({ ...link, house_scope: "selected" } as Parameters<typeof readPropertyPermissionsFromRow>[0]);
    // A house the owner of record picked up later has no entry yet: it starts from the owner default.
    const map = ofRecord
      ? { ...stampTeamRoleOnProperties("property_owner", reach.filter((id) => stored[id] === undefined), {}), ...stored }
      : stored;
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
  return [...grants, ...ownServiceGrants];
}

/**
 * One grant per PropLane Service workspace the user owns as its owner of record: every house of that workspace on
 * the owner defaults (Performance, Statements, Documents; Messages off - the owner is the manager of record there,
 * there is no thread to open). Resolved from the workspace row and the authenticated user id, never a request.
 */
async function loadOwnServiceWorkspaceGrants(db: SupabaseClient, uid: string): Promise<OwnerGrant[]> {
  const workspaceIds = await ownedServiceWorkspaceIds(db, uid);
  if (workspaceIds.length === 0) return [];
  const grants: OwnerGrant[] = [];
  for (const workspaceId of workspaceIds) {
    const { data, error } = await db.from("manager_property_records").select("id").eq("manager_user_id", uid).eq("workspace_id", workspaceId);
    if (error) throw new Error("Could not load owner houses.");
    grants.push({
      linkId: `workspace:${workspaceId}`,
      managerUserId: uid,
      houses: (data ?? []).map((r) => ({ propertyId: String(r.id), performance: true, statements: true, documents: true, messages: false })),
    });
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
 * Membership reads, memoized for the life of the client they were asked
 * through. One send asks the same questions twice - the recipient filter
 * (`filterRecipientsBySenderScope`) and the inbox re-scope
 * (`applyOwnerMessageInboxScope`) both decide "is this recipient my Property
 * owner?" - and `loadOwnerGrants` is 2 + one-per-link queries each time. The
 * service-role client is built per request, so keying on it keeps the memo
 * request-scoped and collectable, with a short TTL in case one is ever held
 * longer; a rejected read is dropped, never cached.
 */
type MemoEntry<T> = { at: number; value: Promise<T> };

/** A membership answer is reused for one burst of work, never for a later request. */
const MEMBERSHIP_MEMO_TTL_MS = 5_000;

function memoByClient<T>(
  store: WeakMap<object, Map<string, MemoEntry<T>>>,
  db: SupabaseClient,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  let byKey = store.get(db as unknown as object);
  if (!byKey) {
    byKey = new Map<string, MemoEntry<T>>();
    store.set(db as unknown as object, byKey);
  }
  const existing = byKey.get(key);
  if (existing && Date.now() - existing.at < MEMBERSHIP_MEMO_TTL_MS) return existing.value;
  const value = run().catch((error) => {
    byKey!.delete(key);
    throw error;
  });
  byKey.set(key, { at: Date.now(), value });
  return value;
}

const GRANTS_BY_CLIENT = new WeakMap<object, Map<string, MemoEntry<OwnerGrant[]>>>();
const OWNER_INVITEES_BY_CLIENT = new WeakMap<object, Map<string, MemoEntry<Set<string>>>>();

/** `loadOwnerGrants`, asked at most once per user per client. */
export function loadOwnerGrantsOnce(db: SupabaseClient, userId: string): Promise<OwnerGrant[]> {
  const uid = userId.trim();
  if (!uid) return Promise.resolve([]);
  return memoByClient(GRANTS_BY_CLIENT, db, uid, () => loadOwnerGrants(db, uid));
}

/**
 * Accepted Property owner memberships this manager granted, as invitee user
 * ids. A candidate list only: `managerMayMessageOwner` decides each one.
 */
export async function ownerInviteeIdsForManagers(db: SupabaseClient, managerIds: string[]): Promise<Set<string>> {
  const inviters = [...new Set(managerIds.map((id) => String(id ?? "").trim()).filter(Boolean))].sort();
  if (inviters.length === 0) return new Set<string>();
  return memoByClient(OWNER_INVITEES_BY_CLIENT, db, inviters.join("|"), async () => {
    const out = new Set<string>();
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
  });
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
  // `admin` is in the list because the team dogfoods on multi-role accounts:
  // the inviting manager of an owner membership can be an account whose
  // `profiles.role` is "admin", and the scope being corrected belongs to the
  // RECIPIENT, so the sender's own label must not decide it.
  const role = String(sender.role ?? "").trim().toLowerCase();
  if (!["manager", "owner", "pro", "admin"].includes(role)) return recipients;
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
    const grants = await loadOwnerGrantsOnce(db, owner);
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
  /** Owner of record of at least one PropLane-managed workspace (shows Finances). False on any read error. */
  financesOn: boolean;
};

const NONE: OwnerAccessState = { hasOwnerAccess: false, ownerOnly: false, messagesOn: false, financesOn: false };

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
  const [ownerRowsRes, ownedServiceIds] = await Promise.all([
    db
      .from("account_link_invites")
      .select("id, status")
      .eq("invitee_user_id", uid)
      .eq("team_role", "property_owner")
      .in("status", ["accepted", "cancelled"]),
    // The owner of record of a service workspace they still own is an owner too (their books are read-only to them).
    ownedServiceWorkspaceIds(db, uid),
  ]);
  const { data: ownerRows, error } = ownerRowsRes;
  // A read error is not "no owner row": answering NONE would hand an owner-only
  // account the manager shell and let `refuseOwnerOnly` wave it through. The
  // callers turn this into a denial (503 / no manager context), never access.
  if (error) throw new OwnerAccessUnavailableError();
  if ((!ownerRows || ownerRows.length === 0) && ownedServiceIds.length === 0) return NONE;
  const ownerOfRecordOfService = ownedServiceIds.length > 0;
  const hasActiveOwner = ownerOfRecordOfService || (ownerRows ?? []).some((r) => r.status === "accepted");

  const [own, teammate, purchase, roles] = await Promise.all([
    // An owner of record of a service workspace owns houses only there as far as this goes: their houses outside the
    // service still make them a manager. Everyone else needs just one house to decide.
    ownerOfRecordOfService
      ? db.from("manager_property_records").select("id, workspace_id").eq("manager_user_id", uid)
      : db.from("manager_property_records").select("id").eq("manager_user_id", uid).limit(1),
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
  const serviceIds = new Set(ownedServiceIds);
  const hasOwn = ownerOfRecordOfService
    ? (own.data ?? []).some((h) => !serviceIds.has(String((h as { workspace_id?: unknown }).workspace_id ?? "")))
    : (own.data ?? []).length > 0;
  const hasTeammate = (teammate.data ?? []).length > 0;
  // A managed client's plan row does not make them a manager: PropLane Service runs their workspace.
  const hasPurchase = !ownerOfRecordOfService && (purchase.data ?? []).length > 0;
  const isAdmin = (roles.data ?? []).some((r) => String(r.role).toLowerCase() === "admin");
  const ownerOnly = !hasOwn && !hasTeammate && !hasPurchase && !isAdmin;

  let messagesOn = false;
  try {
    const grants = await loadOwnerGrants(db, uid);
    messagesOn = grantedHouses(grants, "messages").length > 0;
  } catch {
    messagesOn = false;
  }
  // Finances shows in the owner shell only for an owner-only account; anyone else reaches it by its URL or the manager nav.
  let financesOn = false;
  if (hasActiveOwner || ownerOnly) {
    try {
      financesOn = (await listManagedWorkspacesForOwner(db, uid)).length > 0;
    } catch {
      financesOn = false;
    }
  }
  return { hasOwnerAccess: hasActiveOwner, ownerOnly, messagesOn, financesOn };
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
  } catch (error) {
    // Denying is right, but silently denying every manager route during an
    // `account_link_invites` outage would present as a bare 401/404 with
    // nothing to point at the cause. Class, message and the user id only.
    console.error(
      "[security] owner_membership_unreadable: withholding the manager surface",
      JSON.stringify({
        userId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    );
    return true;
  }
}
