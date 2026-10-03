/**
 * The application fee is the fee of the room the applicant chose, for the lease
 * type they chose (captain, 2026-10-03). Chain: room/term -> application
 * template -> listing-level -> Application system -> none; a typed 0 is free;
 * nothing is read from the request body but selectors.
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
import {
  applicationFeeLabelForSelection,
  applicationFeeRangeAcrossRooms,
  applicationFeeRangeLabel,
  resolveApplicationFeeBasis,
} from "@/lib/application-fee-by-room";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { LEGACY_DEFAULT_APPLICATION_FEE_CENTS } from "@/lib/manager-application-settings";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const PID = "prop_fees";
const MGR = "mgr_fees";
const choice = (roomId: string) => `${PID}${LISTING_ROOM_CHOICE_SEP}${roomId}`;

function room(id: string, applicationFee?: string, shortTermApplicationFee?: string): ManagerRoomSubmission {
  return {
    ...emptyRoom(0),
    id,
    name: id,
    monthlyRent: 900,
    occupancyPrices: [
      {
        count: 1,
        monthlyRent: 900,
        ...(applicationFee !== undefined ? { applicationFee } : {}),
        ...(shortTermApplicationFee !== undefined ? { shortTermApplicationFee } : {}),
      },
    ],
  } as ManagerRoomSubmission;
}

function listing(
  rooms: ManagerRoomSubmission[],
  over: Partial<ManagerListingSubmissionV1> = {},
): ManagerListingSubmissionV1 {
  return normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"],
    shortTermRentalsAllowed: true,
    axisPaymentsEnabled: true,
    applicationFee: "",
    rooms,
    ...over,
  });
}

function dbFor(sub: ManagerListingSubmissionV1, managerFeeCents: number | null = 6000): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      if (table === "manager_property_records") {
        return { data: { manager_user_id: MGR, property_data: { listingSubmission: sub } }, error: null };
      }
      if (table === "manager_automation_settings") {
        return managerFeeCents === null
          ? { data: { row_data: {} }, error: null }
          : { data: { row_data: { applicationSettings: { applicationFeeCents: managerFeeCents } } }, error: null };
      }
      if (table === "profiles") return { data: { stripe_connect_account_id: null }, error: null };
      return { data: null, error: null };
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

async function resolve(
  sub: ManagerListingSubmissionV1,
  selection: { roomChoice1?: string; leaseTerm?: string; rentalType?: "standard" | "short_term"; applicationTemplateId?: string },
  managerFeeCents: number | null = 6000,
) {
  const res = await resolveApplicationFeeProperty(
    dbFor(sub, managerFeeCents),
    { propertyId: PID, managerUserId: MGR, ...selection },
    { allowZeroFee: true },
  );
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

describe("resolveApplicationFeeBasis - the room's fee for the lease type", () => {
  const sub = listing([room("r1", "40", "15"), room("r2", "75")]);

  it("reads the chosen room's long-term fee", () => {
    expect(resolveApplicationFeeBasis(sub, { roomChoice1: choice("r1"), leaseTerm: "Long-term" }).roomTermCents).toBe(4000);
    expect(resolveApplicationFeeBasis(sub, { roomChoice1: choice("r2"), leaseTerm: "Long-term" }).roomTermCents).toBe(7500);
  });

  it("a stay reads the short-term fee, and follows the shared one when it has none of its own", () => {
    const st = { leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" as const };
    expect(resolveApplicationFeeBasis(sub, { roomChoice1: choice("r1"), ...st }).roomTermCents).toBe(1500);
    expect(resolveApplicationFeeBasis(sub, { roomChoice1: choice("r2"), ...st }).roomTermCents).toBe(7500);
  });

  it("a typed 0 is a real answer (free), distinct from nothing set", () => {
    const free = listing([room("r1", "0")]);
    expect(resolveApplicationFeeBasis(free, { roomChoice1: choice("r1") }).roomTermCents).toBe(0);
    const unset = listing([room("r1")]);
    expect(resolveApplicationFeeBasis(unset, { roomChoice1: choice("r1") }).roomTermCents).toBeNull();
  });

  it("no room chosen on a multi-room listing, or a room the listing lacks, resolves no room fee", () => {
    expect(resolveApplicationFeeBasis(sub, {}).roomTermCents).toBeNull();
    expect(resolveApplicationFeeBasis(sub, { roomChoice1: choice("ghost") }).roomTermCents).toBeNull();
  });

  it("a one-room listing needs no room choice", () => {
    expect(resolveApplicationFeeBasis(listing([room("only", "55")]), {}).roomTermCents).toBe(5500);
  });

  it("an entire-home listing reads the whole-house row", () => {
    const home = listing([room("r1", "99")], {
      listingPlaceCategoryId: "entire_home",
      entireHomeArrangementFees: { applicationFee: "120", shortTermApplicationFee: "60" },
    });
    expect(resolveApplicationFeeBasis(home, { leaseTerm: "Long-term" })).toMatchObject({ roomTermCents: 12000, roomId: "whole" });
    expect(
      resolveApplicationFeeBasis(home, { leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" }).roomTermCents,
    ).toBe(6000);
  });

  it("the listing-level fee is the next level down", () => {
    const withListing = listing([room("r1"), room("r2", "75")], { applicationFee: "$30" });
    expect(resolveApplicationFeeBasis(withListing, { roomChoice1: choice("r1") })).toMatchObject({
      roomTermCents: null,
      listingCents: 3000,
    });
  });
});

describe("resolveApplicationFeeProperty - the fee follows the room and the lease type", () => {
  const sub = listing([room("r1", "40", "15"), room("r2", "75"), room("r3")], { applicationFee: "" });

  it("charges each room its own fee", async () => {
    expect((await resolve(sub, { roomChoice1: choice("r1"), leaseTerm: "Long-term" })).applicationFeeCents).toBe(4000);
    expect((await resolve(sub, { roomChoice1: choice("r2"), leaseTerm: "Long-term" })).applicationFeeCents).toBe(7500);
  });

  it("charges the short-term fee for a stay the listing offers", async () => {
    const v = await resolve(sub, { roomChoice1: choice("r1"), leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" });
    expect(v.applicationFeeCents).toBe(1500);
    expect(v).toMatchObject({ feeSource: "room_term", feeRoomId: "r1" });
  });

  it("the amount updates when the applicant changes room or lease type before paying", async () => {
    const a = await resolve(sub, { roomChoice1: choice("r1"), leaseTerm: "Long-term" });
    const b = await resolve(sub, { roomChoice1: choice("r2"), leaseTerm: "Long-term" });
    const c = await resolve(sub, { roomChoice1: choice("r1"), leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" });
    expect([a.applicationFeeCents, b.applicationFeeCents, c.applicationFeeCents]).toEqual([4000, 7500, 1500]);
  });

  it("falls back room -> listing-level -> account -> legacy", async () => {
    // r3 sets nothing, the listing sets nothing: the account setting applies.
    expect(await resolve(sub, { roomChoice1: choice("r3") })).toMatchObject({ applicationFeeCents: 6000, feeSource: "account" });
    // listing-level fee is next.
    const withListing = listing([room("r3")], { applicationFee: "$30" });
    expect(await resolve(withListing, { roomChoice1: choice("r3") })).toMatchObject({
      applicationFeeCents: 3000,
      feeSource: "listing",
    });
    // nothing at all configured -> the legacy default.
    expect((await resolve(sub, { roomChoice1: choice("r3") }, null)).applicationFeeCents).toBe(
      LEGACY_DEFAULT_APPLICATION_FEE_CENTS,
    );
  });

  it("a room fee of 0 means free, even when the account charges one", async () => {
    const free = listing([room("r1", "0"), room("r2", "75")]);
    const v = await resolve(free, { roomChoice1: choice("r1") });
    expect(v.applicationFeeCents).toBe(0);
    const refused = await resolveApplicationFeeProperty(dbFor(free), { propertyId: PID, managerUserId: MGR, roomChoice1: choice("r1") });
    expect(refused.ok).toBe(false);
  });

  it("an unknown room id falls back instead of borrowing another room's fee", async () => {
    expect((await resolve(sub, { roomChoice1: choice("ghost") })).applicationFeeCents).toBe(6000);
  });

  it("a stay the listing does not offer cannot reach the short-term fee", async () => {
    const longOnly = listing([room("r1", "40", "15")], { shortTermRentalsAllowed: false, allowedLeaseTerms: ["Long-term"] });
    const v = await resolve(longOnly, { roomChoice1: choice("r1"), leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" });
    expect(v.applicationFeeCents).toBe(4000);
  });

  it("the room fee outranks the application template's override; the template outranks the listing fee", async () => {
    const withTemplate = listing([room("r1", "40"), room("r2")], {
      applicationFee: "$30",
      propertyApplicationTemplates: [
        { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" }), id: "tpl", feeCentsOverride: 2500 },
      ],
    });
    expect((await resolve(withTemplate, { roomChoice1: choice("r1"), applicationTemplateId: "tpl" })).applicationFeeCents).toBe(4000);
    expect((await resolve(withTemplate, { roomChoice1: choice("r2"), applicationTemplateId: "tpl" })).applicationFeeCents).toBe(2500);
  });
});

describe("createApplicationFeeCheckout - the server amount, never the body", () => {
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

  const stripe = {} as Stripe;
  const sub = listing([room("r1", "40"), room("r2", "75")]);

  it("charges the chosen room's fee and records the room / term / source it was computed for", async () => {
    const res = await createApplicationFeeCheckout(dbFor(sub), stripe, {
      propertyId: PID,
      residentEmail: "a@example.com",
      managerUserId: MGR,
      roomChoice1: choice("r2"),
      leaseTerm: "Long-term",
      mode: "hosted",
      successUrl: "https://app.test/s",
      cancelUrl: "https://app.test/c",
    });
    expect(res.ok).toBe(true);
    const passed = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as {
      amountCents: number;
      metadata: Record<string, string>;
    };
    expect(passed.amountCents).toBe(7500);
    expect(passed.metadata).toMatchObject({
      fee_cents: "7500",
      fee_room_id: "r2",
      fee_lease_term: "Long-term",
      fee_source: "room_term",
    });
  });

  it("ignores an amount smuggled into the request", async () => {
    await createApplicationFeeCheckout(dbFor(sub), stripe, {
      propertyId: PID,
      residentEmail: "a@example.com",
      managerUserId: MGR,
      roomChoice1: choice("r1"),
      mode: "hosted",
      successUrl: "https://app.test/s",
      cancelUrl: "https://app.test/c",
      ...({ applicationFeeCents: 1, amountCents: 1, feeCents: 1 } as object),
    });
    const passed = vi.mocked(createAxisAchCheckoutSession).mock.calls[0]?.[1] as { amountCents: number };
    expect(passed.amountCents).toBe(4000);
  });

  it("a different manager's id is refused before any fee is read", async () => {
    const res = await createApplicationFeeCheckout(dbFor(sub), stripe, {
      propertyId: PID,
      residentEmail: "a@example.com",
      managerUserId: "someone_else",
      roomChoice1: choice("r1"),
      mode: "hosted",
      successUrl: "https://app.test/s",
      cancelUrl: "https://app.test/c",
    });
    expect(res.ok).toBe(false);
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("what the applicant and the manager read", () => {
  const sub = listing([room("r1", "40"), room("r2", "75")]);

  it("the manager's application record shows the room's fee for the term", () => {
    expect(applicationFeeLabelForSelection(sub, { roomChoice1: choice("r2") })).toBe("$75");
    expect(applicationFeeLabelForSelection(sub, { roomChoice1: choice("r1") })).toBe("$40");
  });

  it("the public listing says From $X when rooms differ and the one amount when they agree", () => {
    const range = applicationFeeRangeAcrossRooms(sub, "long");
    expect(range).toEqual({ minCents: 4000, maxCents: 7500 });
    expect(applicationFeeRangeLabel(range!)).toBe("From $40");
    const same = applicationFeeRangeAcrossRooms(listing([room("a", "50"), room("b", "50")]), "long");
    expect(applicationFeeRangeLabel(same!)).toBe("$50");
  });

  it("a room that would fall to the account setting keeps today's listing default", () => {
    expect(applicationFeeRangeAcrossRooms(listing([room("a", "50"), room("b")]), "long")).toBeNull();
    expect(applicationFeeRangeAcrossRooms(listing([room("a", "50"), room("b")], { applicationFee: "$30" }), "long")).toEqual({
      minCents: 3000,
      maxCents: 5000,
    });
  });
});
