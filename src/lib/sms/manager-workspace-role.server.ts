import type { SupabaseClient } from "@supabase/supabase-js";

/** Accepted co-manager links where this user is the invitee (linked workspace, no owned rows). */
export async function getAcceptedCoManagerInviterIds(
  db: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from("account_link_invites")
    .select("inviter_user_id")
    .eq("invitee_user_id", userId)
    .eq("status", "accepted");
  if (error) return [];
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
): Promise<boolean> {
  if (await managerHasOwnedProperties(db, userId)) return false;
  const inviters = await getAcceptedCoManagerInviterIds(db, userId);
  return inviters.length > 0;
}
