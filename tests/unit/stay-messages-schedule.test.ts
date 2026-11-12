/** design-1112 §7: when the automated check-in / check-out messages are due (America/Los_Angeles, DST-safe). */
import { describe, expect, it } from "vitest";
import { checkInDueAt, checkInWindow, checkOutDueAt, checkOutWindow, createdInsideWindow, stayEnded } from "@/lib/stay-messages/schedule";

describe("checkInDueAt: 10:00 local the day before", () => {
  it("is 10:00 PST the day before in winter", () => {
    expect(checkInDueAt("2026-11-20")!.toISOString()).toBe("2026-11-19T18:00:00.000Z");
  });
  it("is 10:00 PDT the day before in summer", () => {
    expect(checkInDueAt("2026-07-10")!.toISOString()).toBe("2026-07-09T17:00:00.000Z");
  });
  it("holds 10:00 local across the fall-back change (check-in Nov 2, the day after DST ends)", () => {
    // Nov 1 2026 is the day clocks fall back: 10:00 on Nov 1 is PST (UTC-8).
    expect(checkInDueAt("2026-11-02")!.toISOString()).toBe("2026-11-01T18:00:00.000Z");
  });
  it("holds 10:00 local across the spring-forward change", () => {
    // Mar 14 2027 clocks spring forward: 10:00 on Mar 14 is PDT (UTC-7).
    expect(checkInDueAt("2027-03-15")!.toISOString()).toBe("2027-03-14T17:00:00.000Z");
    expect(checkInDueAt("2027-03-14")!.toISOString()).toBe("2027-03-13T18:00:00.000Z");
  });
  it("refuses a bad date", () => {
    expect(checkInDueAt("soon")).toBeNull();
  });
});

describe("checkOutDueAt: 09:00 local on the check-out date", () => {
  it("is 09:00 Pacific", () => {
    expect(checkOutDueAt("2026-11-20")!.toISOString()).toBe("2026-11-20T17:00:00.000Z");
    expect(checkOutDueAt("2026-07-10")!.toISOString()).toBe("2026-07-10T16:00:00.000Z");
  });
});

describe("windows", () => {
  const stay = { checkInDate: "2026-11-20", checkInTime: "15:00" };
  it("is not yet before the anchor, due from it, and expired well after check-in", () => {
    expect(checkInWindow({ ...stay, now: new Date("2026-11-19T17:59:00Z") })!.state).toBe("not_yet");
    expect(checkInWindow({ ...stay, now: new Date("2026-11-19T18:00:00Z") })!.state).toBe("due");
    // 15:00 PST on the 20th = 23:00Z; the grace is six hours past it.
    expect(checkInWindow({ ...stay, now: new Date("2026-11-20T23:30:00Z") })!.state).toBe("due");
    expect(checkInWindow({ ...stay, now: new Date("2026-11-21T06:00:00Z") })!.state).toBe("expired");
  });
  it("a booking created inside the window is due now", () => {
    expect(createdInsideWindow("2026-11-19T20:00:00Z", "2026-11-20")).toBe(true);
    expect(createdInsideWindow("2026-11-10T20:00:00Z", "2026-11-20")).toBe(false);
  });
  it("check-out is due from 09:00 on the day until the check-out instant", () => {
    const out = { checkOutDate: "2026-11-23", checkOutTime: "11:00" };
    expect(checkOutWindow({ ...out, now: new Date("2026-11-23T16:59:00Z") })!.state).toBe("not_yet");
    expect(checkOutWindow({ ...out, now: new Date("2026-11-23T17:00:00Z") })!.state).toBe("due");
    expect(checkOutWindow({ ...out, now: new Date("2026-11-24T03:00:00Z") })!.state).toBe("expired");
    expect(stayEnded({ ...out, now: new Date("2026-11-23T19:00:01Z") })).toBe(true);
  });
});
