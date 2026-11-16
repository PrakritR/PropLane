import { describe, expect, it, vi } from "vitest";
import { createFinanceFakeDb } from "../helpers/finance-fake-db";

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("server-only", () => ({}));

import { advanceRecurrenceDate, PAYMENT_METHOD_LABELS, recurrenceDatesThrough } from "@/lib/finance/payment-fields";
import { createRecurringPayable, generateDueRecurringEntries, updateRecurringPayable } from "@/lib/finance/recurring-payables.server";
import { updateManualExpense } from "@/lib/reports/manual-entries.server";

const MGR = "11111111-1111-4111-8111-111111111111";
const OPEN_SCOPE = { propertyIds: null, includeUntagged: true };
const OWNER_PAYMENT = { label: "Owner payment - Ambika", amountCents: 800_000, categoryCode: "mortgage", frequency: "monthly", nextDate: "2026-12-01", paymentMethod: "p2p_transfer" };

describe("recurrence dates (pure)", () => {
  it("steps weekly, monthly, quarterly and annual, and holds the anchor day across short months", () => {
    expect(advanceRecurrenceDate("2026-11-04", "weekly")).toBe("2026-11-11");
    expect(advanceRecurrenceDate("2026-11-01", "monthly")).toBe("2026-12-01");
    expect(advanceRecurrenceDate("2026-12-01", "quarterly")).toBe("2027-03-01");
    expect(advanceRecurrenceDate("2026-11-15", "annual")).toBe("2027-11-15");
    expect(advanceRecurrenceDate("2026-01-31", "monthly", 31)).toBe("2026-02-28");
    expect(advanceRecurrenceDate("2026-02-28", "monthly", 31)).toBe("2026-03-31");
  });

  it("lists occurrences up to a date and the end date", () => {
    expect(recurrenceDatesThrough("2026-12-01", "monthly", "2027-03-15")).toEqual(["2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"]);
    expect(recurrenceDatesThrough("2026-12-01", "monthly", "2027-03-15", "2027-01-15")).toEqual(["2026-12-01", "2027-01-01"]);
  });

  it("payment-method labels are generic (no named payment network)", () => {
    expect(PAYMENT_METHOD_LABELS.p2p_transfer).toBe("Bank app / P2P transfer");
    expect(Object.values(PAYMENT_METHOD_LABELS).join(" ")).not.toMatch(/zelle|venmo/i);
  });
});

describe("recurring payables", () => {
  it("creates the $8,000 monthly owner payment and generates a Due entry that posts as an accrual", async () => {
    const db = createFinanceFakeDb();
    const created = await createRecurringPayable(db as never, MGR, OWNER_PAYMENT, OPEN_SCOPE);
    expect(created.ok).toBe(true);
    const summary = await generateDueRecurringEntries(db as never, "2026-11-28");
    expect(summary).toMatchObject({ payables: 1, generated: 1, errors: [] });
    const entry = db.table("manager_expense_entries")[0]!;
    expect(entry).toMatchObject({ amount_cents: 800_000, payment_status: "due", due_date: "2026-12-01", payment_method: "p2p_transfer", category_code: "mortgage" });
    expect(entry.recurring_payable_id).toBe(db.table("manager_recurring_payables")[0]!.id);
    expect(db.table("manager_recurring_payables")[0]!.next_date).toBe("2027-01-01");
    // accrual: DR mortgage / CR accounts payable, balanced
    expect(db.table("gl_journal_lines").map((l) => `${l.account_code}:${l.debit_cents}/${l.credit_cents}`)).toEqual(["mortgage:800000/0", "accounts_payable:0/800000"]);
  });

  it("is idempotent: running again the same day generates nothing, and a second run next month adds one entry", async () => {
    const db = createFinanceFakeDb();
    await createRecurringPayable(db as never, MGR, OWNER_PAYMENT, OPEN_SCOPE);
    await generateDueRecurringEntries(db as never, "2026-11-28");
    const again = await generateDueRecurringEntries(db as never, "2026-11-28");
    expect(again.generated).toBe(0);
    const january = await generateDueRecurringEntries(db as never, "2026-12-29");
    expect(january.generated).toBe(1);
    expect(db.table("manager_expense_entries").map((e) => e.due_date)).toEqual(["2026-12-01", "2027-01-01"]);
  });

  it("an occurrence that already has its entry is skipped but the schedule still advances", async () => {
    const db = createFinanceFakeDb();
    const created = await createRecurringPayable(db as never, MGR, OWNER_PAYMENT, OPEN_SCOPE);
    if (!created.ok) throw new Error("setup");
    db.table("manager_expense_entries").push({ id: "pre", manager_user_id: MGR, recurring_payable_id: created.value.id, due_date: "2026-12-01", amount_cents: 800_000 });
    const summary = await generateDueRecurringEntries(db as never, "2026-11-28");
    expect(summary).toMatchObject({ generated: 0, skipped: 1 });
    expect(db.table("manager_recurring_payables")[0]!.next_date).toBe("2027-01-01");
  });

  it("ends once the end date passes, and does not generate past it", async () => {
    const db = createFinanceFakeDb();
    await createRecurringPayable(db as never, MGR, { ...OWNER_PAYMENT, endDate: "2027-01-01" }, OPEN_SCOPE);
    const summary = await generateDueRecurringEntries(db as never, "2027-03-01");
    expect(summary.generated).toBe(2);
    expect(summary.ended).toBe(1);
    expect(db.table("manager_recurring_payables")[0]!.status).toBe("ended");
    expect((await generateDueRecurringEntries(db as never, "2027-06-01")).generated).toBe(0);
  });

  it("a paused schedule generates nothing until resumed", async () => {
    const db = createFinanceFakeDb();
    const created = await createRecurringPayable(db as never, MGR, OWNER_PAYMENT, OPEN_SCOPE);
    if (!created.ok) throw new Error("setup");
    await updateRecurringPayable(db as never, MGR, created.value.id, { status: "paused" }, OPEN_SCOPE);
    expect((await generateDueRecurringEntries(db as never, "2026-12-02")).generated).toBe(0);
    await updateRecurringPayable(db as never, MGR, created.value.id, { status: "active" }, OPEN_SCOPE);
    expect((await generateDueRecurringEntries(db as never, "2026-12-02")).generated).toBe(1);
  });

  it("marking the generated entry Paid records the payment method and settles accounts payable against cash", async () => {
    const db = createFinanceFakeDb();
    await createRecurringPayable(db as never, MGR, OWNER_PAYMENT, OPEN_SCOPE);
    await generateDueRecurringEntries(db as never, "2026-11-28");
    const id = String(db.table("manager_expense_entries")[0]!.id);
    const paid = await updateManualExpense(db as never, MGR, { id, paymentStatus: "paid", paidDate: "2026-12-01", paymentMethod: "p2p_transfer" });
    expect(paid).toMatchObject({ ok: true });
    expect(db.table("manager_expense_entries")[0]).toMatchObject({ payment_status: "paid", paid_date: "2026-12-01" });
    const lines = db.table("gl_journal_lines");
    expect(lines.reduce((s, l) => s + Number(l.debit_cents), 0)).toBe(lines.reduce((s, l) => s + Number(l.credit_cents), 0));
    expect(lines.map((l) => l.account_code)).toContain("operating_cash");
  });

  it("validates input and refuses a foreign payee", async () => {
    const db = createFinanceFakeDb({ manager_payees: [{ id: "00000000-0000-4000-8000-0000000000aa", manager_user_id: "someone-else", name: "X", archived_at: null }] });
    expect(await createRecurringPayable(db as never, MGR, { ...OWNER_PAYMENT, frequency: "daily" }, OPEN_SCOPE)).toMatchObject({ ok: false, status: 400 });
    expect(await createRecurringPayable(db as never, MGR, { ...OWNER_PAYMENT, amountCents: 0 }, OPEN_SCOPE)).toMatchObject({ ok: false, status: 400 });
    expect(await createRecurringPayable(db as never, MGR, { ...OWNER_PAYMENT, endDate: "2026-01-01" }, OPEN_SCOPE)).toMatchObject({ ok: false, status: 400 });
    expect(await createRecurringPayable(db as never, MGR, { ...OWNER_PAYMENT, paymentMethod: "carrier pigeon" }, OPEN_SCOPE)).toMatchObject({ ok: false, status: 400 });
    expect(await createRecurringPayable(db as never, MGR, { ...OWNER_PAYMENT, payeeId: "00000000-0000-4000-8000-0000000000aa" }, OPEN_SCOPE)).toMatchObject({ ok: false, status: 404 });
  });
});
