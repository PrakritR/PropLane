import { describe, expect, it } from "vitest";
import { propertyAttention, propertyAttentionParts, summarizeAttention } from "@/lib/property-attention";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { DemoApplicantRow } from "@/data/demo-portal";

const TODAY = new Date("2026-09-11T12:00:00");

function listing(rooms: number, category: "shared_home" | "entire_home" = "shared_home"): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    listingPlaceCategoryId: category,
    rooms: Array.from({ length: rooms }, (_, i) => ({ ...base.rooms[0]!, id: `r${i}`, name: `Room ${i}` })),
  } as ManagerListingSubmissionV1;
}

function app(over: Partial<DemoApplicantRow>): DemoApplicantRow {
  return { id: "a", name: "Sam", property: "", stage: "", bucket: "pending", detail: "", ...over } as DemoApplicantRow;
}

const row = (rooms: number, category?: "shared_home" | "entire_home") => ({
  adminRefId: "mgr-1",
  listingId: "lst-1",
  submission: listing(rooms, category),
});

describe("property attention", () => {
  it("counts open rooms as rooms minus approved placements", () => {
    const a = propertyAttention(
      row(3),
      [app({ id: "1", bucket: "approved", assignedPropertyId: "lst-1" }), app({ id: "2", bucket: "approved", assignedPropertyId: "mgr-1" })],
      TODAY,
    );
    expect(a.units).toBe(3);
    expect(a.open).toBe(1);
    expect(a.waiting).toBe(0);
  });

  it("treats a whole place as one unit", () => {
    expect(propertyAttention(row(4, "entire_home"), [], TODAY).open).toBe(1);
    expect(propertyAttention(row(4, "entire_home"), [app({ bucket: "approved", propertyId: "lst-1" })], TODAY).open).toBe(0);
  });

  it("ignores applications on other properties and withdrawn ones", () => {
    const a = propertyAttention(
      row(2),
      [
        app({ id: "1", assignedPropertyId: "someone-else" }),
        app({ id: "2", assignedPropertyId: "lst-1", withdrawnAt: "2026-09-01" }),
        app({ id: "3", assignedPropertyId: "lst-1" }),
      ],
      TODAY,
    );
    expect(a.waiting).toBe(1);
  });

  it("flags a lease ending inside 45 days and names the soonest", () => {
    const a = propertyAttention(
      row(2),
      [
        app({ id: "1", name: "Late", bucket: "approved", assignedPropertyId: "lst-1", manualResidentDetails: { moveOutDate: "2026-10-20" } }),
        app({ id: "2", name: "Soon", bucket: "approved", assignedPropertyId: "lst-1", manualResidentDetails: { moveOutDate: "2026-10-03" } }),
        app({ id: "3", name: "Far", bucket: "approved", assignedPropertyId: "lst-1", manualResidentDetails: { moveOutDate: "2027-03-01" } }),
      ],
      TODAY,
    );
    expect(a.endingSoon).toEqual({ name: "Soon", date: "2026-10-03" });
  });

  it("ranks an application waiting above an open room", () => {
    const waiting = propertyAttention(row(1), [app({ assignedPropertyId: "lst-1" })], TODAY);
    const open = propertyAttention(row(1), [], TODAY);
    expect(waiting.score).toBeGreaterThan(open.score);
    expect(propertyAttention(row(1), [app({ bucket: "approved", assignedPropertyId: "lst-1" })], TODAY).score).toBe(0);
  });

  it("writes the row's line in the manager's words", () => {
    const a = propertyAttention(
      row(3),
      [app({ id: "1", assignedPropertyId: "lst-1" }), app({ id: "2", bucket: "approved", assignedPropertyId: "lst-1", manualResidentDetails: { moveOutDate: "2026-10-03" } })],
      TODAY,
    );
    expect(propertyAttentionParts(a).map((p) => p.text)).toEqual(["1 application waiting", "2 of 3 open", "Lease ends Oct 3"]);
    expect(propertyAttentionParts(propertyAttention(row(1), [], TODAY)).map((p) => p.text)).toEqual(["Open"]);
  });

  it("totals across the list for the strip", () => {
    const t = summarizeAttention([
      propertyAttention(row(2), [app({ assignedPropertyId: "lst-1" })], TODAY),
      propertyAttention(row(1), [], TODAY),
    ]);
    expect(t).toEqual({ open: 3, waiting: 1, ending: 0 });
  });
});
