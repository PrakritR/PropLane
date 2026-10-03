/**
 * A short-term applicant's application fee has ONE rule: the stay type's own fee replaces the
 * house fee (`listing-placement-standard-fees.ts`). The fee the wizard previews, the fee the
 * checkout charges, the fee the listing quote shows and the resolver's answer for
 * stay type = short term are all the same number -- whichever way the manager stored it
 * (the room's own Short term entry, the older short-term field on the room's row, or the
 * whole-house row of an entire-home listing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/stripe-axis-ach-checkout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe-axis-ach-checkout")>(
    "@/lib/stripe-axis-ach-checkout",
  );
  return { ...actual, createAxisAchCheckoutSession: vi.fn() };
});
vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: vi.fn() }));

import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import {
  createApplicationFeeCheckout,
  resolveApplicationFeeProperty,
} from "@/lib/application-fee-checkout.server";
import { placementFeeOptionsFor, resolvePlacementStandardFees } from "@/lib/listing-placement-standard-fees";
import { buildListingQuote } from "@/lib/listing-quote";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const PID = "prop_st";
const MGR = "mgr_st";
const ACCOUNT_FEE_CENTS = 6000;
const choice = (roomId: string) => `${PID}${LISTING_ROOM_CHOICE_SEP}${roomId}`;

function room(id: string, over: Partial<ManagerRoomSubmission> = {}): ManagerRoomSubmission {
  return { ...emptyRoom(0), id, name: id, monthlyRent: 900, ...over } as ManagerRoomSubmission;
}

function listing(over: Partial<ManagerListingSubmissionV1>): ManagerListingSubmissionV1 {
  return normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    allowedLeaseTerms: [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM],
    shortTermRentalsAllowed: true,
    axisPaymentsEnabled: true,
    applicationFee: "",
    ...over,
  });
}

function dbFor(sub: ManagerListingSubmissionV1): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      if (table === "manager_property_records") {
        return { data: { manager_user_id: MGR, property_data: { listingSubmission: sub } }, error: null };
      }
      if (table === "manager_automation_settings") {
        return { data: { row_data: { applicationSettings: { applicationFeeCents: ACCOUNT_FEE_CENTS } } }, error: null };
      }
      if (table === "profiles") return { data: { stripe_connect_account_id: null }, error: null };
      return { data: null, error: null };
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

const SHORT = { leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" as const };

/** Every place a short-term applicant's application fee is read, in cents. */
async function allReads(sub: ManagerListingSubmissionV1, roomChoice1: string | undefined, roomId: string | null) {
  const db = dbFor(sub);
  // The wizard preview and the checkout both resolve through `resolveApplicationFeeProperty`.
  const preview = await resolveApplicationFeeProperty(
    db,
    { propertyId: PID, managerUserId: MGR, roomChoice1, ...SHORT },
    { allowZeroFee: true },
  );
  if (!preview.ok) throw new Error(preview.error);

  vi.mocked(createAxisAchCheckoutSession).mockClear();
  const checkout = await createApplicationFeeCheckout(db, {} as Stripe, {
    propertyId: PID,
    residentEmail: "a@example.com",
    managerUserId: MGR,
    roomChoice1,
    ...SHORT,
    mode: "hosted",
    successUrl: "https://app.test/s",
    cancelUrl: "https://app.test/c",
  });
  expect(checkout.ok).toBe(true);
  const passed = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as {
    amountCents: number;
    metadata: Record<string, string>;
  };

  const roomRow = roomId ? (sub.rooms ?? []).find((r) => r.id === roomId) ?? null : null;
  const resolver = resolvePlacementStandardFees(
    sub,
    placementFeeOptionsFor(sub, { room: roomRow, wholeHouse: !roomRow, ...SHORT }),
  );
  const quote = buildListingQuote(sub, { roomId: roomRow?.id, leaseTerm: SHORT_TERM_LEASE_TERM });
  return {
    preview: preview.value.applicationFeeCents,
    charged: passed.amountCents,
    metadataFee: Number(passed.metadata.fee_cents),
    resolver: Math.round(resolver.applicationFee * 100),
    quote: Math.round((quote.applicationFees.find((f) => f.id === "application_fee")?.amount ?? 0) * 100),
  };
}

describe("short-term application fee: preview == charged == quote == resolver(short_term)", () => {
  beforeEach(() => {
    vi.mocked(createAxisAchCheckoutSession).mockReset();
    vi.mocked(createAxisAchCheckoutSession).mockResolvedValue({
      mode: "hosted",
      url: "https://checkout.stripe.com/s",
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
      promoCode: null,
      readFailed: false,
    } as never);
    vi.mocked(loadManagerManualPaymentSettings).mockResolvedValue({
      serviceFeePayer: "resident",
      adminServiceFeeOverride: null,
    } as never);
  });

  it("the room's own Short term entry replaces the long-term fee", async () => {
    const sub = listing({
      rooms: [
        room("r1", {
          occupancyPrices: [{ count: 1, monthlyRent: 900, applicationFee: "40" }],
          termPricing: { [SHORT_TERM_LEASE_TERM]: { applicationFee: "15" } },
        }),
        room("r2", { occupancyPrices: [{ count: 1, monthlyRent: 900, applicationFee: "75" }] }),
      ],
    });
    const r1 = await allReads(sub, choice("r1"), "r1");
    expect(r1).toEqual({ preview: 1500, charged: 1500, metadataFee: 1500, resolver: 1500, quote: 1500 });
    // r2 typed no Short term fee: it inherits its own long-term row, on every read.
    const r2 = await allReads(sub, choice("r2"), "r2");
    expect(r2).toEqual({ preview: 7500, charged: 7500, metadataFee: 7500, resolver: 7500, quote: 7500 });
  });

  it("a fee stored on the room row's short-term field reads the same everywhere", async () => {
    const sub = listing({
      rooms: [
        room("r1", {
          occupancyPrices: [{ count: 1, monthlyRent: 900, applicationFee: "40", shortTermApplicationFee: "22" }],
        }),
        room("r2"),
      ],
    });
    expect(await allReads(sub, choice("r1"), "r1")).toEqual({
      preview: 2200,
      charged: 2200,
      metadataFee: 2200,
      resolver: 2200,
      quote: 2200,
    });
  });

  it("an entire-home listing's Short term fee on the whole-house row", async () => {
    const sub = listing({
      listingPlaceCategoryId: "entire_home",
      entireHomeMonthlyRent: 3000,
      entireHomeArrangementFees: { applicationFee: "120", shortTermApplicationFee: "30" },
      rooms: [room("only")],
    });
    expect(await allReads(sub, undefined, null)).toEqual({
      preview: 3000,
      charged: 3000,
      metadataFee: 3000,
      resolver: 3000,
      quote: 3000,
    });
  });

  it("a typed 0 for the stay type is free everywhere, not the account default", async () => {
    const sub = listing({
      rooms: [
        room("r1", {
          occupancyPrices: [{ count: 1, monthlyRent: 900, applicationFee: "40" }],
          termPricing: { [SHORT_TERM_LEASE_TERM]: { applicationFee: "0" } },
        }),
        room("r2"),
      ],
    });
    const db = dbFor(sub);
    const res = await resolveApplicationFeeProperty(
      db,
      { propertyId: PID, managerUserId: MGR, roomChoice1: choice("r1"), ...SHORT },
      { allowZeroFee: true },
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.value.applicationFeeCents).toBe(0);
    const resolver = resolvePlacementStandardFees(
      sub,
      placementFeeOptionsFor(sub, { room: sub.rooms[0], ...SHORT }),
    );
    expect(resolver.applicationFee).toBe(0);
  });
});
