import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { applyPlaidChanges, plaidAmountToCents, syncPlaidItem } from "@/lib/plaid/transactions-sync.server";
import { createPlaidItem } from "@/lib/plaid/items.server";
import { createFakeDb } from "./fake-db";

process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = "test";
process.env.DATA_ENCRYPTION_KEYS_JSON = JSON.stringify({ test: randomBytes(32).toString("base64") });

const item = { owner_user_id: "u1", bank_account_id: "ba-1", plaid_account_id: "acc-1" };
const txn = (id: string, date: string, amount: number, extra: Record<string, unknown> = {}) =>
  ({ transaction_id: id, account_id: "acc-1", date, amount, name: `Txn ${id}`, pending: false, ...extra }) as never;

describe("plaidAmountToCents", () => {
  it("flips Plaid's sign: outflow positive becomes negative cents", () => {
    expect(plaidAmountToCents(212.4)).toBe(-21240);
    expect(plaidAmountToCents(-1450)).toBe(145000);
  });
});

describe("applyPlaidChanges", () => {
  it("is idempotent on plaid_transaction_id and uses one statement per month", async () => {
    const { db, tables } = createFakeDb();
    const changes = { added: [txn("t1", "2026-11-14", 212.4), txn("t2", "2026-11-13", -3120.55), txn("t3", "2026-10-30", 5)], modified: [], removed: [] };
    const first = await applyPlaidChanges(db, item, changes);
    const second = await applyPlaidChanges(db, item, changes);
    expect(first.added).toBe(3);
    expect(tables.manager_bank_statement_lines).toHaveLength(3);
    expect(tables.manager_bank_statements).toHaveLength(2);
    expect(second.added).toBe(0);
    expect(second.modified).toBe(3);
    expect(tables.manager_bank_statement_lines).toHaveLength(3);
  });

  it("ignores pending and other accounts", async () => {
    const { db, tables } = createFakeDb();
    await applyPlaidChanges(db, item, { added: [txn("p", "2026-11-14", 1, { pending: true }), txn("o", "2026-11-14", 1, { account_id: "other" })], modified: [], removed: [] });
    expect(tables.manager_bank_statement_lines).toHaveLength(0);
  });

  it("removes only lines that are not matched, cleared or reconciled", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [
        { id: "s-open", reconciled_at: null },
        { id: "s-done", reconciled_at: "2026-11-01" },
      ],
      manager_bank_statement_lines: [
        { id: "l1", statement_id: "s-open", plaid_transaction_id: "free", cleared: false, matched_ledger_entry_id: null, matched_expense_entry_id: null },
        { id: "l2", statement_id: "s-open", plaid_transaction_id: "matched", cleared: false, matched_ledger_entry_id: "le-1", matched_expense_entry_id: null },
        { id: "l3", statement_id: "s-open", plaid_transaction_id: "cleared", cleared: true, matched_ledger_entry_id: null, matched_expense_entry_id: null },
        { id: "l4", statement_id: "s-done", plaid_transaction_id: "locked", cleared: false, matched_ledger_entry_id: null, matched_expense_entry_id: null },
      ],
    });
    const result = await applyPlaidChanges(db, item, { added: [], modified: [], removed: ["free", "matched", "cleared", "locked"].map((transaction_id) => ({ transaction_id })) });
    expect(result.removed).toBe(1);
    expect(tables.manager_bank_statement_lines!.map((l) => l.id).sort()).toEqual(["l2", "l3", "l4"]);
  });

  it("does not rewrite a matched line when Plaid modifies it", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [{ id: "s", reconciled_at: null }],
      manager_bank_statement_lines: [{ id: "l", statement_id: "s", plaid_transaction_id: "t", amount_cents: -100, cleared: false, matched_ledger_entry_id: "le", matched_expense_entry_id: null }],
    });
    const r = await applyPlaidChanges(db, item, { added: [], modified: [txn("t", "2026-11-14", 9)], removed: [] });
    expect(r.skipped).toBe(1);
    expect(tables.manager_bank_statement_lines![0]!.amount_cents).toBe(-100);
  });
});

describe("syncPlaidItem", () => {
  async function setup() {
    const fake = createFakeDb();
    const row = await createPlaidItem(fake.db, { ownerUserId: "u1", purpose: "bank_feed", itemId: "i1", accessToken: "access-x", plaidAccountId: "acc-1", bankAccountId: "ba-1" });
    return { ...fake, row };
  }

  it("walks pages, stores the cursor and marks the item active", async () => {
    const { db, tables, row } = await setup();
    const transactionsSync = vi
      .fn()
      .mockResolvedValueOnce({ data: { added: [txn("a", "2026-11-02", 10)], modified: [], removed: [], next_cursor: "c1", has_more: true } })
      .mockResolvedValueOnce({ data: { added: [txn("b", "2026-11-03", 20)], modified: [], removed: [], next_cursor: "c2", has_more: false } });
    const result = await syncPlaidItem(db, row, { client: { transactionsSync } as never });
    expect(result).toMatchObject({ status: "synced", added: 2 });
    expect(tables.plaid_items![0]).toMatchObject({ transactions_cursor: "c2", status: "active", sync_lock_until: null });
    expect(transactionsSync.mock.calls[1]![0].cursor).toBe("c1");
  });

  it("marks login_required on ITEM_LOGIN_REQUIRED", async () => {
    const { db, tables, row } = await setup();
    const transactionsSync = vi.fn().mockRejectedValue({ response: { status: 400, data: { error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR", error_message: "x" } } });
    const result = await syncPlaidItem(db, row, { client: { transactionsSync } as never });
    expect(result.status).toBe("login_required");
    expect(tables.plaid_items![0]).toMatchObject({ status: "login_required", last_error: "ITEM_LOGIN_REQUIRED" });
  });

  it("marks error on any other failure and keeps the cursor", async () => {
    const { db, tables, row } = await setup();
    const transactionsSync = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await syncPlaidItem(db, row, { client: { transactionsSync } as never });
    expect(result.status).toBe("error");
    expect(tables.plaid_items![0]).toMatchObject({ status: "error" });
    expect(tables.plaid_items![0]!.transactions_cursor ?? null).toBeNull();
  });
});
