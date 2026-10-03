import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The application fee actually charged resolves through the SAME placement resolver the quote
 * uses: a stay type's own application fee (room + lease type known) replaces the account
 * default; an application template's own fee still wins over it; with no room or no typed
 * stay-type fee the account default applies exactly as before.
 */
vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: vi.fn() }));

import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { buildListingQuote } from "@/lib/listing-quote";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const TEMPLATE = {
  ...createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" }),
  id: "tpl-own-fee",
  feeCentsOverride: 7700,
};

function submission(withRoomFees = true) {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  sub.applicationFee = "35";
  sub.allowedLeaseTerms = [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM];
  const base = sub.rooms[0]!;
  sub.rooms = [
    {
      ...base,
      id: "room-1",
      name: "Unit 2A",
      monthlyRent: 1100,
      ...(withRoomFees
        ? {
            occupancyPrices: [{ count: 1, applicationFee: "40" }],
            termPricing: { [SHORT_TERM_LEASE_TERM]: { applicationFee: "15" } },
          }
        : {}),
    } as ManagerRoomSubmission,
  ];
  sub.propertyApplicationTemplates = [TEMPLATE];
  return normalizeManagerListingSubmissionV1(sub);
}

function makeDb(sub: ReturnType<typeof submission>, managerFeeCents = 5000): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      if (table === "manager_property_records") {
        return { data: { manager_user_id: "mgr_A", property_data: { listingSubmission: sub } }, error: null };
      }
      if (table === "manager_automation_settings") {
        return { data: { row_data: { applicationSettings: { applicationFeeCents: managerFeeCents } } }, error: null };
      }
      return { data: null, error: null };
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

async function charged(sub: ReturnType<typeof submission>, input: { leaseTerm?: string; roomId?: string; rentalType?: "standard" | "short_term"; applicationTemplateId?: string }) {
  const res = await resolveApplicationFeeProperty(
    makeDb(sub),
    { propertyId: "prop_1", managerUserId: "mgr_A", ...input },
    { allowZeroFee: true },
  );
  if (!res.ok) throw new Error(res.error);
  return res.value.applicationFeeCents;
}

describe("application fee charged = the quote's application fee for that stay type", () => {
  it("charges each stay type's own fee when the room is known, and matches the quote", async () => {
    const sub = submission();
    expect(await charged(sub, { roomId: "room-1", leaseTerm: LONG_TERM_LEASE_TERM })).toBe(4000);
    expect(await charged(sub, { roomId: "room-1", leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" })).toBe(1500);
    for (const [term, cents] of [[LONG_TERM_LEASE_TERM, 4000], [SHORT_TERM_LEASE_TERM, 1500]] as const) {
      const quote = buildListingQuote(sub, { roomId: "room-1", leaseTerm: term });
      expect(Math.round((quote.applicationFees.find((f) => f.id === "application_fee")?.amount ?? 0) * 100)).toBe(cents);
    }
  });

  it("falls back to the account default with no room, or when the stay type typed nothing", async () => {
    expect(await charged(submission(), { leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" })).toBe(5000);
    expect(await charged(submission(false), { roomId: "room-1", leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" })).toBe(5000);
    expect(await charged(submission(), { roomId: "no-such-room", leaseTerm: SHORT_TERM_LEASE_TERM })).toBe(5000);
  });

  it("an application template's own fee still wins", async () => {
    expect(
      await charged(submission(), { roomId: "room-1", leaseTerm: SHORT_TERM_LEASE_TERM, applicationTemplateId: "tpl-own-fee" }),
    ).toBe(7700);
  });
});
