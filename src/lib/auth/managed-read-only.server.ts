import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

/**
 * TS mirror of `public.managed_read_only_workspace_ids()` / `managed_read_only_owner_locked()`
 * (migrations 20261020100000 v3 and 20261020130000), for code that holds a service-role client. Keep the rules
 * identical.
 */
export type PurchaseRowForPlan = {
  tier?: string | null;
  stripe_subscription_id?: string | null;
  subscription_status?: string | null;
  apple_original_transaction_id?: string | null;
};

/** The Stripe subscription states that are a plan the client is PAYING for: `past_due` is a retry, not a revocation. */
const SELF_PAID_SUBSCRIPTION_STATUSES = new Set(["active", "past_due"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A plan the client is paying for herself RIGHT NOW: a pro / business row carrying an Apple anchor, or a Stripe
 * subscription whose own status is `active` / `past_due`. The `billing` column is NOT evidence (checkout intents
 * write monthly / annual for tier free before any payment), and admin grants, trials and waivers carry no
 * subscription id.
 *
 * The status is load-bearing: manager Checkout is created with `trial_period_days`, so a subscription id alone is
 * satisfied by a card-on-file TRIAL that has paid nothing - which would unlock a managed workspace for the length
 * of the trial. `past_due` still counts (money has been paid and Stripe is retrying); `trialing`, `incomplete`,
 * `unpaid`, `paused`, `canceled` and an unwritten status do not.
 *
 * "Current" also rests on the tier: every cancellation path writes `tier: "free"` and clears the id - Stripe's
 * `customer.subscription.deleted` and the reconciler (`manager-stripe-subscription-sync.ts`), and RevenueCat's
 * expiry / refund (`downgradeAppleManagerPurchase`). So a client who buys Pro for a month and cancels is locked
 * again once that event lands.
 */
export function hasSelfPaidPlan(rows: readonly PurchaseRowForPlan[] | null | undefined): boolean {
  return (rows ?? []).some((row) => {
    const tier = text(row.tier).toLowerCase();
    if (tier !== "pro" && tier !== "business") return false;
    if (text(row.apple_original_transaction_id) !== "") return true;
    return (
      text(row.stripe_subscription_id) !== "" &&
      SELF_PAID_SUBSCRIPTION_STATUSES.has(text(row.subscription_status).toLowerCase())
    );
  });
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
    db.from("profiles").select("email").eq("id", uid).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", uid).eq("role", "admin"),
    db.from("platform_service_settings").select("owner_user_id").eq("owner_user_id", uid),
  ]);
  for (const res of [profileRes, rolesRes, serviceRes]) {
    if (res.error) throw new Error(res.error.message || "managed read-only lookup failed");
  }
  const profile = (profileRes.data ?? null) as { email?: string | null } | null;
  const email = text(profile?.email).toLowerCase();
  // `profile_roles` (plus the always-admin ops address) is the ONLY admin evidence. `profiles.role` is the role the
  // account was CREATED as and is kept forever, so an owner first created as admin - or one whose admin role has
  // since been revoked - would have written straight past this lock.
  const isAdmin = (rolesRes.data ?? []).length > 0 || email === PRIMARY_ADMIN_EMAIL.toLowerCase();
  if (isAdmin || (serviceRes.data ?? []).length > 0) return [];
  // Matched by user_id only: an email match is satisfied by unauthenticated inserts.
  const purchases = await db
    .from("manager_purchases")
    .select("tier, stripe_subscription_id, subscription_status, apple_original_transaction_id")
    .eq("user_id", uid);
  if (purchases.error) throw new Error("managed read-only plan lookup failed");
  if (hasSelfPaidPlan((purchases.data ?? []) as PurchaseRowForPlan[])) return [];
  return [...ownedServiceIds];
}

/**
 * True when the user OWNS a locked service workspace: the account-wide lock the middleware applies
 * (mirror of `managed_read_only_owner_locked()`). A property_owner seat never counts. Throws on a
 * read error (callers fail closed).
 */
export async function managedReadOnlyOwnerLocked(db: SupabaseClient, userId: string): Promise<boolean> {
  const uid = userId.trim();
  if (!uid) return false;
  const { data, error } = await db.from("portal_workspaces").select("id, is_service").eq("owner_user_id", uid);
  if (error) throw new Error("managed read-only lookup failed");
  const ownedService = ((data ?? []) as { id: string; is_service?: boolean | null }[])
    .filter((w) => w.is_service === true)
    .map((w) => String(w.id));
  return (await lockedOwnedServiceWorkspaceIds(db, uid, ownedService)).length > 0;
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
