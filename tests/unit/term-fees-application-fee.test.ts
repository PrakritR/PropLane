import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The application fee actually charged resolves through the SAME placement resolver the quote
 * uses: a stay type's own application fee (room + lease type known) replaces the house fee and
 * outranks the application template's own fee (so the fee shown is the fee charged); with no
 * typed stay-type fee the template, then the listing-level fee (what the quote also shows),
 * then the account default apply. A
 * one-room listing needs no room choice; a multi-room listing with none chosen falls back.
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

function submission(withRoomFees = true, extraRoom = false, listingFee = "35") {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  sub.applicationFee = listingFee;
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
  if (extraRoom) {
    sub.rooms = [...sub.rooms, { ...base, id: "room-2", name: "Unit 2B", monthlyRent: 1200 } as ManagerRoomSubmission];
  }
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

async function charged(sub: ReturnType<typeof submission>, input: { leaseTerm?: string; roomChoice1?: string; rentalType?: "standard" | "short_term"; applicationTemplateId?: string }) {
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
    expect(await charged(sub, { roomChoice1: "room-1", leaseTerm: LONG_TERM_LEASE_TERM })).toBe(4000);
    expect(await charged(sub, { roomChoice1: "room-1", leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" })).toBe(1500);
    for (const [term, cents] of [[LONG_TERM_LEASE_TERM, 4000], [SHORT_TERM_LEASE_TERM, 1500]] as const) {
      const quote = buildListingQuote(sub, { roomId: "room-1", leaseTerm: term });
      expect(Math.round((quote.applicationFees.find((f) => f.id === "application_fee")?.amount ?? 0) * 100)).toBe(cents);
    }
  });

  it("falls back to the listing-level fee, then the account default, when no stay-type fee applies", async () => {
    const stay = { leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" as const };
    // Two rooms and none chosen: nothing stay-type specific applies; the listing-level fee does (the quote shows it too).
    expect(await charged(submission(true, true), stay)).toBe(3500);
    expect(await charged(submission(false), { roomChoice1: "room-1", ...stay })).toBe(3500);
    expect(await charged(submission(), { roomChoice1: "no-such-room", ...stay, })).toBe(1500); // one-room listing: its only room
    expect(await charged(submission(true, true), { roomChoice1: "no-such-room", ...stay })).toBe(3500);
    // No listing-level fee either: the account's Application system fee.
    expect(await charged(submission(false, true, ""), stay)).toBe(5000);
    // A one-room listing needs no room choice: its only room's stay fee applies.
    expect(await charged(submission(), stay)).toBe(1500);
  });

  it("a stay type's own fee outranks the application template's; the template wins when the stay type typed none", async () => {
    expect(
      await charged(submission(), { roomChoice1: "room-1", leaseTerm: SHORT_TERM_LEASE_TERM, applicationTemplateId: "tpl-own-fee" }),
    ).toBe(1500);
    expect(
      await charged(submission(false), { roomChoice1: "room-1", leaseTerm: SHORT_TERM_LEASE_TERM, applicationTemplateId: "tpl-own-fee" }),
    ).toBe(7700);
  });
});
