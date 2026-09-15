/**
 * Property import — an understood property is an ordinary listing draft,
 * built the way Add property builds one, with the file's fields marked.
 */
import { describe, expect, it } from "vitest";
import { prefillMarkFor } from "@/lib/listing-prefill/apply";
import { describeSourceRows, importedMonthlyRent, importedRoomLabel, submissionFromImportedProperty } from "@/lib/property-import/to-submission";
import type { PropertyImportProperty } from "@/lib/property-import/types";

const pine: PropertyImportProperty = {
  key: "2-rent-roll-1412-pine-st",
  name: "1412 Pine St",
  address: "1412 Pine St",
  city: "Seattle",
  state: "WA",
  zip: "98122",
  propertyType: "house",
  rentByRoom: true,
  bedrooms: 3,
  bathrooms: 1.5,
  monthlyRent: null,
  deposit: null,
  rooms: [
    { label: "Room A", rent: 950, deposit: 950, sourceRow: 6 },
    { label: "Room B", rent: 900, deposit: 900, sourceRow: 7 },
    { label: "Room C", rent: null, deposit: null, sourceRow: 8 },
  ],
  sourceSheet: "Rent Roll",
  sourceRows: [6, 7, 8],
  needsLook: ["Room C has no rent in the file"],
  confidence: "medium",
};

const harvard: PropertyImportProperty = {
  key: "4-rent-roll-918-harvard",
  name: "918 Harvard Ave E",
  address: "918 Harvard Ave E",
  city: "Seattle",
  state: "WA",
  zip: "",
  propertyType: "condo",
  rentByRoom: false,
  bedrooms: 2,
  bathrooms: null,
  monthlyRent: 2650,
  deposit: 2650,
  rooms: [],
  sourceSheet: "Rent Roll",
  sourceRows: [14],
  needsLook: ["No ZIP in the file"],
  confidence: "medium",
};

describe("submissionFromImportedProperty", () => {
  it("builds a by-the-room draft with the file's rooms, rents and deposits on the slots", () => {
    const sub = submissionFromImportedProperty(pine);
    expect(sub.address).toBe("1412 Pine St");
    expect(sub.city).toBe("Seattle");
    expect(sub.state).toBe("WA");
    expect(sub.zip).toBe("98122");
    expect(sub.listingPropertyTypeId).toBe("house");
    expect(sub.listingPlaceCategoryId).toBe("shared_home");
    expect(sub.rentalModelStamp).toBe("shared_home");
    expect(sub.listingBedroomSlots).toBe(3);
    expect(sub.rooms).toHaveLength(3);
    expect(sub.rooms.map((r) => r.name)).toEqual(["Room A", "Room B", "Room C"]);
    expect(sub.rooms.map((r) => r.monthlyRent)).toEqual([950, 900, 0]);
    expect(sub.rooms[0]!.securityDeposit).toBe("950");
    expect(sub.listingTotalBathroomsId).toBe("1.5");
    expect(sub.bathrooms).toHaveLength(2);
  });

  it("builds a whole-place draft with the listing-level rent and deposit", () => {
    const sub = submissionFromImportedProperty(harvard);
    expect(sub.listingPlaceCategoryId).toBe("entire_home");
    expect(sub.entireHomeMonthlyRent).toBe(2650);
    expect(sub.securityDeposit).toBe("2650");
    expect(sub.zip).toBe("");
    expect(sub.rooms).toHaveLength(2);
  });

  it("prices a building whose units each carry a rent by the room, so no unit price is lost", () => {
    const maple: PropertyImportProperty = {
      ...harvard,
      key: "1-maple",
      name: "Maple Court",
      address: "220 Maple Ave",
      zip: "98103",
      propertyType: "apartment",
      bedrooms: 0,
      monthlyRent: null,
      deposit: null,
      rooms: [
        { label: "1A", rent: 1850, deposit: 1850, sourceRow: 2 },
        { label: "1B", rent: 1795, deposit: 1795, sourceRow: 3 },
        { label: "2A", rent: 1900, deposit: null, sourceRow: 4 },
        { label: "2B", rent: 2100, deposit: 2100, sourceRow: 5 },
      ],
      sourceRows: [2, 3, 4, 5],
      needsLook: [],
    };
    const sub = submissionFromImportedProperty(maple);
    expect(sub.listingPlaceCategoryId).toBe("shared_home");
    expect(sub.listingBedroomSlots).toBe(4);
    expect(sub.rooms.map((r) => r.name)).toEqual(["Unit 1A", "Unit 1B", "Unit 2A", "Unit 2B"]);
    expect(sub.rooms.map((r) => r.monthlyRent)).toEqual([1850, 1795, 1900, 2100]);
    expect(importedMonthlyRent(maple)).toBe(7645);
  });

  it("marks every field the file filled as Imported and leaves the rest unmarked", () => {
    const sub = submissionFromImportedProperty(pine);
    expect(sub.prefill?.source).toBe("file");
    expect(prefillMarkFor(sub, "address")).toBe("imported");
    expect(prefillMarkFor(sub, "listingTotalBathroomsId")).toBe("imported");
    expect(prefillMarkFor(sub, "tagline")).toBeNull();
    const noZip = submissionFromImportedProperty(harvard);
    expect(prefillMarkFor(noZip, "zip")).toBeNull();
  });
});

describe("helpers", () => {
  it("names bare room codes", () => {
    expect(importedRoomLabel("1", true)).toBe("Room 1");
    expect(importedRoomLabel("b", true)).toBe("Room B");
    expect(importedRoomLabel("2A", false)).toBe("Unit 2A");
    expect(importedRoomLabel("Master bedroom", true)).toBe("Master bedroom");
    expect(importedRoomLabel("  ", true)).toBe("");
  });

  it("describes rows and sums room rent", () => {
    expect(describeSourceRows([6, 7, 8])).toBe("rows 6–8");
    expect(describeSourceRows([14])).toBe("row 14");
    expect(describeSourceRows([2, 9])).toBe("rows 2, 9");
    expect(describeSourceRows([])).toBe("");
    expect(importedMonthlyRent(pine)).toBe(1850);
    expect(importedMonthlyRent(harvard)).toBe(2650);
  });
});
