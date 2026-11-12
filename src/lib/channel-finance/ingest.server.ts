import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseChannelFinanceEmail } from "./email-parsers";
import { loadFinanceCandidates, recordFinanceFacts, recordFinanceMail } from "./store.server";
import { CHANNEL_FINANCE_PARSER_VERIFIED, enabledFinanceParsers, type FinancePlatform } from "./types";

export type FinanceIngestResult =
  | { status: "unauthenticated" | "not_finance" }
  | { status: "recorded" | "flagged"; recordId: string | null };

/**
 * The front door for an Airbnb / Booking.com reservation, payout or invoice mail that reached the workspace address (the host's
 * Gmail filter forwards it). Believed only when the receiving server proved the sender (DKIM/SPF). A mail the parser is
 * CERTAIN of becomes a record; anything else is stored with its parsed candidates and flagged "needs review" - an amount is
 * never guessed. "Certain" = readable and consistent AND (the parser is verified / switched on, OR gross - fee = payout was
 * cross-checked, OR the mail states no money at all).
 */
export async function ingestChannelFinanceMail(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string | null;
    platform: FinancePlatform;
    emailId: string;
    subject: string;
    text: string;
    receivedAt: string;
    authenticated: boolean;
  },
): Promise<FinanceIngestResult> {
  if (!input.authenticated) return { status: "unauthenticated" };
  const parsed = parseChannelFinanceEmail({ platform: input.platform, subject: input.subject, text: input.text, receivedAt: input.receivedAt });
  if (parsed.status === "not_finance") return { status: "not_finance" };
  const mail = { ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, platform: input.platform, emailId: input.emailId, subject: input.subject, text: input.text, receivedAt: input.receivedAt };
  if (parsed.status === "unreadable") {
    await recordFinanceMail(db, { ...mail, status: "flagged" });
    return { status: "flagged", recordId: null };
  }
  const { facts } = parsed;
  const hasMoney = [facts.grossCents, facts.hostFeeCents, facts.taxCents, facts.payoutCents].some((v) => v !== undefined);
  const trustedParser = CHANNEL_FINANCE_PARSER_VERIFIED[input.platform] || enabledFinanceParsers().has(input.platform);
  const certain = parsed.certain && (!hasMoney || parsed.crossChecked || trustedParser);
  const candidates = await loadFinanceCandidates(db, { ownerUserId: input.ownerUserId, workspaceId: input.workspaceId });
  const outcome = await recordFinanceFacts(db, {
    ownerUserId: input.ownerUserId,
    workspaceId: input.workspaceId,
    facts,
    source: "email",
    review: certain ? "ok" : "needs_review",
    emailId: input.emailId,
    candidates,
    receivedAt: input.receivedAt,
  });
  if (!outcome) {
    await recordFinanceMail(db, { ...mail, status: "flagged" });
    return { status: "flagged", recordId: null };
  }
  const flagged = outcome.reviewStatus === "needs_review";
  await recordFinanceMail(db, { ...mail, status: flagged ? "flagged" : "recorded", recordId: outcome.id });
  return { status: flagged ? "flagged" : "recorded", recordId: outcome.id };
}
