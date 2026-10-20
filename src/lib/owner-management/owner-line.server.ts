import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { portalSignInHref } from "@/lib/one-number/link-destinations.server";
import { readPartyBalance, availableToWithdraw, ownerParty } from "@/lib/managed-finance/ledger.server";
import { workspaceOccupancy } from "@/lib/managed-finance/occupancy.server";
import { decideOwnerExpense, listPendingExpensesForOwner } from "@/lib/managed-finance/vendor-bills.server";
import { monthWindow } from "@/lib/managed-finance/finances.server";
import { readPartyLines } from "@/lib/managed-finance/ledger.server";
import { buildOwnerStatement } from "@/lib/managed-finance/statement";
import { listManagedWorkspacesForOwner, type OwnedManagedWorkspace } from "@/lib/owner-management/policies.server";
import { pacificMonthKey } from "@/lib/owner-management/fee-math";

/**
 * The owner on the PropLane line. The router's team_member lane deliberately excludes owners and its role / reason contracts are
 * fixed, so this runs BEFORE routing in the shared-line seam and answers only what is clearly an owner's question; anything else
 * falls through to normal routing untouched. Deterministic and read-only except for one write: the owner's yes or no on a repair,
 * re-derived from the verified phone. No model, no arithmetic of its own: every figure is read from the ledger.
 */

export type OwnerLineResult = { handled: false } | { handled: true; reply: string };

export type OwnerIntent =
  | { kind: "approve"; approve: boolean; index: number | null; all: boolean; explicit: boolean }
  | { kind: "statement" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "none" };

/**
 * How long after the approval text a reply still answers it. Past that the owner is asked which repair they mean
 * rather than having an old prompt answered by a stray word.
 */
export const OWNER_APPROVAL_VALIDITY_MS = 72 * 60 * 60 * 1000;

/**
 * What an owner's text means. A BARE affirmative ("y", "yes", "ok", "okay") is `explicit: false`: it never
 * approves a repair on its own (captain, Oct 19), because "ok" is the most ordinary reply to any text PropLane
 * sends. Spending the owner's money needs the word APPROVE, or a yes that names the repair ("Y2", "Y all").
 */
export function classifyOwnerText(body: string): OwnerIntent {
  const t = body.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
  const yn = /^(y|yes|yeah|yep|approve|approved|ok|okay)(?: ?(\d{1,2}|all))?$/.exec(t);
  if (yn) {
    const named = Boolean(yn[2]);
    const word = yn[1] === "approve" || yn[1] === "approved";
    return { kind: "approve", approve: true, index: yn[2] && yn[2] !== "all" ? Number(yn[2]) : null, all: yn[2] === "all", explicit: named || word };
  }
  const nn = /^(n|no|decline|declined|deny)(?: ?(\d{1,2}))?$/.exec(t);
  if (nn) return { kind: "approve", approve: false, index: nn[2] ? Number(nn[2]) : null, all: false, explicit: true };
  if (/^(statement|my statement|send (me )?(my |the )?statement|statements)$/.test(t)) return { kind: "statement" };
  if (/(how'?s|how is|hows) (my |the )?(house|home|property|place|rental|properties)( doing| going)?$/.test(t) ||
      /^(balance|my balance|status|how much (do i have|can i withdraw)|what('?s| is) my balance)$/.test(t)) return { kind: "status" };
  if (/^(help|menu|owner)$/.test(t)) return { kind: "help" };
  return { kind: "none" };
}

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function financeLink(workspaceId: string, extra = ""): string {
  return `${resolveEmailLinkBaseUrl()}${portalSignInHref(`/portal/financials/owner-payouts?workspace=${encodeURIComponent(workspaceId)}${extra}`)}`;
}

async function statusReply(db: SupabaseClient, ownerUserId: string, w: OwnedManagedWorkspace, now: Date): Promise<string> {
  const party = ownerParty(ownerUserId);
  const month = pacificMonthKey(now);
  const { fromIso, toIso } = monthWindow(month);
  const [balance, lines, occ] = await Promise.all([
    readPartyBalance(db, "owner_payable", party, w.workspaceId),
    readPartyLines(db, { account: "owner_payable", partyId: party, workspaceId: w.workspaceId }),
    workspaceOccupancy(db, w.workspaceId, month),
  ]);
  const st = buildOwnerStatement(lines.map((l) => ({
    journalId: l.journalId, amountCents: l.amountCents, availableOn: l.availableOn, postedAt: l.postedAt, kind: l.kind, detail: l.detail,
    sourceType: l.sourceType, sourceId: l.sourceId,
  })), fromIso, toIso);
  const parts = [`${w.workspaceName}:`];
  if (occ && occ.units > 0) parts.push(`${occ.occupied} of ${occ.units} rooms occupied.`);
  parts.push(`Rent collected this month ${usd(st.totals.rentGrossCents)}.`);
  parts.push(`Your balance ${usd(balance.owedCents)}, ${usd(availableToWithdraw(balance, w.status === "active" ? w.terms.reserveTargetCents : 0))} available to withdraw.`);
  parts.push("Statement on the 1st.");
  return parts.join(" ");
}

export async function handleOwnerLine(
  db: SupabaseClient,
  input: { fromPhone: string; body: string; now?: Date },
): Promise<OwnerLineResult> {
  const intent = classifyOwnerText(input.body);
  if (intent.kind === "none") return { handled: false };
  const now = input.now ?? new Date();
  const profile = await findVerifiedProfileByPhone(db, input.fromPhone).catch(() => null);
  if (!profile) return { handled: false };
  let workspaces: OwnedManagedWorkspace[];
  try {
    workspaces = (await listManagedWorkspacesForOwner(db, profile.id)).filter((w) => w.status === "active");
  } catch {
    return { handled: false };
  }
  if (workspaces.length === 0) return { handled: false };

  if (intent.kind === "approve") {
    const pending = await listPendingExpensesForOwner(db, profile.id).catch(() => []);
    // An approval word means nothing unless a repair is waiting on this person: it falls through to normal routing otherwise.
    if (pending.length === 0) return { handled: false };
    const askWhich = (): OwnerLineResult => {
      const list = pending.slice(0, 4).map((e, i) => `${i + 1}) ${e.title.slice(0, 30)} ${usd(e.amountCents)}`).join(" ");
      return {
        handled: true,
        reply: pending.length === 1
          ? `Which one? ${list}. Reply APPROVE 1 to approve it or N1 to decline.`
          : `You have ${pending.length} repairs waiting: ${list}. Reply APPROVE 1 or N1, APPROVE 2 or N2, or APPROVE all.`,
      };
    };
    // An unnamed "ok" is an acknowledgement, not authority to spend. Ask which repair instead of charging one.
    if (intent.approve && !intent.explicit) return askWhich();
    if (intent.all) {
      let done = 0;
      for (const e of pending) {
        const r = await decideOwnerExpense(db, { expenseId: e.id, ownerUserId: profile.id, approve: true, via: "sms" }, now);
        if (r.status === "approved") done += 1;
      }
      return { handled: true, reply: `Approved ${done} ${done === 1 ? "repair" : "repairs"}.` };
    }
    let target = pending[0]!;
    if (pending.length > 1) {
      if (intent.index === null || intent.index < 1 || intent.index > pending.length) return askWhich();
      target = pending[intent.index - 1]!;
    }
    // Past its validity window the prompt is no longer what an unnamed reply is answering: name the repair.
    const askedAt = Date.parse(target.requestedAt);
    const named = intent.index !== null;
    if (intent.approve && !named && Number.isFinite(askedAt) && now.getTime() - askedAt > OWNER_APPROVAL_VALIDITY_MS) {
      return askWhich();
    }
    const result = await decideOwnerExpense(db, { expenseId: target.id, ownerUserId: profile.id, approve: intent.approve, via: "sms" }, now);
    if (result.status === "approved") return { handled: true, reply: `Approved: ${target.title.slice(0, 40)}, ${usd(target.amountCents)}. Thank you.` };
    if (result.status === "declined") return { handled: true, reply: `Declined: ${target.title.slice(0, 40)}. We will let the team know.` };
    return { handled: true, reply: "That one was already answered." };
  }

  if (intent.kind === "statement") {
    const w = workspaces[0]!;
    return { handled: true, reply: `Your statements and balance: ${financeLink(w.workspaceId)}` };
  }
  if (intent.kind === "help") {
    return { handled: true, reply: "Text BALANCE for your balance, STATEMENT for your statements, or APPROVE 1 / N1 to answer a repair approval." };
  }
  const replies: string[] = [];
  for (const w of workspaces.slice(0, 3)) replies.push(await statusReply(db, profile.id, w, now));
  return { handled: true, reply: replies.join("\n") };
}
