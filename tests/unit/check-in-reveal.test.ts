/**
 * `checkInReveal` (checkin-1028, decision D1): the ONE rule for when the door codes appear. 24 hours
 * before check-in / move-in; a long-term resident also needs a signed lease; a short-stay guest a
 * confirmed stay; a finished stay closes again. Before the moment: masked, with the unlock time.
 */
import { describe, expect, it } from "vitest";
import { CHECK_IN_REVEAL_LEAD_MS, checkInReveal, formatRevealLabel } from "@/lib/check-in-reveal";

// Thu Oct 30 2026, 15:00 Pacific (PDT, UTC-7).
const MOVE_IN = "2026-10-30T22:00:00.000Z";
const REVEAL_AT = "2026-10-29T22:00:00.000Z";

describe("long-term resident (tenancy)", () => {
  it("is masked before the 24 hour mark, with the unlock moment named", () => {
    const result = checkInReveal({ kind: "tenancy", moveInAtIso: MOVE_IN, leaseSigned: true }, new Date("2026-10-29T21:59:59.000Z"));
    expect(result).toEqual({ revealed: false, reason: "too_early", revealAtIso: REVEAL_AT });
    expect(formatRevealLabel(result.revealAtIso)).toBe("Thu 3:00 PM");
  });

  it("reveals at exactly 24 hours before, and stays revealed after move-in", () => {
    expect(checkInReveal({ kind: "tenancy", moveInAtIso: MOVE_IN, leaseSigned: true }, new Date(REVEAL_AT)).revealed).toBe(true);
    expect(checkInReveal({ kind: "tenancy", moveInAtIso: MOVE_IN, leaseSigned: true }, new Date("2026-11-20T12:00:00.000Z")).revealed).toBe(true);
  });

  it("never reveals on an unsigned lease, however close the date", () => {
    for (const now of ["2026-10-01T00:00:00.000Z", "2026-10-30T23:00:00.000Z", "2027-01-01T00:00:00.000Z"]) {
      const result = checkInReveal({ kind: "tenancy", moveInAtIso: MOVE_IN, leaseSigned: false }, new Date(now));
      expect(result.revealed).toBe(false);
      expect(result.reason).toBe("lease_unsigned");
    }
  });

  it("a signed tenancy with no move-in date on file is already under way", () => {
    expect(checkInReveal({ kind: "tenancy", moveInAtIso: null, leaseSigned: true })).toEqual({ revealed: true, reason: "open", revealAtIso: null });
  });

  it("fails closed on a date that is on file but unreadable", () => {
    expect(checkInReveal({ kind: "tenancy", moveInAtIso: "someday", leaseSigned: true }).revealed).toBe(false);
  });
});

describe("short-stay guest (stay)", () => {
  const stay = (over: Partial<{ status: string; checkOutAtIso: string | null; checkInAtIso: string }> = {}) => ({
    kind: "stay" as const,
    checkInAtIso: MOVE_IN,
    checkOutAtIso: "2026-11-02T18:00:00.000Z",
    status: "confirmed",
    ...over,
  });

  it("is masked until 24 hours before check-in, then reveals", () => {
    expect(checkInReveal(stay(), new Date("2026-10-29T21:00:00.000Z"))).toEqual({ revealed: false, reason: "too_early", revealAtIso: REVEAL_AT });
    expect(checkInReveal(stay(), new Date("2026-10-30T09:00:00.000Z")).revealed).toBe(true);
  });

  it("only a CONFIRMED stay reveals: a hold or a cancelled stay never does", () => {
    for (const status of ["hold", "cancelled", "pending", ""]) {
      const result = checkInReveal(stay({ status }), new Date("2026-10-30T20:00:00.000Z"));
      expect(result.revealed).toBe(false);
      expect(result.reason).toBe("stay_not_confirmed");
    }
  });

  it("closes again after checkout", () => {
    const result = checkInReveal(stay(), new Date("2026-11-02T18:00:00.000Z"));
    expect(result).toMatchObject({ revealed: false, reason: "stay_ended" });
  });

  it("fails closed on an unreadable check-in time", () => {
    expect(checkInReveal(stay({ checkInAtIso: "later" })).revealed).toBe(false);
  });
});

it("the lead is 24 hours", () => {
  expect(CHECK_IN_REVEAL_LEAD_MS).toBe(24 * 60 * 60 * 1000);
});

describe("formatRevealLabel", () => {
  it("reads in the property's zone and tolerates nothing", () => {
    expect(formatRevealLabel("2026-10-29T22:00:00.000Z")).toBe("Thu 3:00 PM");
    expect(formatRevealLabel("2026-10-29T22:00:00.000Z", "America/New_York")).toBe("Thu 6:00 PM");
    expect(formatRevealLabel(null)).toBeNull();
    expect(formatRevealLabel("nope")).toBeNull();
  });
});
