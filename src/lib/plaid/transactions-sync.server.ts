import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlaidApi, RemovedTransaction, Transaction } from "plaid";
import { getPlaidClient, plaidFailure } from "@/lib/plaid/client.server";
import { fillFeedStatementBalances } from "@/lib/plaid/statement-balances.server";
import {
  claimPlaidSync,
  readPlaidAccessToken,
  releasePlaidSync,
  updatePlaidItem,
  type PlaidItemRow,
} from "@/lib/plaid/items.server";

export type PlaidSyncResult = {
  status: "synced" | "login_required" | "error" | "busy" | "skipped";
  added: number;
  modified: number;
  removed: number;
  skipped: number;
  errorCode?: string;
};

type SyncDeps = { client?: PlaidApi };

type FeedLine = { lineDate: string; description: string; amountCents: number; plaidTransactionId: string };

/** Plaid reports outflows as positive dollars; a statement line is signed from the account's view. */
export function plaidAmountToCents(amount: number): number {
  const cents = Math.round(Math.abs(amount) * 100);
  return amount > 0 ? -cents : cents;
}

export function plaidTransactionToLine(txn: Transaction): FeedLine {
  return {
    lineDate: (txn.date ?? txn.authorized_date ?? "").slice(0, 10),
    description: (txn.merchant_name || txn.name || "Bank transaction").trim().slice(0, 500) || "Bank transaction",
    amountCents: plaidAmountToCents(txn.amount),
    plaidTransactionId: txn.transaction_id,
  };
}

function monthBounds(date: string): { first: string; last: string } {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { first: `${y}-${mm}-01`, last: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

/**
 * The open statement for this account and month, or a new empty one the feed owns (`source: 'plaid_feed'`,
 * the only marker that lets `fillFeedStatementBalances` derive its balances). An existing statement keeps
 * whatever source it already has: a month the manager created or imported stays theirs even once feed lines
 * land in it, so their typed opening / closing are never rewritten.
 */
async function statementForMonth(
  db: SupabaseClient,
  ownerId: string,
  bankAccountId: string,
  date: string,
): Promise<{ id: string; reconciled: boolean }> {
  const { first, last } = monthBounds(date);
  const { data, error } = await db
    .from("manager_bank_statements")
    .select("id, reconciled_at")
    .eq("manager_user_id", ownerId)
    .eq("bank_account_id", bankAccountId)
    .gte("statement_date", first)
    .lte("statement_date", last)
    .order("statement_date", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: string; reconciled_at: string | null }[];
  const open = rows.find((r) => !r.reconciled_at);
  if (open) return { id: open.id, reconciled: false };
  if (rows.length > 0) return { id: rows[0]!.id, reconciled: true };

  const { data: created, error: createError } = await db
    .from("manager_bank_statements")
    .insert({
      manager_user_id: ownerId,
      bank_account_id: bankAccountId,
      statement_date: last,
      opening_balance_cents: 0,
      closing_balance_cents: 0,
      source: "plaid_feed",
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (createError || !created) throw new Error(createError?.message ?? "Statement create failed.");
  return { id: String(created.id), reconciled: false };
}

type ExistingLine = {
  id: string;
  plaid_transaction_id: string;
  cleared: boolean;
  matched_ledger_entry_id: string | null;
  matched_expense_entry_id: string | null;
  manager_bank_statements: { reconciled_at: string | null } | { reconciled_at: string | null }[] | null;
};

function isLocked(line: ExistingLine): boolean {
  const st = Array.isArray(line.manager_bank_statements) ? line.manager_bank_statements[0] : line.manager_bank_statements;
  return line.cleared || Boolean(line.matched_ledger_entry_id) || Boolean(line.matched_expense_entry_id) || Boolean(st?.reconciled_at);
}

async function loadExisting(db: SupabaseClient, ids: string[]): Promise<Map<string, ExistingLine>> {
  const found = new Map<string, ExistingLine>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db
      .from("manager_bank_statement_lines")
      .select("id, plaid_transaction_id, cleared, matched_ledger_entry_id, matched_expense_entry_id, manager_bank_statements(reconciled_at)")
      .in("plaid_transaction_id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as ExistingLine[]) found.set(row.plaid_transaction_id, row);
  }
  return found;
}

/**
 * Apply one batch of Plaid changes. Idempotent on `plaid_transaction_id`: a replay inserts
 * nothing twice, a modified transaction updates only a line nobody has matched or cleared, and
 * a removed one deletes only a line that is not matched, cleared or on a reconciled statement.
 * Matching stays the manager's: lines land unmatched and the existing suggestion tool proposes.
 */
export async function applyPlaidChanges(
  db: SupabaseClient,
  item: Pick<PlaidItemRow, "owner_user_id" | "bank_account_id" | "plaid_account_id">,
  changes: { added: Transaction[]; modified: Transaction[]; removed: Pick<RemovedTransaction, "transaction_id">[] },
): Promise<{ added: number; modified: number; removed: number; skipped: number }> {
  const counts = { added: 0, modified: 0, removed: 0, skipped: 0 };
  if (!item.bank_account_id) return counts;

  const posted = [...changes.added, ...changes.modified].filter(
    (t) => !t.pending && (!item.plaid_account_id || t.account_id === item.plaid_account_id) && /^\d{4}-\d{2}-\d{2}/.test(t.date ?? ""),
  );
  const byId = new Map<string, Transaction>();
  for (const t of posted) byId.set(t.transaction_id, t);

  const existing = await loadExisting(db, [...byId.keys()]);
  const statementCache = new Map<string, { id: string; reconciled: boolean }>();

  for (const txn of byId.values()) {
    const line = plaidTransactionToLine(txn);
    const current = existing.get(line.plaidTransactionId);
    if (current) {
      if (isLocked(current)) {
        counts.skipped += 1;
        continue;
      }
      const { error } = await db
        .from("manager_bank_statement_lines")
        .update({ line_date: line.lineDate, description: line.description, amount_cents: line.amountCents })
        .eq("id", current.id);
      if (error) throw new Error(error.message);
      counts.modified += 1;
      continue;
    }
    const monthKey = line.lineDate.slice(0, 7);
    let statement = statementCache.get(monthKey);
    if (!statement) {
      statement = await statementForMonth(db, item.owner_user_id, item.bank_account_id, line.lineDate);
      statementCache.set(monthKey, statement);
    }
    if (statement.reconciled) {
      counts.skipped += 1;
      continue;
    }
    // `ignoreDuplicates` returns no row when the line already existed (a concurrent sync inserted it
    // between our read and this write), so count what was actually inserted, never the attempt.
    const { data: inserted, error } = await db
      .from("manager_bank_statement_lines")
      .upsert(
        {
          statement_id: statement.id,
          line_date: line.lineDate,
          description: line.description,
          amount_cents: line.amountCents,
          cleared: false,
          plaid_transaction_id: line.plaidTransactionId,
        },
        { onConflict: "plaid_transaction_id", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(error.message);
    if ((inserted ?? []).length > 0) counts.added += 1;
    else counts.skipped += 1;
  }

  const removedIds = [...new Set(changes.removed.map((r) => r.transaction_id))];
  if (removedIds.length > 0) {
    const existingRemoved = await loadExisting(db, removedIds);
    const deletable = [...existingRemoved.values()].filter((l) => !isLocked(l)).map((l) => l.id);
    counts.skipped += existingRemoved.size - deletable.length;
    for (let i = 0; i < deletable.length; i += 100) {
      const { error } = await db.from("manager_bank_statement_lines").delete().in("id", deletable.slice(i, i + 100));
      if (error) throw new Error(error.message);
    }
    counts.removed += deletable.length;
  }
  return counts;
}

/** Pull every page of changes since the stored cursor, apply them, then advance the cursor. */
export async function syncPlaidItem(db: SupabaseClient, item: PlaidItemRow, deps: SyncDeps = {}): Promise<PlaidSyncResult> {
  const empty = { added: 0, modified: 0, removed: 0, skipped: 0 };
  if (item.purpose !== "bank_feed" || !item.bank_account_id || item.status === "revoked") return { status: "skipped", ...empty };
  if (!(await claimPlaidSync(db, item.id))) return { status: "busy", ...empty };

  try {
    const client = deps.client ?? getPlaidClient();
    const accessToken = readPlaidAccessToken(item);
    const startCursor = item.transactions_cursor ?? undefined;
    const totals = { ...empty };

    // A mutation during pagination restarts the walk from the cursor we began with.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let cursor = startCursor;
      const added: Transaction[] = [];
      const modified: Transaction[] = [];
      const removed: Pick<RemovedTransaction, "transaction_id">[] = [];
      try {
        for (let page = 0; page < 200; page += 1) {
          const res = await client.transactionsSync({ access_token: accessToken, cursor, count: 500 });
          added.push(...res.data.added);
          modified.push(...res.data.modified);
          removed.push(...res.data.removed);
          cursor = res.data.next_cursor;
          if (!res.data.has_more) break;
        }
      } catch (error) {
        if (plaidFailure(error).code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < 2) continue;
        throw error;
      }
      const applied = await applyPlaidChanges(db, item, { added, modified, removed });
      totals.added += applied.added;
      totals.modified += applied.modified;
      totals.removed += applied.removed;
      totals.skipped += applied.skipped;
      try {
        await fillFeedStatementBalances(db, client, {
          accessToken,
          plaidAccountId: item.plaid_account_id,
          ownerUserId: item.owner_user_id,
          bankAccountId: item.bank_account_id,
        });
      } catch {
        /* balances are a convenience; the lines are what the sync owes */
      }
      await updatePlaidItem(db, item.id, {
        transactions_cursor: cursor ?? null,
        status: "active",
        last_error: null,
        last_synced_at: new Date().toISOString(),
      });
      return { status: "synced", ...totals };
    }
    return { status: "error", ...totals, errorCode: "MUTATION_DURING_PAGINATION" };
  } catch (error) {
    const failure = plaidFailure(error);
    const loginRequired = failure.code === "ITEM_LOGIN_REQUIRED";
    try {
      await updatePlaidItem(db, item.id, {
        status: loginRequired ? "login_required" : "error",
        last_error: loginRequired ? "ITEM_LOGIN_REQUIRED" : failure.code,
      });
    } catch {
      /* the original failure is the one worth reporting */
    }
    return { status: loginRequired ? "login_required" : "error", ...empty, errorCode: failure.code };
  } finally {
    await releasePlaidSync(db, item.id);
  }
}
