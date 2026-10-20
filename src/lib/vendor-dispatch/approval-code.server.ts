import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readPlatformServiceOwnerId } from "@/lib/service/service-catalog.server";
import {
  checkSmsConfirmationCode,
  clearSmsConfirmationCode,
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
 * The code's three-guess budget belongs to ONE PROPOSAL, keyed by `proposalId` - which is built from the proposal's
 * OWN facts (the run's wave for an approval or an exhausted chain, the attempt and the amount for a quote or an
 * invoice), never from the clock, so the two halves and a later reminder all name the same proposal. The subject
 * stays the RUN, which is all the reply knows; without the proposal key a run's later invoice inherited a spent
 * budget and was auto-declined on the manager's first answer, and a cancelled proposal's row is dropped so the same
 * facts coming round again start clean.
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

/**
 * Which proposal the code belongs to: a new one resets the guess budget, a re-ask of the open one does not.
 *
 * Every part is intrinsic to the proposal itself. A wall-clock stamp made the id unreproducible, so the reminder for
 * a proposal still open could not name it - it read as a new proposal and handed a fresh budget back to whoever was
 * guessing.
 */
export function dispatchProposalId(input: { kind: DispatchApprovalKind; wave?: number | null; attemptId?: string | null; amountCents?: number | null }): string {
  if (input.kind === "dispatch_approval") return `approval:w${input.wave ?? 0}`;
  if (input.kind === "dispatch_retry") return `exhausted:w${input.wave ?? 0}`;
  const amount = Number.isFinite(Number(input.amountCents)) ? Math.trunc(Number(input.amountCents)) : 0;
  return `${input.kind === "dispatch_quote" ? "quote" : "invoice"}:${String(input.attemptId ?? "")}:${amount}`;
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

/** Past this the pick example gives way to the plain range, so one long vendor name cannot bloat the instruction. */
const CODED_PICK_CHARS = 80;

/**
 * "Reply Y 7 4821 or N 7 4821": the handle is in the instruction, because a lone code only resolves one waiting job.
 *
 * An approval with backups is answerable by NUMBER as well ("2 7 4821" picks the second vendor), and the coded
 * instruction has to carry that form too: it replaces the ask's own "Y/N or 1-3 to pick one", so a manager reading
 * only the coded line would otherwise have no way to see that picking is still on the table - and a bare "2" costs
 * them a wrong-code attempt.
 */
export function codedAnswerLine(
  kind: DispatchApprovalKind,
  handle: number,
  code: string,
  options: { vendorNames?: readonly string[] } = {},
): string {
  const [yes, no] = ANSWER_VERBS[kind];
  const answer = `Reply ${yes} ${handle} ${code} or ${no} ${handle} ${code}`;
  if (kind !== "dispatch_approval") return answer;
  const names = (options.vendorNames ?? []).map((name) => toGsm7(String(name ?? "")).trim()).filter(Boolean);
  if (names.length < 2) return answer;
  const both = `Reply ${yes} ${handle} ${code}, ${no} ${handle} ${code}, or 2 ${handle} ${code} to pick ${names[1]}`;
  return both.length <= CODED_PICK_CHARS
    ? both
    : `Reply ${yes} ${handle} ${code}, ${no} ${handle} ${code}, or 1-${names.length} ${handle} ${code} to pick one`;
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
  vendorNames: readonly string[] = [],
): Promise<string> {
  if (!(await dispatchApprovalNeedsCode(db, run))) return text;
  const code = await issueSmsConfirmationCode(db, { kind, subjectId: run.id, proposalId }).catch(() => null);
  if (!code) return text;
  return toGsm7(`${text.trimEnd()} ${codedAnswerLine(kind, run.handle, code, { vendorNames })}`);
}

/** Re-ask the SAME proposal with a fresh code (only its hash is stored); the guess budget carries over. */
export async function reaskDispatchApprovalCode(
  db: SupabaseClient,
  run: Pick<RunRef, "id">,
  kind: DispatchApprovalKind,
): Promise<string | null> {
  return issueSmsConfirmationCode(db, { kind, subjectId: run.id }).catch(() => null);
}

/** The vendors an open approval is still offering, in the order the ask listed them. Empty when they cannot be read. */
export async function dispatchApprovalVendorNames(db: SupabaseClient, run: Pick<RunRef, "id" | "owner_user_id">): Promise<string[]> {
  try {
    const { loadAttempts, loadVendorContacts, vendorNamesForApproval } = await import("@/lib/vendor-dispatch/engine.server");
    const attempts = await loadAttempts(db, run.id);
    const contacts = await loadVendorContacts(db, run.owner_user_id, attempts.map((attempt) => attempt.vendor_directory_id));
    return vendorNamesForApproval(attempts, contacts);
  } catch {
    return [];
  }
}

/** The proposal is over (cancelled or settled): its code dies with it, so the same facts coming round again start clean. */
export async function clearDispatchApprovalCode(db: SupabaseClient, run: Pick<RunRef, "id">, kind: DispatchApprovalKind): Promise<void> {
  await clearSmsConfirmationCode(db, { kind, subjectId: run.id });
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
