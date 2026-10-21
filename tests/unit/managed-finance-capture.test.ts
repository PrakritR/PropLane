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
type PriorAllocation = { email?: string; leasingCents?: number; feeCents?: number; policyId?: string };

function db(opts: {
  totals?: Array<{ cum_base: number; monthly_fee: number }>;
  results?: Array<Call>;
  prior?: Array<string | PriorAllocation>;
  /** Other fee versions of the same workspace, and the monthly fee each already took this month. */
  otherVersions?: Array<{ id: string; monthlyFee: number }>;
  policyId?: string;
} = {}) {
  const self = opts.policyId ?? "pol-1";
  const totals = [...(opts.totals ?? [{ cum_base: 0, monthly_fee: 0 }])];
  const results = [...(opts.results ?? [{ status: "created", journal_id: "j1" }])];
  const others = new Map((opts.otherVersions ?? []).map((v) => [v.id, v.monthlyFee] as const));
  const calls: Call[] = [];
  const f = fakeOwnerDb(
    {
      managed_workspace_fee_policies: [self, ...others.keys()].map((id) => ({ id, workspace_id: "ws-1" })),
      managed_rent_allocations: (opts.prior ?? []).map((raw) => {
        const a: PriorAllocation = typeof raw === "string" ? { email: raw } : raw;
        return {
          policy_id: a.policyId ?? "pol-1", workspace_id: "ws-1", month_key: "2026-10", fee_applies: true,
          resident_email: a.email ?? "r@x.test", leasing_cents: a.leasingCents ?? 100,
          fee_cents: a.feeCents ?? 0, refunded_fee_cents: 0,
        };
      }),
    },
    {
      rpc: {
        managed_month_totals: (args) => {
          const id = String(args.p_policy);
          if (others.has(id)) return [{ cum_base: 0, monthly_fee: others.get(id)! }];
          return [totals.length > 1 ? totals.shift() : totals[0]];
        },
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
  // Review fix, Oct 20: the month's accounting is per policy VERSION, which is what keeps a rate change off rent
  // already collected - but the leasing fee and the monthly minimum are the WORKSPACE's, so an admin changing the
  // rate mid-month must not charge either of them a second time under the new version.
  it("a rate change does not let the same resident be charged a second leasing fee", async () => {
    const p = { ...policy({ leasingFeeBps: 5000 }), id: "pol-2" };
    const { f, calls } = db({ prior: [{ email: "r@x.test", policyId: "pol-1", leasingCents: 25_000 }] });
    await creditManagedCapture(f.db, stripe, { policy: p, paymentIntentId: "pi_11", stripeChargeId: "ch_11", grossCents: 100_000, components: [comp("a", "first_month_rent", 100_000)] });
    expect((calls[0]!.p_rows as Array<Record<string, number>>)[0]!.leasing_cents).toBe(0);
  });

  it("a rate change does not charge the monthly minimum a second time", async () => {
    const p = { ...policy({ minFeeCents: 50_000 }), id: "pol-2" };
    // The version this one replaced already took $500 of minimum this month, on its own cumulative base. It is
    // summed through `managed_month_totals`, the same SQL aggregate the current version's own total comes from.
    const { f, calls } = db({ policyId: "pol-2", otherVersions: [{ id: "pol-1", monthlyFee: 50_000 }] });
    await creditManagedCapture(f.db, stripe, { policy: p, paymentIntentId: "pi_12", stripeChargeId: "ch_12", grossCents: 100_000, components: [comp("a", "rent", 100_000)] });
    // 10% of this version's own base, not the $500 floor all over again.
    expect((calls[0]!.p_rows as Array<Record<string, number>>)[0]!.fee_cents).toBe(10_000);

    // With nothing taken earlier this month the floor still applies in full.
    const fresh = db({ policyId: "pol-2" });
    await creditManagedCapture(fresh.f.db, stripe, { policy: p, paymentIntentId: "pi_13", stripeChargeId: "ch_13", grossCents: 100_000, components: [comp("a", "rent", 100_000)] });
    expect((fresh.calls[0]!.p_rows as Array<Record<string, number>>)[0]!.fee_cents).toBe(50_000);
    // Review fix (L3): the figure is handed to the function too. It bounds the floor the same way there, and two
    // captures settling under two versions at once each lock their own policy row - so the function re-sums this
    // under a per-workspace lock and answers `conflict` when it moved, rather than letting both charge the floor.
    expect(calls[0]!.p_prior_fee).toBe(50_000);
    expect(fresh.calls[0]!.p_prior_fee).toBe(0);
  });

  // Review fix (L3): a `conflict` on that figure is retried, not refused - the money still has to land.
  it("re-reads the other versions' month total on a conflict and retries", async () => {
    const p = { ...policy({ minFeeCents: 50_000 }), id: "pol-2" };
    const { f, calls } = db({
      policyId: "pol-2",
      otherVersions: [{ id: "pol-1", monthlyFee: 50_000 }],
      results: [{ status: "conflict", prior_fee: 50_000 }, { status: "created", journal_id: "j2" }],
    });
    const out = await creditManagedCapture(f.db, stripe, { policy: p, paymentIntentId: "pi_14", stripeChargeId: "ch_14", grossCents: 100_000, components: [comp("a", "rent", 100_000)] });
    expect(out.journalId).toBe("j2");
    expect(calls.map((c) => c.p_prior_fee)).toEqual([50_000, 50_000]);
    // Counted again inside the retry: the other version may have taken more between the two attempts.
    expect(f.rpcCalls.filter((c) => c.name === "managed_month_totals" && c.args.p_policy === "pol-1")).toHaveLength(2);
  });

  // The dated resolver returns the ENDED version for a payment taken before a rate change / End; it must settle.
  describe("an ended version", () => {
    const ended = (): PolicyRow => ({ ...policy(), status: "ended", endsOn: "2026-10-19", endedAt: "2026-10-19T20:00:00.000Z", endedByRole: "system" });
    const input = (paidAt: string) => ({ policy: ended(), paymentIntentId: "pi_e", stripeChargeId: "ch_e", grossCents: 100_000, components: [comp("c1", "rent", 100_000, { paidAt })] });

    it("settles a capture dated inside its window and reaches the database with that policy id", async () => {
      const { f, calls } = db();
      const out = await creditManagedCapture(f.db, stripe, input("2026-10-18T17:00:00.000Z"));
      expect(out).toEqual({ status: "created", journalId: "j1" });
      expect(calls[0]).toMatchObject({ p_policy: "pol-1" });
    });
    it("refuses a capture dated on or after the day it ended, and one before it started", async () => {
      const { f, calls } = db();
      await expect(creditManagedCapture(f.db, stripe, input("2026-10-20T17:00:00.000Z"))).rejects.toMatchObject({ status: 409 });
      await expect(creditManagedCapture(f.db, stripe, input("2025-12-31T17:00:00.000Z"))).rejects.toMatchObject({ status: 409 });
      expect(calls).toHaveLength(0);
    });
    it("refuses when ANY component falls outside the window, and an ended version with no end date at all", async () => {
      const { f } = db();
      const mixed = { ...input("2026-10-18T17:00:00.000Z"), components: [comp("c1", "rent", 50_000, { paidAt: "2026-10-18T17:00:00.000Z" }), comp("c2", "rent", 50_000, { paidAt: "2026-10-21T17:00:00.000Z" })] };
      await expect(creditManagedCapture(f.db, stripe, mixed)).rejects.toMatchObject({ status: 409 });
      const open = { ...input("2026-10-18T17:00:00.000Z"), policy: { ...ended(), endsOn: null, endedAt: null } };
      await expect(creditManagedCapture(f.db, stripe, open)).rejects.toMatchObject({ status: 409 });
    });
    it("still refuses an unsigned one", async () => {
      const { f } = db();
      await expect(creditManagedCapture(f.db, stripe, { ...input("2026-10-18T17:00:00.000Z"), policy: { ...ended(), signedAt: null } })).rejects.toMatchObject({ status: 409 });
    });
  });

  it("an active policy is open-ended whatever day the charge was paid", async () => {
    const { f, calls } = db();
    await creditManagedCapture(f.db, stripe, { policy: policy(), paymentIntentId: "pi_a", stripeChargeId: "ch_a", grossCents: 100_000, components: [comp("c1", "rent", 100_000, { paidAt: "2030-01-01T17:00:00.000Z" })] });
    expect(calls).toHaveLength(1);
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
