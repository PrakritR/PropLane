import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

/**
 * A Supabase query mock: every builder method returns the same chain, so a
 * query may stack `.eq().eq()` (the workspace fee-payer resolver does), and the
 * terminal `maybeSingle` / `single` resolve `result`.
 */
function queryChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "neq", "in", "is", "order", "limit"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.single = vi.fn().mockResolvedValue(result);
  return chain;
}

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
  cookies: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(),
}));

vi.mock("@/lib/application-fee-payment-claim.server", () => ({
  createClaimedApplicationFeeCheckout: vi.fn(),
}));
vi.mock("@/lib/auth/resident-setup-token", () => ({
  isResidentSetupTokenValid: vi.fn(() => true),
}));

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn().mockResolvedValue({ tier: "pro", stripeCustomerId: null }),
  normalizeManagerSkuTier: vi.fn((t: string) => t),
}));

vi.mock("@/lib/stripe-connect", () => ({
  resolveAndValidateManagerConnectForPayments: vi.fn(),
  resolveConnectDestinationIfReady: vi.fn(),
  isStripeConnectAccountAccessError: vi.fn(() => false),
  managerConnectReconnectMessage: vi.fn(() => "Reconnect Stripe"),
}));

vi.mock("@/lib/stripe-axis-ach-checkout", () => ({
  createAxisAchCheckoutSession: vi.fn(),
  stripeNotConfiguredError: vi.fn(() => false),
  APPLICATION_FEE_CHECKOUT_PURPOSE: "application_fee",
}));

vi.mock("@/lib/household-charge-payment-eligibility", () => ({
  listingFromPropertyData: vi.fn(() => null),
}));

vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  resolveListingForHouseholdCharge: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/payment-policy", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payment-policy")>("@/lib/payment-policy");
  return {
    ...actual,
    axisPaymentsEnabledOnListing: vi.fn(() => true),
    resolveServiceFeePayer: vi.fn(() => "resident"),
  };
});

vi.mock("@/lib/manager-manual-payment-settings", () => ({
  loadManagerManualPaymentSettings: vi.fn().mockResolvedValue({ serviceFeePayer: "resident" }),
}));

vi.mock("@/lib/stripe-household-charge", () => ({
  householdChargeAmountCents: vi.fn((charge: { amountCents?: number }) => charge.amountCents ?? 10000),
  householdChargeCheckoutPaid: vi.fn(() => true),
  householdChargeCheckoutProcessing: vi.fn(() => false),
  isHouseholdChargeCheckoutSession: vi.fn(() => true),
  markHouseholdChargePaidFromStripeSession: vi.fn().mockResolvedValue({ ok: true, chargeId: "charge_1", alreadyPaid: false }),
  HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE: "household_charge",
}));

// The central source credit is exercised in its own suites; here we only prove
// that /household-charge-verify refuses to report paid unless it succeeds.
vi.mock("@/lib/household-captured-source.server", () => ({
  creditVerifiedHouseholdCheckoutSource: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rental-application/application-fee-channel", () => ({
  listingApplicationFeeChannels: vi.fn(() => ({ ach: true, axisPlatformFee: true })),
}));

vi.mock("@/lib/manager-listing-submission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-listing-submission")>()),
  normalizeManagerListingSubmissionV1: vi.fn((s: unknown) => s),
}));

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAndValidateManagerConnectForPayments, resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { POST as householdChargeCheckout } from "@/app/api/stripe/household-charge-checkout/route";
import { GET as householdChargeVerify } from "@/app/api/stripe/household-charge-verify/route";
import { POST as applicationFeeCheckout } from "@/app/api/stripe/application-fee-checkout/route";
import { getStripe } from "@/lib/stripe";
import { createClaimedApplicationFeeCheckout } from "@/lib/application-fee-payment-claim.server";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";
import { resolveListingForHouseholdCharge } from "@/lib/household-charge-payment-eligibility.server";
import { listingFromPropertyData } from "@/lib/household-charge-payment-eligibility";
import { creditVerifiedHouseholdCheckoutSource } from "@/lib/household-captured-source.server";
import { markHouseholdChargePaidFromStripeSession } from "@/lib/stripe-household-charge";
import { residentServiceFeeBreakdown } from "@/lib/payment-policy";

type Row = Record<string, unknown> | null;

/**
 * Fake service-role client for the resident household routes. Every builder
 * method returns the same chain (the route stacks `.eq().eq()` on
 * `profile_roles` and the workspace resolver does too); `maybeSingle` resolves
 * the configured row for the table. `rpc` models the whole-cart claim:
 * `reserve_resident_checkout_attempt` freezes the request it was handed (exactly
 * what the SQL does for a fresh cart) and `bind_resident_checkout_session`
 * stamps the provider id.
 */
function residentDb(opts: {
  /** `profiles.role`; "resident" is accepted without a `profile_roles` read. */
  profileRole?: string | null;
  /** `profile_roles` row (the multi-role source of truth), or null for none. */
  residentRoleRow?: Row;
  charge?: Row;
  property?: Row;
  attempt?: Row;
  order?: string[];
  reserveError?: boolean;
}) {
  const order = opts.order ?? [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const queried: string[] = [];
  const rowFor = (table: string): Row => {
    if (table === "profiles") return { role: opts.profileRole ?? "resident" };
    if (table === "profile_roles") return opts.residentRoleRow ?? null;
    if (table === "portal_household_charge_records") return opts.charge ?? null;
    if (table === "manager_property_records") return opts.property ?? null;
    if (table === "resident_checkout_attempts") return opts.attempt ?? null;
    return null;
  };
  const db = {
    from: vi.fn((table: string) => {
      queried.push(table);
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "in", "is", "order", "limit"]) {
        chain[method] = vi.fn().mockReturnValue(chain);
      }
      chain.maybeSingle = vi.fn(async () => ({ data: rowFor(table), error: null }));
      chain.single = chain.maybeSingle;
      return chain;
    }),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "reserve_resident_checkout_attempt") {
        order.push("reserve");
        if (opts.reserveError) return { data: null, error: { message: "slot taken" } };
        return {
          data: {
            id: "attempt_1",
            attempt_token: args.p_attempt_token,
            resident_user_id: args.p_resident_user_id,
            resident_email: args.p_resident_email,
            manager_user_id: args.p_manager_user_id,
            charge_ids: args.p_charge_ids,
            charge_cents: args.p_charge_cents,
            subtotal_cents: args.p_subtotal_cents,
            payer_total_cents: args.p_payer_total_cents,
            recipient_net_cents: args.p_recipient_net_cents,
            payment_method: args.p_payment_method,
            currency: "usd",
            provider_params: args.p_provider_params,
            stripe_session_id: null,
            stripe_payment_intent_id: null,
            status: "pending",
            created_at: new Date().toISOString(),
          },
          error: null,
        };
      }
      if (name === "bind_resident_checkout_session") return { data: true, error: null };
      return { data: null, error: null };
    }),
  };
  return { db, rpcCalls, queried, order };
}

/** A pending $2,500 rent charge on prop_1, created by (and owned by) mgr_1. */
const CHARGE_ROW: Row = {
  id: "charge_1",
  status: "pending",
  manager_user_id: "mgr_1",
  row_data: {
    id: "charge_1",
    kind: "rent",
    status: "pending",
    amountCents: 250000,
    residentEmail: "resident@example.com",
    residentUserId: "res_1",
    propertyId: "prop_1",
    managerUserId: "mgr_1",
  },
};
const PROPERTY_ROW: Row = {
  id: "prop_1",
  manager_user_id: "mgr_1",
  property_data: { listingSubmission: { v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true } },
};
const LISTING = { v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true };

/** A frozen card claim + its paid Checkout Session, shaped like what the claim RPC stores. */
function paidCardFixture(overrides: { attemptResidentUserId?: string } = {}) {
  const subtotal = 250000;
  const fee = residentServiceFeeBreakdown(subtotal, "card", "resident");
  const token = "attempt-token";
  const metadata = {
    purpose: "household_charge", source_arbitration_v: "1", resident_attempt_token: token,
    charge_id: "charge_1", charge_ids: "charge_1", manager_user_id: "mgr_1",
    resident_email: "resident@example.com", property_id: "prop_1", bulk: "false",
  };
  const attempt = {
    id: "attempt_1", attempt_token: token,
    resident_user_id: overrides.attemptResidentUserId ?? "res_1",
    resident_email: "resident@example.com", manager_user_id: "mgr_1",
    charge_ids: ["charge_1"], charge_cents: [subtotal], subtotal_cents: subtotal,
    payer_total_cents: fee.totalCents, recipient_net_cents: fee.managerPayoutCents,
    payment_method: "card", currency: "usd", stripe_session_id: "cs_ach_done",
    stripe_payment_intent_id: null, status: "pending", created_at: new Date().toISOString(),
    provider_params: {
      residentEmail: "resident@example.com", mode: "embedded", paymentMethod: "card",
      lineItems: [{ amountCents: subtotal, productName: "Rent", productDescription: "Axis" }],
      metadata, destinationAccountId: null, fundingModel: "connect_destination",
      forceExplicitCard: true, feePayer: "resident", managerTier: "pro",
      fixedFeeBreakdown: fee, idempotencyKey: `resident-checkout:${token}`,
    },
  };
  const session = {
    id: "cs_ach_done", mode: "payment", status: "complete", payment_status: "paid",
    currency: "usd", amount_total: fee.totalCents, payment_intent: "pi_done",
    customer_email: "resident@example.com",
    metadata: {
      ...metadata, payment_method: "card", subtotal_cents: String(subtotal),
      processing_fee_cents: String(fee.totalCents - subtotal),
      manager_payout_cents: String(fee.managerPayoutCents), fee_payer: "resident",
      platform_hold: "1", hold_amount_cents: String(fee.managerPayoutCents),
    },
  };
  return { attempt, session };
}

describe("ACH checkout routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveListingForHouseholdCharge).mockResolvedValue(null);
    vi.mocked(listingFromPropertyData).mockReturnValue(null);
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "res_1", email: "resident@example.com" } } }) },
    } as never);

    vi.mocked(resolveAndValidateManagerConnectForPayments).mockResolvedValue({
      ok: true,
      accountId: "acct_test_123",
    } as never);
    vi.mocked(resolveConnectDestinationIfReady).mockResolvedValue("acct_test_123");

    vi.mocked(createAxisAchCheckoutSession).mockResolvedValue({
      mode: "embedded",
      clientSecret: "cs_ach_secret",
      sessionId: "cs_ach_session",
      subtotalCents: 250000,
      processingFeeCents: 0,
      axisFeeCents: 0,
      platformFeeCents: 0,
      totalCents: 250000,
      paymentMethod: "ach",
    } as never);
  });

  describe("POST /api/stripe/household-charge-checkout", () => {
    it("returns 401 without auth", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      } as never);

      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: { chargeId: "charge_1" },
      });
      const res = await householdChargeCheckout(req);
      expect(res.status).toBe(401);
    });

    it("returns 403 for an account that does not hold the resident role, before any charge read or provider call", async () => {
      const { db, queried, rpcCalls } = residentDb({ profileRole: "manager", residentRoleRow: null, charge: CHARGE_ROW });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      const stripe = { paymentIntents: { create: vi.fn() } };
      vi.mocked(getStripe).mockReturnValue(stripe as never);

      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: { chargeId: "charge_1", embedded: true },
      });
      const res = await householdChargeCheckout(req);
      expect(res.status).toBe(403);
      expect(queried).not.toContain("portal_household_charge_records");
      expect(rpcCalls).toEqual([]);
      expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
      expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
    });

    it("admits a manager+resident (profile_roles resident row) even though profiles.role is manager", async () => {
      const { db } = residentDb({ profileRole: "manager", residentRoleRow: { role: "resident" }, charge: null });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: { chargeId: "nonexistent_charge" },
      });
      // Past the role gate: the charge lookup is what answers (404), not the 403 role refusal.
      expect((await householdChargeCheckout(req)).status).toBe(404);
    });

    // New contract: the resident role gate runs first, then the charge load. With a
    // resident session and no chargeId/chargeIds the core still answers 400.
    it("returns 400 when no chargeId provided", async () => {
      const { db, rpcCalls } = residentDb({});
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: {},
      });
      const res = await householdChargeCheckout(req);
      expect(res.status).toBe(400);
      expect(rpcCalls).toEqual([]);
    });

    // New contract: a resident-role account asking for a charge that does not exist
    // still gets 404 (the 403 earlier is only for non-residents), with no claim made.
    it("returns 404 when charge not found", async () => {
      const { db, rpcCalls } = residentDb({ charge: null });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: { chargeId: "nonexistent_charge" },
      });
      const res = await householdChargeCheckout(req);
      expect(res.status).toBe(404);
      expect(rpcCalls).toEqual([]);
    });

    it("refuses a historical charge whose creator is not the property's owner, before any claim or provider call", async () => {
      vi.mocked(listingFromPropertyData).mockReturnValue(LISTING as never);
      const created = { ...CHARGE_ROW!, manager_user_id: "mgr_co",
        row_data: { ...(CHARGE_ROW!.row_data as object), managerUserId: "mgr_co" } };
      const { db, rpcCalls } = residentDb({ charge: created, property: PROPERTY_ROW });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      const stripe = { paymentIntents: { create: vi.fn() } };
      vi.mocked(getStripe).mockReturnValue(stripe as never);

      const res = await householdChargeCheckout(jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST", body: { chargeId: "charge_1", embedded: true, paymentMethod: "card" },
      }));
      const { status, data } = await parseJsonResponse<{ code?: string }>(res);
      expect(status).toBe(409);
      expect(data.code).toBe("PAYMENT_SOURCE_REVIEW");
      expect(rpcCalls).toEqual([]);
      expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
      expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    });

    it("refuses a partially_paid historical charge before any claim or provider call", async () => {
      vi.mocked(listingFromPropertyData).mockReturnValue(LISTING as never);
      const partial = { ...CHARGE_ROW!, status: "partially_paid",
        row_data: { ...(CHARGE_ROW!.row_data as object), status: "partially_paid" } };
      const { db, rpcCalls } = residentDb({ charge: partial, property: PROPERTY_ROW });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

      const res = await householdChargeCheckout(jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST", body: { chargeId: "charge_1", embedded: true, paymentMethod: "card" },
      }));
      expect(res.status).toBe(409);
      expect(rpcCalls).toEqual([]);
      expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
    });

    it("refuses another resident's charge with 403 before any claim", async () => {
      vi.mocked(listingFromPropertyData).mockReturnValue(LISTING as never);
      const other = { ...CHARGE_ROW!, row_data: { ...(CHARGE_ROW!.row_data as object),
        residentUserId: "someone_else", residentEmail: "other@example.com" } };
      const { db, rpcCalls } = residentDb({ charge: other, property: PROPERTY_ROW });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

      const res = await householdChargeCheckout(jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST", body: { chargeId: "charge_1", embedded: true, paymentMethod: "card" },
      }));
      expect(res.status).toBe(403);
      expect(rpcCalls).toEqual([]);
    });

    it("creates embedded checkout session for valid charge", async () => {
      vi.mocked(resolveListingForHouseholdCharge).mockResolvedValue(LISTING as never);
      vi.mocked(listingFromPropertyData).mockReturnValue(LISTING as never);
      const { db, rpcCalls, order } = residentDb({ charge: CHARGE_ROW, property: PROPERTY_ROW });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      vi.mocked(getStripe).mockReturnValue({} as never);
      vi.mocked(createAxisAchCheckoutSession).mockImplementation(async () => {
        order.push("provider");
        return { mode: "embedded", clientSecret: "cs_ach_secret", sessionId: "cs_ach_session" } as never;
      });

      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: { chargeId: "charge_1", embedded: true, paymentMethod: "card" },
      });
      const res = await householdChargeCheckout(req);
      const { status, data } = await parseJsonResponse<{
        clientSecret?: string; sessionId?: string; chargeIds?: string[]; subtotalCents?: number; totalCents?: number;
      }>(res);

      expect(status).toBe(200);
      expect(data.clientSecret).toBe("cs_ach_secret");
      expect(data.sessionId).toBe("cs_ach_session");
      expect(data.chargeIds).toEqual(["charge_1"]);
      expect(data.subtotalCents).toBe(250000);

      // The whole-cart claim is reserved for the exact charge actor + canonical owner BEFORE the provider call.
      expect(order).toEqual(["reserve", "provider"]);
      const reserve = rpcCalls.find((c) => c.name === "reserve_resident_checkout_attempt")!;
      expect(reserve.args).toMatchObject({
        p_resident_user_id: "res_1", p_manager_user_id: "mgr_1", p_charge_ids: ["charge_1"],
        p_charge_cents: [250000], p_subtotal_cents: 250000, p_payment_method: "card",
      });
      // The session is created from the FROZEN claim parameters (idempotency key, quote, central source marker)...
      const params = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as {
        metadata: Record<string, string>; idempotencyKey: string; fixedFeeBreakdown: { totalCents: number };
      };
      expect(params).toMatchObject({
        destinationAccountId: null, fundingModel: "connect_destination", paymentMethod: "card",
        forceExplicitCard: true, metadata: { source_arbitration_v: "1", manager_user_id: "mgr_1" },
      });
      expect(params.idempotencyKey).toBe(`resident-checkout:${params.metadata.resident_attempt_token}`);
      expect(params.fixedFeeBreakdown.totalCents).toBe(data.totalCents);
      // ...and a household capture never resolves a Connect destination at checkout (platform capture, central source credit).
      expect(resolveConnectDestinationIfReady).not.toHaveBeenCalled();
      // ...then the provider id is bound back to the claim.
      expect(rpcCalls.find((c) => c.name === "bind_resident_checkout_session")?.args).toMatchObject({
        p_attempt_id: "attempt_1", p_session_id: "cs_ach_session",
      });
      expect(captureTestWorkspaceEffectForUser).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "res_1", kind: "payment" }),
      );
    });

    it("creates a manual bank PaymentIntent (no hosted/embedded Checkout) from the frozen claim for ACH", async () => {
      vi.mocked(listingFromPropertyData).mockReturnValue(LISTING as never);
      const { db, rpcCalls, order } = residentDb({ charge: CHARGE_ROW, property: PROPERTY_ROW });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      const create = vi.fn(async (params: Record<string, unknown>, opts: { idempotencyKey: string }) => {
        order.push("provider");
        return { id: "pi_manual_1", ...params, status: "requires_payment_method",
          client_secret: "pi_manual_1_secret", idempotencyKey: opts.idempotencyKey };
      });
      vi.mocked(getStripe).mockReturnValue({ paymentIntents: { create } } as never);

      const res = await householdChargeCheckout(jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST", body: { chargeId: "charge_1", embedded: true, paymentMethod: "ach" },
      }));
      const { status, data } = await parseJsonResponse<{
        mode?: string; clientSecret?: string; paymentIntentId?: string; sessionId?: string; bankStatus?: string;
        chargeIds?: string[]; subtotalCents?: number;
      }>(res);

      expect(status).toBe(200);
      expect(data).toMatchObject({
        mode: "manual_ach", clientSecret: "pi_manual_1_secret", paymentIntentId: "pi_manual_1",
        sessionId: "pi_manual_1", bankStatus: "entry", chargeIds: ["charge_1"], subtotalCents: 250000,
      });
      expect(order).toEqual(["reserve", "provider"]);
      expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
      const [piParams, piOpts] = create.mock.calls[0]!;
      expect(piParams).toMatchObject({ payment_method_types: ["us_bank_account"], currency: "usd" });
      expect(piParams).not.toHaveProperty("transfer_data");
      expect(piOpts.idempotencyKey).toMatch(/^resident-checkout:/);
      expect(rpcCalls.find((c) => c.name === "bind_resident_checkout_session")?.args)
        .toMatchObject({ p_session_id: "pi_manual_1" });
    });

    it("returns 409 and never calls the provider when a payment already owns a selected charge", async () => {
      vi.mocked(listingFromPropertyData).mockReturnValue(LISTING as never);
      const { db } = residentDb({ charge: CHARGE_ROW, property: PROPERTY_ROW, reserveError: true });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      const create = vi.fn();
      vi.mocked(getStripe).mockReturnValue({ paymentIntents: { create } } as never);

      const res = await householdChargeCheckout(jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST", body: { chargeId: "charge_1", embedded: true, paymentMethod: "ach" },
      }));
      const { status, data } = await parseJsonResponse<{ code?: string }>(res);
      expect(status).toBe(409);
      expect(data.code).toBe("PAYMENT_IN_PROGRESS");
      expect(create).not.toHaveBeenCalled();
      expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
    });

    it("keeps card when native app header is present (native supports card)", async () => {
      vi.mocked(resolveListingForHouseholdCharge).mockResolvedValue(LISTING as never);
      vi.mocked(listingFromPropertyData).mockReturnValue(LISTING as never);
      const { db } = residentDb({ charge: CHARGE_ROW, property: PROPERTY_ROW });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      vi.mocked(getStripe).mockReturnValue({} as never);

      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        headers: { "x-axis-native-platform": "ios" },
        body: { chargeId: "charge_1", embedded: true, paymentMethod: "card" },
      });
      const res = await householdChargeCheckout(req);
      expect(res.status, await res.clone().text()).toBe(200);
      const call = vi.mocked(createAxisAchCheckoutSession).mock.calls[0];
      expect(call?.[1]).toMatchObject({ paymentMethod: "card" });
    });
  });

  describe("GET /api/stripe/household-charge-verify", () => {
    it("returns 400 without session_id", async () => {
      const req = new Request("http://localhost/api/stripe/household-charge-verify");
      const res = await householdChargeVerify(req);
      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      } as never);

      const req = new Request("http://localhost/api/stripe/household-charge-verify?session_id=cs_test");
      const res = await householdChargeVerify(req);
      expect(res.status).toBe(401);
    });

    function verifyRequest() {
      return new Request("http://localhost/api/stripe/household-charge-verify?session_id=cs_ach_done");
    }

    it("returns paid:true for completed session", async () => {
      const { attempt, session } = paidCardFixture();
      const stripe = { checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } } };
      vi.mocked(getStripe).mockReturnValue(stripe as never);
      const { db } = residentDb({ attempt });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

      const res = await householdChargeVerify(verifyRequest());
      const { status, data } = await parseJsonResponse<{ paid?: boolean; chargeId?: string; sessionId?: string }>(res);

      expect(status).toBe(200);
      expect(data.paid).toBe(true);
      expect(data.chargeId).toBe("charge_1");
      // Paid is reported only after the exact claim settlement AND the central source credit.
      expect(markHouseholdChargePaidFromStripeSession).toHaveBeenCalledWith(expect.anything(), session);
      expect(creditVerifiedHouseholdCheckoutSource).toHaveBeenCalledWith(expect.anything(), stripe, session);
    });

    it("does not report paid when the central source credit fails", async () => {
      const { attempt, session } = paidCardFixture();
      vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } } } as never);
      const { db } = residentDb({ attempt });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      vi.mocked(creditVerifiedHouseholdCheckoutSource).mockRejectedValueOnce(new Error("source mismatch"));

      const res = await householdChargeVerify(verifyRequest());
      const { status, data } = await parseJsonResponse<{ paid?: boolean }>(res);
      expect(status).toBe(409);
      expect(data.paid).toBe(false);
    });

    it("does not report paid when the exact claim settlement fails, and never credits", async () => {
      const { attempt, session } = paidCardFixture();
      vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } } } as never);
      const { db } = residentDb({ attempt });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
      vi.mocked(markHouseholdChargePaidFromStripeSession).mockResolvedValueOnce({ ok: false } as never);

      const res = await householdChargeVerify(verifyRequest());
      const { status, data } = await parseJsonResponse<{ paid?: boolean }>(res);
      expect(status).toBe(409);
      expect(data.paid).toBe(false);
      expect(creditVerifiedHouseholdCheckoutSource).not.toHaveBeenCalled();
    });

    it("returns 403 for an account without the resident role before reading the provider session", async () => {
      const { attempt } = paidCardFixture();
      const retrieve = vi.fn();
      vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { retrieve } } } as never);
      const { db } = residentDb({ profileRole: "manager", residentRoleRow: null, attempt });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

      const res = await householdChargeVerify(verifyRequest());
      expect(res.status).toBe(403);
      expect(retrieve).not.toHaveBeenCalled();
      expect(markHouseholdChargePaidFromStripeSession).not.toHaveBeenCalled();
    });

    it("returns 403 and settles nothing when the original attempt belongs to a different auth user", async () => {
      const { attempt, session } = paidCardFixture({ attemptResidentUserId: "original_resident" });
      vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } } } as never);
      const { db } = residentDb({ attempt });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

      const res = await householdChargeVerify(verifyRequest());
      expect(res.status).toBe(403);
      expect(markHouseholdChargePaidFromStripeSession).not.toHaveBeenCalled();
      expect(creditVerifiedHouseholdCheckoutSource).not.toHaveBeenCalled();
    });

    it("holds a session with no durable resident attempt for review instead of marking it paid", async () => {
      const { session } = paidCardFixture();
      vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } } } as never);
      const { db } = residentDb({ attempt: null });
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

      const res = await householdChargeVerify(verifyRequest());
      const { status, data } = await parseJsonResponse<{ paid?: boolean }>(res);
      expect(status).toBe(409);
      expect(data.paid).toBe(false);
      expect(markHouseholdChargePaidFromStripeSession).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/stripe/application-fee-checkout", () => {
    it("returns 400 when missing required fields", async () => {
      const req = jsonRequest("http://localhost/api/stripe/application-fee-checkout", {
        method: "POST",
        body: { residentEmail: "resident@example.com" }, // missing propertyId and managerUserId
      });
      const res = await applicationFeeCheckout(req);
      expect(res.status).toBe(400);
    });

    it("returns 403 when the specified manager does not own the property", async () => {
      // The Connect destination must be the property's real owner; the amount is
      // derived from the listing, so body.amountCents is ignored.
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: "app_1", manager_user_id: "other_mgr", property_id: "prop_1", resident_email: "resident@example.com", row_data: { bucket: "pending", stage: "In progress" } },
                error: null,
              }),
            }),
          }),
        }),
      } as never);
      const req = jsonRequest("http://localhost/api/stripe/application-fee-checkout", {
        method: "POST",
        body: { applicationId: "app_1", propertyId: "prop_1", residentEmail: "resident@example.com", managerUserId: "mgr_1", amountCents: 0 },
      });
      const res = await applicationFeeCheckout(req);
      expect(res.status).toBe(403);
    });

    it("rejects a hosted application fee request before creating a provider session", async () => {
      const req = jsonRequest("http://localhost/api/stripe/application-fee-checkout", {
        method: "POST",
        body: {
          applicationId: "app_1",
          propertyId: "prop_1",
          residentEmail: "resident@example.com",
          residentName: "Test Resident",
          managerUserId: "mgr_1",
          mode: "hosted",
        },
      });
      const res = await applicationFeeCheckout(req);
      const { status, data } = await parseJsonResponse<{ error?: string; url?: string }>(res);
      expect(status).toBe(400);
      expect(data.error).toMatch(/inside your application/i);
      expect(data.url).toBeUndefined();
      expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
    });

    it("quotes only selectors from the authorized saved draft", async () => {
      vi.mocked(getStripe).mockReturnValue({} as never);
      vi.mocked(createSupabaseServerClient).mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      } as never);
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockReturnValue(queryChain({
          data: {
            id: "app_owned", manager_user_id: "mgr_1", property_id: "prop_1",
            resident_email: "resident@example.com", updated_at: "2026-10-04T12:00:00.123456Z",
            row_data: { bucket: "pending", stage: "In progress", application: {
              propertyId: "prop_1", email: "resident@example.com",
              roomChoice1: "premium-room", leaseTerm: "12 months", rentalType: "standard",
              applicationTemplateId: "premium-template",
            } },
          }, error: null,
        })),
      } as never);
      vi.mocked(createClaimedApplicationFeeCheckout).mockResolvedValue({
        ok: true, mode: "embedded", clientSecret: "cs_secret", sessionId: "cs_owned",
        itemization: { applicationFeeCents: 5000, serviceFeeCents: 440, totalCents: 5440, feePayer: "resident", managerTier: "pro" },
      });
      const req = jsonRequest("http://localhost/api/stripe/application-fee-checkout", {
        method: "POST", body: {
          applicationId: "app_owned", setupToken: "owned-token", propertyId: "prop_1",
          residentEmail: "resident@example.com", managerUserId: "mgr_1",
          roomChoice1: "cheap-room", applicationTemplateId: "cheap-template", leaseTerm: "1 month",
        },
      });
      const res = await applicationFeeCheckout(req);
      expect(res.status).toBe(200);
      expect(createClaimedApplicationFeeCheckout).toHaveBeenCalledWith(expect.anything(), expect.anything(),
        expect.objectContaining({ applicationId: "app_owned", roomChoice1: "premium-room",
          applicationTemplateId: "premium-template", leaseTerm: "12 months",
          draftUpdatedAt: "2026-10-04T12:00:00.123456Z" }));
    });
  });
});
