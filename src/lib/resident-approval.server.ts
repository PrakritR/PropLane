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
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import {
  BLOCKING_FORMS_FAIL_CLOSED,
  NO_BLOCKING_FORMS,
  loadApplicationBlockingForms,
  loadResidentBlockingForms,
  type BlockingFormsPending,
} from "@/lib/move-in-forms/blocking";
import { managerOwnsResident, residentPropertyIdsForManager } from "@/lib/auth/resident-relationship";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";

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

/**
 * The email-keyed forms read a MANAGER's approval decision may rest on. Scoped to forms the caller
 * holds (the SAME access test the Applications list uses: they sent it, own the property, or
 * co-manage it with permission), so another landlord's form for the same applicant neither blocks
 * this manager nor reveals itself. Admins see every form. Fails closed on a read or scope error.
 */
export function loadCallerScopedResidentBlockingForms(
  db: SupabaseClient,
  actor: ResidentApprovalActor,
  email: string,
): Promise<BlockingFormsPending> {
  return loadResidentBlockingForms(db, {
    email,
    callerHolds: actor.isAdmin
      ? undefined
      : (form) => managerCanAccessApplicationRecord(db, actor.userId, { manager_user_id: form.manager_user_id, property_id: form.property_id }),
  });
}

/**
 * What blocks turning a resident's portal access ON from a manager's hand when no single application is
 * named (the agent's set_resident_approval): forms tied to any of the caller's applications for this
 * email, plus the caller-scoped email read. Fails closed on any error.
 */
export async function loadResidentApprovalBlocking(
  db: SupabaseClient,
  actor: ResidentApprovalActor,
  email: string,
): Promise<BlockingFormsPending> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return NO_BLOCKING_FORMS;
  try {
    const { data, error } = await db
      .from("manager_application_records")
      .select("id, manager_user_id, property_id, assigned_property_id, row_data")
      .eq("resident_email", normalized);
    if (error) return BLOCKING_FORMS_FAIL_CLOSED;
    const ids: string[] = [];
    for (const record of (data ?? []) as Array<{ id: string; manager_user_id: string | null; property_id: string | null; assigned_property_id: string | null; row_data: { id?: unknown } | null }>) {
      if (!actor.isAdmin && !(await managerCanAccessApplicationRecord(db, actor.userId, record))) continue;
      ids.push(String(record.id), String(record.row_data?.id ?? ""));
    }
    const [byApplication, byEmail] = await Promise.all([
      loadApplicationBlockingForms(db, ids),
      loadCallerScopedResidentBlockingForms(db, actor, normalized),
    ]);
    if (byApplication.readFailed || byEmail.readFailed) return BLOCKING_FORMS_FAIL_CLOSED;
    return {
      moveInDetails: byApplication.moveInDetails || byEmail.moveInDetails,
      leaseSigning: byApplication.leaseSigning || byEmail.leaseSigning,
      approval: byApplication.approval || byEmail.approval,
    };
  } catch {
    return BLOCKING_FORMS_FAIL_CLOSED;
  }
}

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
    // Portfolio ownership above is not workspace-scoped — active-workspace
    // narrowing runs BESIDE it, never instead of it. A resident this actor
    // manages only through a property outside their current active workspace
    // must be refused exactly like every other module (documents, leases,
    // applications, …) already refuses a row outside it. Property-less
    // relationships (no application/charge/lease carried a property id) are
    // left unnarrowed — there is nothing here to check against.
    const propertyIds = await residentPropertyIdsForManager(db, actor.userId, { email });
    if (propertyIds.length > 0) {
      const scope = await activeWorkspacePropertyScope(db, actor.userId);
      if (scope !== null && !propertyIds.some((id) => scope.includes(id))) {
        return { ok: false, status: 403, error: "Forbidden: resident is not in your active workspace." };
      }
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
