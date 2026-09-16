import { describe, expect, it } from "vitest";
import {
  isPaymentDueAtSigning,
  listingTermFollowsLongTerm,
  resolvedSigningLeaseTerm,
  roomHasOwnPaymentAtSigning,
} from "@/lib/listing-fee-scope";
import {
  applyPaymentAtSigningCell,
  clearRoomPaymentAtSigning,
  seedSigningColumnFromLongTerm,
} from "@/lib/listing-fees";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const MONTH_TO_MONTH = "Month-to-Month";

function listing(): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.allowedLeaseTerms = [LONG_TERM_LEASE_TERM, MONTH_TO_MONTH];
  sub.rooms = [
    { ...sub.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1200 },
    { ...sub.rooms[0]!, id: "room-b", name: "Room B", monthlyRent: 1000 },
  ];
  sub.paymentAtSigningByLeaseType = {
    [LONG_TERM_LEASE_TERM]: ["first_month_rent", "security_deposit"],
    [MONTH_TO_MONTH]: [],
  };
  return sub;
}

describe("signing inherit and room override", () => {
  it("treats month-to-month as long-term while no room has its own price", () => {
    const sub = listing();
    expect(listingTermFollowsLongTerm(sub, MONTH_TO_MONTH)).toBe(true);
    expect(resolvedSigningLeaseTerm(sub, MONTH_TO_MONTH)).toBe(LONG_TERM_LEASE_TERM);
  });

  it("writes Every-room ticks onto long-term while same-as is on", () => {
    const after = applyPaymentAtSigningCell(listing(), MONTH_TO_MONTH, "move_in_fee", true);
    expect(after.paymentAtSigningByLeaseType?.[LONG_TERM_LEASE_TERM]).toContain("move_in_fee");
    expect(after.paymentAtSigningByLeaseType?.[MONTH_TO_MONTH] ?? []).not.toContain("move_in_fee");
    expect(isPaymentDueAtSigning(after, "move_in_fee", MONTH_TO_MONTH)).toBe(true);
  });

  it("keeps month-to-month ticks when long-term is not an offered lease type", () => {
    const sub = listing();
    sub.allowedLeaseTerms = [MONTH_TO_MONTH];
    const after = applyPaymentAtSigningCell(sub, MONTH_TO_MONTH, "first_month_rent", true);
    expect(isPaymentDueAtSigning(after, "first_month_rent", MONTH_TO_MONTH)).toBe(true);
    const again = applyPaymentAtSigningCell(after, MONTH_TO_MONTH, "security_deposit", true);
    expect(isPaymentDueAtSigning(again, "security_deposit", MONTH_TO_MONTH)).toBe(true);
    expect(isPaymentDueAtSigning(again, "first_month_rent", MONTH_TO_MONTH)).toBe(true);
  });

  it("seeds the month-to-month column from long-term when same-as is turned off", () => {
    const seeded = seedSigningColumnFromLongTerm(listing(), MONTH_TO_MONTH);
    expect(seeded.paymentAtSigningByLeaseType?.[MONTH_TO_MONTH]).toEqual([
      "first_month_rent",
      "security_deposit",
    ]);
  });

  it("stores a room override without changing the house ticks", () => {
    const after = applyPaymentAtSigningCell(listing(), LONG_TERM_LEASE_TERM, "first_month_rent", false, "room-a");
    expect(roomHasOwnPaymentAtSigning(after, "room-a", LONG_TERM_LEASE_TERM)).toBe(true);
    expect(isPaymentDueAtSigning(after, "first_month_rent", LONG_TERM_LEASE_TERM, "room-a")).toBe(false);
    expect(isPaymentDueAtSigning(after, "first_month_rent", LONG_TERM_LEASE_TERM)).toBe(true);
    expect(after.paymentAtSigningByLeaseType?.[LONG_TERM_LEASE_TERM]).toContain("first_month_rent");
  });

  it("Reset drops the room override so it follows Every room again", () => {
    const overridden = applyPaymentAtSigningCell(listing(), LONG_TERM_LEASE_TERM, "first_month_rent", false, "room-a");
    const reset = clearRoomPaymentAtSigning(overridden, "room-a", LONG_TERM_LEASE_TERM);
    expect(roomHasOwnPaymentAtSigning(reset, "room-a", LONG_TERM_LEASE_TERM)).toBe(false);
    expect(isPaymentDueAtSigning(reset, "first_month_rent", LONG_TERM_LEASE_TERM, "room-a")).toBe(true);
  });
});
