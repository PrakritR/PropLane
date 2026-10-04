import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: vi.fn() }));

import { applicationFeeLabelForSelection } from "@/lib/application-fee-by-room";
import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import {
  applicantChoiceFromStored,
  applicantTermOptions,
  storedTermForApplicant,
} from "@/lib/rental-application/applicant-lease-term";
import { mergeLongTermPrivateArrangementRow, mergeTermStandardFees } from "@/lib/listing-placement-standard-fees";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";

describe("what the applicant can pick", () => {
  it("is the four lease types, filtered to what the property enabled", () => {
    expect(applicantTermOptions(["Long-term", "Month-to-Month", "Custom"]).map((o) => o.label)).toEqual(["Long-term", "Custom", "Month-to-month"]);
    expect(applicantTermOptions(["Long-term", "Short-Term Stay"]).map((o) => o.label)).toEqual(["Long-term", "Short-term"]);
    expect(applicantTermOptions(["Short-Term Stay"]).map((o) => o.label)).toEqual(["Short-term"]);
    expect(applicantTermOptions(["Airbnb"]).map((o) => o.label)).toEqual(["Short-term"]);
    expect(applicantTermOptions(["Custom"]).map((o) => o.label)).toEqual(["Custom"]);
  });

  it("reads every stored term back as its lease type", () => {
    for (const stored of ["Long-term", "3-Month", "6-Month", "9-Month", "12-Month"]) expect(applicantChoiceFromStored(stored)).toBe("long_term");
    expect(applicantChoiceFromStored("Custom")).toBe("custom");
    expect(applicantChoiceFromStored("Month-to-Month")).toBe("month_to_month");
    expect(applicantChoiceFromStored("Short-Term Stay")).toBe("short_term");
    expect(applicantChoiceFromStored("Airbnb")).toBe("short_term");
    expect(applicantChoiceFromStored("")).toBe("");
  });
});

describe("translating the pick to the stored term", () => {
  const all = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];
  it("maps each choice to its stored term", () => {
    expect(storedTermForApplicant({ offered: all, term: "long_term" })).toBe("Long-term");
    expect(storedTermForApplicant({ offered: all, term: "short_term" })).toBe("Short-Term Stay");
    expect(storedTermForApplicant({ offered: ["Airbnb"], term: "short_term" })).toBe("Airbnb");
    expect(storedTermForApplicant({ offered: all, term: "month_to_month" })).toBe("Month-to-Month");
    expect(storedTermForApplicant({ offered: all, term: "custom" })).toBe("Custom");
    expect(storedTermForApplicant({ offered: ["12-Month"], term: "long_term" })).toBe("12-Month");
  });

  it("a start date never rewrites the pick: Long-term stays Long-term mid-month", () => {
    expect(storedTermForApplicant({ offered: all, term: "long_term" })).toBe("Long-term");
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
    { name: "Long-term", pick: { offered: [], term: "long_term" }, cents: 3000 },
    { name: "Custom", pick: { offered: [], term: "custom" }, cents: 2000 },
    { name: "Month-to-month", pick: { offered: [], term: "month_to_month" }, cents: 1000 },
    { name: "Short-term", pick: { offered: [], term: "short_term" }, cents: 500 },
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
