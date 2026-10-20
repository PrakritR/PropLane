import { describe, expect, it, vi } from "vitest";
import { fakeOwnerDb } from "../helpers/owner-fake-db";
import {
  computeCartFee,
  floorDiv,
  spreadByWeightCapped,
  splitManagedCart,
  type CartComponent,
} from "@/lib/owner-management/fee-math";
import { buildTaxPackage } from "@/lib/managed-finance/tax-package";
import type { StatementLine } from "@/lib/managed-finance/statement";

vi.mock("@/lib/platform-owner-recovery.server", () => ({
  verifiedCapturedChargeAvailability: vi.fn(async () => ({ availableOn: null, balanceTransactionId: "txn_1", status: "pending" })),
}));

import { creditManagedCapture, type ManagedCaptureComponent } from "@/lib/managed-finance/capture.server";
import type { PolicyRow } from "@/lib/owner-management/policies.server";

const terms = (over: Partial<PolicyRow["terms"]> = {}): PolicyRow["terms"] => ({
  ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0,
  reserveTargetCents: 0, repairApprovalThresholdCents: 25_000, ...over,
});

const policy = (over: Partial<PolicyRow["terms"]> = {}): PolicyRow => ({
  id: "pol-1", workspaceId: "ws-1", ownerUserId: "own-1", status: "active", effectiveFrom: "2026-01-01", endsOn: null,
  sentAt: null, signedAt: "2026-01-01T00:00:00Z", acceptedVia: "owner_signature", termsSha256: "h",
  createdAt: "2026-01-01T00:00:00Z", terms: terms(over),
});

const cart = (id: string, kind: string, cents: number, email: string): CartComponent => ({
  id, kind, liabilityClass: "income", principalCents: cents, distributableCents: cents, residentEmail: email,
});

describe("leasing fee never exceeds the database's per-row cap", () => {
  it("floor-of-sum is spread without handing any row more than its own floor", () => {
    // Two first-month charges of $150 at 33.33%: floor(30000*3333/10000) = 9999, but each row's own cap is 4999.
    const bps = 3333;
    const comps = [cart("a", "first_month_rent", 15_000, "a@x.test"), cart("b", "first_month_rent", 15_000, "b@x.test")];
    const fee = computeCartFee({
      terms: terms({ ownerShareBps: 10_000, leasingFeeBps: bps }),
      cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 30_000, leasingBase: 30_000,
    });
    expect(fee.leasingFeeCents).toBe(9_999);

    const split = splitManagedCart(terms({ ownerShareBps: 10_000, leasingFeeBps: bps }), comps, fee, new Set(["a", "b"]));
    for (const row of split) {
      const cap = floorDiv(row.distributableCents * bps, 10_000);
      expect(row.leasingCents, `${row.id} must stay inside its own cap`).toBeLessThanOrEqual(cap);
      expect(row.ownerCents).toBe(row.distributableCents - row.feeCents - row.leasingCents);
    }
    // The cents the caps refuse stay with the owner rather than making the whole capture unallocatable.
    expect(split.reduce((sum, row) => sum + row.leasingCents, 0)).toBe(9_998);
  });

  it("a cap that frees cents gives them to a row that still has room", () => {
    expect(spreadByWeightCapped([{ id: "a", weight: 10, cap: 1 }, { id: "b", weight: 10, cap: 9 }], 8))
      .toEqual([{ id: "a", cents: 1 }, { id: "b", cents: 7 }]);
    expect(spreadByWeightCapped([{ id: "a", weight: 1, cap: 0 }], 0)).toEqual([{ id: "a", cents: 0 }]);
  });
});

describe("a managed capture records the resident-added processing fee per charge", () => {
  const comp = (id: string, principal: number): ManagedCaptureComponent => ({
    id, kind: "rent", liabilityClass: "income", principalCents: principal, recipientNetCents: principal,
    propertyId: "p1", residentEmail: "r@x.test", paidAt: "2026-10-18T17:00:00.000Z",
  });
  const stripeFor = (amount: number) => ({ charges: { retrieve: vi.fn(async (id: string) => ({ id, amount })) } }) as never;

  function fixture() {
    const calls: Array<Record<string, unknown>> = [];
    const f = fakeOwnerDb({}, {
      rpc: {
        managed_month_totals: () => [{ cum_base: 0, monthly_fee: 0 }],
        credit_managed_capture: (args) => { calls.push(args); return { status: "created", journal_id: "j1" }; },
      },
    });
    return { f, calls };
  }

  it("spreads gross-above-principal over the charges so a full refund can be reversed", async () => {
    const { f, calls } = fixture();
    await creditManagedCapture(f.db, stripeFor(154_500), {
      policy: policy(), paymentIntentId: "pi_1", stripeChargeId: "ch_1", grossCents: 154_500,
      components: [comp("c1", 100_000), comp("c2", 50_000)],
    });
    const rows = calls[0]!.p_rows as Array<Record<string, number>>;
    const added = rows.reduce((sum, row) => sum + row.resident_added_cents, 0);
    expect(added).toBe(4_500);
    expect(rows.map((row) => row.principal_cents + row.resident_added_cents).reduce((a, b) => a + b, 0)).toBe(154_500);
  });

  it("records zero when the resident added nothing", async () => {
    const { f, calls } = fixture();
    await creditManagedCapture(f.db, stripeFor(100_000), {
      policy: policy(), paymentIntentId: "pi_2", stripeChargeId: "ch_2", grossCents: 100_000,
      components: [comp("c1", 100_000)],
    });
    expect((calls[0]!.p_rows as Array<Record<string, number>>)[0]!.resident_added_cents).toBe(0);
  });

  it("refuses a capture claiming a fee larger than the principal, which no refund could reverse", async () => {
    const { f } = fixture();
    await expect(creditManagedCapture(f.db, stripeFor(300_000), {
      policy: policy(), paymentIntentId: "pi_3", stripeChargeId: "ch_3", grossCents: 300_000,
      components: [comp("c1", 100_000)],
    })).rejects.toMatchObject({ status: 500 });
  });
});

describe("the tax package's year is the PACIFIC year the caller resolved", () => {
  const line = (kind: string, cents: number, postedAt: string): StatementLine => ({
    journalId: `j-${postedAt}`, amountCents: cents, availableOn: null, postedAt, kind,
    detail: { charges: [{ property_id: "p1", owner_cents: cents, fee_cents: 0 }] }, sourceType: null, sourceId: null,
  });

  it("keeps rent posted on December 31 Pacific, which is already January 1 in UTC", () => {
    // 2026-12-31 21:00 Pacific === 2027-01-01T05:00Z: inside the Pacific year, outside `${year+1}-01-01` UTC.
    const lateDecember = line("rent_capture", 150_000, "2027-01-01T05:00:00.000Z");
    const window = { fromIso: "2026-01-01T08:00:00.000Z", toIso: "2027-01-01T08:00:00.000Z" };

    const withWindow = buildTaxPackage(2026, [lateDecember], [], new Map(), "", window);
    expect(withWindow.totals.rentsReceivedCents).toBe(150_000);

    // Without the window it falls out of the year entirely — the defect this guards.
    expect(buildTaxPackage(2026, [lateDecember], [], new Map()).totals.rentsReceivedCents).toBe(0);
  });

  it("still excludes a line that falls outside the Pacific window", () => {
    const window = { fromIso: "2026-01-01T08:00:00.000Z", toIso: "2027-01-01T08:00:00.000Z" };
    const nextYear = line("rent_capture", 150_000, "2027-01-01T09:00:00.000Z");
    expect(buildTaxPackage(2026, [nextYear], [], new Map(), "", window).totals.rentsReceivedCents).toBe(0);
  });
});
