import { describe, expect, it, vi, beforeEach } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";

vi.mock("@/lib/reports/ledger-sync", () => ({
  syncLedgerPaymentEntry: vi.fn().mockResolvedValue(undefined),
}));

import { markHouseholdChargePaidFromStripeSession } from "@/lib/stripe-household-charge";
import { MAX_BULK_CHARGES } from "@/lib/stripe-household-charge-checkout.server";
import {
  RESIDENT_PAY_MAX_CHARGES,
  buildResidentStaySummary,
  residentStayRowIdForKind,
} from "@/lib/resident-stay-summary";

function charge(over: Partial<HouseholdCharge> & { id: string }): HouseholdCharge {
  return {
    createdAt: "2026-09-01T00:00:00.000Z",
    residentEmail: "maya@example.com",
    residentName: "Maya Chen",
    residentUserId: "res-maya",
    propertyId: "prop-1",
    propertyLabel: "4709A 8th Ave NE",
    managerUserId: "mgr_a",
    kind: "rent",
    title: "Charge",
    amountLabel: "$100.00",
    balanceLabel: over.amountLabel ?? "$100.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    axisPaymentsEnabledSnapshot: true,
    managerStripeConnectReadySnapshot: true,
    ...over,
  };
}

describe("resident stay summary", () => {
  const stay = [
    charge({ id: "first", kind: "first_month_rent", amountLabel: "$1,100.00" }),
    charge({ id: "prorated", kind: "prorated_rent", amountLabel: "$405.50" }),
    charge({ id: "dep", kind: "security_deposit", amountLabel: "$800.00" }),
    charge({ id: "fee", kind: "move_in_fee", amountLabel: "$250.00" }),
    charge({ id: "clean", kind: "other_cost", amountLabel: "$150.00" }),
  ];

  it("groups the server's charges into stay, deposit and additional charges", () => {
    const s = buildResidentStaySummary(stay);
    expect(s.rows.map((r) => [r.id, r.cents, r.chargeIds])).toEqual([
      ["stay", 150550, ["first", "prorated"]],
      ["deposit", 80000, ["dep"]],
      ["additional", 40000, ["fee", "clean"]],
    ]);
    expect(s.totalDueCents).toBe(270550);
    expect(s.payCents).toBe(270550);
    expect(s.remainingCount).toBe(0);
  });

  it("totals only what is payable: paid, processing, cancelled and unpayable lines stay out", () => {
    const s = buildResidentStaySummary([
      ...stay,
      charge({ id: "paid", kind: "rent", status: "paid", amountLabel: "$999.00", balanceLabel: "$0.00" }),
      charge({ id: "clearing", kind: "rent", status: "processing", amountLabel: "$700.00" }),
      charge({ id: "void", kind: "other_cost", status: "void", amountLabel: "$60.00" }),
      charge({ id: "noaxis", kind: "other_cost", amountLabel: "$60.00", axisPaymentsEnabledSnapshot: false }),
    ]);
    expect(s.totalDueCents).toBe(270550);
    expect(s.payChargeIds.sort()).toEqual(["clean", "dep", "fee", "first", "prorated"]);
  });

  it("a custom-date surcharge rides inside the one stay total the server billed", () => {
    const s = buildResidentStaySummary([charge({ id: "st", kind: "stay_total", amountLabel: "$1,234.56" })]);
    expect(s.rows).toEqual([{ id: "stay", label: "Stay", cents: 123456, chargeIds: ["st"] }]);
  });

  it("is empty when nothing is owed", () => {
    const s = buildResidentStaySummary([charge({ id: "p", status: "paid", balanceLabel: "$0.00" })]);
    expect(s).toMatchObject({ rows: [], totalDueCents: 0, payChargeIds: [], payCents: 0 });
  });

  it("one Pay covers exactly the due charges, capped at one checkout's limit, soonest due first", () => {
    expect(RESIDENT_PAY_MAX_CHARGES).toBe(MAX_BULK_CHARGES);
    const many = Array.from({ length: 12 }, (_, i) =>
      charge({ id: `c${String(i).padStart(2, "0")}`, kind: "other_cost", amountLabel: "$10.00", createdAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    const s = buildResidentStaySummary(many.reverse());
    expect(s.payChargeIds).toHaveLength(MAX_BULK_CHARGES);
    expect(s.payChargeIds[0]).toBe("c00");
    expect(s.payCents).toBe(10000);
    expect(s.totalDueCents).toBe(12000);
    expect(s.remainingCount).toBe(2);
  });

  it("classifies kinds: rent-class is the stay, deposits are deposits, the rest is additional", () => {
    expect(residentStayRowIdForKind("rent")).toBe("stay");
    expect(residentStayRowIdForKind("security_deposit")).toBe("deposit");
    expect(residentStayRowIdForKind("late_fee")).toBe("additional");
    expect(residentStayRowIdForKind("work_order_charge")).toBe("additional");
  });
});

// The combined checkout bills one session for the due charges (one line each - the deposit is its
// own line); the webhook marks each charge from that session's charge_ids, never the client.
type Row = { id: string; row_data: HouseholdCharge; status: string };
function makeDb(charges: HouseholdCharge[], failOn: string[] = []) {
  const rows = new Map<string, Row>(charges.map((c) => [c.id, { id: c.id, row_data: c, status: c.status }]));
  const writes: Array<{ id: string; status: string }> = [];
  const db = {
    from() {
      return {
        select() {
          return {
            eq(_c: string, val: string) {
              return { maybeSingle: async () => ({ data: rows.get(val) ?? null, error: null }) };
            },
          };
        },
        upsert: async (row: Record<string, unknown>) => {
          if (failOn.includes(row.id as string)) return { error: { message: "write failed" } };
          writes.push({ id: row.id as string, status: row.status as string });
          const existing = rows.get(row.id as string);
          if (existing) {
            existing.status = row.status as string;
            existing.row_data = row.row_data as HouseholdCharge;
          }
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, writes, rows };
}
const paidSession = (ids: string[]) =>
  ({
    id: "cs_test_all",
    payment_status: "paid",
    metadata: { purpose: "household_charge", charge_ids: ids.join(","), manager_user_id: "mgr_a" },
  }) as unknown as Stripe.Checkout.Session;

describe("combined checkout settlement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks each included charge, deposit too, paid exactly once even when the webhook redelivers", async () => {
    const charges = [
      charge({ id: "first", kind: "first_month_rent" }),
      charge({ id: "dep", kind: "security_deposit" }),
      charge({ id: "fee", kind: "move_in_fee" }),
    ];
    const { db, writes } = makeDb(charges);
    const session = paidSession(["first", "dep", "fee"]);
    const one = await markHouseholdChargePaidFromStripeSession(db, session);
    expect(one.ok).toBe(true);
    expect(writes.filter((w) => w.status === "paid").map((w) => w.id).sort()).toEqual(["dep", "fee", "first"]);
    const before = writes.length;
    await markHouseholdChargePaidFromStripeSession(db, session);
    expect(writes.length).toBe(before);
  });

  it("leaves a charge outside the session untouched", async () => {
    const { db, writes } = makeDb([
      charge({ id: "first", kind: "first_month_rent" }),
      charge({ id: "later", kind: "other_cost" }),
    ]);
    await markHouseholdChargePaidFromStripeSession(db, paidSession(["first"]));
    expect(writes.map((w) => w.id)).toEqual(["first"]);
  });

  it("a charge that cannot be marked does not disturb the others", async () => {
    const { db, rows } = makeDb(
      [charge({ id: "a", kind: "first_month_rent" }), charge({ id: "b", kind: "security_deposit" }), charge({ id: "c", kind: "other_cost" })],
      ["b"],
    );
    const result = await markHouseholdChargePaidFromStripeSession(db, paidSession(["a", "b", "c"])).catch(() => null);
    void result;
    // The failing charge is not paid; the charges after it in the session are still settled.
    expect(rows.get("b")!.status).not.toBe("paid");
    expect(rows.get("a")!.status).toBe("paid");
    expect(rows.get("c")!.status).toBe("paid");
  });
});
