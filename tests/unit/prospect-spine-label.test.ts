import { describe, expect, it } from "vitest";
import { contextLabel, maskedPhoneLabel, sourceLabelFor } from "@/lib/prospect-spine/label";
import { roomByLabel, roomFromText } from "@/lib/prospect-spine/context.server";
import { residentViewOfTurns } from "@/lib/prospect-spine/link.server";

describe("contextLabel", () => {
  it("house + room reads exactly as the captain's tag", () => {
    expect(contextLabel({ propertyLabel: "5259 Brooklyn Ave NE", roomLabel: "Room 4" })).toBe("5259 Brooklyn Ave NE · Room 4");
  });
  it("a platform inquiry leads with the source", () => {
    expect(contextLabel({ propertyLabel: "4709a", roomLabel: "Room 9", sourceLabel: "SpareRoom" })).toBe("SpareRoom · 4709a Room 9");
  });
  it("house only, and nothing at all", () => {
    expect(contextLabel({ propertyLabel: "5259 Brooklyn Ave NE" })).toBe("5259 Brooklyn Ave NE");
    expect(contextLabel({ propertyLabel: null })).toBe("");
  });
  it("source labels and masked numbers", () => {
    expect(sourceLabelFor("spareroom")).toBe("SpareRoom");
    expect(sourceLabelFor("sms")).toBeNull();
    expect(maskedPhoneLabel("+12065550188")).toBe("***0188");
    expect(maskedPhoneLabel("")).toBe("Unknown number");
  });
});

describe("room matching", () => {
  const rooms = [{ id: "r1", label: "Room 1" }, { id: "r4", label: "Room 4" }, { id: "r12", label: "Room 12" }];
  it("finds the named room, never guesses", () => {
    expect(roomFromText("is room 4 still open?", rooms)?.id).toBe("r4");
    expect(roomFromText("Room #12 please", rooms)?.id).toBe("r12");
    expect(roomFromText("any rooms open", rooms)).toBeNull();
    expect(roomFromText("room 9", rooms)).toBeNull();
  });
  it("matches a resident's occupancy room by label", () => {
    expect(roomByLabel(rooms, " room 4 ")?.id).toBe("r4");
    expect(roomByLabel(rooms, "Attic")).toBeNull();
  });
});

describe("residentViewOfTurns", () => {
  it("flips direction: the prospect's own texts are outbound to them", () => {
    const turns = residentViewOfTurns({
      rootMessageId: "m1", from: "+1206", body: "hi", rootAt: "t1", rootOutbound: false, rootChannel: "sms",
      messages: [{ id: "m2", from: "You", body: "hello", at: "t2", outbound: true }],
    });
    expect(turns.map((t) => [t.id, t.outbound])).toEqual([["m1", true], ["m2", false]]);
  });
});
