import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * P003 (2026-09-27): each application template can carry its OWN
 * application cost and promo code, falling back to the account default when
 * unset. The fee charged is resolved SERVER-SIDE from the template the
 * applicant actually applied with (`applicationTemplateId`, a SELECTOR —
 * exactly like the existing `rentalType`/`leaseTerm` selectors, never an
 * amount), through the same `resolveApplicationFeeProperty` /
 * `createApplicationFeeCheckout` path every application fee already goes
 * through. One resolver (`effectiveApplicationFeeCents`), no client-supplied
 * amount, the waiver-code REDEMPTION mechanism untouched.
 */

vi.mock("@/lib/stripe-axis-ach-checkout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe-axis-ach-checkout")>(
    "@/lib/stripe-axis-ach-checkout",
  );
  return { ...actual, createAxisAchCheckoutSession: vi.fn() };
});

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn(),
}));

vi.mock("@/lib/manager-manual-payment-settings", () => ({
  loadManagerManualPaymentSettings: vi.fn(),
}));

import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import {
  createApplicationFeeCheckout,
  resolveApplicationFeeProperty,
} from "@/lib/application-fee-checkout.server";
import { effectiveApplicationFeeCents } from "@/lib/manager-application-settings";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";

function makeStripe(): Stripe {
  return {
    accounts: {
      retrieve: vi.fn().mockResolvedValue({ id: "acct_manager_A", capabilities: { transfers: "active" }, payouts_enabled: true }),
      update: vi.fn(),
    },
  } as unknown as Stripe;
}

const LONG_TERM_TEMPLATE = {
  ...createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" }),
  id: "app-tpl-long",
  feeCentsOverride: 3500,
  waiverCodeOverride: "LONGSTAY",
};
const SHORT_TERM_TEMPLATE = {
  ...createPropertyApplicationTemplate({ kind: "short-term", label: "Short-term application" }),
  id: "app-tpl-short",
  // No override — must fall back to the account default.
  feeCentsOverride: null,
  waiverCodeOverride: null,
};
const FREE_TEMPLATE = {
  ...createPropertyApplicationTemplate({ kind: "long-term", label: "Free intro application" }),
  id: "app-tpl-free",
  // 0 is a meaningful override ("this application is free"), same
  // null-vs-zero rule the account-level setting already uses.
  feeCentsOverride: 0,
};

function makeDb(opts: { managerUserId: string; managerFeeCents?: number | null; managerAccountId?: string | null }): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      if (table === "manager_property_records") {
        return {
          data: {
            manager_user_id: opts.managerUserId,
            property_data: {
              listingSubmission: {
                v: 1,
                axisPaymentsEnabled: true,
                rooms: [],
                bathrooms: [],
                propertyApplicationTemplates: [LONG_TERM_TEMPLATE, SHORT_TERM_TEMPLATE, FREE_TEMPLATE],
              },
            },
          },
          error: null,
        };
      }
      if (table === "profiles") {
        return { data: { stripe_connect_account_id: opts.managerAccountId ?? "acct_manager_A" }, error: null };
      }
      if (table === "manager_automation_settings") {
        return {
          data: {
            row_data: { applicationSettings: { applicationFeeCents: opts.managerFeeCents ?? 5000 } },
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

const baseInput = {
  propertyId: "prop_1",
  residentEmail: "applicant@example.com",
  managerUserId: "mgr_A",
  successUrl: "https://app.test/success",
  cancelUrl: "https://app.test/cancel",
};

beforeEach(() => {
  vi.mocked(createAxisAchCheckoutSession).mockReset();
  vi.mocked(createAxisAchCheckoutSession).mockResolvedValue({
    mode: "hosted",
    url: "https://checkout.stripe.com/session",
    sessionId: "cs_1",
    subtotalCents: 0,
    processingFeeCents: 0,
    axisFeeCents: 0,
    totalCents: 0,
    platformFeeCents: 0,
    paymentMethod: "card",
  });
  vi.mocked(getManagerPurchaseSku).mockResolvedValue({
    tier: "free",
    billing: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    appleOriginalTransactionId: null,
  });
  vi.mocked(loadManagerManualPaymentSettings).mockResolvedValue({ serviceFeePayer: "resident" });
});

describe("effectiveApplicationFeeCents — template override precedence (pure resolver)", () => {
  it("the template's own fee wins over the account default", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: 5000, templateFeeCentsOverride: 3500 })).toBe(3500);
  });

  it("falls back to the account default when the template set no override", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: 5000, templateFeeCentsOverride: null })).toBe(5000);
    expect(effectiveApplicationFeeCents({ managerFeeCents: 5000, templateFeeCentsOverride: undefined })).toBe(5000);
  });

  it("falls all the way back to the legacy $50 default when nothing at all is configured", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: null, templateFeeCentsOverride: null })).toBe(5000);
  });

  it("0 is a meaningful override distinct from unset — the application is free", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: 5000, templateFeeCentsOverride: 0 })).toBe(0);
  });
});

describe("resolveApplicationFeeProperty — resolves the template fee SERVER-SIDE by applicationTemplateId", () => {
  it("uses the resolved template's own fee, ignoring the account default", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const result = await resolveApplicationFeeProperty(db, {
      propertyId: "prop_1",
      managerUserId: "mgr_A",
      applicationTemplateId: "app-tpl-long",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.applicationFeeCents).toBe(3500);
  });

  it("falls back to the account default when the resolved template set no override", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const result = await resolveApplicationFeeProperty(db, {
      propertyId: "prop_1",
      managerUserId: "mgr_A",
      applicationTemplateId: "app-tpl-short",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.applicationFeeCents).toBe(5000);
  });

  it("falls back to the account default when applicationTemplateId matches nothing stored (unknown/blank id)", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const unknown = await resolveApplicationFeeProperty(db, {
      propertyId: "prop_1",
      managerUserId: "mgr_A",
      applicationTemplateId: "does-not-exist",
    });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.value.applicationFeeCents).toBe(5000);

    const omitted = await resolveApplicationFeeProperty(db, { propertyId: "prop_1", managerUserId: "mgr_A" });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect(omitted.value.applicationFeeCents).toBe(5000);
  });

  it("a template override of 0 is honored as free (allowZeroFee)", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const result = await resolveApplicationFeeProperty(
      db,
      { propertyId: "prop_1", managerUserId: "mgr_A", applicationTemplateId: "app-tpl-free" },
      { allowZeroFee: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.applicationFeeCents).toBe(0);
  });

  it("a template override of 0 is refused by the checkout/waiver paths exactly like the account default is (no allowZeroFee)", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const result = await resolveApplicationFeeProperty(db, {
      propertyId: "prop_1",
      managerUserId: "mgr_A",
      applicationTemplateId: "app-tpl-free",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_APPLICATION_FEE");
  });

  it("returns the resolved template's own waiver-code DEFAULT (display only — redemption is unchanged elsewhere)", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const withCode = await resolveApplicationFeeProperty(db, {
      propertyId: "prop_1",
      managerUserId: "mgr_A",
      applicationTemplateId: "app-tpl-long",
    });
    expect(withCode.ok).toBe(true);
    if (withCode.ok) expect(withCode.value.templateWaiverCodeOverride).toBe("LONGSTAY");

    const withoutCode = await resolveApplicationFeeProperty(db, {
      propertyId: "prop_1",
      managerUserId: "mgr_A",
      applicationTemplateId: "app-tpl-short",
    });
    expect(withoutCode.ok).toBe(true);
    if (withoutCode.ok) expect(withoutCode.value.templateWaiverCodeOverride).toBeNull();
  });
});

describe("createApplicationFeeCheckout — the Stripe amount is the SERVER-resolved template fee, never a client amount", () => {
  it("charges the template's own fee when applicationTemplateId resolves to one that set an override", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const stripe = makeStripe();

    await createApplicationFeeCheckout(db, stripe, { ...baseInput, applicationTemplateId: "app-tpl-long" });

    const passed = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as { amountCents?: number };
    expect(passed.amountCents).toBe(3500);
  });

  it("charges the account default when the resolved template has no override", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const stripe = makeStripe();

    await createApplicationFeeCheckout(db, stripe, { ...baseInput, applicationTemplateId: "app-tpl-short" });

    const passed = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as { amountCents?: number };
    expect(passed.amountCents).toBe(5000);
  });

  it("a tampered/forged amount on the input object is IGNORED — the type has no amount field, and a smuggled one is never read", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const stripe = makeStripe();

    // Simulate a caller that reaches past the type system (e.g. a raw fetch
    // body) and smuggles in fields that LOOK like an amount override.
    const tampered = {
      ...baseInput,
      applicationTemplateId: "app-tpl-long",
      applicationFeeCents: 1,
      amountCents: 1,
      totalCents: 1,
    } as unknown as Parameters<typeof createApplicationFeeCheckout>[2];

    await createApplicationFeeCheckout(db, stripe, tampered);

    const passed = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as { amountCents?: number };
    // Still 3500 — the server-resolved template fee, not the smuggled "1".
    expect(passed.amountCents).toBe(3500);
  });

  it("a client claiming an applicationTemplateId that belongs to a DIFFERENT property's listing never applies (the lookup is scoped to the resolved listing's own stored templates)", async () => {
    const db = makeDb({ managerUserId: "mgr_A", managerFeeCents: 5000 });
    const stripe = makeStripe();

    await createApplicationFeeCheckout(db, stripe, { ...baseInput, applicationTemplateId: "some-other-propertys-template-id" });

    const passed = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as { amountCents?: number };
    expect(passed.amountCents).toBe(5000);
  });
});
