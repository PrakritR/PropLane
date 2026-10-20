import { describe, expect, it } from "vitest";
import { remindableTours } from "@/lib/reminders/subjects/tours.server";
import type { PlannedEvent } from "@/lib/demo-admin-scheduling";

const now = new Date("2026-10-19T12:00:00Z");
const base = { id: "t1", kind: "tour", title: "Tour", start: "2026-10-22T16:00:00Z", end: "2026-10-22T16:30:00Z", managerUserId: "mgr-1" } as unknown as PlannedEvent;

describe("which tours get a manager reminder", () => {
  it("includes a tour booked by text, where the guest has a phone and no email", () => {
    expect(remindableTours([{ ...base, attendeePhone: "+12065550142" } as PlannedEvent], now)).toHaveLength(1);
  });

  it("still includes a tour with an email", () => {
    expect(remindableTours([{ ...base, attendeeEmail: "guest@example.com" } as PlannedEvent], now)).toHaveLength(1);
  });

  it("leaves out a tour with no way to reach the guest", () => {
    expect(remindableTours([base], now)).toHaveLength(0);
    expect(remindableTours([{ ...base, attendeePhone: "123" } as PlannedEvent], now)).toHaveLength(0);
  });
});
