import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, emptyRoom, emptyBathroom } from "@/lib/manager-listing-submission";
import { createRoomInspectionDocument, resolveInspectionRoom } from "@/lib/inspections/room-template";

const listing = () => ({ ...createDefaultListingSubmission(), rooms: [
  { ...emptyRoom(0), id: "a", name: "Room 15A", furnishing: "Unfurnished" },
  { ...emptyRoom(1), id: "b", name: "Room 15B", furnishing: "Bed and desk" },
] });

describe("room inspection scope", () => {
  it("requires the actual assigned room instead of choosing a default room", () => {
    expect(() => resolveInspectionRoom("property", "", "", listing())).toThrow("Assign a room");
    expect(() => resolveInspectionRoom("property", "property", "", listing())).toThrow("Assign a room");
    expect(() => resolveInspectionRoom("property", "other::a", "", listing())).toThrow("does not belong");
    expect(() => resolveInspectionRoom("property", "property::missing", "", listing())).toThrow("could not be found");
  });
  it("uses only the selected room's furnishing and private bathroom", () => {
    const sub = listing();
    sub.bathrooms = [{ ...emptyBathroom(0), assignedRoomIds: ["b"], accessKindByRoomId: { b: "ensuite" } }];
    const a = createRoomInspectionDocument(resolveInspectionRoom("property", "property::a", "", sub));
    const b = createRoomInspectionDocument(resolveInspectionRoom("property", "property::b", "", sub));
    expect(a.roomScope).toEqual({ assignment: "property::a", label: "Room 15A" });
    expect(a.areas.map(a => a.label)).toEqual(["Room overview", "Walls, ceiling & floor", "Windows & blinds", "Door, lock & closet", "Lights & outlets", "Other"]);
    expect(b.areas.map(a => a.label)).toContain("Furniture");
    expect(b.areas.map(a => a.label)).toContain("Private bathroom");
    expect(b.areas.some(a => /kitchen|yard|hall|laundry|parking/i.test(a.label))).toBe(false);
  });
  it("does not turn a shared or whole-house bathroom into part of a private room", () => {
    for (const bath of [
      { ...emptyBathroom(0), assignedRoomIds: ["a", "b"], accessKindByRoomId: { a: "ensuite" as const } },
      { ...emptyBathroom(0), assignedRoomIds: ["a"], accessKindByRoomId: { a: "shared" as const } },
      { ...emptyBathroom(0), allResidents: true, assignedRoomIds: ["a"], accessKindByRoomId: { a: "ensuite" as const } },
    ]) expect(resolveInspectionRoom("property", "property::a", "", { ...listing(), bathrooms: [bath] }).privateBathroom).toBe(false);
  });
  it("supports an explicit manual room without inventing room features or condition", () => {
    const doc = createRoomInspectionDocument(resolveInspectionRoom("property", "", "Room 8"));
    expect(doc.roomScope?.label).toBe("Room 8");
    expect(doc.areas).toHaveLength(6);
    expect(doc.areas.every(a => a.items[0].resident.condition === "unchecked" && !a.items[0].resident.photos.length)).toBe(true);
    doc.areas[0].items[0].resident.notes = "A small mark";
    expect(doc.areas[0].items[0].manager.notes).toBe("");
    expect(doc.areas[1].items[0].resident.notes).toBe("");
  });
});
