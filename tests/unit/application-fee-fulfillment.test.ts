import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const syncLedger = vi.hoisted(() => vi.fn());
const syncCharge = vi.hoisted(() => vi.fn());
const creditSource = vi.hoisted(() => vi.fn());
const findHold = vi.hoisted(() => vi.fn());
const findIntentHold = vi.hoisted(() => vi.fn());
const cancelReminders = vi.hoisted(() => vi.fn());
const attestDestination = vi.hoisted(() => vi.fn());
const releaseSource = vi.hoisted(() => vi.fn());
const settleRecovery = vi.hoisted(() => vi.fn());
const sourceAvailability = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerChargeOnlyEntry: syncCharge, syncLedgerPaymentEntry: syncLedger }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  findPlatformHold: findHold, findPlatformHoldByPaymentIntent: findIntentHold,
}));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({ cancelFuturePaymentRemindersForCharge: cancelReminders }));
vi.mock("@/lib/platform-destination-source.server", () => ({ attestPlatformDestinationSource: attestDestination }));
vi.mock("@/lib/platform-hold-release.server", () => ({ releaseVerifiedPlatformHoldsForOwner: releaseSource }));
vi.mock("@/lib/platform-owner-recovery.server", () => ({
  settleClearedPlatformOwnerRecovery: settleRecovery,
  verifiedCapturedChargeAvailability: sourceAvailability,
}));

import { fulfillClaimedApplicationFeePayment } from "@/lib/application-fee-fulfillment.server";

const claim = {
  application_id: "app_paid", attempt_token: "attempt-paid", manager_user_id: "manager-1",
  property_id: "property-1", resident_email: "resident@example.com", charge_id: "hc_app_paid",
  stripe_session_id: "cs_paid", stripe_charge_id: null, principal_cents: 500,
  processing_fee_cents: 44, payer_total_cents: 544, recipient_net_cents: 500,
  status: "pending", created_at: "2026-01-01T00:00:00Z",
  provider_params: { destinationAccountId: null, residentEmail: "resident@example.com", productDescription: "Listing",
    metadata: { resident_email: "resident@example.com", resident_name: "Resident", fee_room_id: "room-1", fee_lease_term: "12 months", fee_source: "room_term" },
    fixedFeeBreakdown: { serviceFeeCents: 44 }, feePayer: "resident" },
};
const session = {
  id: "cs_paid", mode: "payment", status: "complete", payment_status: "paid",
  payment_intent: "pi_paid", amount_total: 544, currency: "usd",
  customer_details: { email: "resident@example.com" },
  metadata: { purpose: "rental_application_fee", application_id: "app_paid", attempt_token: "attempt-paid",
    manager_user_id: "manager-1", property_id: "property-1", resident_email: "resident@example.com",
    fee_cents: "500", subtotal_cents: "500", processing_fee_cents: "44", service_fee_cents: "44",
    manager_payout_cents: "500", fee_payer: "resident", platform_hold: "1", hold_amount_cents: "500",
    fee_room_id: "room-1", fee_lease_term: "12 months", fee_source: "room_term" },
};

describe("claimed application fee fulfillment", () => {
  let stored: Record<string, unknown> | null;
  let state: typeof claim;
  let settle: ReturnType<typeof vi.fn>;
  let stripe: Record<string, unknown>;
  let db: Record<string, unknown>;
  let persistedHold: Record<string, unknown> | null;
  let classifiedHold: boolean;
  let deletionGuard: Record<string, unknown> | null;
  beforeEach(() => {
    vi.clearAllMocks();
    syncLedger.mockResolvedValue(undefined);
    syncCharge.mockResolvedValue(undefined);
    attestDestination.mockResolvedValue({ destinationAccountId: "acct_owned",
      transferId: "tr_exact", transferGrossCents: 544,
      applicationFeeId: "fee_exact", applicationFeeCents: 44 });
    releaseSource.mockResolvedValue({ transferred: 0, pending: 1 });
    settleRecovery.mockResolvedValue({ settled: 0, pending: 0 });
    sourceAvailability.mockResolvedValue(null);
    persistedHold = null;
    classifiedHold = false;
    deletionGuard = null;
    creditSource.mockImplementation(async () => {
      persistedHold ??= { id: "hold-paid", ownerUserId: "manager-1", ownerRole: "manager",
        source: "application_fee", sourceId: "cs_paid",
        status: state.provider_params.destinationAccountId ? "transferred" : "held",
        amountCents: 500, stripeChargeId: "ch_paid" };
      return { data: [{ hold_id: "hold-paid", credited: true }], error: null };
    });
    findHold.mockImplementation(async () => persistedHold?.sourceId === "cs_paid" ? persistedHold : null);
    findIntentHold.mockImplementation(async () => persistedHold);
    cancelReminders.mockResolvedValue(undefined);
    state = { ...claim };
    stored = null;
    settle = vi.fn(async (name: string, args: { p_charge_row_data: Record<string, unknown> }) => {
      if (name === "credit_verified_platform_hold" || name === "credit_platform_income_with_recovery") {
        const result = await creditSource(args);
        if (name === "credit_platform_income_with_recovery") classifiedHold = true;
        return result;
      }
      stored = args.p_charge_row_data;
      return { data: claim.charge_id, error: null };
    });
    db = {
      from: vi.fn((table: string) => {
        if (table === "application_fee_payment_claims") {
          const query: Record<string, unknown> = { eq: () => query, maybeSingle: async () => ({ data: state, error: null }) };
          const update = (patch: Record<string, unknown>) => {
            Object.assign(state, patch);
            const updated: Record<string, unknown> = { eq: () => updated,
              select: () => updated, maybeSingle: async () => ({ data: { application_id: state.application_id }, error: null }) };
            return updated;
          };
          return { select: () => query, update };
        }
        if (table === "account_deleted_record_identities") {
          const query: Record<string, unknown> = { eq: () => query,
            maybeSingle: async () => ({ data: deletionGuard, error: null }) };
          return { select: () => query };
        }
        if (table === "proplane_balance_entries") {
          const query: Record<string, unknown> = {
            eq: () => query,
            then: (resolve: (value: unknown) => void) => resolve({
              data: classifiedHold ? [{ id: "mirror-1" }] : [], error: null,
            }),
          };
          return { select: () => query };
        }
        if (table === "platform_payment_holds") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
            data: { source_verified_at: "2026-10-04T00:00:00Z" }, error: null,
          }) }) }) };
        }
        if (table === "ledger_entries") {
          const chain = { eq: vi.fn(), select: vi.fn().mockResolvedValue({ data: [{ id: "ledger-1" }], error: null }) };
          chain.eq.mockReturnValue(chain);
          return { update: vi.fn().mockReturnValue(chain) };
        }
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: table === "application_fee_payment_claims" ? state : stored ? { row_data: stored } : null,
          error: null,
        }) }) }) };
      }),
      rpc: settle,
    };
    stripe = {
      paymentIntents: { retrieve: vi.fn().mockResolvedValue({ id: "pi_paid", status: "succeeded", currency: "usd",
        amount_received: 544, latest_charge: "ch_paid", metadata: { purpose: "rental_application_fee",
          application_id: "app_paid", attempt_token: "attempt-paid", manager_user_id: "manager-1" } }) },
      charges: { retrieve: vi.fn().mockResolvedValue({ id: "ch_paid", payment_intent: "pi_paid", paid: true,
        status: "succeeded", currency: "usd", amount: 544, amount_refunded: 0,
        refunded: false, disputed: false, created: 1_768_000_000 }) },
      refunds: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
    };
  });

  it("uses the actual captured charge time and repairs ledger/hold on paid replay", async () => {
    const first = await fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never);
    expect(first).toMatchObject({ chargeId: "hc_app_paid", alreadyPaid: false });
    expect(stored?.paidAt).toBe(new Date(1_768_000_000_000).toISOString());
    expect(syncCharge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      id: claim.charge_id, createdAt: claim.created_at, amountLabel: "$5.00",
    }));
    expect(syncCharge.mock.invocationCallOrder[0]).toBeLessThan(syncLedger.mock.invocationCallOrder[0]);
    expect(creditSource).toHaveBeenCalledWith(expect.objectContaining({
      p_owner: "manager-1", p_source_id: "cs_paid", p_charge: "ch_paid",
      p_payment_intent: "pi_paid", p_original_net: 500, p_available_on: null,
    }));
    expect(releaseSource).toHaveBeenCalledWith(db, { ownerUserId: "manager-1",
      holdId: "hold-paid", stripe });
    expect(settleRecovery).toHaveBeenCalledWith(db, stripe, {
      ownerUserId: "manager-1", holdId: "hold-paid",
    });
    state = { ...state, status: "settled" };
    await fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never);
    expect(syncLedger).toHaveBeenCalledTimes(2);
    expect(syncCharge).toHaveBeenCalledTimes(2);
    expect(creditSource).toHaveBeenCalledTimes(2);
  });

  it("passes an attested future availability date to a new classified income mirror", async () => {
    sourceAvailability.mockResolvedValue({ availableOn: "2026-10-08T00:00:00.000Z",
      balanceTransactionId: "txn_paid", status: "pending" });
    await fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never);
    expect(creditSource).toHaveBeenCalledWith(expect.objectContaining({
      p_available_on: "2026-10-08T00:00:00.000Z",
    }));
  });

  it("persists an exact ready-destination allocation only after provider leg attestation", async () => {
    state = { ...claim, provider_params: { ...claim.provider_params, destinationAccountId: "acct_owned" } };
    const readySession = { ...session, metadata: { ...session.metadata,
      platform_hold: undefined, hold_amount_cents: undefined } };
    (stripe.paymentIntents as { retrieve: ReturnType<typeof vi.fn> }).retrieve
      .mockResolvedValueOnce({ id: "pi_paid", status: "succeeded", currency: "usd",
        amount_received: 544, latest_charge: "ch_paid", transfer_data: { destination: "acct_owned" },
        metadata: { purpose: "rental_application_fee", application_id: "app_paid",
          attempt_token: "attempt-paid", manager_user_id: "manager-1" } });
    await fulfillClaimedApplicationFeePayment(db as never, stripe as never, readySession as never);
    expect(attestDestination).toHaveBeenCalledWith(stripe, expect.objectContaining({
      ownerUserId: "manager-1", expectedGrossCents: 544,
      expectedRecipientNetCents: 500, expectedDestinationAccountId: "acct_owned",
    }));
    expect(creditSource).toHaveBeenCalledWith(expect.objectContaining({
      p_destination: "acct_owned", p_transfer: "tr_exact", p_transfer_gross: 544,
      p_application_fee_cents: 44, p_application_fee_id: "fee_exact",
    }));
  });

  it("does not mark a paid ready-destination source settled before asynchronous legs hydrate", async () => {
    state = { ...claim, provider_params: { ...claim.provider_params, destinationAccountId: "acct_owned" } };
    const readySession = { ...session, metadata: { ...session.metadata,
      platform_hold: undefined, hold_amount_cents: undefined } };
    (stripe.paymentIntents as { retrieve: ReturnType<typeof vi.fn> }).retrieve
      .mockResolvedValueOnce({ id: "pi_paid", status: "succeeded", currency: "usd",
        amount_received: 544, latest_charge: "ch_paid", transfer_data: { destination: "acct_owned" },
        metadata: { purpose: "rental_application_fee", application_id: "app_paid",
          attempt_token: "attempt-paid", manager_user_id: "manager-1" } });
    attestDestination.mockRejectedValueOnce(new Error("provider legs processing"));
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, readySession as never))
      .rejects.toThrow(/provider legs processing/);
    expect(settle).not.toHaveBeenCalled();
    expect(syncLedger).not.toHaveBeenCalled();
    expect(creditSource).not.toHaveBeenCalled();
  });

  it("fails a hold write so webhook/return can retry the same captured source", async () => {
    creditSource.mockRejectedValueOnce(new Error("hold write failed"));
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/hold write failed/);
    state = { ...state, status: "settled" };
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ alreadyPaid: true });
    expect(settle.mock.calls.filter(([name]) => name === "settle_application_fee_checkout")).toHaveLength(2);
  });

  it("fails a ledger enrichment error instead of acknowledging an incomplete payment", async () => {
    const originalFrom = db.from as ReturnType<typeof vi.fn>;
    db.from = vi.fn((table: string) => {
      if (table !== "ledger_entries") return originalFrom(table);
      const chain = { eq: vi.fn(), select: vi.fn().mockResolvedValue({ data: null, error: { message: "ledger unavailable" } }) };
      chain.eq.mockReturnValue(chain);
      return { update: vi.fn().mockReturnValue(chain) };
    });
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/ledger enrichment needs repair/);
    expect(creditSource).not.toHaveBeenCalled();
  });

  it("retries a failed originating charge/GL write before payment and hold", async () => {
    syncCharge.mockRejectedValueOnce(new Error("charge GL unavailable"));
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/charge GL unavailable/);
    expect(syncLedger).not.toHaveBeenCalled();
    expect(creditSource).not.toHaveBeenCalled();
    state = { ...state, status: "settled" };
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ alreadyPaid: true });
    expect(syncCharge).toHaveBeenCalledTimes(2);
    expect(syncLedger).toHaveBeenCalledOnce();
  });

  it("does not settle unpaid, foreign-session, or mismatched provider amounts", async () => {
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never,
      { ...session, payment_status: "unpaid" } as never)).rejects.toThrow(/not a paid/);
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never,
      { ...session, id: "cs_foreign" } as never)).rejects.toThrow(/does not match/);
    (stripe.paymentIntents as { retrieve: ReturnType<typeof vi.fn> }).retrieve.mockResolvedValueOnce({
      id: "pi_paid", status: "succeeded", currency: "usd", amount_received: 500,
      latest_charge: "ch_paid", metadata: { purpose: "rental_application_fee",
        application_id: "app_paid", attempt_token: "attempt-paid", manager_user_id: "manager-1" },
    });
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/PaymentIntent does not match/);
    expect(settle).not.toHaveBeenCalled();
  });

  it("retains a delayed captured payment without inventing a paid receipt or hold after deletion", async () => {
    const marker = "12345678-1234-1234-1234-123456789abc";
    state = { ...state, resident_email: `deleted-${marker}@deleted.invalid` };
    deletionGuard = { marker_id: marker, email_columns: ["resident_email"],
      identity_hashes: [createHash("sha256").update("resident@example.com").digest("hex")] };
    const originalClaim = { ...state, provider_params: structuredClone(state.provider_params) };
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/deleted applicant.*source review/);
    expect(state).toMatchObject({ promotion_status: "needs_review",
      promotion_reason: "resident_account_deleted_after_capture" });
    expect(state).toMatchObject(originalClaim);
    expect(stored).toBeNull();
    expect(persistedHold).toBeNull();
    expect(settle).not.toHaveBeenCalled();
    expect(syncLedger).not.toHaveBeenCalled();
    expect(creditSource).not.toHaveBeenCalled();
  });

  it("leaves an already credited receipt, original paid date and hold untouched on deleted-applicant replay", async () => {
    const marker = "12345678-1234-1234-1234-123456789abc";
    state = { ...state, status: "settled", stripe_charge_id: "ch_paid",
      resident_email: `deleted-${marker}@deleted.invalid` };
    deletionGuard = { marker_id: marker, email_columns: ["resident_email"],
      identity_hashes: [createHash("sha256").update("resident@example.com").digest("hex")] };
    stored = { id: claim.charge_id, status: "paid", paidAt: "2026-01-01T00:00:00Z",
      amountLabel: "$5.00", stripeCheckoutSessionId: session.id };
    persistedHold = { id: "hold-paid", ownerUserId: "manager-1", ownerRole: "manager",
      source: "application_fee", sourceId: session.id, status: "held",
      amountCents: 500, stripeChargeId: "ch_paid" };
    const originalClaim = { ...state, provider_params: structuredClone(state.provider_params) };
    const originalStored = { ...stored };
    const originalHold = { ...persistedHold };
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/deleted applicant.*source review/);
    expect(state).toMatchObject(originalClaim);
    expect(state).toMatchObject({ promotion_status: "needs_review",
      promotion_reason: "resident_account_deleted_after_capture" });
    expect(stored).toEqual(originalStored);
    expect(persistedHold).toEqual(originalHold);
    expect(settle).not.toHaveBeenCalled();
    expect(syncLedger).not.toHaveBeenCalled();
    expect(creditSource).not.toHaveBeenCalled();
  });

  it("rejects a forged deletion marker or changed provider email without marking review", async () => {
    const marker = "12345678-1234-1234-1234-123456789abc";
    state = { ...state, resident_email: `deleted-${marker}@deleted.invalid` };
    deletionGuard = { marker_id: marker, email_columns: ["resident_email"], identity_hashes: [] };
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/does not match/);
    deletionGuard.identity_hashes = [createHash("sha256").update("resident@example.com").digest("hex")];
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never,
      { ...session, customer_details: { email: "other@example.com" } } as never))
      .rejects.toThrow(/does not match/);
    expect(state).not.toHaveProperty("promotion_status");
    expect(settle).not.toHaveBeenCalled();
  });

  it("cannot recreate the original hold after a captured refund, including settled-claim replay", async () => {
    state = { ...state, status: "settled" };
    (stripe.charges as { retrieve: ReturnType<typeof vi.fn> }).retrieve.mockResolvedValue({
      id: "ch_paid", payment_intent: "pi_paid", paid: true, status: "succeeded",
      currency: "usd", amount: 544, amount_refunded: 100, refunded: false,
      disputed: false, created: 1_768_000_000,
    });
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/hold reconciliation/);
    expect(creditSource).not.toHaveBeenCalled();
    persistedHold = { id: "hold-paid", ownerUserId: "manager-1", ownerRole: "manager",
      source: "application_fee", sourceId: "cs_paid", status: "held",
      amountCents: 400, stripeChargeId: "ch_paid" };
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ alreadyPaid: true });
    expect(creditSource).toHaveBeenCalledOnce();
    (stripe.charges as { retrieve: ReturnType<typeof vi.fn> }).retrieve.mockResolvedValue({
      id: "ch_paid", payment_intent: "pi_paid", paid: true, status: "succeeded",
      currency: "usd", amount: 544, amount_refunded: 544, refunded: true,
      disputed: false, created: 1_768_000_000,
    });
    persistedHold = null;
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/hold reconciliation/);
  });

  it("repairs an alias-first canonical PI hold without minting a Checkout hold", async () => {
    persistedHold = { id: "hold-paid", ownerUserId: "manager-1", ownerRole: "manager",
      source: "application_fee", sourceId: "pi_paid", status: "held",
      amountCents: 500, stripeChargeId: "ch_paid" };
    state = { ...state, status: "settled" };
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ alreadyPaid: true });
    expect(creditSource).toHaveBeenCalledWith(expect.objectContaining({
      p_source_id: "cs_paid", p_payment_intent: "pi_paid",
    }));
    expect(persistedHold?.sourceId).toBe("pi_paid");
  });

  it("does not rebook a paid source whose saved principal changed after settlement", async () => {
    await fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never);
    state = { ...state, status: "settled" };
    stored = { ...stored, amountLabel: "$7.00" };
    settle.mockResolvedValue({ data: claim.charge_id, error: null });
    syncCharge.mockClear(); syncLedger.mockClear(); creditSource.mockClear();
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/changed after provider settlement/);
    expect(syncLedger).not.toHaveBeenCalled();
    expect(syncCharge).not.toHaveBeenCalled();
    expect(creditSource).not.toHaveBeenCalled();
  });
});
