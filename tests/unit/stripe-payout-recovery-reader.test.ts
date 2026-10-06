import { describe, expect, it } from "vitest";
import { readOwnerRecoveryStatus } from "@/lib/stripe-payouts.server";

function fixture(creditors: Array<Record<string, unknown>>,
  reservations: Array<Record<string, unknown>>, cap = 100) {
  const makeQuery = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
      order: () => query,
      range: async (start: number, end: number) => ({ data:
        (table === "platform_hold_refund_attempts" ? creditors : reservations)
          .filter((row) => filters.every(([column, value]) => row[column] === value))
          .slice(start, Math.min(end + 1, start + cap)), error: null }),
    };
    return query;
  };
  return { from: (table: string) => ({ select: () => makeQuery(table) }) };
}

describe("owner recovery payout reader", () => {
  it("shows outstanding debt and pending reserved income separately across capped pages", async () => {
    const creditors = [
      { id: "creditor-a", owner_user_id: "owner", status: "succeeded",
        funded_debt_cents: 175, recovered_cents: 25 },
      { id: "creditor-b", owner_user_id: "owner", status: "succeeded",
        funded_debt_cents: 50, recovered_cents: 0 },
      { id: "other", owner_user_id: "other", status: "succeeded",
        funded_debt_cents: 1000, recovered_cents: 0 },
    ];
    const reservations = [
      { id: "r1", owner_user_id: "owner", kind: "owner_debt_recovery", status: "reserved",
        creditor_refund_attempt_id: "creditor-a", source_net_cents: 100 },
      { id: "r2", owner_user_id: "owner", kind: "owner_debt_recovery", status: "reserved",
        creditor_refund_attempt_id: "creditor-b", source_net_cents: 20 },
      { id: "settled", owner_user_id: "owner", kind: "owner_debt_recovery", status: "settled",
        creditor_refund_attempt_id: "creditor-a", source_net_cents: 25 },
    ];
    await expect(readOwnerRecoveryStatus(fixture(creditors, reservations, 1) as never, "owner"))
      .resolves.toEqual({ recoveryOutstandingCents: 200, recoveryReservedCents: 120 });
  });

  it("fails closed when reservations exceed a creditor or have no exact creditor", async () => {
    const creditor = [{ id: "a", owner_user_id: "owner", status: "succeeded",
      funded_debt_cents: 100, recovered_cents: 25 }];
    const reserved = (creditorId: string, cents: number) => [{ id: "r", owner_user_id: "owner",
      kind: "owner_debt_recovery", status: "reserved",
      creditor_refund_attempt_id: creditorId, source_net_cents: cents }];
    await expect(readOwnerRecoveryStatus(fixture(creditor, reserved("a", 76)) as never, "owner"))
      .rejects.toThrow(/exceed outstanding debt/);
    await expect(readOwnerRecoveryStatus(fixture(creditor, reserved("missing", 1)) as never, "owner"))
      .rejects.toThrow(/exact creditor/);
  });
});
