/**
 * SMS-native confirmation for agent write actions.
 *
 * `ActionPreview` is a UI contract: the portal renders a card with fields and a
 * Confirm button, and the server re-validates the stored input when it is
 * pressed. Over SMS there is no card and no button, which is exactly why both
 * existing SMS agents run `readOnly: true`. This module supplies the missing
 * half so a resident can approve a write by text without weakening the gate.
 *
 * The gate itself is unchanged: proposals still land in `agent_pending_actions`
 * as `status = 'proposed'`, and confirming still runs through
 * `runConfirmedPendingActionForPortal` — the same executor the three chat routes
 * use, which checks the portal before claiming, re-validates the STORED input
 * against the tool's current schema, and scores the decision in Langfuse. This
 * module never claims or executes; it only decides WHICH action a reply meant.
 *
 * What this adds is the missing ADDRESSING. A text reply says "yes"; it does
 * not carry an action id. Rather than guess which proposal a bare "yes" meant,
 * the invariant is **at most one open proposal per resident at a time**:
 * proposing a new one supersedes any older open proposal first. "Yes" is then
 * unambiguous by construction, and a stale proposal can never be confirmed by a
 * reply the resident meant for a newer one.
 *
 * Two further deliberate choices:
 * - The affirmative vocabulary is a SMALL EXACT allowlist, not a fuzzy match.
 *   "ok" and "sure" are absent on purpose: they are ordinary conversation, and
 *   a chatty "ok" must never authorize a payment link or a lease-change request.
 * - The window is shorter than the portal's, because SMS has no visible card to
 *   re-read before deciding.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  denyPendingAction,
  type AgentPortal,
  type PendingActionActor,
} from "@/lib/tools/pending-actions";
import type { ActionPreview } from "@/lib/tools/registry";

/** Deliberately short: there is no card on screen to re-read. */
export const SMS_PENDING_ACTION_TTL_MS = 10 * 60_000;

/**
 * These sets must stay DISJOINT from the carrier control keywords in
 * `/api/twilio/inbound` (STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT,
 * START/YES/UNSTOP, HELP/INFO). Compliance handling runs first, so any overlap
 * is silently eaten before the agent ever sees the reply.
 *
 * `CANCEL` is deliberately ABSENT from the negatives even though it is the
 * natural word: it is a carrier STOP keyword, so a resident declining a rent
 * payment with "cancel" would unsubscribe from all texts instead. `NO` is safe
 * and is what the prompt asks for.
 *
 * `YES` is the one intentional overlap. It is far too natural a reply to give
 * up, so the inbound route resolves the precedence instead: START only wins
 * when the phone is actually opted out (where opting back in is the only
 * meaningful reading); otherwise the reply falls through to the agent.
 */
const AFFIRMATIVE = new Set(["YES", "Y", "CONFIRM", "CONFIRMED", "APPROVE", "APPROVED"]);
const NEGATIVE = new Set(["NO", "N", "DECLINE", "NEVERMIND", "NEVER MIND", "NVM"]);

export type SmsConfirmationIntent = "confirm" | "deny" | "none";

/**
 * Classify a reply. Exact match on the whole trimmed body only — a message that
 * merely CONTAINS "yes" ("yes I was wondering about parking") is conversation,
 * not an authorization.
 */
export function classifySmsConfirmationReply(body: string): SmsConfirmationIntent {
  const normalized = String(body ?? "")
    .trim()
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
  if (!normalized) return "none";
  if (AFFIRMATIVE.has(normalized)) return "confirm";
  if (NEGATIVE.has(normalized)) return "deny";
  return "none";
}

/** Render a preview as plain text a person can judge from a phone. */
export function renderPreviewForSms(preview: ActionPreview): string {
  const lines: string[] = [preview.title];
  if (preview.summary) lines.push("", preview.summary);
  if (preview.fields?.length) {
    lines.push("");
    for (const field of preview.fields.slice(0, 8)) {
      lines.push(`${field.label}: ${field.value}`);
    }
  }
  for (const warning of preview.warnings ?? []) lines.push("", `Note: ${warning}`);
  lines.push("", "Reply YES to confirm or NO to cancel.");
  return lines.join("\n");
}

type OpenProposal = { id: string; tool_name: string; created_at: string };

/**
 * Every still-open proposal for this actor and SMS session, newest first.
 * `user_id` is the ownership key `claimPendingAction` enforces; `session_id`
 * additionally binds a bare YES/NO to the manager work number being texted.
 */
async function loadOpenProposals(
  db: SupabaseClient,
  userId: string,
  portal: string,
  sessionId: string,
): Promise<OpenProposal[] | null> {
  if (!userId.trim() || !sessionId.trim()) return null;
  const { data, error } = await db
    .from("agent_pending_actions")
    .select("id, tool_name, created_at")
    .eq("user_id", userId)
    .eq("portal", portal)
    .eq("session_id", sessionId)
    .eq("status", "proposed")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return null;
  return (data ?? []).map((row) => ({
    id: String(row.id),
    tool_name: String(row.tool_name),
    created_at: String(row.created_at),
  }));
}

/**
 * Enforce the one-open-proposal invariant by denying every currently open
 * proposal for this actor. Call BEFORE inserting a new one, so a bare "yes"
 * can only ever refer to the newest.
 */
export async function supersedeOpenSmsProposals(
  db: SupabaseClient,
  args: { userId: string; sessionId: string; portal?: AgentPortal },
): Promise<{ ok: boolean; superseded: number }> {
  const portal: AgentPortal = args.portal ?? "resident";
  const open = await loadOpenProposals(db, args.userId, portal, args.sessionId);
  if (open === null) return { ok: false, superseded: 0 };
  let superseded = 0;
  for (const proposal of open) {
    const denied = await denyPendingAction(
      { db: db as PendingActionActor["db"], userId: args.userId },
      proposal.id,
    );
    if (denied) superseded += 1;
  }
  return { ok: true, superseded };
}

export type OpenSmsProposal =
  | { status: "one"; actionId: string; toolName: string }
  | { status: "none" }
  | { status: "ambiguous"; count: number }
  | { status: "unavailable" };

/**
 * Which proposal a bare "YES" refers to. Read-only ON PURPOSE: this module
 * decides the ADDRESSING, it never claims or executes.
 *
 * Execution belongs to `runConfirmedPendingActionForPortal`, the one confirm
 * gate every other surface uses. Claiming here would bypass its portal check,
 * its re-validation of the stored input against the tool's current schema, and
 * its `traceAgentAction` scoring — and would leave the row burned with nothing
 * run. The caller passes {@link OpenSmsProposal.actionId} straight to that gate.
 *
 * `ambiguous` should be unreachable while every proposal path calls
 * {@link supersedeOpenSmsProposals} first, but it is reported rather than
 * guessed at: picking "the newest" when two are somehow open could execute a
 * write the resident never read.
 */
export async function resolveOpenSmsProposal(
  db: SupabaseClient,
  args: { userId: string; sessionId: string; portal?: AgentPortal },
): Promise<OpenSmsProposal> {
  const portal: AgentPortal = args.portal ?? "resident";
  const open = await loadOpenProposals(db, args.userId, portal, args.sessionId);
  if (open === null) return { status: "unavailable" };
  if (open.length === 0) return { status: "none" };
  if (open.length > 1) return { status: "ambiguous", count: open.length };
  return { status: "one", actionId: open[0].id, toolName: open[0].tool_name };
}

/** Decline the open proposal. Deny needs no executor, so it resolves here. */
export async function denyOpenSmsProposal(
  db: SupabaseClient,
  args: { userId: string; actionId: string },
): Promise<{ denied: boolean; toolName?: string }> {
  const actor: PendingActionActor = { db: db as PendingActionActor["db"], userId: args.userId };
  const denied = await denyPendingAction(actor, args.actionId);
  return denied ? { denied: true, toolName: denied.toolName } : { denied: false };
}
