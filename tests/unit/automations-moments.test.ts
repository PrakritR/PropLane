import { describe, expect, it } from "vitest";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import {
  addDaysToKey,
  daysBetweenKeys,
  firstNameOf,
  houseMoments,
  residentMoments,
  shortDateLabel,
  weekdayOfKey,
  withinQuietWindow,
  workOrderIsHouseWide,
  type HouseSubject,
  type LeaseSubject,
} from "@/lib/automations/moments";

const lease = (over: Partial<LeaseSubject> = {}): LeaseSubject => ({
  leaseId: "L1",
  ownerUserId: "owner",
  workspaceId: "ws",
  propertyId: "P1",
  propertyLabel: "5259 Brooklyn",
  roomLabel: "Room 3",
  residentName: "Maya Chen",
  firstName: "Maya",
  residentUserId: "u1",
  residentEmail: "maya@example.com",
  phoneKey: "2065550100",
  signedKey: "2026-10-18",
  moveIn: "2026-11-01",
  moveOut: null,
  ...over,
});

const house = (set: (i: ReturnType<typeof emptyHouseInfo>) => ReturnType<typeof emptyHouseInfo> = (i) => i): HouseSubject => ({
  ownerUserId: "owner",
  workspaceId: "ws",
  propertyId: "P1",
  propertyLabel: "5259 Brooklyn",
  houseInfo: set(emptyHouseInfo()),
});

describe("date helpers", () => {
  it("counts whole days and adds days across a month", () => {
    expect(daysBetweenKeys("2026-10-29", "2026-11-01")).toBe(3);
    expect(addDaysToKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(weekdayOfKey("2026-10-20")).toBe("Tuesday");
    expect(shortDateLabel("2026-11-01")).toBe("Nov 1");
    expect(firstNameOf("maya chen")).toBe("Maya");
    expect(firstNameOf("maya@example.com")).toBe("there");
    expect(firstNameOf("")).toBe("there");
  });
  it("reads a quiet window that wraps midnight", () => {
    expect(withinQuietWindow(23, { from: "22:00", to: "08:00" })).toBe(true);
    expect(withinQuietWindow(7, { from: "22:00", to: "08:00" })).toBe(true);
    expect(withinQuietWindow(12, { from: "22:00", to: "08:00" })).toBe(false);
  });
});

describe("residentMoments", () => {
  it("fires welcome for a lease signed this week, once per lease key", () => {
    const moments = residentMoments(lease(), "2026-10-19");
    expect(moments.map((m) => m.key)).toContain("welcome:L1");
  });
  it("does not welcome a lease signed long ago (turning the preset on is not a backfill)", () => {
    expect(residentMoments(lease({ signedKey: "2026-08-01" }), "2026-10-19").map((m) => m.preset)).not.toContain("welcome");
  });
  it("fires the move-in details text from 3 days out, never before and never after move-in", () => {
    expect(residentMoments(lease(), "2026-10-29").map((m) => m.preset)).toContain("move_in_3d");
    expect(residentMoments(lease(), "2026-10-28").map((m) => m.preset)).not.toContain("move_in_3d");
    expect(residentMoments(lease(), "2026-11-01").map((m) => m.preset)).toContain("move_in_3d");
    expect(residentMoments(lease(), "2026-11-02").map((m) => m.preset)).not.toContain("move_in_3d");
  });
});

describe("houseMoments", () => {
  const clock = (hour: number, todayKey = "2026-11-01") => ({ todayKey, hour, dayOfMonth: Number(todayKey.slice(8, 10)) });

  it("posts move-in day and rent-due-today once per house per day, by key", () => {
    const moments = houseMoments({ house: house(), roster: [lease()], rentDueToday: true, clock: clock(10) });
    expect(moments.map((m) => m.key)).toEqual(["move_in_day:P1:2026-11-01", "rent_due_day:P1:2026-11-01"]);
  });

  it("posts nothing before 9 am or after 9 pm", () => {
    expect(houseMoments({ house: house(), roster: [lease()], rentDueToday: true, clock: clock(7) })).toEqual([]);
    expect(houseMoments({ house: house(), roster: [lease()], rentDueToday: true, clock: clock(21) })).toEqual([]);
  });

  it("respects the house's own quiet hours", () => {
    const quiet = house((i) => setHouseInfoValue(setHouseInfoValue(i, "rules", "quietFrom", "20:00"), "rules", "quietTo", "09:30"));
    expect(houseMoments({ house: quiet, roster: [lease()], rentDueToday: true, clock: clock(10) })).toHaveLength(2);
    const early = house((i) => setHouseInfoValue(setHouseInfoValue(i, "rules", "quietFrom", "10:00"), "rules", "quietTo", "12:00"));
    expect(houseMoments({ house: early, roster: [lease()], rentDueToday: true, clock: clock(10) })).toEqual([]);
  });

  it("does not post rent-due when nothing is due, or move-in when nobody moves in", () => {
    expect(houseMoments({ house: house(), roster: [lease({ moveIn: "2026-12-01" })], rentDueToday: false, clock: clock(10) })).toEqual([]);
  });

  it("reminds about pickup the evening before, naming trash, recycling or both", () => {
    const trash = house((i) => setHouseInfoValue(i, "trash", "day", "Tuesday"));
    const evening = houseMoments({ house: trash, roster: [], rentDueToday: false, clock: clock(18, "2026-10-19") });
    expect(evening).toHaveLength(1);
    expect(evening[0]).toMatchObject({ preset: "house_reminders", key: "house_pickup:P1:2026-10-20" });
    expect(evening[0]!.reminder).toMatch(/^Trash pickup is tomorrow/);
    // Not at lunchtime, not the wrong evening.
    expect(houseMoments({ house: trash, roster: [], rentDueToday: false, clock: clock(12, "2026-10-19") })).toEqual([]);
    expect(houseMoments({ house: trash, roster: [], rentDueToday: false, clock: clock(18, "2026-10-21") })).toEqual([]);
    const both = house((i) => setHouseInfoValue(setHouseInfoValue(i, "trash", "day", "Tuesday"), "trash", "recycling", "Tuesday"));
    expect(houseMoments({ house: both, roster: [], rentDueToday: false, clock: clock(18, "2026-10-19") })[0]!.reminder).toMatch(/^Trash and recycling/);
  });

  it("sends the monthly cleaning heads-up on the 1st for a Monthly cadence only", () => {
    const monthly = house((i) => setHouseInfoValue(i, "trash", "cleaningCadence", "Monthly"));
    const moments = houseMoments({ house: monthly, roster: [], rentDueToday: false, clock: clock(10, "2026-11-01") });
    expect(moments.map((m) => m.key)).toEqual(["house_cleaning:P1:2026-11"]);
    expect(houseMoments({ house: monthly, roster: [], rentDueToday: false, clock: clock(10, "2026-11-02") })).toEqual([]);
    const weekly = house((i) => setHouseInfoValue(i, "trash", "cleaningCadence", "Weekly"));
    expect(houseMoments({ house: weekly, roster: [], rentDueToday: false, clock: clock(10, "2026-11-01") })).toEqual([]);
  });

  it("posts move-out when a roster member leaves today", () => {
    const moments = houseMoments({ house: house(), roster: [lease({ moveIn: null, moveOut: "2026-11-01" })], rentDueToday: false, clock: clock(10) });
    expect(moments.map((m) => m.preset)).toEqual(["move_out"]);
  });
});

describe("workOrderIsHouseWide", () => {
  it("is true for common areas, false for one resident's room or no room", () => {
    expect(workOrderIsHouseWide({ unit: "Common area" })).toBe(true);
    expect(workOrderIsHouseWide({ unit: "Kitchen" })).toBe(true);
    expect(workOrderIsHouseWide({ unit: "Whole house" })).toBe(true);
    expect(workOrderIsHouseWide({ unit: "Room 3" })).toBe(false);
    expect(workOrderIsHouseWide({ unit: "" })).toBe(false);
    expect(workOrderIsHouseWide({})).toBe(false);
  });
});
