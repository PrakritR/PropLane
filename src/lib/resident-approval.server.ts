/**
 * Shared resident-approval core: the profiles.application_approved toggle a
 * manager flips when approving/denying a resident, plus the access-revocation
 * path. Extracted from `/api/portal/resident-approval` (and the guard+delete
 * pattern of `/api/portal/delete-resident-access`) so the routes and the
 * agent's set_resident_approval / revoke_resident_access tools run one
 * implementation.
 *
 * IMPORTANT: this extraction ADDS the ownership check the original
 * resident-approval route lacked — a non-admin caller may only touch residents
 * tied to their own portfolio (managerOwnsResident), never an arbitrary email.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteResidentAccount } from "@/lib/auth/delete-portal-account";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { managerOwnsResident } from "@/lib/auth/resident-relationship";

/** Roles allowed to manage another user's approval (matches the original route gate). */
export function canManageResidentApproval(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

export type ResidentApprovalActor = {
  /** Authenticated caller's user id — never client/model input. */
  userId: string;
  /** True skips the portfolio-ownership check (platform admins). */
  isAdmin: boolean;
};

export type ResidentApprovalResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Set profiles.application_approved for a resident on behalf of a manager.
 * Non-admin callers must be related to the resident through an application,
 * charge, or lease record in their own workspace — defaults closed.
 */
export async function setResidentApprovalForManager(
  db: SupabaseClient,
  actor: ResidentApprovalActor,
  input: { email: string; approved: boolean },
): Promise<ResidentApprovalResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) return { ok: false, status: 400, error: "Email is required." };

  if (!actor.isAdmin) {
    const related = await managerOwnsResident(db, actor.userId, { email });
    if (!related) {
      return { ok: false, status: 403, error: "Forbidden: resident is not in your portfolio." };
    }
  }

  const { error } = await db
    .from("profiles")
    .update({ application_approved: input.approved, updated_at: new Date().toISOString() })
    .eq("role", "resident")
    .eq("email", email);
  if (error) return { ok: false, status: 400, error: error.message };
  return { ok: true };
}

export type RevokeResidentAccessResult =
  | { ok: true; mode: string }
  | { ok: false; status: number; error: string };

/**
 * Remove a resident's portal sign-in access (login only — application, lease,
 * payment, and message records are kept; this is the delete-resident-access
 * route's guard + deleteResidentAccount with purgeData:false). If resident is
 * the target's only portal role their auth user is deleted entirely; otherwise
 * just the resident role is removed and application_approved is cleared.
 */
export async function revokeResidentAccessForManager(
  db: SupabaseClient,
  actor: ResidentApprovalActor,
  input: { email: string },
): Promise<RevokeResidentAccessResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) return { ok: false, status: 400, error: "Email is required." };

  if (!actor.isAdmin) {
    return {
      ok: false, status: 403,
      error: "Resident logins belong to the resident. Remove the specific application from your portfolio instead; their login and financial history remain.",
    };
  }

  const targetUserId = await findAuthUserIdByEmail(db, email);
  const result = await deleteResidentAccount(db, {
    userId: targetUserId ?? undefined,
    email,
    purgeData: false,
  });
  if (!result.ok) return { ok: false, status: 409, error: result.error };
  return { ok: true, mode: result.mode };
}
