import { describe, expect, it } from "vitest";
import { groupStaysByRoom } from "@/lib/occupancy/snapshot";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("groupStaysByRoom", () => {
  it("collapses same-room stays under one Room N and sorts by room number", () => {
    const groups = groupStaysByRoom([
      { roomId: "r3", roomLabel: "Room 3", name: "Vedel" },
      { roomId: "r1", roomLabel: "Room 1", name: "Ada" },
      { roomId: "r3", roomLabel: "Room 3", name: "Blocked" },
    ]);
    expect(groups.map((g) => g.roomLabel)).toEqual(["Room 1", "Room 3"]);
    expect(groups[1]!.stays.map((s) => s.name)).toEqual(["Vedel", "Blocked"]);
  });
});

describe("Bookings day page — no Add booking in the header", () => {
  it("does not render the day-header Add booking control", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/bookings-day-page.tsx"), "utf8");
    expect(src).not.toContain("bookings-day-add");
    expect(src).not.toContain("PortalPrimaryIconAction");
  });
});
