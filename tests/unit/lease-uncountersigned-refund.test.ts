import { describe, expect, it } from "vitest";
import {
  listUncountersignedLeasesPastDeadline,
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
