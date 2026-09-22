// PLAN-0920-2357: the assistant tools follow the same two rules as the
// Payments screens — the resident's `list_my_charges` hides a not-yet-due
// charge until it is within the 7-day window (unless the manager surfaced it
// via `residentVisibleAt`), and the manager's `list_charges` flags a charge
// belonging to a later calendar month as `upcoming`. Relative dates so the
// scenario never rots.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMyChargesTool } from "@/lib/tools/domains/resident/balance";
import { listChargesTool } from "@/lib/tools/domains/payments";
import { makeResidentToolCtx, type FakeRow } from "./fake-resident-ctx";
import { makeManagerRowsCtx, managerRow } from "./fake-agent-ctx";

const RES = { id: "resident_a", email: "resa@axis.test" };
const MANAGER = "manager_1";

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function label(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Charges dated relative to a fixed "today" that sits mid-month. */
const NOW = new Date(2026, 8, 21, 12, 0, 0); // Sep 21, 2026 — Oct 1 is 10 days out
const dueIn3 = new Date(2026, 8, 24);
const nextMonthFirst = new Date(2026, 9, 1);
const overdueDue = new Date(2026, 8, 11);

function rowData(id: string, extra: Record<string, unknown>) {
  return {
    id,
    residentEmail: RES.email,
    residentName: "Res A",
    residentUserId: RES.id,
    propertyId: "prop_1",
    propertyLabel: "Maple House",
    managerUserId: MANAGER,
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...extra,
  };
}
function residentRow(id: string, extra: Record<string, unknown>): FakeRow {
  return {
    id,
    manager_user_id: MANAGER,
    resident_user_id: RES.id,
    resident_email: RES.email,
    status: "pending",
    row_data: rowData(id, extra),
  };
}

const CHARGES = {
  overdue: { kind: "late_fee", sourceChargeId: "paid-aug", title: "Late fee", dueDateLabel: label(overdueDue) },
  dueSoon: { kind: "utilities", rentMonth: ymd(NOW), title: "Utilities — September", dueDateLabel: label(dueIn3) },
  nextRent: { kind: "rent", rentMonth: ymd(nextMonthFirst), dueDay: 1, title: "Rent — October" },
  surfaced: {
    kind: "work_order_charge",
    workOrderId: "wo_1",
    title: "Drain repair (shared cost)",
    dueDateLabel: label(nextMonthFirst),
    residentVisibleAt: "2026-09-20T18:00:00.000Z",
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("resident list_my_charges — visibility window", () => {
  it("omits next month's rent (10 days out) but keeps the overdue, due-in-3-days, and manager-surfaced charges", async () => {
    const { ctx } = makeResidentToolCtx({
      profiles: [{ id: RES.id, email: RES.email, full_name: "Res A", role: "resident" }],
      portal_household_charge_records: Object.entries(CHARGES).map(([id, extra]) => residentRow(id, extra)),
      ledger_entries: [],
    });
    const res = (await listMyChargesTool.handler(ctx, {})) as { count: number; charges: { id: string }[] };
    expect(res.charges.map((c) => c.id).sort()).toEqual(["dueSoon", "overdue", "surfaced"]);
    expect(res.count).toBe(3);
    expect(JSON.stringify(res)).not.toContain("Rent — October");
  });

  it("shows next month's rent once inside the 7-day window", async () => {
    vi.setSystemTime(new Date(2026, 8, 25, 12)); // Sep 25 — 6 days before Oct 1
    const { ctx } = makeResidentToolCtx({
      profiles: [{ id: RES.id, email: RES.email, full_name: "Res A", role: "resident" }],
      portal_household_charge_records: [residentRow("nextRent", CHARGES.nextRent)],
      ledger_entries: [],
    });
    const res = (await listMyChargesTool.handler(ctx, {})) as { charges: { id: string }[] };
    expect(res.charges.map((c) => c.id)).toEqual(["nextRent"]);
  });
});

describe("manager list_charges — upcoming flag", () => {
  it("flags only the charges belonging to a later calendar month", async () => {
    // `makeManagerRowsCtx` scopes reads to landlord "manager_a".
    const ctx = makeManagerRowsCtx({
      portal_household_charge_records: Object.entries(CHARGES).map(([id, extra]) =>
        managerRow("manager_a", rowData(id, { ...extra, managerUserId: "manager_a" })),
      ),
    });
    const res = (await listChargesTool.handler(ctx, {})) as { charges: { id: string; upcoming: boolean }[] };
    const byId = Object.fromEntries(res.charges.map((c) => [c.id, c.upcoming]));
    expect(byId).toEqual({ overdue: false, dueSoon: false, nextRent: true, surfaced: true });
  });
});
