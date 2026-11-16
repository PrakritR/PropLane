import { describe, expect, it, vi } from "vitest";
import { createFinanceFakeDb } from "../helpers/finance-fake-db";

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("server-only", () => ({}));

import { billingPeriodKey, findDuplicatePayments, type PaymentFingerprint } from "@/lib/finance/duplicate-payment";
import { recordManualExpense, updateManualExpense } from "@/lib/reports/manual-entries.server";

const MGR = "11111111-1111-4111-8111-111111111111";
const SPU = "Seattle Public Utilities";

/** The real case: October 2026 SPU bills, each paid twice (Oct 29 and Nov 6). */
const octoberPaid = (property: string, cents: number, paidDate: string): PaymentFingerprint => ({
  id: `${property}-${paidDate}`,
  amountCents: cents,
  propertyId: property,
  payeeLabel: SPU,
  paidDate,
  billingPeriodStart: "2026-10-01",
  billingPeriodEnd: "2026-10-31",
});

describe("duplicate payment detection (pure)", () => {
  it("catches the second October SPU payment for 5257 ($525.63, 8 days later) by billing period", () => {
    const first = octoberPaid("5257", 52_563, "2026-10-29");
    const second = octoberPaid("5257", 52_563, "2026-11-06");
    const hits = findDuplicatePayments(second, [first]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: first.id, reason: "same_billing_period" });
  });

  it("catches the second October SPU payment for 4709A ($638.05)", () => {
    const first = octoberPaid("4709A", 63_805, "2026-10-29");
    const second = octoberPaid("4709A", 63_805, "2026-11-06");
    expect(findDuplicatePayments(second, [first])).toHaveLength(1);
  });

  it("does not confuse the two houses or the two amounts", () => {
    const history = [octoberPaid("5257", 52_563, "2026-10-29"), octoberPaid("4709A", 63_805, "2026-10-29")];
    expect(findDuplicatePayments(octoberPaid("4709A", 52_563, "2026-11-06"), history)).toHaveLength(0);
    expect(findDuplicatePayments(octoberPaid("5257", 63_805, "2026-11-06"), history)).toHaveLength(0);
  });

  it("the next month's bill of the same amount is not a duplicate", () => {
    const first = octoberPaid("5257", 52_563, "2026-10-29");
    const november: PaymentFingerprint = { ...octoberPaid("5257", 52_563, "2026-11-29"), id: "n", billingPeriodStart: "2026-11-01", billingPeriodEnd: "2026-11-30" };
    expect(findDuplicatePayments(november, [first])).toHaveLength(0);
  });

  it("without a billing period, a payment within 3 days is flagged and one 4 days later is not", () => {
    const base: PaymentFingerprint = { id: "a", amountCents: 100, payeeLabel: SPU, paidDate: "2026-11-01" };
    expect(findDuplicatePayments({ ...base, id: "b", paidDate: "2026-11-04" }, [base])).toHaveLength(1);
    expect(findDuplicatePayments({ ...base, id: "b", paidDate: "2026-11-05" }, [base])).toHaveLength(0);
  });

  it("matches an older entry that carries only a memo, and a different payee never matches", () => {
    const legacy: PaymentFingerprint = { id: "old", amountCents: 52_563, memo: "Seattle Public Utilities - Oct", paidDate: "2026-10-29" };
    const candidate: PaymentFingerprint = { id: "new", amountCents: 52_563, payeeLabel: SPU, paidDate: "2026-10-30" };
    expect(findDuplicatePayments(candidate, [legacy])).toHaveLength(1);
    expect(findDuplicatePayments({ ...candidate, payeeLabel: "Xfinity" }, [legacy])).toHaveLength(0);
  });

  it("billingPeriodKey is the month of the start, else the end", () => {
    expect(billingPeriodKey("2026-10-01", "2026-10-31")).toBe("2026-10");
    expect(billingPeriodKey(null, "2026-11-30")).toBe("2026-11");
    expect(billingPeriodKey()).toBeNull();
  });
});

describe("duplicate gate on recording a payment", () => {
  const base = { categoryCode: "utilities", payeeLabel: SPU, billingPeriodStart: "2026-10-01", billingPeriodEnd: "2026-10-31", propertyId: "5257" };

  it("records the first payment, refuses the second with a 409 naming the first, and records it only with a reason + audit row", async () => {
    const db = createFinanceFakeDb();
    const first = await recordManualExpense(db as never, MGR, { ...base, amountCents: 52_563, expenseDate: "2026-10-29" });
    expect(first.ok).toBe(true);

    const second = await recordManualExpense(db as never, MGR, { ...base, amountCents: 52_563, expenseDate: "2026-11-06" });
    expect(second).toMatchObject({ ok: false, status: 409, code: "duplicate_payment" });
    if (second.ok) throw new Error("unreachable");
    expect(second.duplicates?.[0]?.paidDate).toBe("2026-10-29");
    expect(db.table("manager_expense_entries")).toHaveLength(1);
    expect(db.table("gl_journal_entries")).toHaveLength(1);

    const tooShort = await recordManualExpense(db as never, MGR, { ...base, amountCents: 52_563, expenseDate: "2026-11-06", duplicateOverrideReason: "ok" });
    expect(tooShort).toMatchObject({ ok: false, status: 409 });

    const forced = await recordManualExpense(db as never, MGR, {
      ...base, amountCents: 52_563, expenseDate: "2026-11-06", duplicateOverrideReason: "Late fee reversed, second invoice is real",
    });
    expect(forced.ok).toBe(true);
    expect(db.table("manager_expense_entries")).toHaveLength(2);
    const audit = db.table("audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "expense_duplicate_override", landlord_id: MGR });
    expect(JSON.stringify(audit[0]!.input_summary)).toContain("second invoice is real");
    expect(db.table("manager_expense_entries")[1]!.duplicate_override_reason).toContain("second invoice");
  });

  it("the 4709A duplicate ($638.05) is refused too, and a different house with the same amount is not", async () => {
    const db = createFinanceFakeDb();
    await recordManualExpense(db as never, MGR, { ...base, propertyId: "4709A", amountCents: 63_805, expenseDate: "2026-10-29" });
    const again = await recordManualExpense(db as never, MGR, { ...base, propertyId: "4709A", amountCents: 63_805, expenseDate: "2026-11-06" });
    expect(again).toMatchObject({ ok: false, status: 409 });
    const otherHouse = await recordManualExpense(db as never, MGR, { ...base, propertyId: "5259", amountCents: 63_805, expenseDate: "2026-11-06" });
    expect(otherHouse.ok).toBe(true);
  });

  it("a Due entry is not checked until it is marked Paid, and marking it Paid runs the check", async () => {
    const db = createFinanceFakeDb();
    await recordManualExpense(db as never, MGR, { ...base, amountCents: 52_563, expenseDate: "2026-10-29" });
    const due = await recordManualExpense(db as never, MGR, {
      ...base, amountCents: 52_563, expenseDate: "2026-11-06", paymentStatus: "due", dueDate: "2026-11-20",
    });
    expect(due.ok).toBe(true);
    if (!due.ok) throw new Error("unreachable");
    const paid = await updateManualExpense(db as never, MGR, { id: String(due.entry.id), paymentStatus: "paid", paidDate: "2026-11-07" });
    expect(paid).toMatchObject({ ok: false, status: 409, code: "duplicate_payment" });
    const forced = await updateManualExpense(db as never, MGR, {
      id: String(due.entry.id), paymentStatus: "paid", paidDate: "2026-11-07", duplicateOverrideReason: "Two separate meters",
    });
    expect(forced.ok).toBe(true);
    expect(db.table("audit_log")).toHaveLength(1);
  });

  it("fails closed when the history cannot be read", async () => {
    const db = createFinanceFakeDb();
    db.failOn("manager_expense_entries", "select", "history down");
    const result = await recordManualExpense(db as never, MGR, { ...base, amountCents: 100, expenseDate: "2026-11-01" });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(db.table("manager_expense_entries")).toHaveLength(0);
  });
});
