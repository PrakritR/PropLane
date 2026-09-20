/**
 * `applicationResidentSlotFact` (PLAN-0920-0631): the Applications list row
 * fact "Resident N of M · $rent/mo" for a room priced per resident.
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
  it("reads the resolved rent for the application's own stored slot", () => {
    expect(applicationResidentSlotFact(row({ application: { residentSlot: 2 } as never }))).toBe(
      "Resident 2 of 2 · $800/mo",
    );
  });

  it("is undefined without a stored slot", () => {
    expect(applicationResidentSlotFact(row())).toBeUndefined();
  });

  it("is undefined for a room that does not price per resident", () => {
    expect(
      applicationResidentSlotFact(row({ assignedRoomChoice: `${LISTING}::not-a-room`, application: { residentSlot: 1 } as never })),
    ).toBeUndefined();
  });
});
