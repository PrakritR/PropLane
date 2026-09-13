import { describe, expect, it } from "vitest";
import { roomInheritsDefault, emptyListingHouseDefaults } from "@/lib/listing-house-defaults";
import { buildListingQuote } from "@/lib/listing-quote";
import { isListingFeeAmountFilled } from "@/lib/listing-fees";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";

/**
 * "$0, on purpose" used to be unsayable on the pricing screen: a stored "0" was
 * scrubbed to "" for display, and "" means "follow the house default", so the
 * house number came straight back. Four of the captain's complaints — reset,
 * $0 utilities, $0 deposit, $0 pricing — were that one bug.
 */
const room = (over: Partial<ManagerRoomSubmission> = {}): ManagerRoomSubmission =>
  ({
    id: "r1",
    name: "Room A",
    monthlyRent: 1100,
    utilitiesEstimate: "",
    ...over,
  }) as ManagerRoomSubmission;

describe("an explicit zero is a room's own answer, not an empty box", () => {
  const defaults = { ...emptyListingHouseDefaults(), utilitiesEstimate: "150", securityDeposit: "1000" };

  it("does not inherit utilities when the room says 0", () => {
    expect(roomInheritsDefault(room({ utilitiesEstimate: "0" }), defaults, "utilitiesEstimate")).toBe(false);
  });

  it("does not inherit the deposit when the room says 0", () => {
    expect(roomInheritsDefault(room({ securityDeposit: "0" }), defaults, "securityDeposit")).toBe(false);
  });

  it("still inherits when the room says nothing at all", () => {
    expect(roomInheritsDefault(room({ utilitiesEstimate: "" }), defaults, "utilitiesEstimate")).toBe(true);
    expect(roomInheritsDefault(room({ securityDeposit: undefined }), defaults, "securityDeposit")).toBe(true);
  });

  it("treats a zero amount as filled, and a blank one as not", () => {
    expect(isListingFeeAmountFilled("0")).toBe(true);
    expect(isListingFeeAmountFilled("")).toBe(false);
  });
});

describe("a fee set to zero keeps its line on the receipt", () => {
  const baseSub = {
    rooms: [room()],
    securityDeposit: "1000",
    allowedLeaseTerms: ["Long-term"],
    leaseTermsBody: "",
    shortTermRentalsAllowed: false,
    airbnbRentalsAllowed: false,
  };

  const feeLabels = (sub: unknown) => {
    const quote = buildListingQuote(sub as never, { leaseTerm: "Long-term", roomId: "r1" });
    return [
      ...quote.monthlyFees.map((f) => f.label),
      ...quote.foldedIntoRent.map((f) => f.label),
      ...quote.applicationFees.map((f) => f.label),
      ...quote.signingLines.map((l) => l.label),
    ];
  };

  it("shows a deliberately free fee rather than dropping it", () => {
    expect(
      feeLabels({
        ...baseSub,
        customFees: [{ id: "f1", label: "Parking", amount: "0", presetId: "parking_monthly", frequency: "monthly" }],
      }),
    ).toContain("Parking");
  });

  it("still skips a fee nobody ever priced", () => {
    expect(
      feeLabels({
        ...baseSub,
        customFees: [{ id: "f1", label: "Parking", amount: "", presetId: "parking_monthly", frequency: "monthly" }],
      }),
    ).not.toContain("Parking");
  });

  it("a zero fee changes no total", () => {
    const withZero = buildListingQuote({
      ...baseSub,
      customFees: [{ id: "f1", label: "Parking", amount: "0", presetId: "parking_monthly", frequency: "monthly" }],
    } as never, { leaseTerm: "Long-term", roomId: "r1" });
    const without = buildListingQuote({ ...baseSub, customFees: [] } as never, {
      leaseTerm: "Long-term",
      roomId: "r1",
    });
    expect(withZero.signingTotal).toBe(without.signingTotal);
    expect(withZero.monthlyTotal).toBe(without.monthlyTotal);
  });
});
