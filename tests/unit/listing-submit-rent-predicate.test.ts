import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listingRoomHasRent } from "@/lib/listing-wizard-validation";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";

/**
 * Two different rules for "does this room have a price" (PRP-200): the Pricing
 * step accepted a monthly rent OR a daily rate, and Submit demanded monthly. A
 * manager who priced every room daily — the correct setup for the short-term
 * listings this product supports — passed Pricing, reached the end, and was
 * refused by an error pointing back at a step that reported itself as fine.
 * There was no way out without guessing at a figure the wizard never asked for.
 */
function room(overrides: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  return { id: "r1", name: "Room 1", monthlyRent: 0, ...overrides } as ManagerRoomSubmission;
}

describe("listingRoomHasRent is the one rule", () => {
  it("accepts a monthly rent", () => {
    expect(listingRoomHasRent(room({ monthlyRent: 1200 }))).toBe(true);
  });

  it("accepts a daily-priced room with no monthly rent — the case that dead-ended", () => {
    expect(listingRoomHasRent(room({ rentBasis: "daily", dailyRentPrice: 95 }))).toBe(true);
  });

  it("accepts a weekly-priced room with no monthly rent", () => {
    expect(listingRoomHasRent(room({ rentBasis: "weekly", weeklyRentPrice: 350 }))).toBe(true);
  });

  it("rejects a room with neither", () => {
    expect(listingRoomHasRent(room({}))).toBe(false);
    expect(listingRoomHasRent(room({ rentBasis: "daily", dailyRentPrice: 0 }))).toBe(false);
  });

  it("does not accept a daily PRICE when the room is not on the daily basis", () => {
    // rentBasis alone decides which rate is active (AGENTS.md → rent-basis):
    // daily never wins unless the manager set it.
    expect(listingRoomHasRent(room({ dailyRentPrice: 95 }))).toBe(false);
  });
});

describe("submit uses that rule rather than its own", () => {
  const FORM = readFileSync(join(process.cwd(), "src/components/portal/pro-add-listing-form.tsx"), "utf8");

  it("no longer demands a monthly rent at submit", () => {
    const roomsOk = FORM.slice(FORM.indexOf("const roomsOk ="), FORM.indexOf("const roomsOk =") + 600);
    expect(roomsOk).toContain("listingRoomHasRent(r)");
    expect(roomsOk).not.toContain("r.monthlyRent > 0");
  });

  it("says what it actually accepts, so the message cannot send anyone to the wrong step", () => {
    expect(FORM).toContain("Add at least one room with a name and a monthly or daily rent.");
    expect(FORM).not.toContain("Add at least one room with a name and monthly rent.");
  });
});
