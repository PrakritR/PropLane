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
 * Plan then act: the whole lease is classified before any money moves, so a charge this
 * job cannot return means it returns nothing at all. A half-refunded lease is the one
 * outcome to avoid — its rent is gone but it is still countersignable, and neither the
 * attention digest nor the countersign route checks for that.
 *
 * A held `security_deposit` is NOT such a charge: Return deposit owns deposits, so it is
 * skipped and reported via `depositHeldCents` rather than blocking the void.
 */
describe("the uncountersigned-lease refund plans the whole lease first", () => {
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
    const voidReasons: string[] = [];
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
          // No `platform_payment_holds` row: the legacy destination rail, which the
          // rail resolver accepts. A needs-review case is driven by spying instead.
          limit: async () => ({ data: [], error: null }),
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
              const data = row.row_data as { status?: string; thread?: Array<{ text?: string }> };
              voided.push(String(data?.status ?? ""));
              voidReasons.push(String(data?.thread?.at(-1)?.text ?? ""));
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
    return { db: db as never, voided, voidReasons, refundedIds };
  }

  const now = new Date("2026-10-03T00:00:00.000Z");

  async function rail() {
    return import("@/lib/household-charge-refund-rail.server");
  }

  it("refunds nothing and leaves the lease untouched when one charge needs review", async () => {
    const mod = await rail();
    const refund = vi.spyOn(mod, "refundPaidHouseholdCharge");
    const resolve = vi.spyOn(mod, "resolveHouseholdChargeRefundRail");
    resolve.mockImplementation(async (_db, input: { chargeId: string }) => {
      if (input.chargeId === "chg-old") {
        throw new mod.HouseholdChargeRefundReviewError(mod.PRE_ARBITRATION_REFUND_REVIEW_MESSAGE);
      }
      return { rail: "destination" as const };
    });

    const { db, voided, refundedIds } = harness([
      paidCharge("chg-rent", "prorated_first_month_rent"),
      paidCharge("chg-old", "move_in_fee"),
    ]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    // The refundable rent is NOT sent back: one unrefundable charge stops the lease.
    expect(refund).not.toHaveBeenCalled();
    expect(refundedIds).toEqual([]);
    expect(result.refundedCharges).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.refundedLeases).toBe(0);
    expect(voided).toHaveLength(0);
    expect(result.errors[0]).toContain(mod.PRE_ARBITRATION_REFUND_REVIEW_MESSAGE);
    refund.mockRestore();
    resolve.mockRestore();
  });

  it("refunds the rent, voids the lease, and reports the deposit still held", async () => {
    const mod = await rail();
    const refund = vi.spyOn(mod, "refundPaidHouseholdCharge");
    refund.mockResolvedValue({ refundId: "re_1", rail: "destination" });

    const { db, voided, voidReasons, refundedIds } = harness([
      paidCharge("chg-rent", "prorated_first_month_rent"),
      paidCharge("chg-dep", "security_deposit"),
    ]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(refund).toHaveBeenCalledTimes(1);
    expect(refundedIds).toEqual(["chg-rent"]);
    expect(result.refundedCharges).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.refundedLeases).toBe(1);
    expect(voided).toEqual(["Voided"]);
    expect(result.depositHeldCents).toBe(100_000);
    expect(voidReasons[0]).toContain("Return deposit");
    refund.mockRestore();
  });

  it("reports no held deposit once Return deposit has settled it", async () => {
    const mod = await rail();
    const refund = vi.spyOn(mod, "refundPaidHouseholdCharge");
    refund.mockResolvedValue({ refundId: "re_1", rail: "destination" });

    const returned = paidCharge("chg-dep", "security_deposit");
    // Return deposit records its own tracker, not `refundedCents`.
    returned.row_data.depositReturnedCents = 100_000;
    const { db, voided, voidReasons } = harness([
      paidCharge("chg-rent", "prorated_first_month_rent"), returned,
    ]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(result.depositHeldCents).toBe(0);
    expect(result.refundedLeases).toBe(1);
    expect(voided).toEqual(["Voided"]);
    expect(voidReasons[0]).not.toContain("Return deposit");
    refund.mockRestore();
  });

  it("refunds nothing while a move-in payment is still clearing", async () => {
    const mod = await rail();
    const refund = vi.spyOn(mod, "refundPaidHouseholdCharge");
    const clearing = paidCharge("chg-ach", "prorated_first_month_rent");
    clearing.row_data.stripePaymentStatus = "processing";

    const { db, voided } = harness([paidCharge("chg-rent", "prorated_first_month_rent"), clearing]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(refund).not.toHaveBeenCalled();
    expect(result.refundedCharges).toBe(0);
    expect(result.failed).toBe(1);
    expect(voided).toHaveLength(0);
    refund.mockRestore();
  });

  it("skips an unpaid move-in charge without blocking the void", async () => {
    const mod = await rail();
    const refund = vi.spyOn(mod, "refundPaidHouseholdCharge");
    refund.mockResolvedValue({ refundId: "re_1", rail: "destination" });
    const unpaid = paidCharge("chg-unpaid", "move_in_fee");
    unpaid.status = "pending";
    unpaid.row_data.status = "pending";

    const { db, voided } = harness([paidCharge("chg-rent", "prorated_first_month_rent"), unpaid]);
    const result = await refundUncountersignedMoveInCharges({} as never, db, now);

    expect(refund).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(0);
    expect(result.refundedLeases).toBe(1);
    expect(voided).toEqual(["Voided"]);
    expect(result.depositHeldCents).toBe(0);
    refund.mockRestore();
  });
});
