import type { SupabaseClient } from "@supabase/supabase-js";

/** Accepted co-manager links where this user is the invitee (linked workspace, no owned rows). */
export async function getAcceptedCoManagerInviterIds(
  db: SupabaseClient,
  userId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<string[]> {
  const { data, error } = await db
    .from("account_link_invites")
    .select("inviter_user_id")
    .eq("invitee_user_id", userId)
    .eq("status", "accepted");
  if (error) {
    if (opts.throwOnError) throw new Error("Co-manager workspace links unavailable.");
    return [];
  }
  return [
    ...new Set(
      (data ?? [])
        .map((row) => String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export async function managerHasOwnedProperties(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id")
    .eq("manager_user_id", userId)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

/** Linked co-manager with no owned properties — still a full manager account for messaging setup. */
export async function isPureCoManagerWorkspace(
  db: SupabaseClient,
  userId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<boolean> {
  const { data, error } = await db.from("manager_property_records")
    .select("id").eq("manager_user_id", userId).limit(1);
  // Unknown ownership is not evidence of eligibility inherited from another account.
  if (error && opts.throwOnError) throw new Error("Co-manager workspace ownership unavailable.");
  if (error || (data ?? []).length > 0) return false;
  const inviters = await getAcceptedCoManagerInviterIds(db, userId, opts);
  return inviters.length > 0;
}

/**
 * The workspace a work number answers FOR.
 *
 * A work number belongs to the workspace, not to whoever provisioned it: every
 * member's line is the same front door, and a prospect texting it cannot tell
 * (and should not care) whether the owner or a co-manager set it up. For an
 * owner that is themselves. For a pure co-manager — linked, no owned houses —
 * it is the owner whose workspace they hold the most houses in, so tenant
 * records and listings stay with the property owner while the reply still
 * goes out from the line that was texted.
 */
export async function resolveWorkspaceOwnerForWorkNumber(
  db: SupabaseClient,
  numberOwnerUserId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<{ ownerUserId: string; sharedFromCoManager: boolean }> {
  if (!(await isPureCoManagerWorkspace(db, numberOwnerUserId, opts))) {
    return { ownerUserId: numberOwnerUserId, sharedFromCoManager: false };
  }
  const { data, error } = await db
    .from("account_link_invites")
    .select("inviter_user_id, assigned_property_ids")
    .eq("invitee_user_id", numberOwnerUserId)
    .eq("status", "accepted");
  if (error) {
    if (opts.throwOnError) throw new Error("Co-manager workspace links unavailable.");
    return { ownerUserId: numberOwnerUserId, sharedFromCoManager: false };
  }
  let best: { ownerUserId: string; houses: number } | null = null;
  for (const row of data ?? []) {
    const ownerUserId = String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim();
    if (!ownerUserId) continue;
    const assigned = (row as { assigned_property_ids?: unknown }).assigned_property_ids;
    const houses = Array.isArray(assigned) ? assigned.length : 0;
    if (!best || houses > best.houses) best = { ownerUserId, houses };
  }
  return best ? { ownerUserId: best.ownerUserId, sharedFromCoManager: true } : { ownerUserId: numberOwnerUserId, sharedFromCoManager: false };
}
