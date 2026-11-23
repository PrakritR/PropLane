import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { deriveFeedBalances, fillFeedStatementBalances, type FeedStatement } from "@/lib/plaid/statement-balances.server";
import { createFakeDb } from "./fake-db";

function st(id: string, lineSumCents: number, extra: Partial<FeedStatement> = {}): FeedStatement {
  return { id, statementDate: "2026-11-30", reconciled: false, feedOwned: true, lineSumCents, openingBalanceCents: 0, closingBalanceCents: 0, ...extra };
}

describe("deriveFeedBalances", () => {
  it("walks back from the current balance, newest month first", () => {
    const updates = deriveFeedBalances([st("nov", -10_000), st("oct", 25_000)], 100_000);
    expect(updates).toEqual([
      { id: "nov", openingBalanceCents: 110_000, closingBalanceCents: 100_000 },
      { id: "oct", openingBalanceCents: 85_000, closingBalanceCents: 110_000 },
    ]);
  });

  it("never touches a reconciled month or anything older", () => {
    const updates = deriveFeedBalances([st("nov", -10_000), st("oct", 5_000, { reconciled: true }), st("sep", 1_000)], 100_000);
    expect(updates.map((u) => u.id)).toEqual(["nov"]);
  });

  it("stops at a month holding a line the manager typed", () => {
    const updates = deriveFeedBalances([st("nov", 0, { feedOwned: false }), st("oct", 1)], 50_000);
    expect(updates).toEqual([]);
  });

  it("writes nothing when the balances already agree", () => {
    expect(deriveFeedBalances([st("nov", -500, { openingBalanceCents: 1_500, closingBalanceCents: 1_000 })], 1_000)).toEqual([]);
  });
});

describe("fillFeedStatementBalances", () => {
  const accountsGet = (current: number) =>
    ({ accountsGet: vi.fn(async () => ({ data: { accounts: [{ account_id: "acc-1", balances: { current } }] } })) }) as never;
  const args = { accessToken: "t", plaidAccountId: "acc-1", ownerUserId: "u1", bankAccountId: "ba-1" };
  const statement = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    manager_user_id: "u1",
    bank_account_id: "ba-1",
    statement_date: "2026-11-30",
    reconciled_at: null,
    opening_balance_cents: 0,
    closing_balance_cents: 0,
    source: "manual",
    ...extra,
  });

  it("derives balances onto a statement the feed created", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [statement("s1", { source: "plaid_feed" })],
      manager_bank_statement_lines: [{ id: "l1", statement_id: "s1", amount_cents: -10_000, plaid_transaction_id: "t1" }],
    });
    expect(await fillFeedStatementBalances(db, accountsGet(1000), args)).toBe(1);
    expect(tables.manager_bank_statements![0]).toMatchObject({ opening_balance_cents: 110_000, closing_balance_cents: 100_000 });
  });

  it("never rewrites a statement the manager made by hand, lines or not", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [statement("s1", { opening_balance_cents: 500, closing_balance_cents: 900 })],
      manager_bank_statement_lines: [],
    });
    expect(await fillFeedStatementBalances(db, accountsGet(1000), args)).toBe(0);
    expect(tables.manager_bank_statements![0]).toMatchObject({ opening_balance_cents: 500, closing_balance_cents: 900 });
  });

  it("reads no lines at all when the newest statement is not the feed's to rewrite", async () => {
    const { db } = createFakeDb({
      manager_bank_statements: [
        statement("s2", { statement_date: "2026-11-30", reconciled_at: "2026-12-01T00:00:00.000Z", source: "plaid_feed" }),
        statement("s1", { statement_date: "2026-10-31", source: "plaid_feed" }),
      ],
      manager_bank_statement_lines: [{ id: "l1", statement_id: "s1", amount_cents: -10_000, plaid_transaction_id: "t1" }],
    });
    const read: string[] = [];
    const spied = { from: (table: string) => (read.push(table), (db as unknown as { from: (t: string) => unknown }).from(table)) } as never;
    expect(await fillFeedStatementBalances(spied, accountsGet(1000), args)).toBe(0);
    expect(read).not.toContain("manager_bank_statement_lines");
  });

  it("never rewrites a hand-made statement that feed lines later landed in", async () => {
    const { db, tables } = createFakeDb({
      manager_bank_statements: [statement("s1", { opening_balance_cents: 500, closing_balance_cents: 900 })],
      manager_bank_statement_lines: [{ id: "l1", statement_id: "s1", amount_cents: -10_000, plaid_transaction_id: "t1" }],
    });
    expect(await fillFeedStatementBalances(db, accountsGet(1000), args)).toBe(0);
    expect(tables.manager_bank_statements![0]).toMatchObject({ opening_balance_cents: 500, closing_balance_cents: 900 });
  });
});
