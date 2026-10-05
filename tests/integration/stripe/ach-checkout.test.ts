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
      vi.mocked(resolveListingForHouseholdCharge).mockResolvedValue({
        v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true,
      } as never);
      vi.mocked(listingFromPropertyData).mockReturnValue({
        v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true,
      } as never);
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === "portal_household_charge_records") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
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
            return queryChain({ data: { id: "prop_1", manager_user_id: "mgr_1",
              property_data: { listingSubmission: { v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true } } },
              error: null });
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

      expect(status).toBe(200);
      expect(data.clientSecret).toBe("cs_ach_secret");
      expect(data.sessionId).toBe("cs_ach_session");
      expect(vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1]).toMatchObject({
        destinationAccountId: null, fundingModel: "connect_destination",
        metadata: { source_arbitration_v: "1" },
      });
      expect(captureTestWorkspaceEffectForUser).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "res_1", kind: "payment" }),
      );
    });

    it("keeps card when native app header is present (native supports card)", async () => {
      vi.mocked(resolveListingForHouseholdCharge).mockResolvedValue({
        v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true,
      } as never);
      vi.mocked(listingFromPropertyData).mockReturnValue({
        v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true,
      } as never);
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === "portal_household_charge_records") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
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
                      },
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "manager_property_records") {
            return queryChain({ data: { id: "prop_1", manager_user_id: "mgr_1",
              property_data: { listingSubmission: { v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true } } },
              error: null });
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
