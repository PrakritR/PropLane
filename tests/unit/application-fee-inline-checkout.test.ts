import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// The application fee must be payable INLINE (embedded) inside the wizard —
// never a redirect to a hosted Stripe page. This locks the server default to
// embedded and confirms a client secret is returned for the inline form.

vi.mock("@/lib/stripe-axis-ach-checkout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe-axis-ach-checkout")>(
    "@/lib/stripe-axis-ach-checkout",
  );
  return { ...actual, createAxisAchCheckoutSession: vi.fn() };
});

vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: vi.fn() }));
vi.mock("@/lib/stripe-connect", () => ({
  resolveAndValidateManagerConnectForPayments: vi.fn(),
  resolveConnectDestinationIfReady: vi.fn(),
}));

import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import { resolveAndValidateManagerConnectForPayments, resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { createApplicationFeeCheckout } from "@/lib/application-fee-checkout.server";

function makeDb(): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      if (table === "manager_property_records") {
        return {
          data: {
            manager_user_id: "mgr_A",
            property_data: {
              listingSubmission: { v: 1, applicationFee: "$50", axisPaymentsEnabled: true, rooms: [], bathrooms: [] },
            },
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

const stripe = {} as Stripe;

describe("createApplicationFeeCheckout — inline (embedded) by default", () => {
  beforeEach(() => {
    vi.mocked(getManagerPurchaseSku).mockResolvedValue({ tier: "free" } as never);
    vi.mocked(loadManagerManualPaymentSettings).mockResolvedValue({ serviceFeePayer: "resident" } as never);
    vi.mocked(resolveAndValidateManagerConnectForPayments).mockResolvedValue({
      ok: true,
      accountId: "acct_1",
    } as never);
    vi.mocked(resolveConnectDestinationIfReady).mockResolvedValue("acct_1");
    vi.mocked(createAxisAchCheckoutSession).mockReset();
  });

  it("defaults to embedded mode and returns a client secret for the inline form", async () => {
    vi.mocked(createAxisAchCheckoutSession).mockResolvedValue({
      mode: "embedded",
      clientSecret: "cs_live_secret",
      sessionId: "cs_1",
      subtotalCents: 5000,
      processingFeeCents: 0,
      axisFeeCents: 0,
      platformFeeCents: 0,
      totalCents: 5000,
      paymentMethod: "card",
    } as never);

    const res = await createApplicationFeeCheckout(makeDb(), stripe, {
      propertyId: "prop_1",
      residentEmail: "a@example.com",
      managerUserId: "mgr_A",
      returnUrl: "https://app.test/rent/apply?fee_checkout=return&session_id={CHECKOUT_SESSION_ID}",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mode).toBe("embedded");
      if (res.mode === "embedded") expect(res.clientSecret).toBe("cs_live_secret");
    }
    // The session creator was asked for an embedded session, not hosted.
    const call = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as { mode?: string };
    expect(call?.mode).toBe("embedded");
  });

  it("still supports an explicit hosted redirect for legacy callers", async () => {
    vi.mocked(createAxisAchCheckoutSession).mockResolvedValue({
      mode: "hosted",
      url: "https://checkout.stripe.com/x",
      sessionId: "cs_2",
      subtotalCents: 5000,
      processingFeeCents: 0,
      axisFeeCents: 0,
      platformFeeCents: 0,
      totalCents: 5000,
      paymentMethod: "card",
    } as never);

    const res = await createApplicationFeeCheckout(makeDb(), stripe, {
      propertyId: "prop_1",
      residentEmail: "a@example.com",
      managerUserId: "mgr_A",
      mode: "hosted",
      successUrl: "https://app.test/s",
      cancelUrl: "https://app.test/c",
    });

    expect(res.ok).toBe(true);
    if (res.ok && res.mode === "hosted") expect(res.url).toBe("https://checkout.stripe.com/x");
  });
});
