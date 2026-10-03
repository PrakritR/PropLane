import { describe, expect, it } from "vitest";
import {
  buildRescheduleDayOptions,
  buildRescheduleTimeOptions,
  slotHostsForReschedule,
} from "@/lib/tour-reschedule-slot-picker";

describe("tour reschedule slot picker", () => {
  it("marks days with no open slots disabled", () => {
    const hosts = slotHostsForReschedule(
      { "2026-10-07:20": [{ userId: "mgr-1", label: "Alex" }] },
      "2026-10-07T17:00:00.000Z",
    );
    const days = buildRescheduleDayOptions({
      slotHosts: hosts,
      currentStartIso: "2026-10-07T17:00:00.000Z",
      maxDays: 5,
    });
    const open = days.filter((d) => !d.disabled);
    expect(open.some((d) => d.value === "2026-10-07")).toBe(true);
    expect(days.some((d) => d.disabled && d.label.includes("No open times"))).toBe(true);
  });

  it("offers half-hour slots for a day with availability", () => {
    const hosts = {
      "2026-10-07:20": [{ userId: "mgr-1", label: "Alex" }],
      "2026-10-07:21": [{ userId: "mgr-1", label: "Alex" }],
    };
    const { options } = buildRescheduleTimeOptions({
      slotHosts: hosts,
      dayYmd: "2026-10-07",
      currentStartIso: "2026-10-07T17:00:00.000Z",
      durationMinutes: 30,
    });
    expect(options.length).toBe(2);
  });
});
