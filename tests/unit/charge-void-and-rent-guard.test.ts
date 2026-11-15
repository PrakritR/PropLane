import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({ cancelFuturePaymentRemindersForCharge: async () => undefined }));
vi.mock("@/lib/domain-action-events.server", () => ({ emitHouseholdChargeTransition: async () => undefined }));

import { voidPaidCharge } from "@/lib/household-charge-void.server";
import { syncLedgerChargeEntry, syncLedgerPaymentEntry } from "@/lib/reports/ledger-sync";
import { runRecurringRentSweep } from "@/lib/recurring-rent-cron.server";
import {
  householdChargeManagerBucket,
  householdChargeToLedgerRow,
  isUnpaidHouseholdCharge,
  rentPeriodAlreadyCovered,
  type HouseholdCharge,
} from "@/lib/household-charges";

const OWNER = "11111111-1111-4111-8111-111111111111";
const CO_MANAGER = "22222222-2222-4222-8222-222222222222";
const EMAIL = "fekadu@example.test";

let tables: Record<string, Row[]>;

/** The fake has no column defaults; the real table defaults `is_reversal` to false. */
function makeDb() {
  const base = fakeSupabaseClient(tables);
  return {
    from(table: string) {
      const q = base.from(table) as unknown as { insert: (r: Row | Row[]) => unknown };
      if (table === "gl_journal_entries") {
        const insert = q.insert.bind(q);
        q.insert = (r) => insert(Array.isArray(r) ? r.map((x) => ({ is_reversal: false, ...x })) : { is_reversal: false, ...r });
      }
      return q;
    },
  } as never;
}

function paidRent(over: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "hc_rent_paid_dec",
    createdAt: "2026-11-01T00:00:00.000Z",
    residentEmail: EMAIL,
    residentName: "Fekadu",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Sweep House",
    managerUserId: OWNER,
    kind: "rent",
    title: "Rent - December 2026",
    amountLabel: "$1,000.00",
    balanceLabel: "$0.00",
    status: "paid",
    paidAt: "2026-11-05T12:00:00.000Z",
    paidMethod: "Cash",
    rentMonth: "2026-12",
    ...over,
  } as HouseholdCharge;
}

async function seedPaid(charge: HouseholdCharge) {
  tables.portal_household_charge_records.push({
    id: charge.id, manager_user_id: OWNER, property_id: charge.propertyId, kind: charge.kind, status: "paid",
    row_data: charge, updated_at: "2026-11-05T12:00:00.000Z",
  });
  await syncLedgerChargeEntry(makeDb(), charge);
  await syncLedgerPaymentEntry(makeDb(), charge, charge.paidAt);
}

function accountNet(account: string): number {
  const entries = new Map(tables.gl_journal_entries.map((e) => [e.id, e]));
  return tables.gl_journal_lines
    .filter((l) => l.account_code === account && entries.has(l.journal_entry_id))
    .reduce((sum, l) => sum + Number(l.debit_cents) - Number(l.credit_cents), 0);
}

beforeEach(() => {
  tables = {
    portal_household_charge_records: [], audit_log: [], ledger_entries: [], gl_journal_entries: [], gl_journal_lines: [],
    portal_recurring_rent_profile_records: [], manager_application_records: [],
  };
});

describe("void a paid charge", () => {
  it("flips the status, keeps the row, audits it and reverses the books to zero", async () => {
    const charge = paidRent();
    await seedPaid(charge);
    expect(tables.ledger_entries.filter((e) => e.entry_type === "payment")).toHaveLength(1);
    expect(accountNet("operating_cash")).toBe(100_000);

    const result = await voidPaidCharge(makeDb(), { chargeId: charge.id, actorUserId: OWNER, reason: "Entered twice", now: "2026-11-14T10:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.providerPayment).toBe(false);

    const row = tables.portal_household_charge_records[0]!;
    expect(row.status).toBe("void");
    const stored = row.row_data as HouseholdCharge;
    expect(stored).toMatchObject({ status: "void", voidReason: "Entered twice", voidedBy: OWNER, voidedAt: "2026-11-14T10:00:00.000Z", balanceLabel: "$0.00" });
    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log[0]).toMatchObject({ action: "charge_voided", actor_user_id: OWNER });
    // Subledger lines for the charge are gone, so every total read from them excludes it.
    expect(tables.ledger_entries.filter((e) => e.source_charge_id === charge.id)).toHaveLength(0);
    // Original journals stay; the reversals are balanced and net every account to zero.
    expect(tables.gl_journal_entries.filter((e) => e.is_reversal === true)).toHaveLength(2);
    for (const account of ["operating_cash", "accounts_receivable"]) expect(accountNet(account)).toBe(0);
    const debits = tables.gl_journal_lines.reduce((s, l) => s + Number(l.debit_cents), 0);
    const credits = tables.gl_journal_lines.reduce((s, l) => s + Number(l.credit_cents), 0);
    expect(debits).toBe(credits);
  });

  it("is idempotent and never double-reverses", async () => {
    const charge = paidRent();
    await seedPaid(charge);
    await voidPaidCharge(makeDb(), { chargeId: charge.id, actorUserId: OWNER, reason: "Entered twice" });
    const again = await voidPaidCharge(makeDb(), { chargeId: charge.id, actorUserId: OWNER, reason: "Entered twice" });
    expect(again.ok && again.alreadyVoid).toBe(true);
    expect(tables.gl_journal_entries.filter((e) => e.is_reversal === true)).toHaveLength(2);
    expect(tables.audit_log).toHaveLength(1);
  });

  it("refuses a co-manager, a missing reason, an unpaid charge and a security deposit", async () => {
    const charge = paidRent();
    await seedPaid(charge);
    expect(await voidPaidCharge(makeDb(), { chargeId: charge.id, actorUserId: CO_MANAGER, reason: "Entered twice" })).toMatchObject({ ok: false, status: 403 });
    expect(await voidPaidCharge(makeDb(), { chargeId: charge.id, actorUserId: OWNER, reason: "  " })).toMatchObject({ ok: false, status: 400 });
    tables.portal_household_charge_records.push({ id: "pending-1", manager_user_id: OWNER, status: "pending", row_data: { ...charge, id: "pending-1", status: "pending" }, updated_at: "x" });
    expect(await voidPaidCharge(makeDb(), { chargeId: "pending-1", actorUserId: OWNER, reason: "Entered twice" })).toMatchObject({ ok: false, status: 409 });
    tables.portal_household_charge_records.push({ id: "dep-1", manager_user_id: OWNER, status: "paid", row_data: { ...charge, id: "dep-1", kind: "security_deposit" }, updated_at: "x" });
    expect(await voidPaidCharge(makeDb(), { chargeId: "dep-1", actorUserId: OWNER, reason: "Entered twice" })).toMatchObject({ ok: false, status: 409 });
    expect(tables.portal_household_charge_records.find((r) => r.id === charge.id)!.status).toBe("paid");
  });

  it("does not refund: it only flags that a real card payment is behind the charge", async () => {
    const charge = paidRent({ paidMethod: undefined, stripeCheckoutSessionId: "cs_test_1" });
    await seedPaid(charge);
    const result = await voidPaidCharge(makeDb(), { chargeId: charge.id, actorUserId: OWNER, reason: "Wrong tenant" });
    expect(result.ok && result.providerPayment).toBe(true);
    expect(tables.ledger_entries.filter((e) => e.entry_type === "refund")).toHaveLength(0);
  });

  it("flips the manager totals: a void row counts for $0, is struck, and is never unpaid", () => {
    const voided = paidRent({ status: "void", balanceLabel: "$0.00", voidReason: "Entered twice" });
    const row = householdChargeToLedgerRow(voided);
    expect(row).toMatchObject({ voided: true, lineAmount: "$0.00", voidedLineAmount: "$1,000.00", statusLabel: "Void", voidReason: "Entered twice" });
    expect(householdChargeManagerBucket(voided)).toBe("paid");
    expect(isUnpaidHouseholdCharge(voided)).toBe(false);
    expect(householdChargeToLedgerRow(paidRent()).lineAmount).toBe("$1,000.00");
  });
});

describe("recurring rent guard", () => {
  const NOW = new Date(2026, 10, 14, 13, 0, 0); // Nov 14 2026: this month + December
  function seedProfile(extra: Record<string, unknown> = {}) {
    tables.portal_recurring_rent_profile_records.push({
      id: "rp-1", manager_user_id: OWNER, active: true, updated_at: "2026-11-01T00:00:00.000Z",
      row_data: {
        id: "rp-1", residentEmail: EMAIL, residentName: "Fekadu", residentUserId: null, propertyId: "prop-1",
        propertyLabel: "Sweep House", roomLabel: "Room 4", managerUserId: OWNER, monthlyRent: 1000, dueDay: 1,
        startMonth: "2026-11", active: true, ...extra,
      },
    });
  }
  const rentMonths = () =>
    tables.portal_household_charge_records.map((r) => (r.row_data as { rentMonth?: string }).rentMonth).sort();

  it("two sweeps for the same period create one charge each", async () => {
    seedProfile();
    const first = await runRecurringRentSweep(makeDb(), NOW);
    const second = await runRecurringRentSweep(makeDb(), NOW);
    expect(first.errors).toEqual([]);
    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    expect(rentMonths()).toEqual(["2026-11", "2026-12"]);
    expect(tables.portal_household_charge_records[0]!.row_data).toMatchObject({ roomLabel: "Room 4" });
  });

  it("a manual December charge blocks the automatic December cycle (any id, any email case, no room)", async () => {
    seedProfile();
    tables.portal_household_charge_records.push({
      id: "manual-dec", manager_user_id: OWNER, status: "pending",
      row_data: { ...paidRent({ id: "manual-dec", status: "pending", balanceLabel: "$1,000.00", residentEmail: "Fekadu@Example.test" }) },
    });
    const result = await runRecurringRentSweep(makeDb(), NOW);
    expect(result.created).toBe(1);
    const auto = tables.portal_household_charge_records.filter((r) => r.id !== "manual-dec");
    expect(auto.map((r) => (r.row_data as { rentMonth: string }).rentMonth)).toEqual(["2026-11"]);
  });

  it("a voided manual December charge does not block the cycle", async () => {
    seedProfile();
    tables.portal_household_charge_records.push({
      id: "manual-dec", manager_user_id: OWNER, status: "void",
      row_data: { ...paidRent({ id: "manual-dec", status: "void", balanceLabel: "$0.00" }) },
    });
    await runRecurringRentSweep(makeDb(), NOW);
    expect(rentMonths()).toEqual(["2026-11", "2026-12", "2026-12"]);
  });

  it("covers by room: a charge naming another room does not cover this one", () => {
    const other = paidRent({ roomLabel: "Room 9" });
    const target = { residentEmail: EMAIL, propertyId: "prop-1", rentMonth: "2026-12", managerUserId: OWNER };
    expect(rentPeriodAlreadyCovered([other], { ...target, roomLabel: "Room 4" })).toBe(false);
    expect(rentPeriodAlreadyCovered([other], { ...target, roomLabel: "Room 9" })).toBe(true);
    expect(rentPeriodAlreadyCovered([paidRent()], { ...target, roomLabel: "Room 4" })).toBe(true);
  });
});
