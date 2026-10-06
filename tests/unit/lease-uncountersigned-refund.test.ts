import { describe, expect, it, vi } from "vitest";
import {
  listUncountersignedLeasesPastDeadline,
  refundUncountersignedMoveInCharges,
  UNCOUNTER_SIGN_REFUND_AFTER_DAYS,
} from "@/lib/lease-uncountersigned-refund.server";

describe("lease uncountersigned refund policy", () => {
  it("uses a 45-day manager countersign window", () => {
    expect(UNCOUNTER_SIGN_REFUND_AFTER_DAYS).toBe(45);
  });
});

/**
 * `row_data` carries the uploaded lease PDF as a base64 data URL plus the
 * generated HTML, so the daily cron must not page the whole table and filter in
 * JS - that pulls every lease in the product through the egress budget.
 */
describe("the daily scan narrows in the database", () => {
  type Filter = { op: string; column: string; value: unknown };

  function recordingDb(rows: Record<string, unknown>[]) {
    const filters: Filter[] = [];
    const db = {
      from: () => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (column: string, value: unknown) => (filters.push({ op: "eq", column, value }), q),
          lte: (column: string, value: unknown) => (filters.push({ op: "lte", column, value }), q),
          is: (column: string, value: unknown) => (filters.push({ op: "is", column, value }), q),
          order: () => q,
          range: () => q,
          then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
            Promise.resolve({ data: rows, error: null }).then(resolve),
        };
        return q;
      },
    };
    return { db: db as never, filters };
  }

  const now = new Date("2026-10-03T00:00:00.000Z");
  const cutoffIso = new Date(now.getTime() - UNCOUNTER_SIGN_REFUND_AFTER_DAYS * 86_400_000).toISOString();

  it("asks only for leases awaiting a countersignature past the deadline", async () => {
    const { db, filters } = recordingDb([]);
    await listUncountersignedLeasesPastDeadline(db, now);
    expect(filters).toEqual(
      expect.arrayContaining([
        { op: "eq", column: "row_data->>status", value: "Manager Signature Pending" },
        { op: "lte", column: "row_data->residentSignature->>signedAtIso", value: cutoffIso },
      ]),
    );
  });

  it("still re-checks every condition on what comes back", async () => {
    const stale = {
      id: "lease-stale",
      manager_user_id: "mgr-1",
      resident_email: "r@x.co",
      row_data: {
        status: "Manager Signature Pending",
        residentSignature: { signedAtIso: "2026-01-01T00:00:00.000Z" },
        residentEmail: "r@x.co",
        residentName: "Rae",
        axisId: "AXIS-APP-1",
      },
    };
    // A row the query would not have matched, returned anyway: the JS checks
    // are what keep a narrowed query from ever widening the answer.
    const countersigned = { ...stale, id: "lease-done", row_data: { ...stale.row_data, managerSignature: { signedAtIso: "2026-02-01T00:00:00.000Z" } } };
    const fresh = { ...stale, id: "lease-fresh", row_data: { ...stale.row_data, residentSignature: { signedAtIso: now.toISOString() } } };
    const { db } = recordingDb([stale, countersigned, fresh]);
    const out = await listUncountersignedLeasesPastDeadline(db, now);
    expect(out.map((lease) => lease.leaseId)).toEqual(["lease-stale"]);
  });
});

/**
 * The cron voids the lease and reports it refunded. If a move-in charge is still
 * holding the resident's money, voiding says the opposite of what happened — so a
 * refusal that needs review fails the lease closed, exactly as a throw used to,
 * while the refunds that did succeed stay recorded.
 *
 * A skip is NOT a refusal: `decideChargeRefund` skips a `security_deposit` (Return
 * deposit owns it) and an already-refunded charge, and no money is outstanding for
 * either. Treating those as "still held" would stall every lease forever.
 */
describe("a move-in charge that still holds money blocks the void", () => {
  type ChargeRow = { id: string; status: string; row_data: Record<string, unknown> };

  const lease = {
    id: "lease-1",
    manager_user_id: "mgr-1",
    resident_email: "r@x.co",
    row_data: {
      status: "Manager Signature Pending",
      residentSignature: { signedAtIso: "2026-01-01T00:00:00.000Z" },
      residentEmail: "r@x.co",
      residentName: "Rae",
    },
  };

  function paidCharge(id: string, kind: string): ChargeRow {
    return { id, status: "paid", row_data: { id, kind, residentEmail: "r@x.co", amountLabel: "$1,000.00" } };
  }

  function harness(charges: ChargeRow[]) {
    const voided: string[] = [];
    const refundedIds: string[] = [];
    const db = {
      from: (table: string) => {
        let wantedId: string | null = null;
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (column: string, value: unknown) => {
            if (column === "id" || column === "source_charge_id") wantedId = String(value);
            return q;
          },
          lte: () => q,
          is: () => q,
          filter: () => q,
          order: () => q,
          range: () => q,
          maybeSingle: async () => ({
            data: table === "ledger_entries"
              ? { stripe_charge_id: `ch_${wantedId}`, amount_cents: 100_000 }
              : table === "portal_lease_pipeline_records"
                ? lease
                : charges.find((c) => c.id === wantedId) ?? null,
            error: null,
          }),
          update: () => q,
          upsert: async (row: Record<string, unknown>) => {
            if (table === "portal_household_charge_records") refundedIds.push(String(row.id));
            if (table === "portal_lease_pipeline_records") {
              voided.push(String((row.row_data as { status?: string })?.status ?? ""));
            }
            return { error: null };
          },
          then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
            Promise.resolve({
              data: table === "portal_lease_pipeline_records" ? [lease] : charges,
              error: null,
            }).then(resolve),
        };
        return q;
      },
    };
    return { db: db as never, voided, refundedIds };
  }

  const now = new Date("2026-10-03T00:00:00.000Z");

  async function railSpy() {
    const rail = await import("@/lib/household-charge-refund-rail.server");
    return { rail, spy: vi.spyOn(rail, "refundPaidHouseholdCharge") };
  }

  it("leaves the lease untouched and counts it failed when a charge needs review", async () => {
    const { rail, spy } = await railSpy();
    spy.mockRejectedValue(
      new rail.HouseholdChargeRefundReviewError(rail.PRE_ARBITRATION_REFUND_REVIEW_MESSAGE));

    const { db, voided } = harness([paidCharge("chg-rent", "prorated_first_month_rent")]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(result.failed).toBe(1);
    expect(result.refundedLeases).toBe(0);
    expect(result.refundedCharges).toBe(0);
    expect(voided).toHaveLength(0);
    expect(result.errors[0]).toContain(rail.PRE_ARBITRATION_REFUND_REVIEW_MESSAGE);
    spy.mockRestore();
  });

  it("keeps the refunds that succeeded while still blocking the void", async () => {
    const { rail, spy } = await railSpy();
    spy.mockImplementation(async (_stripe, _db, input: { chargeId: string }) => {
      if (input.chargeId === "chg-old") {
        throw new rail.HouseholdChargeRefundReviewError(rail.PRE_ARBITRATION_REFUND_REVIEW_MESSAGE);
      }
      return { refundId: "re_1", rail: "central" as const };
    });

    const { db, voided, refundedIds } = harness([
      paidCharge("chg-rent", "prorated_first_month_rent"),
      paidCharge("chg-old", "move_in_fee"),
    ]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(result.refundedCharges).toBe(1);
    expect(refundedIds).toEqual(["chg-rent"]);
    expect(result.failed).toBe(1);
    expect(result.refundedLeases).toBe(0);
    expect(voided).toHaveLength(0);
    spy.mockRestore();
  });

  /**
   * `decideChargeRefund` refuses a `security_deposit` with `is_a_deposit` because Return
   * deposit owns it — but a PAID deposit is still the resident's money sitting with the
   * manager. Voiding the lease would record that the move-in charges were refunded while
   * the deposit was never sent back.
   */
  it("blocks the void when a paid security deposit is still held", async () => {
    const { spy } = await railSpy();
    spy.mockResolvedValue({ refundId: "re_1", rail: "central" });

    const { db, voided, refundedIds } = harness([
      paidCharge("chg-rent", "prorated_first_month_rent"),
      paidCharge("chg-dep", "security_deposit"),
    ]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(refundedIds).toEqual(["chg-rent"]);
    expect(result.refundedCharges).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.refundedLeases).toBe(0);
    expect(voided).toHaveLength(0);
    expect(result.errors.join(" ")).toContain("Return deposit");
    spy.mockRestore();
  });

  it("voids once that deposit has actually been returned", async () => {
    const { spy } = await railSpy();
    spy.mockResolvedValue({ refundId: "re_1", rail: "central" });

    const returned = paidCharge("chg-dep", "security_deposit");
    // Return deposit records its own tracker, not `refundedCents`.
    returned.row_data.depositReturnedCents = 100_000;
    const { db, voided } = harness([paidCharge("chg-rent", "prorated_first_month_rent"), returned]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(result.failed).toBe(0);
    expect(result.refundedLeases).toBe(1);
    expect(voided).toEqual(["Voided"]);
    spy.mockRestore();
  });

  it("blocks the void while a move-in payment is still clearing", async () => {
    const { spy } = await railSpy();
    const clearing = paidCharge("chg-ach", "prorated_first_month_rent");
    clearing.row_data.stripePaymentStatus = "processing";

    const { db, voided } = harness([clearing]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(spy).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(voided).toHaveLength(0);
    spy.mockRestore();
  });

  it("skips an unpaid move-in charge without blocking the void", async () => {
    const { spy } = await railSpy();
    const unpaid = paidCharge("chg-unpaid", "move_in_fee");
    unpaid.status = "pending";
    unpaid.row_data.status = "pending";
    spy.mockResolvedValue({ refundId: "re_1", rail: "central" });

    const { db, voided } = harness([paidCharge("chg-rent", "prorated_first_month_rent"), unpaid]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(result.failed).toBe(0);
    expect(result.refundedLeases).toBe(1);
    expect(voided).toEqual(["Voided"]);
    spy.mockRestore();
  });
});
