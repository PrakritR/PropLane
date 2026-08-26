/**
 * "Is anything queued to go out, and when?"
 *
 * A manager can see what is DUE but not what PropLane is about to send about it. That is the
 * difference between "I should chase this" and "a reminder goes out tomorrow, leave it alone" —
 * and getting it wrong means chasing a resident PropLane is already chasing.
 *
 * The direction that matters: this must never claim a send is coming when it is not. A missing
 * badge costs a manager one extra look; a phantom one stops them chasing a resident nobody is
 * going to contact.
 */
import { describe, expect, it } from "vitest";
import { scheduledSendBadgeLabel, summariseScheduledSends } from "@/lib/scheduled-send-summary";

const NOW = Date.parse("2026-08-26T12:00:00Z");
const at = (iso: string, status = "scheduled") => ({ sendAt: iso, status });

describe("summariseScheduledSends", () => {
  it("counts queued sends and reports the soonest", () => {
    const summary = summariseScheduledSends(
      [
        at("2026-08-30T09:00:00Z"),
        at("2026-08-28T09:00:00Z"),
        at("2026-09-05T09:00:00Z"),
      ],
      NOW,
    );
    expect(summary.count).toBe(3);
    expect(summary.nextSendAt).toBe("2026-08-28T09:00:00Z");
  });

  it("ignores a send whose moment has passed", () => {
    // The sweep may not have run yet, so a past row can still say "scheduled". Announcing it
    // would promise a reminder that is never coming.
    const summary = summariseScheduledSends([at("2026-08-25T09:00:00Z")], NOW);
    expect(summary).toEqual({ count: 0, nextSendAt: null });
  });

  it("ignores cancelled and sent messages", () => {
    const summary = summariseScheduledSends(
      [
        at("2026-08-30T09:00:00Z", "cancelled"),
        at("2026-08-30T09:00:00Z", "sent"),
        at("2026-08-30T09:00:00Z"),
      ],
      NOW,
    );
    expect(summary.count).toBe(1);
  });

  it("treats a missing status as scheduled", () => {
    // Tour reminders carry no status field; they exist only while queued.
    expect(summariseScheduledSends([{ sendAt: "2026-08-30T09:00:00Z" }], NOW).count).toBe(1);
  });

  it("ignores an unparseable send time rather than counting it", () => {
    expect(summariseScheduledSends([at("not-a-date"), at("")], NOW)).toEqual({
      count: 0,
      nextSendAt: null,
    });
  });

  it("reports nothing for an empty list", () => {
    expect(summariseScheduledSends([], NOW)).toEqual({ count: 0, nextSendAt: null });
  });

  it("does not count a send at exactly now", () => {
    // Its moment has arrived; it is going out, not queued.
    expect(summariseScheduledSends([at(new Date(NOW).toISOString())], NOW).count).toBe(0);
  });
});

describe("scheduledSendBadgeLabel", () => {
  it("returns null when nothing is queued, so no empty badge renders", () => {
    expect(scheduledSendBadgeLabel({ count: 0, nextSendAt: null })).toBeNull();
  });

  it("gets the singular and plural right", () => {
    expect(scheduledSendBadgeLabel({ count: 1, nextSendAt: "x" })).toBe("1 reminder scheduled");
    expect(scheduledSendBadgeLabel({ count: 4, nextSendAt: "x" })).toBe("4 reminders scheduled");
  });

  it("accepts a different noun for other surfaces", () => {
    expect(scheduledSendBadgeLabel({ count: 2, nextSendAt: "x" }, "notification")).toBe(
      "2 notifications scheduled",
    );
  });
});
