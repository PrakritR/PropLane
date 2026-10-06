import { beforeEach, describe, expect, it, vi } from "vitest";

const settle = vi.hoisted(() => vi.fn());
const sync = vi.hoisted(() => vi.fn());
const postGl = vi.hoisted(() => vi.fn());
const providerRetrieve = vi.hoisted(() => vi.fn());
const classified = vi.hoisted(() => vi.fn());

vi.mock("@/lib/platform-money-refund.server", () => ({
  settleReservedPlatformMoneyRefundFromWebhook: settle,
}));
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerRefundEntry: sync }));
vi.mock("@/lib/reports/gl-posting", () => ({ postGlRefundEntry: postGl }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { retrieve: providerRetrieve } }) }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: classified,
}));

import { handleStripeRefund } from "@/lib/stripe-webhook-financials";

function fixture(allocation = false, mixed = false, reservationOwner = "manager",
  tamper?: "owner" | "category" | "principal") {
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const from = vi.fn((table: string) => {
    let sourceId: string | null = null;
    const query: Record<string, unknown> = {
      eq: (field: string, value: string) => {
        if (field === "source_charge_id") sourceId = value;
        return query;
      },
      limit: vi.fn(async () => ({ data: allocation ? [{ id: "hold" }] : [], error: null })),
      maybeSingle: vi.fn(async () => ({ data: table === "ledger_entries"
        ? (sourceId === "charge-1" || (mixed && sourceId === "charge-deposit"))
          ? { id: `ledger-${sourceId}`, manager_user_id: tamper === "owner" ? "other" : "manager",
            source_charge_id: sourceId,
            category_code: tamper === "category" ? "other_income"
              : sourceId === "charge-deposit" ? "security_deposit_liability" : "rent_income",
            amount_cents: tamper === "principal" ? 999
              : sourceId === "charge-deposit" ? 20 : mixed ? 80 : 100,
            property_id: null, resident_user_id: null }
          : null
        : table === "platform_hold_refund_attempts"
          ? { hold_id: "hold", owner_user_id: reservationOwner, source_charge_id: "ch_exact",
            refund_components: mixed
              ? [{ source_id: "charge-1", principal_cents: 80 },
                { source_id: "charge-deposit", principal_cents: 20 }]
              : [{ source_id: "charge-1", principal_cents: 100 }] }
          : table === "platform_payment_holds"
            ? { owner_user_id: reservationOwner, stripe_charge_id: "ch_exact",
              source_verified_at: "2026-10-04T00:00:00Z",
              source_components: mixed
                ? [{ source_id: "charge-1", kind: "rent", principal_cents: 80 },
                  { source_id: "charge-deposit", kind: "security_deposit", principal_cents: 20 }]
                : [{ source_id: "charge-1", kind: "rent", principal_cents: 100 }] }
            : null, error: null })),
    };
    return { select: () => query };
  });
  const refund = { id: "re_exact", charge: "ch_exact", payment_intent: "pi_exact",
    amount: 100, currency: "usd", status: "succeeded", created: 1_750_000_000,
    metadata: { platform_refund_attempt: "attempt-1" } };
  return { db: { rpc, from }, refund, rpc, from };
}

describe("signed Stripe refund source evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settle.mockResolvedValue("unmatched");
    sync.mockResolvedValue("ledger-refund");
    classified.mockResolvedValue({ captured: false });
    providerRetrieve.mockImplementation(async () => fixture().refund);
  });

  it("records pending evidence but does not debit a hold or book a paid refund", async () => {
    const f = fixture();
    providerRetrieve.mockResolvedValueOnce({ ...f.refund, status: "pending" });
    await handleStripeRefund(f.db as never, { ...f.refund, status: "pending" } as never, "ch_exact");
    expect(f.rpc).toHaveBeenCalledWith("record_platform_source_refund_evidence",
      expect.objectContaining({ p_refund: "re_exact", p_charge: "ch_exact", p_status: "pending" }));
    expect(sync).not.toHaveBeenCalled();
    expect(postGl).not.toHaveBeenCalled();
  });

  it("upgrades a delayed pending event to current succeeded evidence and repairs accounting", async () => {
    const f = fixture(true);
    settle.mockResolvedValueOnce("succeeded");
    await handleStripeRefund(f.db as never, { ...f.refund, status: "pending" } as never, "ch_exact");
    expect(f.rpc).toHaveBeenCalledWith("record_platform_source_refund_evidence",
      expect.objectContaining({ p_status: "succeeded", p_refund: "re_exact" }));
    expect(settle).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stripeRefundId: "re_exact" }));
  });

  it("records evidence but refuses classified vendor money mutations before settlement", async () => {
    const f = fixture(true, false, "vendor");
    classified.mockResolvedValueOnce({ captured: true });
    await handleStripeRefund(f.db as never, f.refund as never, "ch_exact");
    expect(f.rpc).toHaveBeenCalledWith("record_platform_source_refund_evidence", expect.anything());
    expect(settle).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(classified).toHaveBeenCalledWith(expect.objectContaining({
      userId: "vendor", metadata: { operation: "refund" },
    }));
  });

  it("fails an unmatched refund of an existing recipient allocation after recording evidence", async () => {
    const f = fixture(true);
    await expect(handleStripeRefund(f.db as never, f.refund as never, "ch_exact"))
      .rejects.toThrow(/exact allocation review/);
    expect(f.rpc).toHaveBeenCalledWith("record_platform_source_refund_evidence", expect.anything());
    expect(sync).not.toHaveBeenCalled();
  });

  it("settles exact reserved provider money before idempotent refund ledger and GL", async () => {
    const f = fixture(true);
    settle.mockResolvedValueOnce("succeeded");
    await handleStripeRefund(f.db as never, f.refund as never, "ch_exact");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stripeRefundId: "re_exact", amountCents: 100, stripeChargeId: "ch_exact",
    }));
    expect(postGl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stripeRefundId: "re_exact", amountCents: 100, linkLedgerEntryId: "ledger-refund",
    }));
  });

  it("books a mixed rent and deposit refund against each captured component", async () => {
    const f = fixture(true, true);
    settle.mockResolvedValueOnce("succeeded");
    await handleStripeRefund(f.db as never, f.refund as never, "ch_exact");
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceChargeId: "charge-1", categoryCode: "rent_income", amountCents: 80,
    }));
    expect(sync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceChargeId: "charge-deposit", categoryCode: "security_deposit_liability", amountCents: 20,
    }));
    expect(postGl).toHaveBeenCalledTimes(2);
  });

  it.each(["owner", "category", "principal"] as const)(
    "refuses %s ledger tampering before refund GL posting", async (tamper) => {
      const f = fixture(true, false, "manager", tamper);
      settle.mockResolvedValueOnce("succeeded");
      await expect(handleStripeRefund(f.db as never, f.refund as never, "ch_exact"))
        .rejects.toThrow(/no matching original payment ledger/);
      expect(sync).not.toHaveBeenCalled();
      expect(postGl).not.toHaveBeenCalled();
    },
  );

  it("does not acknowledge a failed evidence write as a completed refund", async () => {
    const f = fixture();
    f.rpc.mockResolvedValueOnce({ data: null, error: { message: "db unavailable" } });
    await expect(handleStripeRefund(f.db as never, f.refund as never, "ch_exact"))
      .rejects.toThrow(/record captured refund evidence/);
    expect(settle).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});
