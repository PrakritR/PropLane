import { describe, expect, it } from "vitest";
import {
  createDefaultListingSubmission,
  duplicateBathroomEntry,
  duplicateListingSubmission,
  duplicateRoomEntry,
  duplicateSharedSpaceEntry,
  emptyBathroom,
  emptySharedSpace,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

function seeded(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    buildingName: "Proof Oak House",
    rooms: [
      { ...base.rooms[0]!, id: "r1", name: "Studio", occupancyCapacity: 2, photoDataUrls: ["https://cdn.example/r.jpg"] },
    ],
    bathrooms: [
      {
        ...emptyBathroom(0),
        id: "b1",
        name: "Full bathroom",
        assignedRoomIds: ["r1"],
        accessKindByRoomId: { r1: "ensuite" },
        photoDataUrls: ["https://cdn.example/b.jpg"],
      },
    ],
    sharedSpaces: [
      {
        ...emptySharedSpace(0),
        id: "s1",
        name: "Kitchen",
        roomAccessIds: ["r1"],
      },
    ],
    bundles: [
      {
        id: "bundle-1",
        label: "Whole house",
        price: "2400",
        strikethrough: "",
        promo: "",
        roomsLine: "",
        includedRoomIds: ["r1"],
      },
    ],
    allowedLeaseTerms: ["Long-term"],
    paymentAtSigningByLeaseType: {
      "Long-term": ["security_deposit", "room_rent:r1"],
    },
  };
}

describe("duplicateRoomEntry", () => {
  it("mints a new id and appends (copy) to the name", () => {
    const copy = duplicateRoomEntry(seeded().rooms[0]!);
    expect(copy.id).not.toBe("r1");
    expect(copy.name).toBe("Studio (copy)");
    expect(copy.occupancyCapacity).toBe(2);
    expect(copy.photoDataUrls).toEqual(["https://cdn.example/r.jpg"]);
  });

  it("keeps the original name when asked", () => {
    expect(duplicateRoomEntry(seeded().rooms[0]!, { keepName: true }).name).toBe("Studio");
  });
});

describe("duplicateBathroomEntry / duplicateSharedSpaceEntry", () => {
  it("appends (copy) and remints the bathroom id", () => {
    const copy = duplicateBathroomEntry(seeded().bathrooms[0]!);
    expect(copy.id).not.toBe("b1");
    expect(copy.name).toBe("Full bathroom (copy)");
    expect(copy.assignedRoomIds).toEqual(["r1"]);
  });

  it("remaps ensuite rooms when a room id map is provided", () => {
    const copy = duplicateBathroomEntry(seeded().bathrooms[0]!, {
      keepName: true,
      roomIdMap: new Map([["r1", "r-new"]]),
    });
    expect(copy.name).toBe("Full bathroom");
    expect(copy.assignedRoomIds).toEqual(["r-new"]);
    expect(copy.accessKindByRoomId).toEqual({ "r-new": "ensuite" });
  });

  it("copies a shared space with a new id", () => {
    const copy = duplicateSharedSpaceEntry(seeded().sharedSpaces[0]!);
    expect(copy.id).not.toBe("s1");
    expect(copy.name).toBe("Kitchen (copy)");
    expect(copy.roomAccessIds).toEqual(["r1"]);
  });
});

describe("duplicateListingSubmission", () => {
  it("names the property (copy), remints nested ids, and remaps room references", () => {
    const copy = duplicateListingSubmission(seeded());
    expect(copy.buildingName).toBe("Proof Oak House (copy)");
    expect(copy.rooms[0]!.id).not.toBe("r1");
    expect(copy.rooms[0]!.name).toBe("Studio");
    expect(copy.bathrooms[0]!.name).toBe("Full bathroom");
    expect(copy.bathrooms[0]!.assignedRoomIds).toEqual([copy.rooms[0]!.id]);
    expect(copy.bathrooms[0]!.accessKindByRoomId).toEqual({ [copy.rooms[0]!.id]: "ensuite" });
    expect(copy.sharedSpaces[0]!.roomAccessIds).toEqual([copy.rooms[0]!.id]);
    expect(copy.bundles[0]!.includedRoomIds).toEqual([copy.rooms[0]!.id]);
    expect(copy.paymentAtSigningByLeaseType?.["Long-term"]).toEqual([
      "security_deposit",
      `room_rent:${copy.rooms[0]!.id}`,
    ]);
    expect(copy.rooms[0]!.photoDataUrls).toEqual(["https://cdn.example/r.jpg"]);
  });
});
