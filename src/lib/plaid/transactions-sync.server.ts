import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlaidApi, RemovedTransaction, Transaction } from "plaid";
import { getPlaidClient, logPlaidFailure, plaidFailure } from "@/lib/plaid/client.server";
import { fillFeedStatementBalances } from "@/lib/plaid/statement-balances.server";
import {
  claimPlaidSync,
  isRelinkAfterRevoke,
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

/** The month-end of the month that follows this date's month. */
function nextMonthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/**
 * The open statement for this account and month, or a new empty one the feed owns (`source: 'plaid_feed'`,
 * the only marker that lets `fillFeedStatementBalances` derive its balances). An existing statement keeps
 * whatever source it already has: a month the manager created or imported stays theirs even once feed lines
 * land in it, so their typed opening / closing are never rewritten.
 *
 * A bank item that posts late into a month whose every statement is already reconciled lands on the EARLIEST
 * open statement after that month instead, keeping its own line date. The cursor advances once a batch is
 * applied, so the line would otherwise be dropped for good - and a second statement sharing the reconciled
 * one's month end would leave `fillFeedStatementBalances` two rows with the same date to chain through, which
 * is how a money screen ends up showing a balance matching nothing. The reconciled statement is never touched.
 */
async function statementForMonth(
  db: SupabaseClient,
  ownerId: string,
  bankAccountId: string,
  date: string,
): Promise<{ id: string }> {
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
  if (open) return { id: open.id };
  if (rows.length > 0) return openStatementAfterMonth(db, ownerId, bankAccountId, last);
  return createFeedStatement(db, ownerId, bankAccountId, last);
}

/** The earliest open statement after a closed month, else a new feed statement dated after every statement there is. */
async function openStatementAfterMonth(
  db: SupabaseClient,
  ownerId: string,
  bankAccountId: string,
  monthEnd: string,
): Promise<{ id: string }> {
  const afterMonth = nextMonthEnd(monthEnd).slice(0, 8) + "01";
  const { data, error } = await db
    .from("manager_bank_statements")
    .select("id, statement_date")
    .eq("manager_user_id", ownerId)
    .eq("bank_account_id", bankAccountId)
    .gte("statement_date", afterMonth)
    .is("reconciled_at", null)
    .order("statement_date", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const next = (data ?? []) as { id: string }[];
  if (next[0]) return { id: String(next[0].id) };

  const { data: newest, error: newestError } = await db
    .from("manager_bank_statements")
    .select("statement_date")
    .eq("manager_user_id", ownerId)
    .eq("bank_account_id", bankAccountId)
    .order("statement_date", { ascending: false })
    .limit(1);
  if (newestError) throw new Error(newestError.message);
  const latest = String(((newest ?? []) as { statement_date: string }[])[0]?.statement_date ?? monthEnd).slice(0, 10);
  return createFeedStatement(db, ownerId, bankAccountId, nextMonthEnd(latest >= monthEnd ? latest : monthEnd));
}

async function createFeedStatement(
  db: SupabaseClient,
  ownerId: string,
  bankAccountId: string,
  statementDate: string,
): Promise<{ id: string }> {
  const { data: created, error: createError } = await db
    .from("manager_bank_statements")
    .insert({
      manager_user_id: ownerId,
      bank_account_id: bankAccountId,
      statement_date: statementDate,
      opening_balance_cents: 0,
      closing_balance_cents: 0,
      source: "plaid_feed",
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (createError || !created) throw new Error(createError?.message ?? "Statement create failed.");
  return { id: String(created.id) };
}

type ExistingLine = {
  id: string;
  statement_id: string;
  line_date: string;
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

/**
 * The lines these Plaid transaction ids already own, scoped through their statement to ONE owner. Plaid's
 * transaction ids are globally unique, but the update and delete below name rows by id alone, so the scope
 * is what keeps a collision (or an id replayed from another owner's item) from rewriting someone else's
 * statement: an inner join on `manager_bank_statements.manager_user_id` means a foreign line is simply not
 * found, and nothing here touches it.
 *
 * Not finding it is not the same as being able to insert it: `plaid_transaction_id` is unique across the
 * WHOLE table, so an id another owner already holds makes this sync's insert a no-op. That transaction is
 * counted as skipped and reported by `logConflictedInserts`, never silently dropped.
 */
async function loadExisting(db: SupabaseClient, ownerId: string, ids: string[]): Promise<Map<string, ExistingLine>> {
  const found = new Map<string, ExistingLine>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db
      .from("manager_bank_statement_lines")
      .select("id, statement_id, line_date, plaid_transaction_id, cleared, matched_ledger_entry_id, matched_expense_entry_id, manager_bank_statements!inner(reconciled_at, manager_user_id)")
      .eq("manager_bank_statements.manager_user_id", ownerId)
      .in("plaid_transaction_id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as ExistingLine[]) found.set(row.plaid_transaction_id, row);
  }
  return found;
}

/** The identity of a statement line apart from its Plaid id: date, signed cents and a normalized description. */
export function feedLineContentKey(line: { lineDate: string; amountCents: number; description: string }): string {
  const text = line.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${line.lineDate.slice(0, 10)}|${line.amountCents}|${text}`;
}

/**
 * After a relink, the feed lines this account already holds (under the revoked Item's transaction ids), as a
 * multiset of content keys over the incoming date span. Each incoming line consumes at most one, so two real
 * same-day same-amount purchases still land twice when two were already there twice.
 *
 * Only the FIRST sync of the new Item reads this (see `applyPlaidChanges`): that is the one batch Plaid replays
 * history in, and once the Item has its own cursor every later batch is new activity whose content may legitimately
 * repeat a line this same Item already posted.
 */
async function loadRelinkBaseline(
  db: SupabaseClient,
  ownerId: string,
  bankAccountId: string,
  fromDate: string,
  toDate: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("manager_bank_statement_lines")
      .select("id, line_date, amount_cents, description, plaid_transaction_id, manager_bank_statements!inner(manager_user_id, bank_account_id)")
      .eq("manager_bank_statements.manager_user_id", ownerId)
      .eq("manager_bank_statements.bank_account_id", bankAccountId)
      .gte("line_date", fromDate)
      .lte("line_date", toDate)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as { line_date: string; amount_cents: number; description: string; plaid_transaction_id: string | null }[];
    for (const r of rows) {
      if (!r.plaid_transaction_id) continue;
      const key = feedLineContentKey({ lineDate: String(r.line_date), amountCents: Number(r.amount_cents), description: String(r.description ?? "") });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (rows.length < pageSize) break;
  }
  return counts;
}

/**
 * Apply one batch of Plaid changes. Idempotent on `plaid_transaction_id`: a replay inserts
 * nothing twice, a modified transaction updates only a line nobody has matched or cleared, and
 * a removed one deletes only a line that is not matched, cleared or on a reconciled statement.
 * Matching stays the manager's: lines land unmatched and the existing suggestion tool proposes.
 */
export async function applyPlaidChanges(
  db: SupabaseClient,
  item: Pick<PlaidItemRow, "owner_user_id" | "bank_account_id" | "plaid_account_id"> &
    Partial<Pick<PlaidItemRow, "id" | "account_mask" | "institution_name" | "transactions_cursor">>,
  changes: { added: Transaction[]; modified: Transaction[]; removed: Pick<RemovedTransaction, "transaction_id">[] },
): Promise<{ added: number; modified: number; removed: number; skipped: number }> {
  const counts = { added: 0, modified: 0, removed: 0, skipped: 0 };
  if (!item.bank_account_id) return counts;

  const posted = [...changes.added, ...changes.modified].filter(
    (t) => !t.pending && (!item.plaid_account_id || t.account_id === item.plaid_account_id) && /^\d{4}-\d{2}-\d{2}/.test(t.date ?? ""),
  );
  const byId = new Map<string, Transaction>();
  for (const t of posted) byId.set(t.transaction_id, t);

  const existing = await loadExisting(db, item.owner_user_id, [...byId.keys()]);
  const statementCache = new Map<string, { id: string }>();
  let conflicted = 0;
  // Relink after a revoke: dedupe the replayed history against the lines the old Item already posted. Only on this
  // Item's FIRST batch (no cursor yet) — a revoked sibling row stays there for good, and from the second batch on an
  // incoming line that matches an existing one is a real second transaction, not the replay.
  let relinkBaseline: Map<string, number> | null = null;
  const incoming = [...byId.values()].filter((t) => !existing.has(t.transaction_id));
  if (incoming.length > 0 && !item.transactions_cursor && (await isRelinkAfterRevoke(db, item))) {
    const dates = incoming.map((t) => t.date.slice(0, 10)).sort();
    relinkBaseline = await loadRelinkBaseline(db, item.owner_user_id, item.bank_account_id, dates[0]!, dates[dates.length - 1]!);
  }

  for (const txn of byId.values()) {
    const line = plaidTransactionToLine(txn);
    const current = existing.get(line.plaidTransactionId);
    if (current) {
      if (isLocked(current)) {
        counts.skipped += 1;
        continue;
      }
      // A modified transaction can post in another month; the line follows it. `statementForMonth` never
      // returns a reconciled statement (it carries the line to the next open one), the same as the insert path.
      const patch: Record<string, unknown> = { line_date: line.lineDate, description: line.description, amount_cents: line.amountCents };
      if (String(current.line_date ?? "").slice(0, 7) !== line.lineDate.slice(0, 7)) {
        const monthKey = line.lineDate.slice(0, 7);
        let target = statementCache.get(monthKey);
        if (!target) {
          target = await statementForMonth(db, item.owner_user_id, item.bank_account_id, line.lineDate);
          statementCache.set(monthKey, target);
        }
        patch.statement_id = target.id;
      }
      const { error } = await db.from("manager_bank_statement_lines").update(patch).eq("id", current.id);
      if (error) throw new Error(error.message);
      counts.modified += 1;
      continue;
    }
    if (relinkBaseline) {
      const key = feedLineContentKey(line);
      const left = relinkBaseline.get(key) ?? 0;
      if (left > 0) {
        relinkBaseline.set(key, left - 1);
        counts.skipped += 1;
        continue;
      }
    }
    const monthKey = line.lineDate.slice(0, 7);
    let statement = statementCache.get(monthKey);
    if (!statement) {
      statement = await statementForMonth(db, item.owner_user_id, item.bank_account_id, line.lineDate);
      statementCache.set(monthKey, statement);
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
    else {
      counts.skipped += 1;
      conflicted += 1;
    }
  }
  logConflictedInserts(item.owner_user_id, conflicted);

  const removedIds = [...new Set(changes.removed.map((r) => r.transaction_id))];
  if (removedIds.length > 0) {
    const existingRemoved = await loadExisting(db, item.owner_user_id, removedIds);
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

/**
 * A line this owner does not already hold, which the unique `plaid_transaction_id` still refused: either a
 * concurrent sync of this same item won the race (harmless) or another owner's item holds that id, in which
 * case the transaction is dropped for good while the cursor moves on. One line per batch, so neither is silent.
 */
function logConflictedInserts(ownerUserId: string, conflicted: number): void {
  if (conflicted > 0) console.warn("[plaid] feed lines refused by an existing transaction id", { ownerUserId, conflicted });
}

/** Pull every page of changes since the stored cursor, apply them, then advance the cursor. */
export async function syncPlaidItem(db: SupabaseClient, item: PlaidItemRow, deps: SyncDeps = {}): Promise<PlaidSyncResult> {
  const empty = { added: 0, modified: 0, removed: 0, skipped: 0 };
  if (item.purpose !== "bank_feed" || !item.bank_account_id || item.status === "revoked") return { status: "skipped", ...empty };
  // The claim runs before the try/finally that owns the release, so its own failure is answered here:
  // a throw from this line would escape the whole function and, in the cron's loop, take every item
  // after this one down with it.
  let claimed = false;
  try {
    claimed = await claimPlaidSync(db, item.id);
  } catch (error) {
    return { status: "error", ...empty, errorCode: plaidFailure(error).code };
  }
  if (!claimed) return { status: "busy", ...empty };

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
      } catch (error) {
        // Balances are a convenience; the lines are what the sync owes. But a statement the feed just created
        // opens and closes at zero until this fills it, so a silent failure reads as a whole month out of
        // balance with nothing to explain it.
        logPlaidFailure("[plaid] statement balances failed", error);
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
    logPlaidFailure("[plaid] sync failed", error);
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
