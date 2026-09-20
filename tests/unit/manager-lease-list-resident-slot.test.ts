/**
 * `leaseResidentSlotFact` (PLAN-0920-0631): "Resident 2 of 2 · $800/mo" on a
 * lease card row when its room prices per resident, and undefined for every
 * other lease — never a pill, never invented for a plain single-rent room.
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
    residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }],
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
  it("reads slot 2's own $800 rent from the listing, not a made-up figure", () => {
    const fact = leaseResidentSlotFact(row({ application: { residentSlot: 2 } as never }));
    expect(fact).toBe("Resident 2 of 2 · $800/mo");
  });

  it("reads slot 1's own $900 rent", () => {
    const fact = leaseResidentSlotFact(row({ application: { residentSlot: 1 } as never }));
    expect(fact).toBe("Resident 1 of 2 · $900/mo");
  });

  it("is undefined when the application carries no resident slot", () => {
    expect(leaseResidentSlotFact(row())).toBeUndefined();
  });

  it("is undefined when the room does not price per resident, even with a stray slot number", () => {
    const soloRow = row({
      roomChoice: `${LISTING}::not-a-room`,
      application: { residentSlot: 1 } as never,
    });
    expect(leaseResidentSlotFact(soloRow)).toBeUndefined();
  });
});
