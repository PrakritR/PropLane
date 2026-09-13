import { describe, expect, it } from "vitest";
import {
  attachCheckInReply,
  checkInDedupeKey,
  checkInRuleOutcome,
  checkInSendAtMs,
  checkInSendDates,
  classifyCheckInReply,
  nextCheckInAt,
  normalizeVendorCheckIn,
  type VendorCheckIn,
} from "@/lib/vendor-check-ins";

/**
 * "Every two weeks, Monday 9 AM" has to mean Monday 9 AM in Seattle — across a
 * DST change — and a "no" or silence has to become exactly one task.
 */

const BASE: VendorCheckIn = {
  id: "ci_1",
  question: "Did you clean today?",
  cadence: "biweekly",
  weekday: 1,
  hour: 9,
  minute: 0,
  enabled: true,
  onNoOrSilent: "task",
  anchorDate: "2026-09-07",
  createdAt: "2026-09-07T00:00:00.000Z",
  log: [],
};

describe("cadence dates", () => {
  it("biweekly lands on alternate Mondays counted from the anchor", () => {
    expect(checkInSendDates(BASE, "2026-09-07", 42)).toEqual(["2026-09-07", "2026-09-21", "2026-10-05"]);
    // Starting mid-fortnight keeps the same parity.
    expect(checkInSendDates(BASE, "2026-09-10", 30)).toEqual(["2026-09-21", "2026-10-05"]);
  });

  it("weekly is every chosen weekday; monthly is the first chosen weekday of the month", () => {
    expect(checkInSendDates({ ...BASE, cadence: "weekly" }, "2026-09-07", 15)).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
    expect(checkInSendDates({ ...BASE, cadence: "monthly", weekday: 5 }, "2026-09-01", 62)).toEqual([
      "2026-09-04",
      "2026-10-02",
    ]);
  });

  it("everyDays counts from the anchor regardless of weekday", () => {
    expect(checkInSendDates({ ...BASE, cadence: { everyDays: 3 } }, "2026-09-07", 10)).toEqual([
      "2026-09-07",
      "2026-09-10",
      "2026-09-13",
      "2026-09-16",
    ]);
  });

  it("9:00 AM stays 9:00 AM Pacific on both sides of the November DST change", () => {
    // PDT (UTC-7) before Nov 1 2026, PST (UTC-8) after.
    expect(new Date(checkInSendAtMs(BASE, "2026-10-26")).toISOString()).toBe("2026-10-26T16:00:00.000Z");
    expect(new Date(checkInSendAtMs(BASE, "2026-11-09")).toISOString()).toBe("2026-11-09T17:00:00.000Z");
  });

  it("nextCheckInAt is the first send strictly after now, or null when disabled", () => {
    const now = Date.parse("2026-09-21T16:30:00.000Z"); // Mon Sep 21, 9:30 AM PDT — today's send already went
    expect(new Date(nextCheckInAt(BASE, now)!).toISOString()).toBe("2026-10-05T16:00:00.000Z");
    expect(nextCheckInAt({ ...BASE, enabled: false }, now)).toBeNull();
  });

  it("dedupe key is one per vendor, check-in and date", () => {
    expect(checkInDedupeKey("v1", "ci_1", "2026-09-21")).toBe("vendor_checkin:v1:ci_1:2026-09-21");
  });
});

describe("replies", () => {
  it("classifies yes / no / unclear in English and Spanish, no beats yes", () => {
    expect(classifyCheckInReply("Yes")).toBe("yes");
    expect(classifyCheckInReply("all clean 👍")).toBe("yes");
    expect(classifyCheckInReply("Sí, todo limpio")).toBe("yes");
    expect(classifyCheckInReply("no")).toBe("no");
    expect(classifyCheckInReply("Not yet, tomorrow")).toBe("no");
    expect(classifyCheckInReply("todavía no")).toBe("no");
    expect(classifyCheckInReply("yes but not done with the kitchen")).toBe("no");
    expect(classifyCheckInReply("what?")).toBe("unclear");
    expect(classifyCheckInReply("")).toBe("unclear");
  });

  it("attaches a reply to the latest unanswered send inside 36 hours, else leaves it alone", () => {
    const withSend: VendorCheckIn = { ...BASE, log: [{ sentAt: "2026-09-21T16:00:00.000Z" }] };
    const r1 = attachCheckInReply(withSend, { at: "2026-09-21T16:14:00.000Z", text: "yes" });
    expect(r1.attached).toBe(true);
    expect(r1.checkIn.log[0]!.reply?.verdict).toBe("yes");
    const r2 = attachCheckInReply(withSend, { at: "2026-09-24T16:14:00.000Z", text: "yes" });
    expect(r2.attached).toBe(false);
    // Already answered: a second reply does not overwrite.
    const r3 = attachCheckInReply(r1.checkIn, { at: "2026-09-21T17:00:00.000Z", text: "no" });
    expect(r3.attached).toBe(false);
  });

  it("the rule fires on a no immediately, on silence after 24h, and never twice", () => {
    const sent = "2026-09-21T16:00:00.000Z";
    expect(checkInRuleOutcome({ sentAt: sent, reply: { at: sent, text: "no", verdict: "no" } })).toBe("no");
    expect(checkInRuleOutcome({ sentAt: sent }, Date.parse("2026-09-22T10:00:00.000Z"))).toBeNull();
    expect(checkInRuleOutcome({ sentAt: sent }, Date.parse("2026-09-22T16:00:00.000Z"))).toBe("silent");
    expect(checkInRuleOutcome({ sentAt: sent, ruleRanAt: sent }, Date.parse("2026-09-25T00:00:00.000Z"))).toBeNull();
    expect(checkInRuleOutcome({ sentAt: sent, reply: { at: sent, text: "yes", verdict: "yes" } })).toBeNull();
  });
});

describe("normalize", () => {
  it("fills defaults and drops junk", () => {
    expect(normalizeVendorCheckIn({ id: " ", question: "x" })).toBeNull();
    const c = normalizeVendorCheckIn({ id: "a", question: "q", cadence: { everyDays: 400 }, hour: 99, weekday: 9 });
    expect(c?.cadence).toBe("biweekly");
    expect(c?.hour).toBe(9);
    expect(c?.weekday).toBe(1);
    expect(c?.onNoOrSilent).toBe("task");
    expect(c?.enabled).toBe(true);
  });
});
