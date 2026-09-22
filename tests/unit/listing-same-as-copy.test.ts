/**
 * PLAN-0921-1648 / PLAN-0922-1159: Rooms, Bathrooms and Pricing have no
 * Default card. "Same as Room X" / "Same as Bathroom X" copies another
 * record onto this one once, right now. These are the pure functions:
 * `copyRoomDescriptionFrom` / `roomDescriptionMatches`,
 * `copyRoomPricingFrom` / `roomPricingMatches`
 * (`src/lib/listing-house-defaults.ts`) and
 * `copyBathroomDescriptionFrom` / `bathroomDescriptionMatches`
 * (`src/lib/listing-record-defaults.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  copyRoomDescriptionFrom,
  copyRoomPricingFrom,
  ROOM_DESCRIPTION_FIELDS,
  ROOM_PRICING_FIELDS,
  roomDescriptionMatches,
  roomPricingHasAnyValue,
  roomPricingMatches,
} from "@/lib/listing-house-defaults";
import {
  copyBathroomDescriptionFrom,
  bathroomDescriptionMatches,
} from "@/lib/listing-record-defaults";
import { emptyBathroom, emptyRoom, type ManagerRoomSubmission } from "@/lib/manager-listing-submission";

describe("copyRoomDescriptionFrom", () => {
  it("copies every description field onto the target", () => {
    const source: ManagerRoomSubmission = {
      ...emptyRoom(0),
      floor: "2nd floor",
      beds: [{ type: "Queen", count: 1 }],
      bedCount: 1,
      occupancyCapacity: 2,
      furnishing: "furnished",
      roomAmenitiesText: "Desk, closet",
      sizeSqft: 140,
      moveInInspectionRequired: true,
      moveOutInspectionRequired: true,
      photoDataUrls: ["p1", "p2"],
      videoDataUrl: "clip",
      detail: "Bright corner room",
      moveInInstructions: "Key under the mat",
      moveInPhotoDataUrls: ["e1"],
      moveInVideoDataUrl: "arrival-clip",
    };
    const target = emptyRoom(1);
    const copied = copyRoomDescriptionFrom(source, target);
    expect(copied.floor).toBe("2nd floor");
    expect(copied.beds).toEqual([{ type: "Queen", count: 1 }]);
    expect(copied.bedCount).toBe(1);
    expect(copied.occupancyCapacity).toBe(2);
    expect(copied.furnishing).toBe("furnished");
    expect(copied.roomAmenitiesText).toBe("Desk, closet");
    expect(copied.sizeSqft).toBe(140);
    expect(copied.moveInInspectionRequired).toBe(true);
    expect(copied.moveOutInspectionRequired).toBe(true);
    expect(copied.photoDataUrls).toEqual(["p1", "p2"]);
    expect(copied.videoDataUrl).toBe("clip");
    expect(copied.detail).toBe("Bright corner room");
    expect(copied.moveInInstructions).toBe("Key under the mat");
    expect(copied.moveInPhotoDataUrls).toEqual(["e1"]);
    expect(copied.moveInVideoDataUrl).toBe("arrival-clip");
    // Lists are copied by value, not by reference.
    expect(copied.photoDataUrls).not.toBe(source.photoDataUrls);
  });

  it("never touches id, name, availability, manual unavailable ranges, price, or per-resident pricing", () => {
    const source: ManagerRoomSubmission = { ...emptyRoom(0), id: "src", name: "Source", floor: "2nd floor", monthlyRent: 1500 };
    const target: ManagerRoomSubmission = {
      ...emptyRoom(1),
      id: "tgt",
      name: "Target",
      monthlyRent: 900,
      availability: "occupied",
      moveInAvailableDate: "2027-03-01",
      manualUnavailableRanges: [{ id: "u1", start: "2027-01-01", end: null }],
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 800 }],
      ownRoomFields: ["floor"],
      dailyRentPrice: 90,
      rentBasis: "daily",
      pricingMode: "flexible",
      securityDeposit: "500",
      termPricing: { "Month-to-Month": { monthlyRent: 1000 } },
    };
    const copied = copyRoomDescriptionFrom(source, target);
    expect(copied.id).toBe("tgt");
    expect(copied.name).toBe("Target");
    expect(copied.monthlyRent).toBe(900);
    expect(copied.availability).toBe("occupied");
    expect(copied.moveInAvailableDate).toBe("2027-03-01");
    expect(copied.manualUnavailableRanges).toEqual([{ id: "u1", start: "2027-01-01", end: null }]);
    expect(copied.residentPricing).toBe("per_resident");
    expect(copied.residentPrices).toEqual([{ monthlyRent: 800 }]);
    expect(copied.dailyRentPrice).toBe(90);
    expect(copied.rentBasis).toBe("daily");
    expect(copied.pricingMode).toBe("flexible");
    expect(copied.securityDeposit).toBe("500");
    expect(copied.termPricing).toEqual({ "Month-to-Month": { monthlyRent: 1000 } });
    // Floor IS copied — it is a description field.
    expect(copied.floor).toBe("2nd floor");
  });

  it("copies every field the guard list names, and nothing outside it", () => {
    expect(ROOM_DESCRIPTION_FIELDS).toEqual([
      "floor",
      "bedsLine",
      "occupancyCapacity",
      "furnishing",
      "roomAmenitiesText",
      "sizeSqft",
      "moveInInspectionRequired",
      "moveOutInspectionRequired",
      "photoDataUrls",
      "videoDataUrl",
      "detail",
      "moveInInstructions",
      "moveInPhotoDataUrls",
      "moveInVideoDataUrl",
    ]);
  });
});

describe("roomDescriptionMatches", () => {
  it("is true for two blank rooms and for an exact copy", () => {
    const a = emptyRoom(0);
    const b = emptyRoom(1);
    expect(roomDescriptionMatches(a, b)).toBe(true);
    const source = { ...emptyRoom(0), floor: "2nd floor", furnishing: "furnished" };
    const copied = copyRoomDescriptionFrom(source, emptyRoom(1));
    expect(roomDescriptionMatches(source, copied)).toBe(true);
  });

  it("is false once a description field diverges, true again after copying back", () => {
    const a = { ...emptyRoom(0), floor: "2nd floor" };
    const b = emptyRoom(1);
    expect(roomDescriptionMatches(a, b)).toBe(false);
    const matched = copyRoomDescriptionFrom(a, b);
    expect(roomDescriptionMatches(a, matched)).toBe(true);
  });

  it("ignores price, availability and name entirely", () => {
    const a = { ...emptyRoom(0), name: "Room A", monthlyRent: 1200, availability: "occupied" };
    const b = { ...emptyRoom(1), name: "Room B", monthlyRent: 900, availability: "available" };
    expect(roomDescriptionMatches(a, b)).toBe(true);
  });
});

describe("copyBathroomDescriptionFrom", () => {
  it("copies floor, type, finishes, description, photos and video", () => {
    const source = { ...emptyBathroom(0), location: "2nd floor", toilet: true, sink: true, shower: false, bathtub: false, amenitiesText: "Heated floor", detail: "Renovated", photoDataUrls: ["p"], videoDataUrl: "clip" };
    const target = emptyBathroom(1);
    const copied = copyBathroomDescriptionFrom(source, target);
    expect(copied.location).toBe("2nd floor");
    expect(copied.shower).toBe(false);
    expect(copied.bathtub).toBe(false);
    expect(copied.sink).toBe(true);
    expect(copied.amenitiesText).toBe("Heated floor");
    expect(copied.detail).toBe("Renovated");
    expect(copied.photoDataUrls).toEqual(["p"]);
    expect(copied.videoDataUrl).toBe("clip");
  });

  it("never touches id, name, assignedRoomIds, allResidents, accessKindByRoomId, or the access kind", () => {
    const source = { ...emptyBathroom(0), id: "src", name: "Source", assignedRoomIds: ["r9"], allResidents: true, accessKindByRoomId: { r9: "ensuite" as const }, accessKind: "ensuite" as const };
    const target = { ...emptyBathroom(1), id: "tgt", name: "Target", assignedRoomIds: ["r1", "r2"], allResidents: false, accessKindByRoomId: { r1: "shared" as const }, accessKind: "shared" as const };
    const copied = copyBathroomDescriptionFrom(source, target);
    expect(copied.id).toBe("tgt");
    expect(copied.name).toBe("Target");
    expect(copied.assignedRoomIds).toEqual(["r1", "r2"]);
    expect(copied.allResidents).toBe(false);
    expect(copied.accessKindByRoomId).toEqual({ r1: "shared" });
    expect(copied.accessKind).toBe("shared");
  });
});

describe("bathroomDescriptionMatches", () => {
  // emptyBathroom(0) is a full bath (tub + shower); every other index is a
  // shower bath — a genuine difference in type, so these compare same-shaped
  // bathrooms (index 1 vs 2) to isolate the field being tested.
  it("is true for two blank bathrooms of the same type and for an exact copy, false once a field diverges", () => {
    expect(bathroomDescriptionMatches(emptyBathroom(1), emptyBathroom(2))).toBe(true);
    const source = { ...emptyBathroom(1), location: "2nd floor" };
    const copied = copyBathroomDescriptionFrom(source, emptyBathroom(2));
    expect(bathroomDescriptionMatches(source, copied)).toBe(true);
    const diverged = { ...copied, location: "1st floor" };
    expect(bathroomDescriptionMatches(source, diverged)).toBe(false);
  });

  it("is false when the type differs (tub vs no tub), true once the type is copied over", () => {
    expect(bathroomDescriptionMatches(emptyBathroom(0), emptyBathroom(1))).toBe(false);
    const copied = copyBathroomDescriptionFrom(emptyBathroom(0), emptyBathroom(1));
    expect(bathroomDescriptionMatches(emptyBathroom(0), copied)).toBe(true);
  });

  it("ignores who uses it entirely", () => {
    const a = { ...emptyBathroom(1), assignedRoomIds: ["r1"], allResidents: false };
    const b = { ...emptyBathroom(2), assignedRoomIds: ["r2", "r3"], allResidents: true };
    expect(bathroomDescriptionMatches(a, b)).toBe(true);
  });
});

describe("copyRoomPricingFrom", () => {
  it("copies the price card onto the target, including this term's prices", () => {
    const source: ManagerRoomSubmission = {
      ...emptyRoom(0),
      monthlyRent: 1100,
      utilitiesEstimate: "75",
      securityDeposit: "250",
      pricingMode: "flexible",
      prorateMethod: "daily_rate",
      dailyRentRate: 40,
      dailyUtilitiesRate: 5,
      weeklyRentPrice: 700,
      shortTermRent: "120",
      termPricing: { "Month-to-Month": { monthlyRent: 1050, utilitiesEstimate: "50" } },
    };
    const copied = copyRoomPricingFrom(source, emptyRoom(1));
    expect(copied.monthlyRent).toBe(1100);
    expect(copied.utilitiesEstimate).toBe("75");
    expect(copied.securityDeposit).toBe("250");
    expect(copied.pricingMode).toBe("flexible");
    expect(copied.prorateMethod).toBe("daily_rate");
    expect(copied.dailyRentRate).toBe(40);
    expect(copied.dailyUtilitiesRate).toBe(5);
    expect(copied.weeklyRentPrice).toBe(700);
    expect(copied.shortTermRent).toBe("120");
    expect(copied.termPricing).toEqual({ "Month-to-Month": { monthlyRent: 1050, utilitiesEstimate: "50" } });
    expect(copied.termPricing).not.toBe(source.termPricing);
  });

  it("never touches id, name, availability, rentBasis, dailyRentPrice, or per-resident pricing", () => {
    const source: ManagerRoomSubmission = {
      ...emptyRoom(0),
      id: "src",
      name: "Source",
      monthlyRent: 1500,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 800 }],
    };
    const target: ManagerRoomSubmission = {
      ...emptyRoom(1),
      id: "tgt",
      name: "Target",
      availability: "occupied",
      moveInAvailableDate: "2027-03-01",
      rentBasis: "daily",
      dailyRentPrice: 90,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 700 }],
      floor: "2nd floor",
    };
    const copied = copyRoomPricingFrom(source, target);
    expect(copied.id).toBe("tgt");
    expect(copied.name).toBe("Target");
    expect(copied.availability).toBe("occupied");
    expect(copied.moveInAvailableDate).toBe("2027-03-01");
    expect(copied.rentBasis).toBe("daily");
    expect(copied.dailyRentPrice).toBe(90);
    expect(copied.residentPricing).toBe("per_resident");
    expect(copied.residentPrices).toEqual([{ monthlyRent: 700 }]);
    expect(copied.floor).toBe("2nd floor");
    expect(copied.monthlyRent).toBe(1500);
  });

  it("never copies per-resident rows off a term entry", () => {
    const source: ManagerRoomSubmission = {
      ...emptyRoom(0),
      termPricing: {
        "Month-to-Month": {
          monthlyRent: 1050,
          residentPricing: "per_resident",
          residentPrices: [{ monthlyRent: 500 }],
        },
      },
    };
    const copied = copyRoomPricingFrom(source, emptyRoom(1));
    expect(copied.termPricing?.["Month-to-Month"]).toEqual({ monthlyRent: 1050 });
  });

  it("names every field the guard list carries", () => {
    expect(ROOM_PRICING_FIELDS).toEqual([
      "monthlyRent",
      "utilitiesEstimate",
      "securityDeposit",
      "pricingMode",
      "prorateMethod",
      "dailyRentRate",
      "dailyUtilitiesRate",
      "weeklyRentPrice",
      "shortTermRent",
      "termPricing",
    ]);
  });
});

describe("roomPricingMatches", () => {
  it("is false for two blank rooms, true for an exact priced copy", () => {
    expect(roomPricingHasAnyValue(emptyRoom(0))).toBe(false);
    expect(roomPricingMatches(emptyRoom(0), emptyRoom(1))).toBe(false);
    const source = { ...emptyRoom(0), monthlyRent: 1100, utilitiesEstimate: "75" };
    const copied = copyRoomPricingFrom(source, emptyRoom(1));
    expect(roomPricingMatches(source, copied)).toBe(true);
  });

  it("is false once a price field diverges, true again after copying back", () => {
    const a = { ...emptyRoom(0), monthlyRent: 1100 };
    const b = { ...emptyRoom(1), monthlyRent: 900 };
    expect(roomPricingMatches(a, b)).toBe(false);
    expect(roomPricingMatches(a, copyRoomPricingFrom(a, b))).toBe(true);
  });

  it("ignores name, availability and per-resident rows", () => {
    const a = { ...emptyRoom(0), name: "A", monthlyRent: 1100, availability: "occupied", residentPrices: [{ monthlyRent: 800 }] };
    const b = { ...emptyRoom(1), name: "B", monthlyRent: 1100, availability: "available", residentPrices: [{ monthlyRent: 500 }] };
    expect(roomPricingMatches(a, b)).toBe(true);
  });
});
