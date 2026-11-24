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
        { id: "s-open", manager_user_id: "u1", reconciled_at: null },
        { id: "s-done", manager_user_id: "u1", reconciled_at: "2026-11-01" },
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

  it("never drops a transaction that posts into a fully reconciled month", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [
        { id: "s-closed", manager_user_id: "u1", bank_account_id: "ba-1", statement_date: "2026-10-31", reconciled_at: "2026-11-02", source: "manual" },
      ],
    });
    const result = await applyPlaidChanges(db, item, { added: [txn("late", "2026-10-28", 44)], modified: [], removed: [] });
    expect(result).toMatchObject({ added: 1, skipped: 0 });
    const line = tables.manager_bank_statement_lines![0]!;
    expect(line.plaid_transaction_id).toBe("late");
    // Its own feed-owned statement for that month; the reconciled one is untouched.
    expect(line.statement_id).not.toBe("s-closed");
    const created = tables.manager_bank_statements!.find((s) => s.id === line.statement_id)!;
    expect(created).toMatchObject({ source: "plaid_feed", statement_date: "2026-10-31" });
    expect(created.reconciled_at ?? null).toBeNull();
    expect(tables.manager_bank_statements!.find((s) => s.id === "s-closed")).toMatchObject({ reconciled_at: "2026-11-02" });
    // And a second pass reuses that open statement instead of making another.
    await applyPlaidChanges(db, item, { added: [txn("late2", "2026-10-27", 5)], modified: [], removed: [] });
    expect(tables.manager_bank_statements).toHaveLength(2);
  });

  it("leaves another owner's line alone when a transaction id collides", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [
        { id: "s-mine", manager_user_id: "u1", bank_account_id: "ba-1", statement_date: "2026-11-30", reconciled_at: null, source: "plaid_feed" },
        { id: "s-theirs", manager_user_id: "u2", bank_account_id: "ba-9", statement_date: "2026-11-30", reconciled_at: null, source: "plaid_feed" },
      ],
      manager_bank_statement_lines: [
        { id: "l-theirs", statement_id: "s-theirs", plaid_transaction_id: "shared", amount_cents: -100, description: "Theirs", cleared: false, matched_ledger_entry_id: null, matched_expense_entry_id: null },
      ],
    });
    await applyPlaidChanges(db, item, { added: [txn("shared", "2026-11-14", 9)], modified: [], removed: [] });
    expect(tables.manager_bank_statement_lines!.find((l) => l.id === "l-theirs")).toMatchObject({ amount_cents: -100, description: "Theirs" });
    await applyPlaidChanges(db, item, { added: [], modified: [], removed: [{ transaction_id: "shared" }] });
    expect(tables.manager_bank_statement_lines!.some((l) => l.id === "l-theirs")).toBe(true);
  });

  it("moves a modified line to the statement for its new month, never into a reconciled one", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [
        { id: "s-oct", manager_user_id: "u1", bank_account_id: "ba-1", statement_date: "2026-10-31", reconciled_at: null, source: "plaid_feed" },
        { id: "s-nov-done", manager_user_id: "u1", bank_account_id: "ba-1", statement_date: "2026-11-30", reconciled_at: "2026-12-01", source: "manual" },
      ],
      manager_bank_statement_lines: [
        { id: "l", statement_id: "s-oct", line_date: "2026-10-31", plaid_transaction_id: "t", amount_cents: -100, cleared: false, matched_ledger_entry_id: null, matched_expense_entry_id: null },
      ],
    });
    await applyPlaidChanges(db, item, { added: [], modified: [txn("t", "2026-11-02", 9)], removed: [] });
    const line = tables.manager_bank_statement_lines![0]!;
    expect(line).toMatchObject({ line_date: "2026-11-02", amount_cents: -900 });
    expect(line.statement_id).not.toBe("s-oct");
    expect(line.statement_id).not.toBe("s-nov-done");
    expect(tables.manager_bank_statements!.find((s) => s.id === line.statement_id)).toMatchObject({ statement_date: "2026-11-30", source: "plaid_feed" });
    // Same month: stays put.
    await applyPlaidChanges(db, item, { added: [], modified: [txn("t", "2026-11-05", 9)], removed: [] });
    expect(tables.manager_bank_statements).toHaveLength(3);
  });

  it("does not rewrite a matched line when Plaid modifies it", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [{ id: "s", manager_user_id: "u1", reconciled_at: null }],
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

describe("relink after revoke", () => {
  const relinked = { ...item, id: "p2", institution_name: "Chase", account_mask: "1234" };
  const seed = () =>
    createFakeDb({
      plaid_items: [{ id: "p1", owner_user_id: "u1", bank_account_id: "ba-1", purpose: "bank_feed", status: "revoked", institution_name: "Chase", account_mask: "1234" }],
      manager_bank_statements: [{ id: "s-nov", manager_user_id: "u1", bank_account_id: "ba-1", statement_date: "2026-11-30", reconciled_at: null, source: "plaid_feed" }],
      manager_bank_statement_lines: [
        { id: "old1", statement_id: "s-nov", line_date: "2026-11-02", amount_cents: -1000, description: "Txn a", plaid_transaction_id: "old-a", cleared: false },
        { id: "old2", statement_id: "s-nov", line_date: "2026-11-03", amount_cents: -500, description: "Coffee  Shop", plaid_transaction_id: "old-b", cleared: false },
      ],
    });

  it("does not double-post history the revoked Item already posted", async () => {
    const { db, tables } = seed();
    const result = await applyPlaidChanges(db, relinked, {
      added: [txn("new-a", "2026-11-02", 10, { name: "TXN A" }), txn("new-b", "2026-11-03", 5, { name: "coffee shop" }), txn("new-c", "2026-11-04", 7)],
      modified: [],
      removed: [],
    });
    expect(result).toMatchObject({ added: 1, skipped: 2 });
    expect(tables.manager_bank_statement_lines).toHaveLength(3);
    expect(tables.manager_bank_statement_lines!.some((l) => l.plaid_transaction_id === "new-c")).toBe(true);
  });

  it("matches each old line once, so a genuine second identical purchase still lands", async () => {
    const { db, tables } = seed();
    const result = await applyPlaidChanges(db, relinked, {
      added: [txn("new-a1", "2026-11-02", 10, { name: "Txn a" }), txn("new-a2", "2026-11-02", 10, { name: "Txn a" })],
      modified: [],
      removed: [],
    });
    expect(result).toMatchObject({ added: 1, skipped: 1 });
    expect(tables.manager_bank_statement_lines).toHaveLength(3);
  });

  it("dedupes nothing when no revoked Item shares the institution and mask", async () => {
    const { db } = seed();
    const result = await applyPlaidChanges(db, { ...relinked, account_mask: "9999" }, { added: [txn("n", "2026-11-02", 10, { name: "Txn a" })], modified: [], removed: [] });
    expect(result.added).toBe(1);
  });
});

describe("syncPlaidItem bookkeeping", () => {
  it("stamps the attempt on success and on failure, and logs a secret-safe failure", async () => {
    const fake = createFakeDb();
    const row = await createPlaidItem(fake.db, { ownerUserId: "u1", purpose: "bank_feed", itemId: "i1", accessToken: "access-x", plaidAccountId: "acc-1", bankAccountId: "ba-1" });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(Object.assign(new Error("boom access-x"), { config: { headers: { secret: "S3CRET" } } }));
    await syncPlaidItem(fake.db, row, { client: { transactionsSync: failing } as never });
    expect(typeof fake.tables.plaid_items![0]!.last_sync_attempt_at).toBe("string");
    const logged = JSON.stringify([...warn.mock.calls, ...warn2.mock.calls]);
    expect(logged).toContain("[plaid] sync failed");
    expect(logged).not.toContain("S3CRET");
    warn.mockRestore();
    warn2.mockRestore();
    fake.tables.plaid_items![0]!.last_sync_attempt_at = null;
    const ok = vi.fn().mockResolvedValue({ data: { added: [], modified: [], removed: [], next_cursor: "c", has_more: false } });
    await syncPlaidItem(fake.db, { ...row, status: "active" }, { client: { transactionsSync: ok } as never });
    expect(typeof fake.tables.plaid_items![0]!.last_sync_attempt_at).toBe("string");
  });
});
