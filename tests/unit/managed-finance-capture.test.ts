import { describe, expect, it, vi } from "vitest";
import { fakeOwnerDb } from "../helpers/owner-fake-db";

vi.mock("@/lib/platform-owner-recovery.server", () => ({
  verifiedCapturedChargeAvailability: vi.fn(async () => ({ availableOn: "2026-10-20T00:00:00.000Z", balanceTransactionId: "txn_1", status: "pending" })),
}));

import { creditManagedCapture, type ManagedCaptureComponent } from "@/lib/managed-finance/capture.server";
import { LedgerError } from "@/lib/managed-finance/ledger.server";
import type { PolicyRow } from "@/lib/owner-management/policies.server";

const policy = (over: Partial<PolicyRow["terms"]> = {}): PolicyRow => ({
  id: "pol-1", workspaceId: "ws-1", ownerUserId: "own-1", status: "active", effectiveFrom: "2026-01-01", endsOn: null, sentAt: null,
  signedAt: "2026-01-01T00:00:00Z", acceptedVia: "owner_signature", termsSha256: "h", createdAt: "2026-01-01T00:00:00Z",
  terms: { ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0, reserveTargetCents: 0, repairApprovalThresholdCents: 25_000, ...over },
});
const stripe = { charges: { retrieve: vi.fn(async (id: string) => ({ id, amount: 100_000 })) } } as never;
const comp = (id: string, kind: string, principal: number, over: Partial<ManagedCaptureComponent> = {}): ManagedCaptureComponent => ({
  id, kind, liabilityClass: "income", principalCents: principal, recipientNetCents: principal, propertyId: "p1", residentEmail: "r@x.test",
  paidAt: "2026-10-18T17:00:00.000Z", ...over,
});

type Call = Record<string, unknown>;
function db(opts: { totals?: Array<{ cum_base: number; monthly_fee: number }>; results?: Array<Call>; prior?: string[] } = {}) {
  const totals = [...(opts.totals ?? [{ cum_base: 0, monthly_fee: 0 }])];
  const results = [...(opts.results ?? [{ status: "created", journal_id: "j1" }])];
  const calls: Call[] = [];
  const f = fakeOwnerDb(
    { managed_rent_allocations: (opts.prior ?? []).map((email) => ({ policy_id: "pol-1", resident_email: email, leasing_cents: 100 })) },
    {
      rpc: {
        managed_month_totals: () => [totals.length > 1 ? totals.shift() : totals[0]],
        credit_managed_capture: (args) => { calls.push(args); return results.length > 1 ? results.shift() : results[0]; },
      },
    },
  );
  return { f, calls };
}

describe("creditManagedCapture", () => {
  it("splits $1000 rent 900 / 100 and passes the balanced figures and expectations to the database", async () => {
    const { f, calls } = db();
    const out = await creditManagedCapture(f.db, stripe, { policy: policy(), paymentIntentId: "pi_1", stripeChargeId: "ch_1", grossCents: 100_000, components: [comp("c1", "rent", 100_000)] });
    expect(out).toEqual({ status: "created", journalId: "j1" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({ p_policy: "pol-1", p_workspace: "ws-1", p_key: "capture:pi_1", p_pi: "pi_1", p_gross: 100_000, p_expect_base: 0, p_expect_fee: 0, p_month: "2026-10" });
    expect(call.p_available_on).toBe("2026-10-20T00:00:00.000Z");
    const rows = call.p_rows as Array<Record<string, number>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fee_cents: 10_000, owner_cents: 90_000, leasing_cents: 0, deposit_cents: 0 });
  });
  it("a deposit is held, never split, and a late fee carries no fee under rent-only", async () => {
    const { f, calls } = db();
    await creditManagedCapture(f.db, stripe, {
      policy: policy(), paymentIntentId: "pi_2", stripeChargeId: "ch_2", grossCents: 100_000,
      components: [comp("rent", "rent", 50_000), comp("dep", "security_deposit", 40_000, { liabilityClass: "deposit" }), comp("late", "late_fee", 10_000)],
    });
    const rows = (calls[0]!.p_rows as Array<Record<string, number | string>>);
    const by = Object.fromEntries(rows.map((r) => [r.charge_id as string, r]));
    expect(by.rent).toMatchObject({ fee_cents: 5_000, owner_cents: 45_000 });
    expect(by.dep).toMatchObject({ fee_cents: 0, owner_cents: 0, deposit_cents: 40_000 });
    expect(by.late).toMatchObject({ fee_cents: 0, owner_cents: 10_000, fee_applies: false });
  });
  it("a resident-added processing fee stays out of the split (gross exceeds principal)", async () => {
    const { f, calls } = db();
    await creditManagedCapture(f.db, stripe, { policy: policy(), paymentIntentId: "pi_3", stripeChargeId: "ch_3", grossCents: 100_000, components: [comp("c1", "rent", 96_000)] });
    expect(calls[0]!.p_gross).toBe(100_000);
    expect((calls[0]!.p_rows as Array<Record<string, number>>)[0]).toMatchObject({ distributable_cents: 96_000, fee_cents: 9_600, owner_cents: 86_400 });
  });
  it("tops up against the month so far (second payment of the month)", async () => {
    const { f, calls } = db({ totals: [{ cum_base: 60_000, monthly_fee: 6_000 }] });
    await creditManagedCapture(f.db, stripe, { policy: policy(), paymentIntentId: "pi_4", stripeChargeId: "ch_4", grossCents: 100_000, components: [comp("c1", "rent", 40_000), comp("c2", "rent", 60_000)] });
    expect(calls[0]).toMatchObject({ p_expect_base: 60_000, p_expect_fee: 6_000 });
    const rows = calls[0]!.p_rows as Array<Record<string, number>>;
    expect(rows.reduce((s, r) => s + r.fee_cents!, 0)).toBe(10_000 /* 10% of 160000 = 16000, minus 6000 already taken */);
  });
  it("retries on a conflict and then succeeds, recomputing from the new totals", async () => {
    const { f, calls } = db({
      totals: [{ cum_base: 0, monthly_fee: 0 }, { cum_base: 50_000, monthly_fee: 5_000 }],
      results: [{ status: "conflict" }, { status: "created", journal_id: "j2" }],
    });
    const out = await creditManagedCapture(f.db, stripe, { policy: policy(), paymentIntentId: "pi_5", stripeChargeId: "ch_5", grossCents: 100_000, components: [comp("c1", "rent", 100_000)] });
    expect(out.journalId).toBe("j2");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ p_expect_base: 50_000, p_expect_fee: 5_000 });
    expect((calls[1]!.p_rows as Array<Record<string, number>>)[0]!.fee_cents).toBe(10_000 + 5_000 - 5_000);
  });
  it("gives up with a retryable error if the month keeps moving", async () => {
    const { f } = db({ results: [{ status: "conflict" }] });
    await expect(creditManagedCapture(f.db, stripe, { policy: policy(), paymentIntentId: "pi_6", stripeChargeId: "ch_6", grossCents: 100_000, components: [comp("c1", "rent", 100_000)] }))
      .rejects.toMatchObject({ code: "busy" });
  });
  it("a refusal from the database throws, never falls back to a hold", async () => {
    const { f } = db({ results: [{ status: "refused", reason: "fee_over_policy" }] });
    await expect(creditManagedCapture(f.db, stripe, { policy: policy(), paymentIntentId: "pi_7", stripeChargeId: "ch_7", grossCents: 100_000, components: [comp("c1", "rent", 100_000)] }))
      .rejects.toBeInstanceOf(LedgerError);
  });
  it("replaying an already-credited PaymentIntent is a no-op", async () => {
    const { f } = db({ results: [{ status: "exists", journal_id: "j9" }] });
    expect((await creditManagedCapture(f.db, stripe, { policy: policy(), paymentIntentId: "pi_8", stripeChargeId: "ch_8", grossCents: 100_000, components: [comp("c1", "rent", 100_000)] })).status).toBe("exists");
  });
  it("takes the leasing fee once per resident: only the first leasing charge, and not again after one was taken", async () => {
    const p = policy({ leasingFeeBps: 5000 });
    const first = db();
    await creditManagedCapture(first.f.db, stripe, { policy: p, paymentIntentId: "pi_9", stripeChargeId: "ch_9", grossCents: 100_000, components: [comp("a", "first_month_rent", 50_000), comp("b", "prorated_rent", 50_000)] });
    const rows = first.calls[0]!.p_rows as Array<Record<string, number | string>>;
    expect(rows.filter((r) => (r.leasing_cents as number) > 0).map((r) => r.charge_id)).toEqual(["a"]);
    expect(rows.find((r) => r.charge_id === "a")!.leasing_cents).toBe(25_000);
    const again = db({ prior: ["r@x.test"] });
    await creditManagedCapture(again.f.db, stripe, { policy: p, paymentIntentId: "pi_10", stripeChargeId: "ch_10", grossCents: 100_000, components: [comp("a", "first_month_rent", 100_000)] });
    expect((again.calls[0]!.p_rows as Array<Record<string, number>>)[0]!.leasing_cents).toBe(0);
  });
  it("refuses a policy that is not accepted, and a charge that differs from the PaymentIntent", async () => {
    const { f } = db();
    await expect(creditManagedCapture(f.db, stripe, { policy: { ...policy(), status: "draft", signedAt: null }, paymentIntentId: "pi", stripeChargeId: "ch", grossCents: 100, components: [comp("c1", "rent", 100)] }))
      .rejects.toMatchObject({ status: 409 });
    const wrong = { charges: { retrieve: vi.fn(async (id: string) => ({ id, amount: 5 })) } } as never;
    await expect(creditManagedCapture(f.db, wrong, { policy: policy(), paymentIntentId: "pi", stripeChargeId: "ch", grossCents: 100_000, components: [comp("c1", "rent", 100_000)] }))
      .rejects.toBeInstanceOf(LedgerError);
  });
});
