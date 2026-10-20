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
 * The code gate on the answers a manager phone gives by text on the PropLane line (captain, Oct 20).
 *
 * A dispatch approval spends the owner's money (it sends a vendor), a texted invoice posts the bill at the vendor's
 * claimed amount, and R / B re-text vendors, so each carries the same 4-digit code the Assistant's write
 * confirmations do: the ask shows "Reply Y 7 4821", and a bare Y only re-asks. ONE predicate decides it for both
 * halves, so the ask and the reply can never disagree and leave a manager unable to answer.
 *
 * The code's three-guess budget belongs to ONE PROPOSAL, keyed by `proposalId` (the run's wave for an approval or an
 * exhausted chain, the attempt and the moment of the ask for a quote or an invoice). The subject stays the RUN, which
 * is all the reply knows; without the proposal key a run's later invoice inherited a spent budget and was
 * auto-declined on the manager's first answer.
 *
 * Which runs: a PropLane Service workspace (its approver is the service owner, who answers on the PropLane line)
 * and the platform service owner's own runs (their work number IS that line). Every other workspace answers on its
 * own work number, which is not the shared identity this gate exists for, and is untouched.
 */

export type DispatchApprovalKind = Extract<
  SmsConfirmationSubjectKind,
  "dispatch_approval" | "dispatch_quote" | "dispatch_invoice" | "dispatch_retry"
>;

type RunRef = { id: string; handle: number; owner_user_id: string; workspace_id: string };

/** The two words that answer each kind, so the instruction names what the manager should actually send. */
const ANSWER_VERBS: Record<DispatchApprovalKind, readonly [string, string]> = {
  dispatch_approval: ["Y", "N"],
  dispatch_quote: ["Y", "N"],
  dispatch_invoice: ["Y", "N"],
  dispatch_retry: ["R", "B"],
};

/** Which proposal the code belongs to: a new one resets the guess budget, a re-ask of the open one does not. */
export function dispatchProposalId(input: { kind: DispatchApprovalKind; wave?: number | null; attemptId?: string | null; at?: Date }): string {
  if (input.kind === "dispatch_approval") return `approval:w${input.wave ?? 0}`;
  if (input.kind === "dispatch_retry") return `exhausted:w${input.wave ?? 0}`;
  const at = (input.at ?? new Date()).toISOString();
  return `${input.kind === "dispatch_quote" ? "quote" : "invoice"}:${String(input.attemptId ?? "")}:${at}`;
}

/** Is this run's answer given on the PropLane line, where the inbound caller ID proves nothing? */
export async function dispatchApprovalNeedsCode(db: SupabaseClient, run: Pick<RunRef, "owner_user_id" | "workspace_id">): Promise<boolean> {
  try {
    if (await serviceOwnerForWorkspace(db, run.workspace_id)) return true;
    return (await readPlatformServiceOwnerId(db)) === run.owner_user_id;
  } catch {
    return false;
  }
}

/** "Reply Y 7 4821 or N 7 4821": the handle is in the instruction, because a lone code only resolves one waiting job. */
export function codedAnswerLine(kind: DispatchApprovalKind, handle: number, code: string): string {
  const [yes, no] = ANSWER_VERBS[kind];
  return `Reply ${yes} ${handle} ${code} or ${no} ${handle} ${code}`;
}

/**
 * The ask, with its code. Returns the text unchanged for a run this gate does not cover, and ALSO when no code
 * could be issued: the reply side refuses a coded confirmation in that state, so promising one would be a lie.
 */
export async function withDispatchApprovalCode(
  db: SupabaseClient,
  run: Pick<RunRef, "id" | "handle" | "owner_user_id" | "workspace_id">,
  kind: DispatchApprovalKind,
  text: string,
  proposalId: string,
): Promise<string> {
  if (!(await dispatchApprovalNeedsCode(db, run))) return text;
  const code = await issueSmsConfirmationCode(db, { kind, subjectId: run.id, proposalId }).catch(() => null);
  if (!code) return text;
  return toGsm7(`${text.trimEnd()} ${codedAnswerLine(kind, run.handle, code)}`);
}

/** Re-ask the SAME proposal with a fresh code (only its hash is stored); the guess budget carries over. */
export async function reaskDispatchApprovalCode(
  db: SupabaseClient,
  run: Pick<RunRef, "id">,
  kind: DispatchApprovalKind,
): Promise<string | null> {
  return issueSmsConfirmationCode(db, { kind, subjectId: run.id }).catch(() => null);
}

export type DispatchApprovalCheck = SmsConfirmationCheck | "not_required";

/** Check the code presented with an answer on the PropLane line. `not_required` = this run's answers are ungated. */
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
