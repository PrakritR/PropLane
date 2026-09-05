import { describe, expect, it } from "vitest";
import { isRoommatePlacement } from "@/lib/resident-move-in-resolve";

/**
 * The Move-in tab already lists every approved peer at the property with their
 * name, email, phone and room label. Per-bed rentals add one distinction on top:
 * which of them is in the viewer's OWN room. Getting that wrong introduces
 * strangers to each other as roommates, so the predicate is pinned here.
 *
 * This is a narrowing of data the resident could already see. It grants no access
 * to anyone's money or documents.
 */

const room = (roomId: string, roomLabel = "") => ({ roomId, roomLabel });

describe("roommates are decided by the structured room id", () => {
  it("matches two residents in the same room", () => {
    expect(isRoommatePlacement(room("r1"), room("r1"))).toBe(true);
  });

  it("does not match residents in different rooms of the same house", () => {
    expect(isRoommatePlacement(room("r1"), room("r2"))).toBe(false);
  });

  it("ignores the display label entirely when ids are present", () => {
    // Two houses can each call a room "Room 1"; the label must never decide this.
    expect(isRoommatePlacement(room("r1", "Room 1"), room("r9", "Room 1"))).toBe(false);
  });

  it("does not treat a peer with no id as a roommate of someone who has one", () => {
    expect(isRoommatePlacement(room("r1", "Room 1"), room("", "Room 1"))).toBe(false);
    expect(isRoommatePlacement(room("", "Room 1"), room("r1", "Room 1"))).toBe(false);
  });
});

describe("the legacy name fallback is narrow on purpose", () => {
  it("matches manually added residents who have no ids but a real shared room name", () => {
    expect(isRoommatePlacement(room("", "Room 1"), room("", "Room 1"))).toBe(true);
    expect(isRoommatePlacement(room("", " room 1 "), room("", "Room 1"))).toBe(true);
  });

  it("does not match two residents whose room is simply unknown", () => {
    // "Room TBD" is the loader's placeholder. Matching on it would make every
    // unplaced resident a roommate of every other unplaced resident.
    expect(isRoommatePlacement(room("", "Room TBD"), room("", "Room TBD"))).toBe(false);
  });

  it("does not match when the viewer's room is blank", () => {
    expect(isRoommatePlacement(room("", ""), room("", ""))).toBe(false);
    expect(isRoommatePlacement(room("", ""), room("", "Room 1"))).toBe(false);
  });

  it("does not match different room names", () => {
    expect(isRoommatePlacement(room("", "Room 1"), room("", "Room 2"))).toBe(false);
  });
});
