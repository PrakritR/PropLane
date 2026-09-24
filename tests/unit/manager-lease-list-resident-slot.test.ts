/**
 * `leaseResidentSlotFact` (PLAN-0924-0718): shared rooms show the same
 * per-resident rent for every lease — never unequal slot prices.
 */
import { describe, expect, it, vi } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
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
    residentPricing: "per_resident" as const,
    residentPrices: [{ monthlyRent: 1000 }, { monthlyRent: 1000 }],
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

import { leaseResidentSlotFact } from "@/lib/manager-lease-list";

function row(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentName: "Aaron",
    residentEmail: "aaron@example.com",
    unit: "Shared Room Listing · Room 1",
    stageLabel: "Fully Signed",
    status: "Fully Signed",
    updated: "Sep 18",
    updatedAtIso: "2026-09-18T18:00:00.000Z",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    thread: [],
    roomChoice: `${LISTING}::${ROOM_ID}`,
    ...overrides,
  } as LeasePipelineRow;
}

describe("leaseResidentSlotFact", () => {
  it("shows Shared · N residents · $rent/mo each for a capacity-2 room", () => {
    expect(leaseResidentSlotFact(row({ application: { residentSlot: 2 } as never }))).toBe(
      "Shared · 2 residents · $1,000/mo each",
    );
    expect(leaseResidentSlotFact(row({ application: { residentSlot: 1 } as never }))).toBe(
      "Shared · 2 residents · $1,000/mo each",
    );
  });

  it("still shows shared capacity when the lease has no resident slot", () => {
    expect(leaseResidentSlotFact(row())).toBe("Shared · 2 residents · $1,000/mo each");
  });

  it("is undefined when the room choice does not resolve", () => {
    const soloRow = row({
      roomChoice: `${LISTING}::not-a-room`,
      application: { residentSlot: 1 } as never,
    });
    expect(leaseResidentSlotFact(soloRow)).toBeUndefined();
  });
});
