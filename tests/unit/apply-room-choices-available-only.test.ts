/**
 * AXI-167 — "it gave me like ten bedrooms to choose from… It should only display
 * the rooms that are actually available, it shouldn't show me all of them."
 *
 * The ranked 1st/2nd/3rd room choices passed `includeUnavailable: true`, so an
 * applicant was asked to rank every bedroom on the listing, most of which they
 * could not actually have.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const steps = readFileSync(
  path.join(process.cwd(), "src/components/marketing/rental-wizard-steps.tsx"),
  "utf8",
);
const block = steps.split("const availableRooms =")[1]?.split("const isByRoom")[0] ?? "";

describe("ranked room choices", () => {
  it("builds the offered list from AVAILABLE rooms", () => {
    expect(block).toContain("roomSelectOptionsWithNone(form.propertyId, {");
    expect(block).not.toContain("includeUnavailable: true,\n      leaseStart");
  });

  it("judges availability against the applicant's requested dates, not today", () => {
    // The occupancy check compares the requested window with the leases of the
    // residents already in the house. Omitting the dates asks "is it free right
    // now", which is a different question from the one the applicant is asking.
    expect(block).toContain("leaseStart: form.leaseStart");
    expect(block).toContain("leaseEnd: form.leaseEnd");
  });

  it("keeps a room the applicant already chose, even once it fills up", () => {
    // Silently dropping it would blank a resumed draft's answer with no
    // explanation; validation should be what tells them, not a vanishing option.
    expect(block).toContain("chosenRoomValues");
    expect(block).toContain("form.roomChoice1");
    expect(block).toContain("form.roomChoice2");
    expect(block).toContain("form.roomChoice3");
  });

  it("keeps a None option on the 2nd and 3rd choices", () => {
    expect(block).toContain('{ value: "", label: "None" }');
  });

  it("still preserves listing order rather than re-sorting", () => {
    // `allRooms` is filtered, not rebuilt, so the manager's room order survives.
    expect(block).toContain("allRooms.filter(");
  });
});
