import { describe, expect, it, vi } from "vitest";
import { createFinanceFakeDb } from "../helpers/finance-fake-db";

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("server-only", () => ({}));

import { deleteManualExpenseGl, recordManualExpense, recordManualIncome, updateManualExpense } from "@/lib/reports/manual-entries.server";
import { backfillGlFromSources, repairManualEntryGl } from "@/lib/reports/gl-posting";
import { queryGeneralLedger } from "@/lib/reports/queries/gl-reports";

const MGR = "11111111-1111-4111-8111-111111111111";

function sums(db: ReturnType<typeof createFinanceFakeDb>) {
  const lines = db.table("gl_journal_lines");
  const debit = lines.reduce((s, l) => s + Number(l.debit_cents), 0);
  const credit = lines.reduce((s, l) => s + Number(l.credit_cents), 0);
  return { debit, credit, n: lines.length };
}

describe("manual entries post to the General Ledger (write-through)", () => {
  it("a manual expense posts a balanced journal DR expense / CR cash and appears in the GL report", async () => {
    const db = createFinanceFakeDb();
    const result = await recordManualExpense(db as never, MGR, {
      amountCents: 52_563, categoryCode: "utilities", expenseDate: "2026-11-02", memo: "SPU Oct", propertyId: "prop-1",
    });
    expect(result.ok).toBe(true);
    expect(db.table("gl_journal_entries")).toHaveLength(1);
    const totals = sums(db);
    expect(totals).toEqual({ debit: 52_563, credit: 52_563, n: 2 });
    const report = await queryGeneralLedger(db as never, MGR, { from: "2026-01-01", to: "2026-11-15" } as never);
    expect(report.rows.length).toBe(2);
    expect(report.rows.some((r) => r.debit === 525.63 || String(r.debit).includes("525.63"))).toBe(true);
  });

  it("a manual income entry posts DR cash / CR income and links the ledger row to its journal", async () => {
    const db = createFinanceFakeDb();
    const result = await recordManualIncome(db as never, MGR, {
      amountCents: 80_000, categoryCode: "other_income", postedDate: "2026-11-01", description: "Misc", propertyId: "prop-1",
    });
    expect(result.ok).toBe(true);
    expect(sums(db)).toEqual({ debit: 80_000, credit: 80_000, n: 2 });
    const ledger = db.table("ledger_entries")[0]!;
    expect(ledger.gl_journal_entry_id).toBe(db.table("gl_journal_entries")[0]!.id);
  });

  it("rolls the entry back when the journal cannot be posted (nothing half-saved)", async () => {
    const db = createFinanceFakeDb();
    db.failOn("gl_journal_lines", "insert", "boom");
    const result = await recordManualExpense(db as never, MGR, { amountCents: 1000, categoryCode: "utilities", expenseDate: "2026-11-02" });
    expect(result.ok).toBe(false);
    expect(db.table("manager_expense_entries")).toHaveLength(0);
    expect(db.table("gl_journal_entries")).toHaveLength(0);
  });

  it("editing the amount re-derives the journal; deleting the entry removes it", async () => {
    const db = createFinanceFakeDb();
    const made = await recordManualExpense(db as never, MGR, { amountCents: 10_000, categoryCode: "utilities", expenseDate: "2026-11-02" });
    if (!made.ok) throw new Error("setup");
    const id = String(made.entry.id);
    const edited = await updateManualExpense(db as never, MGR, { id, amountCents: 12_500 });
    expect(edited).toMatchObject({ ok: true });
    expect(sums(db)).toEqual({ debit: 12_500, credit: 12_500, n: 2 });
    expect(db.table("gl_journal_entries")).toHaveLength(1);
    await deleteManualExpenseGl(db as never, MGR, { id });
    expect(db.table("gl_journal_entries")).toHaveLength(0);
  });

  it("a Due entry accrues DR expense / CR accounts payable; marking it Paid settles AP against cash", async () => {
    const db = createFinanceFakeDb();
    const made = await recordManualExpense(db as never, MGR, {
      amountCents: 800_000, categoryCode: "mortgage", expenseDate: "2026-12-01", paymentStatus: "due", dueDate: "2026-12-01",
    });
    if (!made.ok) throw new Error("setup");
    const accounts = () => db.table("gl_journal_lines").map((l) => `${l.account_code}:${l.debit_cents}/${l.credit_cents}`);
    expect(accounts()).toEqual(["mortgage:800000/0", "accounts_payable:0/800000"]);
    const paid = await updateManualExpense(db as never, MGR, { id: String(made.entry.id), paymentStatus: "paid", paidDate: "2026-12-02", paymentMethod: "p2p_transfer" });
    expect(paid).toMatchObject({ ok: true });
    expect(accounts()).toEqual(["mortgage:800000/0", "accounts_payable:0/800000", "accounts_payable:800000/0", "operating_cash:0/800000"]);
    expect(sums(db).debit).toBe(sums(db).credit);
  });

  it("an expense settled by a paid bill is never re-posted by an edit or the repair sweep", async () => {
    const db = createFinanceFakeDb({
      manager_expense_entries: [{ id: "exp-bill", manager_user_id: MGR, category_code: "maintenance", amount_cents: 5000, expense_date: "2026-11-01", payment_status: "paid" }],
      manager_bills: [{ id: "bill-1", manager_user_id: MGR, paid_expense_entry_id: "exp-bill" }],
    });
    const edited = await updateManualExpense(db as never, MGR, { id: "exp-bill", amountCents: 6000 });
    expect(edited).toMatchObject({ ok: true });
    expect(db.table("gl_journal_entries")).toHaveLength(0);
    const repair = await repairManualEntryGl(db as never, { managerUserId: MGR });
    expect(repair.posted).toBe(0);
  });
});

describe("repairManualEntryGl backfill", () => {
  function seeded() {
    return createFinanceFakeDb({
      manager_expense_entries: [
        { id: "e1", manager_user_id: MGR, category_code: "utilities", amount_cents: 41_247, expense_date: "2026-11-02", property_id: "p1", payment_status: "paid" },
        { id: "e2", manager_user_id: MGR, category_code: "utilities", amount_cents: 20_000, expense_date: "2026-11-03", property_id: "p1", payment_status: "paid" },
        { id: "e3", manager_user_id: MGR, category_code: "maintenance", amount_cents: 1000, expense_date: "2026-11-03", source_work_order_id: "wo1", payment_status: "paid" },
      ],
      ledger_entries: [
        { id: "l1", manager_user_id: MGR, entry_type: "payment", category_code: "other_income", amount_cents: 30_000, posted_date: "2026-11-01", property_id: "p1", source_charge_id: null, gl_journal_entry_id: null },
        { id: "l2", manager_user_id: MGR, entry_type: "payment", category_code: "rent_income", amount_cents: 99_000, posted_date: "2026-11-01", source_charge_id: "c1", gl_journal_entry_id: null },
      ],
    });
  }

  it("dry run reports and writes nothing", async () => {
    const db = seeded();
    const r = await repairManualEntryGl(db as never, { managerUserId: MGR, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, wouldPost: 3, posted: 0 });
    expect(db.table("gl_journal_entries")).toHaveLength(0);
  });

  it("posts every manual expense and manual income once, skipping sourced rows; a second run posts nothing", async () => {
    const db = seeded();
    const first = await repairManualEntryGl(db as never, { managerUserId: MGR });
    expect(first.posted).toBe(3);
    expect(first.failed).toBe(0);
    const totals = sums(db);
    expect(totals.debit).toBe(totals.credit);
    expect(totals.debit).toBe(41_247 + 20_000 + 30_000);
    const second = await repairManualEntryGl(db as never, { managerUserId: MGR });
    expect(second.posted).toBe(0);
    expect(db.table("gl_journal_entries")).toHaveLength(3);
    const report = await queryGeneralLedger(db as never, MGR, { from: "2026-01-01", to: "2026-11-15" } as never);
    expect(report.rows.length).toBe(6);
  });

  it("the admin backfill sweep includes manual income and stays idempotent", async () => {
    const db = seeded();
    await backfillGlFromSources(db as never, MGR);
    const n = db.table("gl_journal_entries").length;
    await backfillGlFromSources(db as never, MGR);
    expect(db.table("gl_journal_entries")).toHaveLength(n);
  });
});
