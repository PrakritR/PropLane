import { describe, expect, it } from "vitest";
import type { ResidentTourView } from "@/lib/tour-resident-link.server";
import {
  countResidentToursByBucket,
  residentTourBucketForView,
  residentTourStatusLabel,
  sortResidentTourViews,
} from "@/lib/resident-tour-list";

function tour(over: Partial<ResidentTourView>): ResidentTourView {
  return {
    inquiryId: "inq-1",
    tourGroupId: null,
    status: "pending",
    propertyId: "prop-1",
    propertyTitle: "Maple House",
    roomLabel: null,
    managerUserId: null,
    managerLabel: null,
    guestName: null,
    guestEmail: null,
    guestPhone: null,
    notes: null,
    instructions: null,
    proposedStart: null,
    proposedEnd: null,
    requestedWindows: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    confirmed: false,
    confirmedStart: null,
    confirmedEnd: null,
    ...over,
  };
}

describe("resident-tour-list", () => {
  it("classifies confirmed and declined tours into buckets", () => {
    expect(residentTourBucketForView(tour({ confirmed: true, status: "confirmed" }))).toBe("confirmed");
    expect(residentTourBucketForView(tour({ status: "declined" }))).toBe("declined");
    expect(residentTourBucketForView(tour({ status: "pending" }))).toBe("pending");
  });

  it("counts tours by bucket", () => {
    const counts = countResidentToursByBucket([
      tour({ inquiryId: "a", status: "pending" }),
      tour({ inquiryId: "b", confirmed: true, status: "confirmed" }),
      tour({ inquiryId: "c", status: "declined" }),
    ]);
    expect(counts).toEqual({ pending: 1, confirmed: 1, declined: 1 });
  });

  // C120: the one merged tour list reads status per row as text — this is the
  // same word the removed Pending/Confirmed/Declined tabs used to carry.
  it("labels a tour's status as text for the merged list row", () => {
    expect(residentTourStatusLabel(tour({ confirmed: true, status: "confirmed" }))).toBe("Confirmed");
    expect(residentTourStatusLabel(tour({ status: "declined" }))).toBe("Declined");
    expect(residentTourStatusLabel(tour({ status: "cancelled" }))).toBe("Declined");
    expect(residentTourStatusLabel(tour({ status: "pending" }))).toBe("Pending");
  });

  it("sorts newest tours first", () => {
    const sorted = sortResidentTourViews([
      tour({ inquiryId: "old", createdAt: "2026-07-01T00:00:00.000Z" }),
      tour({ inquiryId: "new", createdAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((row) => row.inquiryId)).toEqual(["new", "old"]);
  });
});
