import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlaidApi } from "plaid";

export type FeedStatement = {
  id: string;
  statementDate: string;
  reconciled: boolean;
  /**
   * The feed created this statement (`manager_bank_statements.source = 'plaid_feed'`) AND every line on it
   * came from the bank feed. A statement the manager created or imported is never feed-owned, even when it
   * holds no lines at all — their typed opening / closing is the number.
   */
  feedOwned: boolean;
  lineSumCents: number;
  openingBalanceCents: number;
  closingBalanceCents: number;
};

export type BalanceUpdate = { id: string; openingBalanceCents: number; closingBalanceCents: number };

/** PostgREST's own max-rows cap: every bulk read here pages at it rather than trusting one response. */
const LINE_PAGE_SIZE = 1000;

type StatementLineRow = { statement_id: string; amount_cents: number | string; plaid_transaction_id: string | null };

/**
 * Every line on these statements, paged. A truncated read would under-count `lineSumCents` and, because
 * each opening chains into the next closing, would corrupt every older statement — so the read either
 * returns all of them or throws.
 */
async function readStatementLines(db: SupabaseClient, statementIds: readonly string[]): Promise<StatementLineRow[]> {
  const out: StatementLineRow[] = [];
  for (let i = 0; i < statementIds.length; i += 50) {
    const chunk = statementIds.slice(i, i + 50);
    for (let offset = 0; ; offset += LINE_PAGE_SIZE) {
      const { data, error } = await db
        .from("manager_bank_statement_lines")
        .select("statement_id, amount_cents, plaid_transaction_id")
        .in("statement_id", [...chunk])
        .order("id", { ascending: true })
        .range(offset, offset + LINE_PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as StatementLineRow[];
      out.push(...page);
      if (page.length < LINE_PAGE_SIZE) break;
    }
  }
  return out;
}

/**
 * Walk back from the bank's current balance, newest statement first: a month closes at the
 * running balance and opens at that minus its lines. Stops at the first statement the manager
 * owns (reconciled, not created by the feed, or holding a line they typed), so their numbers
 * are never overwritten.
 */
export function deriveFeedBalances(statementsNewestFirst: readonly FeedStatement[], currentBalanceCents: number): BalanceUpdate[] {
  const updates: BalanceUpdate[] = [];
  let running = currentBalanceCents;
  for (const st of statementsNewestFirst) {
    if (st.reconciled || !st.feedOwned) break;
    const closing = running;
    const opening = running - st.lineSumCents;
    if (closing !== st.closingBalanceCents || opening !== st.openingBalanceCents) {
      updates.push({ id: st.id, openingBalanceCents: opening, closingBalanceCents: closing });
    }
    running = opening;
  }
  return updates;
}

/** Fill a feed account's open statements' balances from the bank's current balance. Best-effort. */
export async function fillFeedStatementBalances(
  db: SupabaseClient,
  client: Pick<PlaidApi, "accountsGet">,
  args: { accessToken: string; plaidAccountId: string | null; ownerUserId: string; bankAccountId: string },
): Promise<number> {
  const res = await client.accountsGet({ access_token: args.accessToken });
  const account = res.data.accounts.find((a) => a.account_id === args.plaidAccountId) ?? null;
  const current = account?.balances.current;
  if (account == null || typeof current !== "number" || !Number.isFinite(current)) return 0;

  const { data: statements, error } = await db
    .from("manager_bank_statements")
    .select("id, statement_date, reconciled_at, opening_balance_cents, closing_balance_cents, source")
    .eq("manager_user_id", args.ownerUserId)
    .eq("bank_account_id", args.bankAccountId)
    .order("statement_date", { ascending: false })
    .limit(36);
  if (error) throw new Error(error.message);
  const rows = (statements ?? []) as {
    id: string;
    statement_date: string;
    reconciled_at: string | null;
    opening_balance_cents: number | string;
    closing_balance_cents: number | string;
    source: string | null;
  }[];
  if (rows.length === 0) return 0;

  // `deriveFeedBalances` walks newest first and stops at the first statement the manager owns, so only the
  // leading run of unreconciled feed statements can ever be rewritten. Reading the rest of a year's lines
  // on every webhook delivery and every cron run would be egress spent on sums that are then discarded.
  const candidates: typeof rows = [];
  for (const row of rows) {
    if (row.reconciled_at || row.source !== "plaid_feed") break;
    candidates.push(row);
  }
  if (candidates.length === 0) return 0;

  const lines = await readStatementLines(db, candidates.map((r) => r.id));
  const sums = new Map<string, number>();
  const manual = new Set<string>();
  for (const line of lines) {
    sums.set(line.statement_id, (sums.get(line.statement_id) ?? 0) + Number(line.amount_cents));
    if (!line.plaid_transaction_id) manual.add(line.statement_id);
  }

  // Depository: `current` is the money in the account; a positive Plaid balance is a positive book balance.
  const currentCents = Math.round(current * 100);
  const updates = deriveFeedBalances(
    candidates.map((r) => ({
      id: r.id,
      statementDate: r.statement_date,
      reconciled: Boolean(r.reconciled_at),
      feedOwned: r.source === "plaid_feed" && !manual.has(r.id),
      lineSumCents: sums.get(r.id) ?? 0,
      openingBalanceCents: Number(r.opening_balance_cents),
      closingBalanceCents: Number(r.closing_balance_cents),
    })),
    currentCents,
  );
  for (const u of updates) {
    const { error: upError } = await db
      .from("manager_bank_statements")
      .update({ opening_balance_cents: u.openingBalanceCents, closing_balance_cents: u.closingBalanceCents, updated_at: new Date().toISOString() })
      .eq("id", u.id)
      .eq("manager_user_id", args.ownerUserId)
      .eq("source", "plaid_feed")
      .is("reconciled_at", null);
    if (upError) throw new Error(upError.message);
  }
  return updates.length;
}
