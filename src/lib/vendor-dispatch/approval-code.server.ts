import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readPlatformServiceOwnerId } from "@/lib/service/service-catalog.server";
import {
  checkSmsConfirmationCode,
  issueSmsConfirmationCode,
  type SmsConfirmationCheck,
  type SmsConfirmationSubjectKind,
} from "@/lib/sms/confirmation-code";
import { serviceOwnerForWorkspace } from "@/lib/vendor-dispatch/service-roster.server";
import { toGsm7 } from "@/lib/vendor-dispatch/text";

/**
 * The code gate on the money answers a manager phone gives by text on the PropLane line (captain, Oct 20).
 *
 * A dispatch approval spends the owner's money (it sends a vendor) and a texted invoice posts the bill at the
 * vendor's claimed amount, so they carry the same 4-digit code the Assistant's write confirmations do: the ask
 * shows "Reply Y 4821", and a bare Y only re-sends the ask. ONE predicate decides it for both halves, so the ask
 * and the reply can never disagree and leave a manager unable to answer.
 *
 * Which runs: a PropLane Service workspace (its approver is the service owner, who answers on the PropLane line)
 * and the platform service owner's own runs (their work number IS that line). Every other workspace answers on its
 * own work number, which is not the shared identity this gate exists for, and is untouched.
 */

export type DispatchApprovalKind = Extract<SmsConfirmationSubjectKind, "dispatch_approval" | "dispatch_quote" | "dispatch_invoice">;

type RunRef = { id: string; owner_user_id: string; workspace_id: string };

/** Is this run's approval answered on the PropLane line, where the inbound caller ID proves nothing? */
export async function dispatchApprovalNeedsCode(db: SupabaseClient, run: Pick<RunRef, "owner_user_id" | "workspace_id">): Promise<boolean> {
  try {
    if (await serviceOwnerForWorkspace(db, run.workspace_id)) return true;
    return (await readPlatformServiceOwnerId(db)) === run.owner_user_id;
  } catch {
    return false;
  }
}

/**
 * The ask, with its code. Returns the text unchanged for a run this gate does not cover, and ALSO when no code
 * could be issued: the reply side refuses a coded confirmation in that state, so promising one would be a lie.
 */
export async function withDispatchApprovalCode(
  db: SupabaseClient,
  run: Pick<RunRef, "id" | "owner_user_id" | "workspace_id">,
  kind: DispatchApprovalKind,
  text: string,
): Promise<string> {
  if (!(await dispatchApprovalNeedsCode(db, run))) return text;
  const code = await issueSmsConfirmationCode(db, { kind, subjectId: run.id }).catch(() => null);
  if (!code) return text;
  return toGsm7(`${text.trimEnd()} Reply Y ${code} or N ${code}`);
}

/** Re-ask with a FRESH code (only its hash is stored). Null when none could be issued. */
export async function reaskDispatchApprovalCode(
  db: SupabaseClient,
  run: Pick<RunRef, "id">,
  kind: DispatchApprovalKind,
): Promise<string | null> {
  return issueSmsConfirmationCode(db, { kind, subjectId: run.id }).catch(() => null);
}

export type DispatchApprovalCheck = SmsConfirmationCheck | "not_required";

/** Check the code presented with a Y / N on the PropLane line. `not_required` = this run's answers are ungated. */
export async function checkDispatchApprovalCode(
  db: SupabaseClient,
  run: Pick<RunRef, "id" | "owner_user_id" | "workspace_id">,
  kind: DispatchApprovalKind,
  code: string | null | undefined,
): Promise<DispatchApprovalCheck> {
  if (!(await dispatchApprovalNeedsCode(db, run))) return "not_required";
  if (!code) return "wrong";
  return checkSmsConfirmationCode(db, { kind, subjectId: run.id, code });
}
