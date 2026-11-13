import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { approvalPlacementBlocker } from "@/lib/application-approval-placement";
import { approvalPlacementServerBlocker } from "@/lib/application-approval-placement.server";

const row = { id: "a", bucket: "approved", managerUserId: "m", propertyId: "p", application: { roomChoice1: "p::room::r" } } as unknown as DemoApplicantRow;
// The real encoded room value comes from the shared room-choice builder.
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/room-choice-value";
const placed = { ...row, application: { roomChoice1: `p${LISTING_ROOM_CHOICE_SEP}r` } } as unknown as DemoApplicantRow;
const listing = { ...createDefaultListingSubmission(), rooms: [{ id: "r", name: "Room", monthlyRent: 0 }] } as never;
function db(data: unknown, error: unknown = null) {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data, error }) };
  return { from: () => query } as never;
}
describe("approval property readiness", () => {
  it("allows a resolved room with explicitly zero rent", () => {
    expect(approvalPlacementBlocker(placed, listing)).toBeNull();
  });
  it("refuses absent listing or an unknown room", () => {
    expect(approvalPlacementBlocker(placed, null)).toMatch(/verify/);
    expect(approvalPlacementBlocker({ ...placed, application: { roomChoice1: `p${LISTING_ROOM_CHOICE_SEP}missing` } } as never, listing)).toMatch(/valid room/);
  });
  it("fails closed when the scoped server property is unreadable or absent", async () => {
    expect(await approvalPlacementServerBlocker(db(null, {}), placed, null)).toMatch(/verify/);
    expect(await approvalPlacementServerBlocker(db(null), placed, null)).toMatch(/verify/);
    expect(await approvalPlacementServerBlocker(db({ property_data: { listingSubmission: listing } }), placed, null)).toBeNull();
  });
  it("does not block edits of already approved historical rows", async () => {
    expect(await approvalPlacementServerBlocker(db(null, {}), placed, { bucket: "approved" } as never)).toBeNull();
  });
});
