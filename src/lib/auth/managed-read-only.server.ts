import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { isStripeManagedBilling } from "@/lib/manager-access";

/**
 * TS mirror of `public.managed_read_only_workspace_ids()` (migration 20261019100000), for code
 * that holds a service-role client. Keep the two rules identical.
 */
export type PurchaseRowForPlan = {
  stripe_subscription_id?: string | null;
  billing?: string | null;
  apple_original_transaction_id?: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A plan the client paid for herself: a Stripe subscription, monthly / annual billing, or an Apple
 * anchor. Admin grants, trials and waivers / promo codes are NOT self-paid (allowlist).
 */
export function hasSelfPaidPlan(rows: readonly PurchaseRowForPlan[] | null | undefined): boolean {
  return (rows ?? []).some(
    (row) =>
      text(row.stripe_subscription_id) !== "" ||
      isStripeManagedBilling(text(row.billing)) ||
      text(row.apple_original_transaction_id) !== "",
  );
}

/**
 * Of the service workspaces `ownedServiceIds` this user owns, the ones that are locked: all of them
 * unless the user is a platform admin, the platform service owner, or holds a self-paid plan.
 * Throws on a read error (callers fail closed).
 */
export async function lockedOwnedServiceWorkspaceIds(
  db: SupabaseClient,
  userId: string,
  ownedServiceIds: readonly string[],
): Promise<string[]> {
  const uid = userId.trim();
  if (!uid || ownedServiceIds.length === 0) return [];
  const [profileRes, rolesRes, serviceRes] = await Promise.all([
    db.from("profiles").select("email, role").eq("id", uid).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", uid).eq("role", "admin"),
    db.from("platform_service_settings").select("owner_user_id").eq("owner_user_id", uid),
  ]);
  for (const res of [profileRes, rolesRes, serviceRes]) {
    if (res.error) throw new Error(res.error.message || "managed read-only lookup failed");
  }
  const profile = (profileRes.data ?? null) as { email?: string | null; role?: string | null } | null;
  const email = text(profile?.email).toLowerCase();
  const isAdmin =
    (rolesRes.data ?? []).length > 0 ||
    text(profile?.role).toLowerCase() === "admin" ||
    email === PRIMARY_ADMIN_EMAIL.toLowerCase();
  if (isAdmin || (serviceRes.data ?? []).length > 0) return [];
  const select = "stripe_subscription_id, billing, apple_original_transaction_id";
  const [byUser, byEmail] = await Promise.all([
    db.from("manager_purchases").select(select).eq("user_id", uid),
    email ? db.from("manager_purchases").select(select).ilike("email", email) : Promise.resolve({ data: [] as PurchaseRowForPlan[], error: null }),
  ]);
  if (byUser.error || byEmail.error) throw new Error("managed read-only plan lookup failed");
  if (hasSelfPaidPlan([...(byUser.data ?? []), ...(byEmail.data ?? [])])) return [];
  return [...ownedServiceIds];
}

/** The workspaces this user sees view-only. Throws on any read error (callers fail closed). */
export async function managedReadOnlyWorkspaceIds(db: SupabaseClient, userId: string): Promise<string[]> {
  const uid = userId.trim();
  if (!uid) return [];
  const locked = new Set<string>();
  const [seatsRes, ownedRes] = await Promise.all([
    db
      .from("account_link_invites")
      .select("workspace_id, inviter_user_id")
      .eq("invitee_user_id", uid)
      .eq("status", "accepted")
      .eq("team_role", "property_owner"),
    db.from("portal_workspaces").select("id, is_service").eq("owner_user_id", uid),
  ]);
  if (seatsRes.error || ownedRes.error) throw new Error("managed read-only lookup failed");

  // Retired property_owner seats: the workspace they were seated in (a legacy row with none: the inviter's).
  const unpinnedInviters: string[] = [];
  for (const seat of (seatsRes.data ?? []) as { workspace_id?: string | null; inviter_user_id?: string | null }[]) {
    const ws = text(seat.workspace_id);
    if (ws) locked.add(ws);
    else if (text(seat.inviter_user_id)) unpinnedInviters.push(text(seat.inviter_user_id));
  }
  if (unpinnedInviters.length) {
    const { data, error } = await db.from("portal_workspaces").select("id").in("owner_user_id", unpinnedInviters);
    if (error) throw new Error(error.message || "managed read-only lookup failed");
    for (const row of (data ?? []) as { id: string }[]) locked.add(String(row.id));
  }

  const ownedService = ((ownedRes.data ?? []) as { id: string; is_service?: boolean | null }[])
    .filter((w) => w.is_service === true)
    .map((w) => String(w.id));
  for (const id of await lockedOwnedServiceWorkspaceIds(db, uid, ownedService)) locked.add(id);
  return [...locked].sort();
}

/** True when `workspaceId` is view-only for the user. A read error counts as locked (fail closed). */
export async function isManagedReadOnly(db: SupabaseClient, userId: string, workspaceId: string): Promise<boolean> {
  const ws = workspaceId.trim();
  if (!ws) return false;
  try {
    return (await managedReadOnlyWorkspaceIds(db, userId)).includes(ws);
  } catch {
    return true;
  }
}
