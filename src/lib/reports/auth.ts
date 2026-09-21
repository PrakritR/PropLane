import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerSectionAllowedForTier } from "@/lib/manager-access";
import { getManagerSubscriptionTier } from "@/lib/manager-access-server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export type ReportsAuthContext =
  | {
      role: "manager";
      userId: string;
      email: string;
      db: ReturnType<typeof createSupabaseServiceRoleClient>;
    }
  | {
      role: "resident";
      userId: string;
      email: string;
      db: ReturnType<typeof createSupabaseServiceRoleClient>;
    }
  | {
      role: "admin";
      userId: string;
      email: string;
      db: ReturnType<typeof createSupabaseServiceRoleClient>;
    }
  | {
      role: "vendor";
      userId: string;
      email: string;
      db: ReturnType<typeof createSupabaseServiceRoleClient>;
    };

export type ReportsPreferRole = "manager" | "resident" | "vendor";

function hasManagerRole(roles: string[]): boolean {
  return roles.some((r) => r === "manager" || r === "owner" || r === "pro");
}

function hasResidentRole(roles: string[]): boolean {
  return roles.includes("resident");
}

function hasVendorRole(roles: string[]): boolean {
  return roles.includes("vendor");
}

export async function getReportsAuthContext(options?: {
  preferRole?: ReportsPreferRole;
}): Promise<ReportsAuthContext | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return null;
  const admin = await isAdminUser(user.id);
  const { data: profile } = await db
    .from("profiles")
    .select("email, role")
    .eq("id", user.id)
    .maybeSingle();
  const { data: roleRows } = await db.from("profile_roles").select("role").eq("user_id", user.id);
  const roles = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const legacyRole = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const allRoles = roles.length > 0 ? roles : legacyRole ? [legacyRole] : [];
  const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();

  if (admin) {
    return { role: "admin", userId: user.id, email, db };
  }

  const preferRole = options?.preferRole;
  if (preferRole === "resident" && hasResidentRole(allRoles)) {
    return { role: "resident", userId: user.id, email, db };
  }
  if (preferRole === "manager" && hasManagerRole(allRoles)) {
    return { role: "manager", userId: user.id, email, db };
  }
  if (preferRole === "vendor" && hasVendorRole(allRoles)) {
    return { role: "vendor", userId: user.id, email, db };
  }

  if (hasManagerRole(allRoles)) {
    return { role: "manager", userId: user.id, email, db };
  }
  // A vendor with no manager/resident role resolves to the vendor context so
  // vendor-scoped financial reads work; a dual-role user still prefers manager.
  if (hasVendorRole(allRoles) && !hasResidentRole(allRoles)) {
    return { role: "vendor", userId: user.id, email, db };
  }
  return { role: "resident", userId: user.id, email, db };
}

export async function assertManagerFinancialsAccess(ctx: ReportsAuthContext): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (ctx.role === "admin") return { ok: true };
  if (ctx.role !== "manager") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const tier = await getManagerSubscriptionTier(ctx.userId);
  if (!managerSectionAllowedForTier("documents", tier)) {
    return { ok: false, status: 402, error: "Documents requires Pro or Business." };
  }
  return { ok: true };
}

/**
 * Tier-only variant for callers that already hold an authenticated,
 * landlord-scoped identity (e.g. agent tools): does this manager's
 * subscription allow financial writes? Returns a structured, honest error the
 * assistant can relay instead of a bare status code.
 */
export async function assertFinancialsTier(
  landlordId: string,
): Promise<{ ok: true } | { ok: false; code: "tier_required"; error: string }> {
  const tier = await getManagerSubscriptionTier(landlordId);
  if (!managerSectionAllowedForTier("documents", tier)) {
    return {
      ok: false,
      code: "tier_required",
      error:
        "Recording financials requires the Pro or Business plan. Upgrade in Settings → Subscription.",
    };
  }
  return { ok: true };
}

export async function assertResidentFinancialsAccess(ctx: ReportsAuthContext): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (ctx.role === "admin") return { ok: true };
  if (ctx.role !== "resident") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  return { ok: true };
}

/**
 * Gate for vendor-scoped financial reads (invoices, payouts). A vendor only ever
 * sees their own rows: every vendor report query filters by
 * `vendor_user_id = ctx.userId`, and `ctx.userId` is the authenticated user id —
 * never model- or client-supplied — so cross-vendor access is structurally
 * impossible. This role-gate rejects any non-vendor caller (a manager/resident
 * cannot reach vendor invoice/payout reports); admins pass for support access.
 */
export async function assertVendorFinancialsAccess(ctx: ReportsAuthContext): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (ctx.role === "admin") return { ok: true };
  if (ctx.role !== "vendor") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  return { ok: true };
}
