import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeAdminAuditReason } from "@/lib/admin-billing-audit.server";
import type { AdminAccountRowKind } from "@/lib/admin/admin-account-keys";
import { writeAuditLog } from "@/lib/tools/audit";

/**
 * Disabling or re-enabling one portal account, for every kind.
 *
 * The three admin routes (`managers` / `residents` / `vendors`) all write the same
 * `profiles.application_approved` flag, and the Accounts list and record pages all collect the
 * staff member's reason through one popup — so the reason requirement and the audit row live here,
 * once, rather than in whichever route happened to get them. A reason the route then discarded
 * would be worse than never asking for it.
 *
 * `landlord_id` is the account the change is about and `actor_user_id` the staff member who made
 * it, so `audit_log_landlord_idx` answers "everything ever done to this account" in one query.
 * The audit insert is best-effort: the flag has already moved, so the caller reports
 * `auditRecorded: false` rather than failing a request whose write landed.
 */

export const ADMIN_ACCOUNT_ACTIVE_AUDIT_ACTION = "admin_account_active";
export const ADMIN_ACCOUNT_ACTIVE_AUDIT_TOOL = "admin_account_active";

export type AdminAccountActiveResult =
  | { ok: false; status: number; error: string }
  | { ok: true; auditRecorded: boolean; before: boolean };

export async function setAdminAccountActive(args: {
  db: SupabaseClient;
  actorUserId: string;
  accountUserId: string;
  kind: AdminAccountRowKind;
  active: boolean;
  reason: unknown;
}): Promise<AdminAccountActiveResult> {
  const reason = normalizeAdminAuditReason(args.reason);
  if (!reason) return { ok: false, status: 400, error: "A reason is required." };

  // The before-value for the trail; an account with no explicit refusal reads as active.
  const { data: beforeRows, error: readError } = await args.db
    .from("profiles")
    .select("application_approved")
    .eq("id", args.accountUserId);
  if (readError) {
    console.error("setAdminAccountActive: profile read failed", readError);
    return { ok: false, status: 500, error: "Could not read this account." };
  }
  const before =
    (beforeRows as Array<{ application_approved: boolean | null }> | null)?.[0]?.application_approved !== false;

  const { error } = await args.db
    .from("profiles")
    .update({ application_approved: args.active })
    .eq("id", args.accountUserId);
  if (error) {
    console.error("setAdminAccountActive: profile update failed", error);
    return { ok: false, status: 500, error: "Could not update account." };
  }

  let auditRecorded = false;
  try {
    const outcome = await writeAuditLog(
      { db: args.db, landlordId: args.accountUserId, userId: args.actorUserId },
      {
        action: ADMIN_ACCOUNT_ACTIVE_AUDIT_ACTION,
        toolName: ADMIN_ACCOUNT_ACTIVE_AUDIT_TOOL,
        inputSummary: {
          field: "active",
          before,
          after: args.active,
          accountKind: args.kind,
          accountUserId: args.accountUserId,
          reason,
        },
        resultSummary: { applied: true },
      },
    );
    auditRecorded = outcome.recorded;
  } catch {
    auditRecorded = false;
  }
  if (!auditRecorded) {
    console.error("setAdminAccountActive: audit row not written", { accountUserId: args.accountUserId });
  }
  return { ok: true, auditRecorded, before };
}
