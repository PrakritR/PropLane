/**
 * `applicationResidentSlotFact` (PLAN-0924-0718): shared rooms show
 * "Shared · N residents · $X/mo each" — same rent for every resident.
 */
import { describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";

const LISTING = "mgr-shared-room-listing";
const ROOM_ID = "room-1";

function sharedRoomListing() {
  const room = {
    ...emptyRoom(0),
    id: ROOM_ID,
    monthlyRent: 1000,
    utilitiesEstimate: "75",
    securityDeposit: "250",
    occupancyCapacity: 2,
  };
  return { ...createDefaultListingSubmission(), rooms: [room] };
}

vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: (id: string) =>
    id === LISTING ? { id: LISTING, listingSubmission: sharedRoomListing() } : undefined,
  parseRoomChoiceValue: (value: string) => {
    const i = value.indexOf("::");
    return i === -1 ? { propertyId: value } : { propertyId: value.slice(0, i), listingRoomId: value.slice(i + 2) };
  },
}));

import { applicationResidentSlotFact } from "@/components/portal/pro-applications-grouped-table";

function row(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXIS-GRACE",
    name: "Grace",
    email: "grace@example.com",
    bucket: "approved",
    stage: "Approved",
    detail: "",
    assignedRoomChoice: `${LISTING}::${ROOM_ID}`,
    ...overrides,
  } as DemoApplicantRow;
}

describe("applicationResidentSlotFact", () => {
  it("names shared capacity and the same per-resident rent", () => {
    expect(applicationResidentSlotFact(row())).toBe("Shared · 2 residents · $1,000/mo each");
  });

  it("is undefined for an unknown room", () => {
    expect(applicationResidentSlotFact(row({ assignedRoomChoice: `${LISTING}::not-a-room` }))).toBeUndefined();
  });
});
