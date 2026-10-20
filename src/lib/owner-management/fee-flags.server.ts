import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The one admin attention item for a PropLane Service workspace whose management fee could not be put in place: one row
 * per workspace per day in Admin > Finances > Flags, carrying the CAUSE so an operator is never told to "name an owner"
 * for a transient read failure. Written wherever the fee fails - inside `ensureServiceFeePolicy` itself and at the money
 * paths that then refuse or freeze - never only logged. Never throws: an attention item must not fail the path that
 * raised it. `check_name` stays `fee_agreement_unsigned` for continuity with the rows already in production.
 */

export const FEE_FLAG_CHECK_NAME = "fee_agreement_unsigned";

/** Why the fee is missing. `no_owner` is the only one an admin fixes by naming someone. */
export type FeeFlagCause =
  | "no_owner"
  | "draft_pending"
  | "workspace_unreadable"
  | "owner_unreadable"
  | "activation_refused"
  | "read_failed";

/** Where the refusal was felt. Context for the operator, not the cause. */
export type FeeFlagReason = "checkout_refused" | "hold_frozen" | "fee_unavailable";

const WHAT_TO_DO: Record<FeeFlagCause, string> = {
  no_owner: "name its owner of record",
  draft_pending: "record or end its draft fee policy in Admin > Managed finance",
  workspace_unreadable: "the workspace could not be read",
  owner_unreadable: "the owner of record could not be read",
  activation_refused: "the fee policy could not be activated",
  read_failed: "the fee policy could not be read",
};

export function feeFlagMessage(workspaceName: string, cause: FeeFlagCause): string {
  return `Could not set the management fee for ${workspaceName}: ${WHAT_TO_DO[cause]}`;
}

export async function flagManagedFeeProblem(
  db: SupabaseClient,
  input: { workspaceId: string; workspaceName?: string | null; cause: FeeFlagCause; reason: FeeFlagReason },
): Promise<void> {
  const workspace = String(input.workspaceName ?? "").trim() || "Service workspace";
  try {
    await db.from("owner_ledger_flags").upsert(
      {
        check_name: FEE_FLAG_CHECK_NAME,
        subject: input.workspaceId,
        detail: { message: feeFlagMessage(workspace, input.cause), reason: input.reason, cause: input.cause, workspace },
      },
      { onConflict: "check_name,subject,day", ignoreDuplicates: true },
    );
  } catch {
    /* an attention item must never fail the money path that raised it */
  }
}
