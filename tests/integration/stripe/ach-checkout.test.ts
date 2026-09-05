import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

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

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn().mockResolvedValue({ tier: "pro", stripeCustomerId: null }),
  normalizeManagerSkuTier: vi.fn((t: string) => t),
}));

vi.mock("@/lib/stripe-connect", () => ({
  resolveAndValidateManagerConnectForPayments: vi.fn(),
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

vi.mock("@/lib/rental-application/application-fee-channel", () => ({
  listingApplicationFeeChannels: vi.fn(() => ({ ach: true, axisPlatformFee: true })),
}));

vi.mock("@/lib/manager-listing-submission", () => ({
  normalizeManagerListingSubmissionV1: vi.fn((s: unknown) => s),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAndValidateManagerConnectForPayments } from "@/lib/stripe-connect";
import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { POST as householdChargeCheckout } from "@/app/api/stripe/household-charge-checkout/route";
import { GET as householdChargeVerify } from "@/app/api/stripe/household-charge-verify/route";
import { POST as applicationFeeCheckout } from "@/app/api/stripe/application-fee-checkout/route";
import { getStripe } from "@/lib/stripe";

describe("ACH checkout routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "res_1", email: "resident@example.com" } } }) },
    } as never);

    vi.mocked(resolveAndValidateManagerConnectForPayments).mockResolvedValue({
      ok: true,
      accountId: "acct_test_123",
    } as never);

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

    it("returns 400 when no chargeId provided", async () => {
      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: {},
      });
      const res = await householdChargeCheckout(req);
      expect(res.status).toBe(400);
    });

    it("returns 404 when charge not found", async () => {
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      } as never);

      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: { chargeId: "nonexistent_charge" },
      });
      const res = await householdChargeCheckout(req);
      expect(res.status).toBe(404);
    });

    it("creates embedded checkout session for valid charge", async () => {
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === "portal_household_charge_records") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      id: "charge_1",
                      status: "due",
                      manager_user_id: "mgr_1",
                      row_data: {
                        id: "charge_1",
                        kind: "rent",
                        status: "due",
                        amountCents: 250000,
                        residentEmail: "resident@example.com",
                        residentUserId: "res_1",
                        propertyId: "prop_1",
                      },
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "manager_purchases") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { tier: "pro" }, error: null }),
                }),
              }),
            };
          }
          if (table === "manager_property_records") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            };
          }
          return { select: vi.fn().mockReturnThis() };
        }),
      } as never);

      const req = jsonRequest("http://localhost/api/stripe/household-charge-checkout", {
        method: "POST",
        body: { chargeId: "charge_1", embedded: true },
      });
      const res = await householdChargeCheckout(req);
      const { status, data } = await parseJsonResponse<{ clientSecret?: string; sessionId?: string }>(res);

      expect(status, JSON.stringify(data)).toBe(200);
      expect(data.clientSecret).toBe("cs_ach_secret");
      expect(data.sessionId).toBe("cs_ach_session");
    });

    it("keeps card when native app header is present (native supports card)", async () => {
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === "portal_household_charge_records") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      id: "charge_1",
                      status: "due",
                      manager_user_id: "mgr_1",
                      row_data: {
                        id: "charge_1",
                        kind: "rent",
                        status: "due",
                        amountCents: 250000,
                        residentEmail: "resident@example.com",
                        residentUserId: "res_1",
                        propertyId: "prop_1",
                      },
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "manager_property_records") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            };
          }
          return { select: vi.fn().mockReturnThis() };
        }),
      } as never);

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

    it("returns paid:true for completed session", async () => {
      vi.mocked(getStripe).mockReturnValue({
        checkout: {
          sessions: {
            retrieve: vi.fn().mockResolvedValue({
              id: "cs_ach_done",
              payment_status: "paid",
              status: "complete",
              metadata: { resident_email: "resident@example.com", charge_id: "charge_1", purpose: "household_charge" },
              customer_email: "resident@example.com",
            }),
          },
        },
      } as never);

      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
          }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        }),
      } as never);

      const req = new Request("http://localhost/api/stripe/household-charge-verify?session_id=cs_ach_done");
      const res = await householdChargeVerify(req);
      const { status, data } = await parseJsonResponse<{ paid?: boolean; chargeId?: string }>(res);

      expect(status).toBe(200);
      expect(data.paid).toBe(true);
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
                data: { manager_user_id: "other_mgr", property_data: { listingSubmission: { v: 1, applicationFee: "50" } } },
                error: null,
              }),
            }),
          }),
        }),
      } as never);
      const req = jsonRequest("http://localhost/api/stripe/application-fee-checkout", {
        method: "POST",
        body: { propertyId: "prop_1", residentEmail: "resident@example.com", managerUserId: "mgr_1", amountCents: 0 },
      });
      const res = await applicationFeeCheckout(req);
      expect(res.status).toBe(403);
    });

    it("creates hosted checkout session for valid application fee", async () => {
      // Application-fee payment defaults to inline (embedded); this case pins
      // the still-supported hosted-redirect path via an explicit mode override.
      vi.mocked(createAxisAchCheckoutSession).mockResolvedValue({
        mode: "hosted",
        url: "https://checkout.stripe.test/fee",
        sessionId: "cs_fee_session",
        subtotalCents: 5000,
        processingFeeCents: 0,
        axisFeeCents: 0,
        platformFeeCents: 0,
        totalCents: 5000,
        paymentMethod: "ach",
      } as never);

      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                // Owner matches the request, and the listing carries a $50 fee that
                // the server derives the charge amount from.
                data: { manager_user_id: "mgr_1", property_data: { listingSubmission: { v: 1, applicationFee: "50" } } },
                error: null,
              }),
            }),
          }),
        }),
      } as never);

      const req = jsonRequest("http://localhost/api/stripe/application-fee-checkout", {
        method: "POST",
        body: {
          propertyId: "prop_1",
          residentEmail: "resident@example.com",
          residentName: "Test Resident",
          managerUserId: "mgr_1",
          mode: "hosted",
        },
      });
      const res = await applicationFeeCheckout(req);
      const { status, data } = await parseJsonResponse<{ url?: string; sessionId?: string }>(res);

      expect(status).toBe(200);
      expect(data.url).toContain("checkout.stripe");
      expect(data.sessionId).toBe("cs_fee_session");
    });
  });
});
