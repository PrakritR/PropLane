import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { portalDashboardPath } from "@/lib/auth/portal-roles";
import { purgeManagerPortalData, purgeResidentPortalData } from "@/lib/auth/purge-portal-account-data";
import { closeRelayThreadsForUser } from "@/lib/sms-relay.server";
import { removePortalAccess, type PortalRole } from "@/lib/auth/remove-portal-access";
import { isAdminManagedManagerPurchase } from "@/lib/manager-admin-purchase";
import { getStripe } from "@/lib/stripe";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

export type SelfDeletePortal = "resident" | "manager" | "pro" | "vendor" | "admin";

export type DeleteOwnPortalAccountResult = {
  ok: true;
  mode: string;
  /** When false the auth session stays valid (user still has another portal role). */
  signedOut: boolean;
  redirectTo: string;
};

const PROTECTED_ROLES = new Set(["admin", "manager", "pro"]);

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function profileEmail(db: ServiceDb, userId: string): Promise<string> {
  const { data } = await db.from("profiles").select("email").eq("id", userId).maybeSingle();
  return normalizeEmail(data?.email);
}

async function normalizedRolesForUser(db: ServiceDb, userId: string): Promise<string[]> {
  const [{ data: profile }, { data: roleRows }] = await Promise.all([
    db.from("profiles").select("role").eq("id", userId).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", userId),
  ]);
  const normalized = (roleRows ?? [])
    .map((row) => String(row.role ?? "").toLowerCase())
    .filter(Boolean);
  const legacyRole = String(profile?.role ?? "").toLowerCase();
  if (legacyRole && !normalized.includes(legacyRole)) normalized.push(legacyRole);
  return normalized;
}

function portalDeleteAllowed(roles: string[], portal: SelfDeletePortal): boolean {
  if (portal === "resident") return roles.includes("resident");
  if (portal === "vendor") return roles.includes("vendor");
  if (portal === "admin") return roles.includes("admin");
  return roles.some((role) => role === "manager" || role === "pro" || role === "owner");
}

function redirectForRemainingRoles(roles: string[]): string {
  const normalized = roles.map((role) => (role === "owner" ? "manager" : role));
  if (normalized.includes("admin")) return portalDashboardPath("admin");
  if (normalized.some((role) => role === "manager" || role === "pro")) {
    return portalDashboardPath("manager");
  }
  if (normalized.includes("resident")) return portalDashboardPath("resident");
  if (normalized.includes("vendor")) return portalDashboardPath("vendor");
  return "/auth/sign-in?deleted=1";
}

async function normalizedRolesForEmail(db: ServiceDb, email: string): Promise<string[] | null> {
  const targetUserId = await findAuthUserIdByEmail(db, email);
  if (!targetUserId) return null;

  const [{ data: profile }, { data: roleRows }] = await Promise.all([
    db.from("profiles").select("id, role").eq("id", targetUserId).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", targetUserId),
  ]);

  const normalizedRoles = (roleRows ?? [])
    .map((row) => String(row.role ?? "").toLowerCase())
    .filter(Boolean);
  const legacyRole = String(profile?.role ?? "").toLowerCase();
  if (legacyRole && !normalizedRoles.includes(legacyRole)) normalizedRoles.push(legacyRole);
  return normalizedRoles;
}

/** Returns whether resident portal data can be purged without violating protected-role policy. */
export async function canHardDeleteResident(db: ServiceDb, email: string) {
  const normalizedRoles = await normalizedRolesForEmail(db, email);
  if (normalizedRoles === null) return { ok: true as const };
  if (normalizedRoles.some((role) => PROTECTED_ROLES.has(role))) {
    return { ok: false as const, error: "Target user has non-resident portal roles and cannot be hard-deleted." };
  }
  return { ok: true as const };
}

/** Hard-delete resident login when they have no protected roles. */
export async function deleteResidentAuthUser(db: ServiceDb, email: string) {
  const targetUserId = await findAuthUserIdByEmail(db, email);
  if (!targetUserId) {
    return { ok: true as const, mode: "no_auth_user" as const };
  }

  const guard = await canHardDeleteResident(db, email);
  if (!guard.ok) return guard;

  await db.from("profile_roles").delete().eq("user_id", targetUserId);
  await db.from("profiles").delete().eq("id", targetUserId);

  const { error: authDeleteError } = await db.auth.admin.deleteUser(targetUserId);
  if (authDeleteError) throw new Error(authDeleteError.message);
  return { ok: true as const, mode: "deleted_auth_user" as const };
}

/** Cascade-delete resident child data, then remove resident portal access / auth user. */
export async function deleteResidentAccount(
  db: ServiceDb,
  input: { userId?: string; email?: string; applicationId?: string; purgeData?: boolean },
) {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  const email = normalizeEmail(input.email) || (userId ? await profileEmail(db, userId) : "");
  const applicationId = typeof input.applicationId === "string" ? input.applicationId.trim() : "";
  const purgeData = input.purgeData !== false;
  const hasTarget = Boolean(userId || email || applicationId);

  if (purgeData) {
    await purgeResidentPortalData(db, { email, userId: userId || null, applicationId: applicationId || null });
  }

  if (!hasTarget) {
    return { ok: true as const, mode: "no_target" as const };
  }

  if (!userId && !email) {
    return { ok: true as const, mode: "purged_data_only" as const };
  }

  if (purgeData && email) {
    const canHardDelete = await canHardDeleteResident(db, email);
    if (!canHardDelete.ok) {
      const targetUserId = userId || (await findAuthUserIdByEmail(db, email));
      if (!targetUserId) {
        return { ok: true as const, mode: "purged_data_only" as const };
      }
      const result = await removePortalAccess(db, targetUserId, "resident");
      return { ok: true as const, mode: "purged" as const, loginMode: result.mode };
    }

    const loginDeleteResult = await deleteResidentAuthUser(db, email);
    if (!loginDeleteResult.ok) {
      return { ok: false as const, error: loginDeleteResult.error };
    }
    return { ok: true as const, mode: "purged" as const, loginMode: loginDeleteResult.mode };
  }

  const targetUserId = userId || (email ? await findAuthUserIdByEmail(db, email) : null);
  if (!targetUserId) {
    return { ok: true as const, mode: "no_auth_user" as const };
  }

  const result = await removePortalAccess(db, targetUserId, "resident");
  return { ok: true as const, mode: result.mode };
}

/**
 * Best-effort cancel of the user's active Stripe subscription BEFORE their
 * manager_purchases row is purged. Without this, deleting the account leaves the
 * live subscription billing a now-deleted customer. Never throws — a missing
 * subscription, an admin-comped tier (no real Stripe sub), or unconfigured Stripe
 * must not block deletion. Stripe's own transaction records are retained lawfully.
 */
async function cancelActiveManagerSubscription(db: ServiceDb, userId: string): Promise<void> {
  try {
    const { data } = await db
      .from("manager_purchases")
      .select("stripe_subscription_id, stripe_checkout_session_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (isAdminManagedManagerPurchase(data?.stripe_checkout_session_id)) return;
    const subscriptionId = data?.stripe_subscription_id?.trim();
    if (!subscriptionId) return;
    await getStripe().subscriptions.cancel(subscriptionId);
  } catch {
    /* best-effort — deletion proceeds regardless of the subscription outcome */
  }
}

/** Delete the profile roles, profile row, and auth login for a user (in that order). */
async function deleteProfileAndAuthUser(db: ServiceDb, userId: string): Promise<void> {
  const { error: rolesErr } = await db.from("profile_roles").delete().eq("user_id", userId);
  if (rolesErr) throw new Error(rolesErr.message);

  const { error: profileErr } = await db.from("profiles").delete().eq("id", userId);
  if (profileErr) throw new Error(profileErr.message);

  const { error: authDeleteError } = await db.auth.admin.deleteUser(userId);
  if (authDeleteError) throw new Error(authDeleteError.message);
}

/**
 * Shared cascade: purge all manager + resident portal data (the manager document
 * library and its private storage objects included, via purgeManagerPortalData),
 * then delete the roles, profile, and auth login. Used by BOTH the admin
 * "complete delete" and the self-serve delete so the two can never drift.
 */
async function purgeAndDeletePortalAccount(db: ServiceDb, userId: string) {
  const trimmedId = userId.trim();
  if (!trimmedId) throw new Error("User id is required.");

  const email = await profileEmail(db, trimmedId);
  await purgeManagerPortalData(db, trimmedId);
  await purgeResidentPortalData(db, { email, userId: trimmedId });
  await deleteProfileAndAuthUser(db, trimmedId);

  return { ok: true as const, mode: "deleted_auth_user" as const };
}

/** Admin-only: purge all portal data and remove the auth user entirely. */
export async function deletePortalAccountCompletely(db: ServiceDb, userId: string) {
  return purgeAndDeletePortalAccount(db, userId);
}

/**
 * Admin PropLane Users delete — same full teardown as self-delete (Stripe cancel,
 * vendor rows, SMS relay, manager + resident portal data, auth user). After this
 * the email can register again as a genuinely fresh account.
 */
export async function deleteAdminPortalAccount(db: ServiceDb, userId: string) {
  return deleteOwnAccount(db, userId);
}

/**
 * Self-delete: the authenticated user permanently deletes their OWN account,
 * whatever role(s) they hold. The resident path's PROTECTED_ROLES /
 * canHardDeleteResident guard exists to stop an ADMIN from hard-deleting a
 * manager/pro through the resident tooling — it must NOT block a user from
 * deleting themselves (App Store Guideline 5.1.1(v)). Cancels any active Stripe
 * subscription (so billing stops), disassociates/removes vendor data keyed by
 * vendor_user_id (not covered by the manager/resident purges), then runs the
 * shared purge + auth delete. Afterward the email is free to register again.
 * Best-effort on the vendor tables so a missing one never blocks the deletion.
 */
export async function deleteOwnAccount(db: ServiceDb, userId: string) {
  const trimmedId = userId.trim();
  if (!trimmedId) throw new Error("User id is required.");

  // Stop billing before manager_purchases is purged inside purgeManagerPortalData.
  await cancelActiveManagerSubscription(db, trimmedId);

  // Vendor account data is keyed by vendor_user_id (not manager_user_id), so it is
  // not covered by the manager/resident purges. Disassociate the manager-owned
  // directory / work-order references (they belong to the manager) and delete the
  // vendor-owned rows. Awaiting a PostgREST query resolves with { error } rather
  // than throwing, so a missing table is simply ignored here.
  await db.from("manager_vendor_records").update({ vendor_user_id: null }).eq("vendor_user_id", trimmedId);
  await db.from("portal_work_order_records").update({ vendor_user_id: null }).eq("vendor_user_id", trimmedId);
  await db.from("vendor_tax_profiles").delete().eq("vendor_user_id", trimmedId);
  await db.from("work_order_bids").delete().eq("vendor_user_id", trimmedId);
  await db.from("vendor_invoices").delete().eq("vendor_user_id", trimmedId);
  await db.from("vendor_payouts").delete().eq("vendor_user_id", trimmedId);

  // SMS relay participation holds the user's real cell in active bindings
  // (no FK cascade covers counterparty rows) — close those threads so a
  // deleted user's number stops routing. Personal verification/push rows are
  // likewise not covered by the manager/resident purges.
  await closeRelayThreadsForUser(db, trimmedId).catch(() => undefined);
  await db.from("phone_verifications").delete().eq("user_id", trimmedId);
  await db.from("device_push_tokens").delete().eq("user_id", trimmedId);

  return purgeAndDeletePortalAccount(db, trimmedId);
}

/**
 * Cascade-delete manager properties, payments, leases, etc., then remove ONLY
 * manager access. `removePortalAccess` deletes the auth user outright when
 * manager was the last role, but revokes just that role when the person also
 * holds vendor/resident — so deleting someone's manager account never takes
 * their other portals with it.
 *
 * Stripe is cancelled first: `purgeManagerPortalData` wipes `manager_purchases`,
 * so cancelling afterwards would have nothing left to look up and the customer
 * would keep being billed for an account that no longer exists.
 */
export async function deleteManagerAccount(db: ServiceDb, managerUserId: string) {
  await cancelActiveManagerSubscription(db, managerUserId);
  await purgeManagerPortalData(db, managerUserId);
  const managerResult = await removePortalAccess(db, managerUserId, "manager");
  if (managerResult.mode === "deleted_auth_user") {
    return { ok: true as const, mode: managerResult.mode };
  }
  const proResult = await removePortalAccess(db, managerUserId, "pro");
  if (proResult.mode === "deleted_auth_user") {
    return { ok: true as const, mode: proResult.mode };
  }
  return {
    ok: true as const,
    mode: managerResult.mode === "no_role" ? proResult.mode : managerResult.mode,
  };
}

/**
 * Self-delete from ONE portal only. Purges that portal's data and revokes its
 * role; other portal roles on the same login are left intact. When the removed
 * role was the last one, the auth user is deleted and the client should sign out.
 */
export async function deleteOwnPortalAccount(
  db: ServiceDb,
  userId: string,
  portal: SelfDeletePortal,
): Promise<DeleteOwnPortalAccountResult> {
  const trimmedId = userId.trim();
  if (!trimmedId) throw new Error("User id is required.");

  const rolesBefore = await normalizedRolesForUser(db, trimmedId);
  if (!portalDeleteAllowed(rolesBefore, portal)) {
    throw new Error("This account does not have access to that portal.");
  }

  let mode = "unknown";
  switch (portal) {
    case "resident": {
      const result = await deleteResidentAccount(db, { userId: trimmedId, purgeData: true });
      if (!result.ok) throw new Error(result.error);
      mode = result.loginMode ?? result.mode;
      break;
    }
    case "manager":
    case "pro": {
      const result = await deleteManagerAccount(db, trimmedId);
      mode = result.mode;
      break;
    }
    case "vendor": {
      const result = await deleteVendorAccount(db, trimmedId);
      mode = result.mode;
      break;
    }
    case "admin": {
      const result = await removePortalAccess(db, trimmedId, "admin");
      mode = result.mode;
      break;
    }
    default:
      throw new Error("Unsupported portal.");
  }

  if (mode === "deleted_auth_user") {
    return { ok: true, mode, signedOut: true, redirectTo: "/auth/sign-in?deleted=1" };
  }

  const rolesAfter = await normalizedRolesForUser(db, trimmedId);
  if (rolesAfter.length === 0) {
    return { ok: true, mode, signedOut: true, redirectTo: "/auth/sign-in?deleted=1" };
  }

  return {
    ok: true,
    mode,
    signedOut: false,
    redirectTo: redirectForRemainingRoles(rolesAfter),
  };
}

/**
 * Remove vendor portal data and revoke vendor access. Manager-owned directory
 * rows are disassociated, not deleted — same contract as self-delete cleanup.
 */
export async function deleteVendorAccount(db: ServiceDb, vendorUserId: string) {
  const trimmedId = vendorUserId.trim();
  if (!trimmedId) throw new Error("User id is required.");

  await db.from("manager_vendor_records").update({ vendor_user_id: null }).eq("vendor_user_id", trimmedId);
  await db.from("portal_work_order_records").update({ vendor_user_id: null }).eq("vendor_user_id", trimmedId);
  await db.from("vendor_tax_profiles").delete().eq("vendor_user_id", trimmedId);
  await db.from("work_order_bids").delete().eq("vendor_user_id", trimmedId);
  await db.from("vendor_invoices").delete().eq("vendor_user_id", trimmedId);
  await db.from("vendor_payouts").delete().eq("vendor_user_id", trimmedId);

  const result = await removePortalAccess(db, trimmedId, "vendor");
  return { ok: true as const, mode: result.mode };
}


export type { PortalRole };
