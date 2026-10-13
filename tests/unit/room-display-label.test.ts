import { describe, expect, it } from "vitest";
import { looksLikeRawRecordId, placeNameOrEmpty, roomDisplayLabel } from "@/lib/room-display-label";
describe("roomDisplayLabel", () => {
  it("leaves a written label alone", () => { expect(roomDisplayLabel("Room 2")).toBe("Room 2"); });
  it("labels a bare number", () => { expect(roomDisplayLabel("2")).toBe("Room 2"); });
  it("never prints a stored propertyId::roomId key", () => { expect(roomDisplayLabel("mgr-test-magnolia::room-2")).toBe("Room 2"); });
  it("handles the piped application shape", () => { expect(roomDisplayLabel("Magnolia|mgr-test-magnolia::room-3")).toBe("Room 3"); });
  it("does not prefix a unit or studio name with Room", () => { expect(roomDisplayLabel("Unit 3")).toBe("Unit 3"); expect(roomDisplayLabel("Studio")).toBe("Studio"); expect(roomDisplayLabel("12A")).toBe("Room 12A"); });
  it("is empty for nothing and the em dash", () => { expect(roomDisplayLabel("")).toBe(""); expect(roomDisplayLabel("—")).toBe(""); expect(roomDisplayLabel(null)).toBe(""); });
  it("never prints a raw record id as a room or place", () => {
    expect(roomDisplayLabel("mgr-qa-c3-house-0001")).toBe("");
    expect(placeNameOrEmpty("mgr-qa-c3-house-0001")).toBe("");
    expect(placeNameOrEmpty("3f2b9c1e-0a4d-4b7e-9c11-5d2e8a7f6b10")).toBe("");
    expect(placeNameOrEmpty("5257 Brooklyn Avenue Northeast")).toBe("5257 Brooklyn Avenue Northeast");
    expect(looksLikeRawRecordId("room-2")).toBe(false);
    expect(looksLikeRawRecordId("Unit 3")).toBe(false);
    expect(roomDisplayLabel("room-2")).toBe("Room 2");
  });
});
