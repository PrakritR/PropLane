import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import {
  axisAchCheckoutPaid,
  axisAchCheckoutProcessing,
  createAxisAchCheckoutSession,
} from "@/lib/stripe-axis-ach-checkout";
import { residentProcessingFeeCents } from "@/lib/payment-policy";
import { mockCheckoutSession } from "../mocks/stripe/events";

describe("stripe-axis-ach-checkout", () => {
  it("detects paid ACH checkout", () => {
    expect(axisAchCheckoutPaid(mockCheckoutSession({ payment_status: "paid" }))).toBe(true);
    expect(axisAchCheckoutPaid(mockCheckoutSession({ payment_status: "no_payment_required" }))).toBe(true);
    expect(axisAchCheckoutPaid(mockCheckoutSession({ payment_status: "unpaid" }))).toBe(false);
  });

  it("detects processing ACH checkout", () => {
    expect(
      axisAchCheckoutProcessing(mockCheckoutSession({ status: "complete", payment_status: "unpaid" })),
    ).toBe(true);
    expect(axisAchCheckoutProcessing(mockCheckoutSession({ status: "open", payment_status: "unpaid" }))).toBe(false);
  });
});

// Apple Pay / Google Pay are surfaced by Stripe Checkout on the CARD method-class.
// These assert the session params the builder hands Stripe so the wallet path
// (and its fee model) can't silently regress. `stripe` is injected, so no network.
describe("createAxisAchCheckoutSession — payment-method surface", () => {
  const PREV_PMC = process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION;

  function enabled() {
    return { available: true, display_preference: { preference: "on", value: "on" } };
  }

  function disabled() {
    return { available: false, display_preference: { preference: "none", value: "off" } };
  }

  const CARD_SCOPED_PMC = {
    object: "payment_method_configuration",
    name: "Card + wallets",
    active: true,
    is_default: false,
    livemode: false,
    application: null,
    card: enabled(),
    apple_pay: enabled(),
    google_pay: enabled(),
    link: disabled(),
    us_bank_account: disabled(),
    klarna: disabled(),
  };

  function captureStripe(pmc?: Record<string, unknown> | Error) {
    const calls: Record<string, unknown>[] = [];
    const pmcLookups: string[] = [];
    const stripe = {
      checkout: {
        sessions: {
          create: async (params: Record<string, unknown>) => {
            calls.push(params);
            return { id: "cs_test", url: "https://checkout.stripe.test/x", client_secret: "cs_secret" };
          },
        },
      },
      paymentMethodConfigurations: {
        retrieve: async (id: string) => {
          pmcLookups.push(id);
          if (pmc instanceof Error) throw pmc;
          return { id, ...(pmc ?? CARD_SCOPED_PMC) };
        },
      },
    } as unknown as Stripe;
    return { stripe, calls, pmcLookups };
  }

  const baseInput = {
    residentEmail: "resident@example.com",
    amountCents: 5000,
    productName: "Rental application fee",
    metadata: { purpose: "rental_application_fee" },
    mode: "hosted" as const,
    destinationAccountId: "acct_test",
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/cancel",
  };

  beforeEach(() => {
    delete process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION;
  });

  afterEach(() => {
    if (PREV_PMC === undefined) delete process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION;
    else process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION = PREV_PMC;
  });

  it("card without a PMC env falls back to an explicit card allowlist (never leaks ACH)", async () => {
    const { stripe, calls } = captureStripe();
    await createAxisAchCheckoutSession(stripe, { ...baseInput, paymentMethod: "card" });
    expect(calls[0]?.payment_method_types).toEqual(["card"]);
    expect(calls[0]).not.toHaveProperty("payment_method_configuration");
  });

  it("card WITH a card-scoped PMC env uses dynamic payment methods (so Apple Pay can appear)", async () => {
    process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION = "pmc_card_wallets";
    const { stripe, calls } = captureStripe();
    await createAxisAchCheckoutSession(stripe, { ...baseInput, paymentMethod: "card" });
    // Dynamic payment methods require OMITTING payment_method_types entirely.
    expect(calls[0]).not.toHaveProperty("payment_method_types");
    expect(calls[0]?.payment_method_configuration).toBe("pmc_card_wallets");
  });

  // The card fee line item and the Connect application_fee_amount are computed
  // BEFORE the session exists, so a PMC that also offers a different-fee method
  // would break "manager payout == full subtotal".
  it("rejects a PMC that enables a non-card method and falls back to explicit card", async () => {
    process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION = "pmc_card_plus_ach";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { stripe, calls } = captureStripe({ ...CARD_SCOPED_PMC, us_bank_account: enabled() });
    await createAxisAchCheckoutSession(stripe, { ...baseInput, paymentMethod: "card" });
    expect(calls[0]?.payment_method_types).toEqual(["card"]);
    expect(calls[0]).not.toHaveProperty("payment_method_configuration");
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[0])).toContain("us_bank_account");
    logged.mockRestore();
  });

  // Link is priced at the card rate here, so a card+wallets+Link PMC is still
  // fee-exact — rejecting it would strip Apple Pay from a valid configuration.
  it("accepts a PMC that also enables Link (identical card-rate fee)", async () => {
    process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION = "pmc_card_wallets_link";
    const { stripe, calls } = captureStripe({ ...CARD_SCOPED_PMC, link: enabled() });
    await createAxisAchCheckoutSession(stripe, { ...baseInput, paymentMethod: "card" });
    expect(calls[0]).not.toHaveProperty("payment_method_types");
    expect(calls[0]?.payment_method_configuration).toBe("pmc_card_wallets_link");
  });

  it("rejects a PMC that enables a deferred-payment method (klarna) too", async () => {
    process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION = "pmc_card_plus_klarna";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { stripe, calls } = captureStripe({ ...CARD_SCOPED_PMC, klarna: enabled() });
    await createAxisAchCheckoutSession(stripe, { ...baseInput, paymentMethod: "card" });
    expect(calls[0]?.payment_method_types).toEqual(["card"]);
    logged.mockRestore();
  });

  // A typo'd / deleted PMC id must not cost a Stripe round-trip plus a
  // console.error on EVERY card checkout — the failure is cached too.
  it("falls back to explicit card when the PMC lookup itself fails, and caches that", async () => {
    process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION = "pmc_missing";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { stripe, calls, pmcLookups } = captureStripe(new Error("No such payment_method_configuration"));
    await createAxisAchCheckoutSession(stripe, { ...baseInput, paymentMethod: "card" });
    await createAxisAchCheckoutSession(stripe, { ...baseInput, paymentMethod: "card" });
    expect(calls[0]?.payment_method_types).toEqual(["card"]);
    expect(calls[1]?.payment_method_types).toEqual(["card"]);
    expect(calls[0]).not.toHaveProperty("payment_method_configuration");
    expect(pmcLookups).toEqual(["pmc_missing"]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("ach stays an explicit bank-only session even when a card PMC is configured", async () => {
    process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION = "pmc_card_wallets";
    const { stripe, calls } = captureStripe();
    await createAxisAchCheckoutSession(stripe, { ...baseInput, paymentMethod: "ach" });
    expect(calls[0]?.payment_method_types).toEqual(["us_bank_account"]);
    expect(calls[0]).not.toHaveProperty("payment_method_configuration");
  });

  // ── Money path: the ACTUAL session params for each fee-payer.
  //
  // Every case stays a DESTINATION charge on PropLane's platform account
  // (transfer_data.destination, no on_behalf_of, no Stripe-Account header), so
  // the money always lands in the manager's own account. Only who bears the
  // service fee moves; `application_fee_amount` and the fee line item follow.
  describe("service fee placement by fee-payer", () => {
    const methods = ["ach", "card", "link"] as const;
    // $1.00 floor, a $0.30-fixed-fee-sensitive amount, the ACH cap boundary, and
    // a large rent payment.
    const subtotals = [100, 5_000, 62_500, 499_900];

    function lineItemTotal(params: Record<string, unknown>): number {
      const items = params.line_items as { price_data: { unit_amount: number }; quantity: number }[];
      return items.reduce((sum, item) => sum + item.price_data.unit_amount * item.quantity, 0);
    }

    for (const method of methods) {
      for (const subtotal of subtotals) {
        const fee = residentProcessingFeeCents(subtotal, method);

        it(`resident pays: ${method} @ $${(subtotal / 100).toFixed(2)} → subtotal + fee, appFee=fee`, async () => {
          const { stripe, calls } = captureStripe();
          const result = await createAxisAchCheckoutSession(stripe, {
            ...baseInput,
            amountCents: subtotal,
            paymentMethod: method,
            feePayer: "resident",
          });
          const params = calls[0]!;
          const pid = params.payment_intent_data as Record<string, unknown>;

          // The resident is charged subtotal + fee, shown as its own line item.
          expect(lineItemTotal(params)).toBe(subtotal + fee);
          expect((params.line_items as unknown[]).length).toBe(2);
          expect(result.totalCents).toBe(subtotal + fee);
          expect(result.subtotalCents).toBe(subtotal);
          expect(result.processingFeeCents).toBe(fee);
          expect(result.axisFeeCents).toBe(0);

          // The fee is retained as the application fee; the manager still gets the subtotal.
          expect(pid.application_fee_amount).toBe(fee);
          expect(result.platformFeeCents).toBe(fee);
          expect(lineItemTotal(params) - fee).toBe(subtotal);

          expect(pid.transfer_data).toEqual({ destination: "acct_test" });
          expect(pid).not.toHaveProperty("on_behalf_of");

          const metadata = params.metadata as Record<string, string>;
          expect(metadata.fee_payer).toBe("resident");
          expect(metadata.subtotal_cents).toBe(String(subtotal));
          expect(metadata.processing_fee_cents).toBe(String(fee));
          expect(metadata.service_fee_cents).toBe(String(fee));
          expect(metadata.manager_payout_cents).toBe(String(subtotal));
        });

        it(`manager pays: ${method} @ $${(subtotal / 100).toFixed(2)} → face value, appFee=fee`, async () => {
          const { stripe, calls } = captureStripe();
          const result = await createAxisAchCheckoutSession(stripe, {
            ...baseInput,
            amountCents: subtotal,
            paymentMethod: method,
            feePayer: "manager",
          });
          const params = calls[0]!;
          const pid = params.payment_intent_data as Record<string, unknown>;

          // Resident pays exactly the subtotal (no fee line item)…
          expect(lineItemTotal(params)).toBe(subtotal);
          expect((params.line_items as unknown[]).length).toBe(1);
          expect(result.totalCents).toBe(subtotal);
          expect(result.processingFeeCents).toBe(0);

          // …but the fee is retained, so the manager nets subtotal − fee.
          expect(pid.application_fee_amount).toBe(fee);
          expect(result.platformFeeCents).toBe(fee);
          expect(lineItemTotal(params) - fee).toBe(subtotal - fee);

          expect(pid.transfer_data).toEqual({ destination: "acct_test" });
          expect(pid).not.toHaveProperty("on_behalf_of");

          const metadata = params.metadata as Record<string, string>;
          expect(metadata.fee_payer).toBe("manager");
          expect(metadata.manager_payout_cents).toBe(String(subtotal - fee));
          expect(metadata.service_fee_cents).toBe(String(fee));
        });

        it(`PropLane pays: ${method} @ $${(subtotal / 100).toFixed(2)} → face value, no appFee`, async () => {
          const { stripe, calls } = captureStripe();
          const result = await createAxisAchCheckoutSession(stripe, {
            ...baseInput,
            amountCents: subtotal,
            paymentMethod: method,
            feePayer: "proplane",
          });
          const params = calls[0]!;
          const pid = params.payment_intent_data as Record<string, unknown>;

          // Resident pays face value; nothing retained → PropLane bears Stripe's fee.
          expect(lineItemTotal(params)).toBe(subtotal);
          expect((params.line_items as unknown[]).length).toBe(1);
          expect(result.totalCents).toBe(subtotal);
          expect(result.processingFeeCents).toBe(0);
          expect(result.axisFeeCents).toBe(0);
          expect(pid).not.toHaveProperty("application_fee_amount");
          expect(result.platformFeeCents).toBe(0);

          expect(pid.transfer_data).toEqual({ destination: "acct_test" });
          expect(pid).not.toHaveProperty("on_behalf_of");

          const metadata = params.metadata as Record<string, string>;
          expect(metadata.fee_payer).toBe("proplane");
          expect(metadata.manager_payout_cents).toBe(String(subtotal));
        });
      }
    }

    it("defaults to PropLane-absorbs (face value) when feePayer is omitted", async () => {
      const { stripe, calls } = captureStripe();
      const result = await createAxisAchCheckoutSession(stripe, {
        ...baseInput,
        amountCents: 5_000,
        paymentMethod: "card",
      });
      const params = calls[0]!;
      expect(lineItemTotal(params)).toBe(5_000);
      expect(result.totalCents).toBe(5_000);
      expect(params.payment_intent_data).not.toHaveProperty("application_fee_amount");
    });

    it("resident-pays multi-charge session appends ONE fee line for the whole subtotal", async () => {
      const { stripe, calls } = captureStripe();
      const subtotal = 180_000 + 7_350;
      const fee = residentProcessingFeeCents(subtotal, "card");
      const result = await createAxisAchCheckoutSession(stripe, {
        ...baseInput,
        amountCents: undefined,
        lineItems: [
          { amountCents: 180_000, productName: "Rent — March" },
          { amountCents: 7_350, productName: "Utilities — March" },
        ],
        paymentMethod: "card",
        feePayer: "resident",
      });
      const params = calls[0]!;
      const items = params.line_items as { price_data: { product_data: { name: string } } }[];
      expect(items.map((i) => i.price_data.product_data.name)).toEqual([
        "Rent — March",
        "Utilities — March",
        "Payment processing fee",
      ]);
      expect(result.totalCents).toBe(subtotal + fee);
      expect((params.payment_intent_data as Record<string, unknown>).application_fee_amount).toBe(fee);
    });

    it("hold path: no destination, no application fee, platform_hold metadata", async () => {
      const { stripe, calls } = captureStripe();
      const subtotal = 120_000;
      const fee = residentProcessingFeeCents(subtotal, "ach");
      const result = await createAxisAchCheckoutSession(stripe, {
        ...baseInput,
        amountCents: subtotal,
        paymentMethod: "ach",
        feePayer: "resident",
        destinationAccountId: undefined,
      });
      const params = calls[0]!;
      const pid = params.payment_intent_data as Record<string, unknown>;
      expect(pid.transfer_data).toBeUndefined();
      expect(pid).not.toHaveProperty("application_fee_amount");
      expect((pid.metadata as Record<string, string>).platform_hold).toBe("1");
      expect((pid.metadata as Record<string, string>).hold_amount_cents).toBe(String(subtotal));
      expect(result.totalCents).toBe(subtotal + fee);
    });

    // PROPLANE_BALANCE_ENABLED (night/vendor-pay): the ONE new branch. Must be
    // byte-different from BOTH the destination path (no transfer_data at all,
    // even though a destinationAccountId was passed) and the hold path (no
    // platform_hold flag — this is a deliberate permanent choice, not a
    // "waiting on Connect onboarding" state).
    it("platform_ledger: no transfer_data, no application_fee_amount, no platform_hold — funding_model metadata only", async () => {
      const { stripe, calls } = captureStripe();
      const subtotal = 150_000;
      const fee = residentProcessingFeeCents(subtotal, "ach");
      const result = await createAxisAchCheckoutSession(stripe, {
        ...baseInput,
        amountCents: subtotal,
        paymentMethod: "ach",
        feePayer: "resident",
        destinationAccountId: "acct_test", // must be ignored when platform_ledger is set
        fundingModel: "platform_ledger",
      });
      const params = calls[0]!;
      const pid = params.payment_intent_data as Record<string, unknown>;
      expect(pid.transfer_data).toBeUndefined();
      expect(pid).not.toHaveProperty("application_fee_amount");
      const piMetadata = pid.metadata as Record<string, string>;
      expect(piMetadata.funding_model).toBe("platform_ledger");
      expect(piMetadata.platform_hold).toBeUndefined();

      const metadata = params.metadata as Record<string, string>;
      expect(metadata.funding_model).toBe("platform_ledger");
      expect(metadata.platform_hold).toBeUndefined();
      expect(metadata.manager_payout_cents).toBe(String(subtotal));
      expect(result.totalCents).toBe(subtotal + fee);
    });

    it("connect_destination (default, flag off) is byte-identical whether fundingModel is omitted or explicit", async () => {
      const { stripe, calls: callsOmitted } = captureStripe();
      await createAxisAchCheckoutSession(stripe, { ...baseInput, amountCents: 5_000, paymentMethod: "card" });
      const { stripe: stripe2, calls: callsExplicit } = captureStripe();
      await createAxisAchCheckoutSession(stripe2, {
        ...baseInput,
        amountCents: 5_000,
        paymentMethod: "card",
        fundingModel: "connect_destination",
      });
      expect(callsExplicit[0]).toEqual(callsOmitted[0]);
    });
  });
});
