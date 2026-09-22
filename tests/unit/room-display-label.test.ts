import { describe, expect, it } from "vitest";
import { roomDisplayLabel } from "@/lib/room-display-label";
describe("roomDisplayLabel", () => {
  it("leaves a written label alone", () => { expect(roomDisplayLabel("Room 2")).toBe("Room 2"); });
  it("labels a bare number", () => { expect(roomDisplayLabel("2")).toBe("Room 2"); });
  it("never prints a stored propertyId::roomId key", () => { expect(roomDisplayLabel("mgr-test-magnolia::room-2")).toBe("Room 2"); });
  it("handles the piped application shape", () => { expect(roomDisplayLabel("Magnolia|mgr-test-magnolia::room-3")).toBe("Room 3"); });
  it("is empty for nothing and the em dash", () => { expect(roomDisplayLabel("")).toBe(""); expect(roomDisplayLabel("—")).toBe(""); expect(roomDisplayLabel(null)).toBe(""); });
});
