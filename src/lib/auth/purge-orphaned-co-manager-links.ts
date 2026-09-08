import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAxisId(value: unknown): string {
  return normalize(value).toLowerCase();
}

export type ManagerAccountIndex = {
  userIds: Set<string>;
  axisIds: Set<string>;
  axisIdByUserId: Map<string, string>;
};

/** Valid property-portal manager accounts keyed by user id and Axis ID (profiles.manager_id). */
export async function loadManagerAccountIndex(db: ServiceDb): Promise<ManagerAccountIndex> {
  const userIds = new Set<string>();
  const axisIds = new Set<string>();
  const axisIdByUserId = new Map<string, string>();

  const { data: roleRows } = await db.from("profile_roles").select("user_id, role").in("role", ["manager", "owner"]);
  for (const row of roleRows ?? []) {
    const id = normalize(row.user_id);
    if (id) userIds.add(id);
  }

  const { data: legacyRows } = await db.from("profiles").select("id, role, manager_id").in("role", ["manager", "owner"]);
  for (const row of legacyRows ?? []) {
    const id = normalize(row.id);
    if (id) userIds.add(id);
    const axisId = normalizeAxisId(row.manager_id);
    if (id && axisId) {
      axisIds.add(axisId);
      axisIdByUserId.set(id, axisId);
    }
  }

  if (userIds.size > 0) {
    const { data: profiles } = await db.from("profiles").select("id, manager_id").in("id", [...userIds]);
    for (const row of profiles ?? []) {
      const id = normalize(row.id);
      const axisId = normalizeAxisId(row.manager_id);
      if (id && axisId) {
        axisIds.add(axisId);
        axisIdByUserId.set(id, axisId);
      }
    }
  }

  return { userIds, axisIds, axisIdByUserId };
}

function linkedAxisIdFromRowData(rowData: unknown): string {
  if (!rowData || typeof rowData !== "object") return "";
  return normalizeAxisId((rowData as Record<string, unknown>).linkedAxisId);
}

export function isOrphanCoManagerRelationship(
  record: { related_user_id?: unknown; row_data?: unknown },
  index: ManagerAccountIndex,
): boolean {
  const relatedUserId = normalize(record.related_user_id);
  if (relatedUserId && !index.userIds.has(relatedUserId)) return true;

  const linkedAxisId = linkedAxisIdFromRowData(record.row_data);
  if (linkedAxisId && !index.axisIds.has(linkedAxisId)) return true;

  return false;
}

function isOrphanCoManagerInvite(
  invite: { invitee_user_id?: unknown; invitee_axis_id?: unknown; inviter_user_id?: unknown; inviter_axis_id?: unknown },
  index: ManagerAccountIndex,
): boolean {
  const inviteeUserId = normalize(invite.invitee_user_id);
  const inviterUserId = normalize(invite.inviter_user_id);
  if (inviteeUserId && !index.userIds.has(inviteeUserId)) return true;
  if (inviterUserId && !index.userIds.has(inviterUserId)) return true;

  const inviteeAxisId = normalizeAxisId(invite.invitee_axis_id);
  const inviterAxisId = normalizeAxisId(invite.inviter_axis_id);
  if (inviteeAxisId && !index.axisIds.has(inviteeAxisId)) return true;
  if (inviterAxisId && !index.axisIds.has(inviterAxisId)) return true;

  return false;
}

/** Remove co-manager links that reference deleted or invalid manager accounts. */
export async function purgeOrphanedCoManagerLinks(
  db: ServiceDb,
  opts?: { managerUserId?: string | null },
): Promise<{ deleted: Record<string, number> }> {
  const managerUserId = normalize(opts?.managerUserId);
  const index = await loadManagerAccountIndex(db);
  const deleted: Record<string, number> = {
    portal_pro_relationship_records: 0,
    account_link_invites: 0,
  };

  let relationshipQuery = db.from("portal_pro_relationship_records").select("id, manager_user_id, related_user_id, row_data");
  if (managerUserId) relationshipQuery = relationshipQuery.eq("manager_user_id", managerUserId) as typeof relationshipQuery;
  const { data: relationships } = await relationshipQuery;

  const relationshipIds = (relationships ?? [])
    .filter((record) => isOrphanCoManagerRelationship(record, index))
    .map((record) => normalize(record.id))
    .filter(Boolean);

  if (relationshipIds.length > 0) {
    await db.from("portal_pro_relationship_records").delete().in("id", relationshipIds);
  }
  deleted.portal_pro_relationship_records = relationshipIds.length;

  let inviteQuery = db
    .from("account_link_invites")
    .select("id, inviter_user_id, invitee_user_id, inviter_axis_id, invitee_axis_id, status")
    .in("status", ["pending", "accepted"]);
  if (managerUserId) {
    inviteQuery = inviteQuery.or(`inviter_user_id.eq.${managerUserId},invitee_user_id.eq.${managerUserId}`) as typeof inviteQuery;
  }
  const { data: invites } = await inviteQuery;

  const inviteIds = (invites ?? [])
    .filter((invite) => isOrphanCoManagerInvite(invite, index))
    .map((invite) => normalize(invite.id))
    .filter(Boolean);

  if (inviteIds.length > 0) {
    await db.from("account_link_invites").delete().in("id", inviteIds);
  }
  deleted.account_link_invites = inviteIds.length;

  return { deleted };
}

/** Remove references to a deleted manager from every other workspace. */
export async function purgeCoManagerReferencesToUser(db: ServiceDb, managerUserId: string): Promise<void> {
  const id = normalize(managerUserId);
  if (!id) return;

  const { data: profile, error: profileError } = await db.from("profiles").select("manager_id").eq("id", id).maybeSingle();
  if (profileError) throw new Error(profileError.message);
  const axisId = normalizeAxisId(profile?.manager_id);
  const check = (result: { error: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
  };
  check(await db.from("portal_pro_relationship_records").delete().eq("related_user_id", id));
  if (axisId) {
    check(await db.from("portal_pro_relationship_records").delete().filter("row_data->>linkedAxisId", "eq", axisId));
  }
  check(await db.from("account_link_invites").delete().eq("invitee_user_id", id));
  check(await db.from("account_link_invites").delete().eq("inviter_user_id", id));
}
