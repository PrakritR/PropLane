import { describe, expect, it } from "vitest";
import {
  applicationReadProvesTargetAbsent,
  skippedCatalogHidesApplicationTarget,
} from "@/lib/rental-application/in-progress-application";
import { skippedApplicationTargetFromRecord } from "@/lib/rental-application/skipped-application-target";

const houseA = { propertyId: "house-a" };
const otherHouse = { id: "AXIS-OTHER", propertyId: "house-b", applicationRead: true as const };
const sameHouse = { id: "AXIS-SAME", propertyId: "house-a", applicationRead: true as const, rentalType: "standard" };

describe("skipped application rows and a new apply target", () => {
  it("proves a target absent when the only skip is another house", () => {
    expect(applicationReadProvesTargetAbsent({
      complete: false,
      coveredAsideFromSkips: true,
      skippedRowIds: ["AXIS-OTHER"],
      skippedRows: [otherHouse],
      target: houseA,
    })).toBe(true);
    expect(skippedCatalogHidesApplicationTarget({
      skippedRowIds: ["AXIS-OTHER"],
      skippedRows: [otherHouse],
      target: houseA,
    })).toBe(false);
  });

  it("does not prove absence when the skipped row might be this house", () => {
    expect(applicationReadProvesTargetAbsent({
      complete: false,
      coveredAsideFromSkips: true,
      skippedRowIds: ["AXIS-SAME"],
      skippedRows: [sameHouse],
      target: houseA,
    })).toBe(false);
  });

  it("does not prove absence when a skipped id has no house hint or the list was cut off", () => {
    expect(applicationReadProvesTargetAbsent({
      complete: false,
      coveredAsideFromSkips: true,
      skippedRowIds: ["AXIS-MYSTERY"],
      skippedRows: [],
      target: houseA,
    })).toBe(false);
    expect(applicationReadProvesTargetAbsent({
      complete: false,
      coveredAsideFromSkips: false,
      skippedRowIds: ["AXIS-OTHER"],
      skippedRows: [otherHouse],
      target: houseA,
    })).toBe(false);
  });

  it("treats a skipped saved axis id as this target", () => {
    expect(skippedCatalogHidesApplicationTarget({
      skippedRowIds: ["AXIS-SAVED"],
      skippedRows: [{ id: "AXIS-SAVED", propertyId: "house-b", applicationRead: true }],
      savedAxisId: "AXIS-SAVED",
      target: houseA,
    })).toBe(true);
  });

  it("does not hide a different room of the same house", () => {
    expect(skippedCatalogHidesApplicationTarget({
      skippedRowIds: ["AXIS-ROOM"],
      skippedRows: [{
        id: "AXIS-ROOM",
        propertyId: "house-a",
        applicationRead: true,
        rentalType: "standard",
        roomChoice1: "house-a::room-b",
      }],
      target: { propertyId: "house-a", listingRoomId: "room-a" },
    })).toBe(false);
  });

  it("reads a house hint without copying identity fields", () => {
    const hint = skippedApplicationTargetFromRecord({
      id: "AXIS-BAD",
      property_id: "house-a",
      row_data: {
        application: { fullLegalName: "Bad Row", ssn: "123-45-6789", rentalType: "short_term", propertyId: "house-a" },
      },
    });
    expect(hint).toEqual({
      id: "AXIS-BAD",
      propertyId: "house-a",
      applicationRead: true,
      rentalType: "short_term",
    });
    expect(JSON.stringify(hint)).not.toContain("123-45-6789");
  });
});
