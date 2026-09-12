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
 * A work number belongs to the workspace, not to whoever provisioned it. For an
 * owner that is themselves. For a pure co-manager — linked, no owned houses —
 * it is the owner whose workspace they hold the most houses in, so tenant
 * records and listings stay with the property owner and a prospect texting the
 * line cannot tell whether a manager or a co-manager is behind it.
 */
export async function resolveWorkspaceOwnerForWorkNumber(
  db: SupabaseClient,
  numberOwnerUserId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<{ ownerUserId: string; sharedFromCoManager: boolean }> {
  if (!(await isPureCoManagerWorkspace(db, numberOwnerUserId, opts))) {
    return { ownerUserId: numberOwnerUserId, sharedFromCoManager: false };
  }
  const owners = await listWorkspaceOwnersForCoManager(db, numberOwnerUserId, opts);
  const best = owners[0];
  return best
    ? { ownerUserId: best.ownerUserId, sharedFromCoManager: true }
    : { ownerUserId: numberOwnerUserId, sharedFromCoManager: false };
}

/**
 * Every workspace a co-manager belongs to, most houses first. Order matters:
 * it is the tie-break for which workspace a legacy co-manager line answers for
 * and the order the Communication header lists shared numbers in.
 */
export async function listWorkspaceOwnersForCoManager(
  db: SupabaseClient,
  coManagerUserId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<Array<{ ownerUserId: string; houses: number }>> {
  const { data, error } = await db
    .from("account_link_invites")
    .select("inviter_user_id, assigned_property_ids")
    .eq("invitee_user_id", coManagerUserId)
    .eq("status", "accepted");
  if (error) {
    if (opts.throwOnError) throw new Error("Co-manager workspace links unavailable.");
    return [];
  }
  const byOwner = new Map<string, number>();
  for (const row of data ?? []) {
    const ownerUserId = String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim();
    if (!ownerUserId) continue;
    const assigned = (row as { assigned_property_ids?: unknown }).assigned_property_ids;
    const houses = Array.isArray(assigned) ? assigned.length : 0;
    byOwner.set(ownerUserId, Math.max(byOwner.get(ownerUserId) ?? 0, houses));
  }
  return [...byOwner.entries()]
    .map(([ownerUserId, houses]) => ({ ownerUserId, houses }))
    .sort((a, b) => b.houses - a.houses || a.ownerUserId.localeCompare(b.ownerUserId));
}

export type WorkspaceWorkNumber = {
  ownerUserId: string;
  ownerName: string | null;
  phoneNumber: string | null;
  provisionState: string | null;
};

/**
 * The work number(s) this account sends and replies from, one per workspace.
 *
 * An owner (anyone with a house of their own, or nobody's co-manager) gets
 * their own row. A pure co-manager gets each linked owner's row — never one of
 * their own, which is the whole "one number per workspace" rule. A workspace
 * whose owner has not set a number up yet is still listed, with a null number,
 * so the UI can say whose job it is to set one up.
 */
export async function resolveWorkspaceWorkNumbers(
  db: SupabaseClient,
  userId: string,
): Promise<{ role: "primary" | "co_manager"; numbers: WorkspaceWorkNumber[] }> {
  const pure = await isPureCoManagerWorkspace(db, userId);
  const ownerIds = pure
    ? (await listWorkspaceOwnersForCoManager(db, userId)).map((o) => o.ownerUserId)
    : [userId];
  if (ownerIds.length === 0) return { role: pure ? "co_manager" : "primary", numbers: [] };
  const [{ data: numberRows }, { data: profileRows }] = await Promise.all([
    db
      .from("manager_sms_numbers")
      .select("manager_user_id, phone_number, provision_state")
      .in("manager_user_id", ownerIds),
    db.from("profiles").select("id, full_name, email").in("id", ownerIds),
  ]);
  const numberByOwner = new Map(
    (numberRows ?? []).map((r) => [
      String(r.manager_user_id ?? "").trim(),
      {
        phoneNumber: typeof r.phone_number === "string" && r.phone_number.trim() ? r.phone_number.trim() : null,
        provisionState: typeof r.provision_state === "string" ? r.provision_state : null,
      },
    ]),
  );
  const nameByOwner = new Map(
    (profileRows ?? []).map((p) => [
      String(p.id ?? "").trim(),
      String(p.full_name ?? "").trim() || String(p.email ?? "").trim() || null,
    ]),
  );
  return {
    role: pure ? "co_manager" : "primary",
    numbers: ownerIds.map((ownerUserId) => ({
      ownerUserId,
      ownerName: nameByOwner.get(ownerUserId) ?? null,
      phoneNumber: numberByOwner.get(ownerUserId)?.phoneNumber ?? null,
      provisionState: numberByOwner.get(ownerUserId)?.provisionState ?? null,
    })),
  };
}
