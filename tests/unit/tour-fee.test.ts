/**
 * The optional tour fee. Default $0: nothing changes. Above 0: a signed-in guest's request raises ONE pending `tour_fee`
 * charge through the one charge write path, the request cannot be confirmed until it is paid, and a manager cancel
 * refunds a paid fee. The fee is income, never rent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fee: 0,
  persist: vi.fn(async (_db: unknown, rows: Array<{ id: string }>) => ({ persistedRows: rows, confirmedIds: rows.map((r) => r.id), chargeWriteError: null as string | null })),
  refund: vi.fn(async (..._a: unknown[]) => ({ kind: "pending" as const, attemptId: "att-1", refundId: "re_1" })),
  owner: "owner-1" as string | null,
}));

vi.mock("@/lib/household-charge-persist.server", () => ({ persistHouseholdChargeRows: h.persist }));
vi.mock("@/lib/household-charge-refund-coordinator.server", () => ({ runHouseholdChargeRefund: h.refund }));
vi.mock("@/lib/settings/scope-resolver.server", () => ({
  resolveSettingsScope: async () => ({ value: { tourFeeCents: h.fee }, source: "workspace" }),
}));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: async () => h.owner }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));

import { isResidentPaysFeeChargeKind } from "@/lib/payment-policy";
import { categoryCodeForChargeKind } from "@/lib/reports/categories";
import { chargesImplyTenancy, type HouseholdCharge } from "@/lib/household-charges";
import { DEFAULT_MANAGER_TOUR_SETTINGS, normalizeManagerTourSettings } from "@/lib/manager-tour-settings";
import { TOUR_FEE_MAX_CENTS, TOUR_FEE_SETTING_ENABLED, normalizeTourFeeCents, tourFeeChargeId } from "@/lib/tour-fee";
import { raiseTourFeeCharge, settleTourFeeOnCancel, tourFeeConfirmGate, tourFeeStatus } from "@/lib/tour-fee.server";

type Store = Record<string, { status: string; manager_user_id?: string; row_data?: Record<string, unknown> }>;

function fakeDb(charges: Store, ledger: { stripe_charge_id: string | null; amount_cents: number } | null = null) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const db = {
    updates,
    from(table: string) {
      if (table === "ledger_entries") {
        const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: ledger, error: null }) };
        return q;
      }
      let id = "";
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, value: string) => { if (col === "id") id = value; return q; },
        maybeSingle: async () => ({ data: charges[id] ? { id, ...charges[id] } : null, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_c: string, v: string) => ({
            eq: async () => {
              updates.push({ id: v, patch });
              if (charges[v]) charges[v] = { ...charges[v]!, status: String(patch.status) };
              return { error: null };
            },
          }),
        }),
      };
      return q;
    },
  };
  return db as never as ReturnType<typeof fakeDb> & { updates: typeof updates };
}

const INQUIRY = { name: "Gabi Guest", propertyId: "prop-1", propertyTitle: "Lakeview" };
const base = { inquiry: INQUIRY, inquiryId: "inq-1", residentUserId: "11111111-1111-4111-8111-111111111111", residentEmail: "Gabi@Example.com", hostUserId: "host-1" };

beforeEach(() => {
  h.fee = 0;
  h.owner = "owner-1";
  h.persist.mockClear();
  h.refund.mockClear();
  h.refund.mockResolvedValue({ kind: "pending", attemptId: "att-1", refundId: "re_1" });
});

describe("the tour fee kind", () => {
  it("is income (other_income), never rent, and its processing fee follows the ordinary payer resolver", () => {
    expect(categoryCodeForChargeKind("tour_fee")).toBe("other_income");
    expect(isResidentPaysFeeChargeKind("tour_fee")).toBe(false);
  });

  it("a prospect who owes one is not evidence of a tenancy", () => {
    const charge = { kind: "tour_fee", status: "pending" } as HouseholdCharge;
    expect(chargesImplyTenancy([charge])).toBe(false);
  });

  it("is off by default and the setting is hidden until a prospect has somewhere safe to pay", () => {
    expect(DEFAULT_MANAGER_TOUR_SETTINGS.tourFeeCents).toBe(0);
    expect(normalizeManagerTourSettings({}).tourFeeCents).toBe(0);
    expect(TOUR_FEE_SETTING_ENABLED).toBe(false);
  });

  it("normalizes to whole non-negative cents under the cap", () => {
    expect(normalizeTourFeeCents(2500)).toBe(2500);
    expect(normalizeTourFeeCents(-5)).toBe(0);
    expect(normalizeTourFeeCents("abc")).toBe(0);
    expect(normalizeTourFeeCents(undefined)).toBe(0);
    expect(normalizeTourFeeCents(9_999_999)).toBe(TOUR_FEE_MAX_CENTS);
    expect(normalizeManagerTourSettings({ tourFeeCents: 1500 }).tourFeeCents).toBe(1500);
  });
});

describe("raiseTourFeeCharge", () => {
  it("fee 0: nothing is raised and nothing is written", async () => {
    h.fee = 0;
    expect(await raiseTourFeeCharge(fakeDb({}) as never, base)).toBeNull();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("fee above 0: one pending tour_fee charge through the one write path, billed to the house's owner, id derived from the inquiry", async () => {
    h.fee = 2500;
    const info = await raiseTourFeeCharge(fakeDb({}) as never, base);
    expect(info).toEqual({ chargeId: tourFeeChargeId("inq-1"), amountCents: 2500, amountLabel: "$25.00" });
    expect(h.persist).toHaveBeenCalledTimes(1);
    const rows = h.persist.mock.calls[0]![1];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "hc_tour_fee_inq-1",
      manager_user_id: "owner-1",
      resident_email: "gabi@example.com",
      property_id: "prop-1",
      kind: "tour_fee",
      status: "pending",
    });
    expect(rows[0]!.row_data).toMatchObject({ kind: "tour_fee", title: "Tour fee", amountLabel: "$25.00", balanceLabel: "$25.00", tourInquiryId: "inq-1", residentUserId: base.residentUserId });
  });

  it("a guest with no account (an SMS prospect) owes nothing", async () => {
    h.fee = 2500;
    expect(await raiseTourFeeCharge(fakeDb({}) as never, { ...base, residentUserId: null })).toBeNull();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("a fee that cannot be written throws, so the request is refused rather than stored as a free tour", async () => {
    h.fee = 2500;
    h.persist.mockResolvedValueOnce({ persistedRows: [], confirmedIds: [], chargeWriteError: "boom" });
    await expect(raiseTourFeeCharge(fakeDb({}) as never, base)).rejects.toThrow("boom");
  });
});

describe("the confirm gate: pay before the tour is confirmed", () => {
  it("no fee raised (the default): never gated", async () => {
    expect(await tourFeeConfirmGate(fakeDb({}) as never, "inq-1")).toBeNull();
    expect((await tourFeeStatus(fakeDb({}) as never, "inq-1")).kind).toBe("none");
  });

  it("an unpaid fee blocks the confirm (402); processing counts as unpaid", async () => {
    for (const status of ["pending", "processing", "failed"]) {
      const gate = await tourFeeConfirmGate(fakeDb({ "hc_tour_fee_inq-1": { status } }) as never, "inq-1");
      expect(gate).toMatchObject({ status: 402 });
    }
  });

  it("a paid fee lets the confirm through", async () => {
    expect(await tourFeeConfirmGate(fakeDb({ "hc_tour_fee_inq-1": { status: "paid" } }) as never, "inq-1")).toBeNull();
  });

  it("a cancelled fee owes nothing and blocks nothing; an unreadable fee refuses (503), never confirms", async () => {
    expect(await tourFeeConfirmGate(fakeDb({ "hc_tour_fee_inq-1": { status: "cancelled" } }) as never, "inq-1")).toBeNull();
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "down" } }) }) }) }) };
    expect(await tourFeeConfirmGate(broken as never, "inq-1")).toMatchObject({ status: 503 });
  });
});

describe("a manager cancel", () => {
  it("no fee: nothing is refunded or touched", async () => {
    const db = fakeDb({});
    expect(await settleTourFeeOnCancel(db as never, { inquiryId: "inq-1", reason: "manager_cancelled" })).toEqual({ outcome: "no_fee" });
    expect(h.refund).not.toHaveBeenCalled();
  });

  it("a paid fee is refunded in full through the durable coordinator, on an operation key derived from the inquiry", async () => {
    const db = fakeDb(
      { "hc_tour_fee_inq-1": { status: "paid", manager_user_id: "owner-1", row_data: { amountLabel: "$25.00", paidAmountCents: 2500 } } },
      { stripe_charge_id: "ch_1", amount_cents: 2500 },
    );
    const result = await settleTourFeeOnCancel(db as never, { inquiryId: "inq-1", reason: "manager_cancelled" });
    expect(result).toEqual({ outcome: "refund_pending", chargeId: "hc_tour_fee_inq-1" });
    expect(h.refund).toHaveBeenCalledTimes(1);
    expect(h.refund.mock.calls[0]![2]).toMatchObject({
      ownerUserId: "owner-1",
      chargeId: "hc_tour_fee_inq-1",
      stripeChargeId: "ch_1",
      amountCents: 2500,
      operationKey: "tour-fee-refund:inq-1",
    });
  });

  it("an unpaid fee is cancelled so it can no longer be paid, with no refund", async () => {
    const db = fakeDb({ "hc_tour_fee_inq-1": { status: "pending", row_data: { amountLabel: "$25.00" } } });
    const result = await settleTourFeeOnCancel(db as never, { inquiryId: "inq-1", reason: "manager_declined" });
    expect(result).toEqual({ outcome: "cancelled", chargeId: "hc_tour_fee_inq-1" });
    expect((db as unknown as { updates: Array<{ patch: Record<string, unknown> }> }).updates[0]!.patch).toMatchObject({ status: "cancelled" });
    expect(h.refund).not.toHaveBeenCalled();
  });

  it("a payment still clearing is left for a person; a refused refund never throws", async () => {
    const clearing = fakeDb({ "hc_tour_fee_inq-1": { status: "processing" } });
    expect((await settleTourFeeOnCancel(clearing as never, { inquiryId: "inq-1", reason: "x" })).outcome).toBe("needs_review");

    h.refund.mockResolvedValueOnce({ kind: "review", message: "Rail refused." } as never);
    const paid = fakeDb({ "hc_tour_fee_inq-1": { status: "paid", manager_user_id: "owner-1", row_data: { paidAmountCents: 2500 } } }, { stripe_charge_id: "ch_1", amount_cents: 2500 });
    expect(await settleTourFeeOnCancel(paid as never, { inquiryId: "inq-1", reason: "x" })).toMatchObject({ outcome: "needs_review", message: "Rail refused." });
  });
});
