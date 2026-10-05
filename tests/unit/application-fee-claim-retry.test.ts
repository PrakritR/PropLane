import { describe, expect, it, vi } from "vitest";
import { createClaimedApplicationFeeCheckout } from "@/lib/application-fee-payment-claim.server";

const storedSelectors = JSON.stringify({ rentalType: "standard", leaseTerm: "12 months",
  roomChoice1: "cheap-room", bundleId: "", applicationTemplateId: "" });
const claim = {
  application_id: "app-1", manager_user_id: "manager-1", property_id: "property-1",
  resident_email: "resident@example.com", charge_id: "hc_app-1", attempt_token: "attempt-1",
  stripe_session_id: "cs_open", stripe_charge_id: null, principal_cents: 500,
  processing_fee_cents: 44, payer_total_cents: 544, recipient_net_cents: 500,
  charge_policy: "every_time", status: "pending", updated_at: "2026-10-04T12:00:00Z",
  provider_params: { mode: "embedded", paymentMethod: "card", forceExplicitCard: true,
    amountCents: 500, residentEmail: "resident@example.com", managerTier: "pro", feePayer: "resident",
    returnUrl: "https://proplane.test/return", draftSelectors: storedSelectors,
    metadata: { purpose: "rental_application_fee", application_id: "app-1", manager_user_id: "manager-1", fee_cents: "500" },
    fixedFeeBreakdown: { serviceFeeCents: 44, residentAddedFeeCents: 44,
      applicationFeeCents: 44, totalCents: 544, managerPayoutCents: 500 },
  },
};

describe("application fee quote replacement", () => {
  it("resumes the same open Checkout after an unrelated answer autosave", async () => {
    const rpc = vi.fn(async () => ({ data: claim, error: null }));
    const db = { from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: claim, error: null }) }) }) })), rpc };
    const expire = vi.fn();
    const stripe = { checkout: { sessions: {
      retrieve: vi.fn().mockResolvedValue({ id: "cs_open", mode: "payment", status: "open",
        client_secret: "cs_secret", amount_total: 544, currency: "usd", metadata: {
          purpose: "rental_application_fee", application_id: "app-1", attempt_token: "attempt-1",
          manager_user_id: "manager-1", property_id: "property-1",
          resident_email: "resident@example.com", fee_cents: "500",
        } }), expire,
    } } };
    const result = await createClaimedApplicationFeeCheckout(db as never, stripe as never, {
      applicationId: "app-1", draftUpdatedAt: "2026-10-04T12:01:00Z",
      managerUserId: "manager-1", propertyId: "property-1", residentEmail: "resident@example.com",
      rentalType: "standard", leaseTerm: "12 months", roomChoice1: "cheap-room",
      mode: "embedded", returnUrl: "https://proplane.test/return",
    });
    expect(result).toMatchObject({ ok: true, sessionId: "cs_open", clientSecret: "cs_secret" });
    expect(expire).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not rotate or recreate when payment wins after an open-session read", async () => {
    const rpc = vi.fn(async (name: string) => name === "reserve_application_fee_checkout"
      ? { data: claim, error: null } : { data: null, error: null });
    const db = { from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: claim, error: null }) }) }) })), rpc };
    const expire = vi.fn().mockRejectedValue(new Error("Checkout already completed"));
    const stripe = { checkout: { sessions: {
      retrieve: vi.fn().mockResolvedValue({ id: "cs_open", mode: "payment", status: "open",
        client_secret: "cs_secret", amount_total: 544, currency: "usd", metadata: {
          purpose: "rental_application_fee", application_id: "app-1", attempt_token: "attempt-1",
          manager_user_id: "manager-1", property_id: "property-1",
          resident_email: "resident@example.com", fee_cents: "500",
        } }), expire,
    } } };
    await expect(createClaimedApplicationFeeCheckout(db as never, stripe as never, {
      applicationId: "app-1", draftUpdatedAt: "2026-10-04T12:01:00Z",
      managerUserId: "manager-1", propertyId: "property-1", residentEmail: "resident@example.com",
      rentalType: "standard", leaseTerm: "12 months", roomChoice1: "premium-room",
      mode: "embedded", returnUrl: "https://proplane.test/return",
    })).rejects.toThrow(/already completed/);
    expect(expire).toHaveBeenCalledWith("cs_open");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith("rotate_expired_application_fee_checkout", expect.anything());
  });
});
