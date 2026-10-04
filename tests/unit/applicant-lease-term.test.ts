import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: vi.fn() }));

import { applicationFeeLabelForSelection } from "@/lib/application-fee-by-room";
import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import {
  applicantChoiceFromStored,
  applicantTermOptions,
  storedTermAfterStartChange,
  storedTermForApplicant,
} from "@/lib/rental-application/applicant-lease-term";
import { mergeLongTermPrivateArrangementRow, mergeTermStandardFees } from "@/lib/listing-placement-standard-fees";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";

describe("what the applicant can pick", () => {
  it("is exactly Long-term and Short-term, filtered to what the property offers", () => {
    expect(applicantTermOptions(["Long-term", "Month-to-Month", "Custom"]).map((o) => o.label)).toEqual(["Long-term"]);
    expect(applicantTermOptions(["Long-term", "Short-Term Stay"]).map((o) => o.label)).toEqual(["Long-term", "Short-term"]);
    expect(applicantTermOptions(["Short-Term Stay"]).map((o) => o.label)).toEqual(["Short-term"]);
    expect(applicantTermOptions(["Airbnb"]).map((o) => o.label)).toEqual(["Short-term"]);
    expect(applicantTermOptions(["Custom"]).map((o) => o.label)).toEqual(["Long-term"]);
  });

  it("reads every stored term back as Long-term or Short-term", () => {
    for (const stored of ["Long-term", "Custom", "3-Month", "6-Month", "9-Month", "12-Month"]) {
      expect(applicantChoiceFromStored(stored)).toEqual({ term: "long", length: "fixed" });
    }
    expect(applicantChoiceFromStored("Month-to-Month")).toEqual({ term: "long", length: "month_to_month" });
    expect(applicantChoiceFromStored("Short-Term Stay").term).toBe("short");
    expect(applicantChoiceFromStored("Airbnb").term).toBe("short");
    expect(applicantChoiceFromStored("").term).toBe("");
  });
});

describe("translating the pick to the stored term", () => {
  const all = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];
  it("maps each choice to an existing stored term", () => {
    expect(storedTermForApplicant({ offered: all, term: "short" })).toBe("Short-Term Stay");
    expect(storedTermForApplicant({ offered: ["Airbnb"], term: "short" })).toBe("Airbnb");
    expect(storedTermForApplicant({ offered: all, term: "long", length: "month_to_month" })).toBe("Month-to-Month");
    expect(storedTermForApplicant({ offered: ["Long-term"], term: "long", length: "month_to_month" })).toBe("Long-term");
    expect(storedTermForApplicant({ offered: ["Custom"], term: "long" })).toBe("Custom");
    expect(storedTermForApplicant({ offered: ["12-Month"], term: "long" })).toBe("12-Month");
  });

  it("where Long-term and Custom are both offered, a mid-month start is Custom and a first-of-the-month start is Long-term", () => {
    expect(storedTermForApplicant({ offered: all, term: "long", leaseStart: "2026-11-01" })).toBe("Long-term");
    expect(storedTermForApplicant({ offered: all, term: "long", leaseStart: "2026-11-15" })).toBe("Custom");
    expect(storedTermForApplicant({ offered: all, term: "long" })).toBe("Long-term");
    expect(storedTermAfterStartChange({ offered: all, currentStored: "Long-term", leaseStart: "2026-11-15" })).toBe("Custom");
    expect(storedTermAfterStartChange({ offered: all, currentStored: "Custom", leaseStart: "2026-12-01" })).toBe("Long-term");
    // Month-to-month and short stays are never rewritten by a start date.
    expect(storedTermAfterStartChange({ offered: all, currentStored: "Month-to-Month", leaseStart: "2026-11-15" })).toBe("Month-to-Month");
    expect(storedTermAfterStartChange({ offered: all, currentStored: "Short-Term Stay", leaseStart: "2026-11-15" })).toBe("Short-Term Stay");
  });
});

describe("the fee preview for each choice equals the amount charged", () => {
  const PID = "prop-lease-term-fees";
  const choice = `${PID}${LISTING_ROOM_CHOICE_SEP}room-1`;
  function listing() {
    const sub = createDefaultListingSubmission();
    sub.shortTermRentalsAllowed = true;
    sub.allowedLeaseTerms = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];
    sub.rooms = [{ ...sub.rooms[0]!, id: "room-1", name: "Unit 1", monthlyRent: 1000 }];
    let room = sub.rooms[0]!;
    room = mergeLongTermPrivateArrangementRow(room, { applicationFee: "30" });
    room = mergeTermStandardFees(room, "Month-to-Month", { applicationFee: "10" });
    room = mergeTermStandardFees(room, "Custom", { applicationFee: "20" });
    room = mergeTermStandardFees(room, "Short-Term Stay", { applicationFee: "5" });
    return normalizeManagerListingSubmissionV1({ ...sub, rooms: [room] });
  }
  const db = (sub: ReturnType<typeof listing>): SupabaseClient => {
    const from = (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        if (table === "manager_property_records") return { data: { manager_user_id: "mgr", property_data: { listingSubmission: sub } }, error: null };
        if (table === "manager_automation_settings") return { data: { row_data: { applicationSettings: { applicationFeeCents: 5000 } } }, error: null };
        return { data: null, error: null };
      };
      return chain;
    };
    return { from } as unknown as SupabaseClient;
  };

  const cases: Array<{ name: string; pick: Parameters<typeof storedTermForApplicant>[0]; cents: number }> = [
    { name: "Long-term, first of the month", pick: { offered: [], term: "long", leaseStart: "2026-11-01" }, cents: 3000 },
    { name: "Long-term, custom (mid-month) start", pick: { offered: [], term: "long", leaseStart: "2026-11-15" }, cents: 2000 },
    { name: "Long-term, month-to-month", pick: { offered: [], term: "long", length: "month_to_month" }, cents: 1000 },
    { name: "Short-term", pick: { offered: [], term: "short" }, cents: 500 },
  ];
  for (const { name, pick, cents } of cases) {
    it(`${name}`, async () => {
      const sub = listing();
      const offered = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];
      const stored = storedTermForApplicant({ ...pick, offered });
      const rentalType = stored === "Short-Term Stay" ? "short_term" : "standard";
      const preview = applicationFeeLabelForSelection(sub, { roomChoice1: choice, leaseTerm: stored, rentalType });
      const resolved = await resolveApplicationFeeProperty(
        db(sub),
        { propertyId: PID, managerUserId: "mgr", rentalType, leaseTerm: stored, roomChoice1: choice },
        { allowZeroFee: true },
      );
      expect(resolved.ok && resolved.value.applicationFeeCents).toBe(cents);
      expect(preview).toBe(`$${cents / 100}`);
    });
  }
});
