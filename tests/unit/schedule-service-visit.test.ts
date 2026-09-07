import { describe, expect, it } from "vitest";
import {
  buildManagerVisitScheduledNotice,
  formatServiceVisitLabel,
  visitEndIso,
} from "@/lib/schedule-service-visit";
import { scheduledTaskTitleForWorkOrder } from "@/lib/manager-scheduled-work-tasks";

describe("schedule-service-visit helpers", () => {
  it("builds a manager inbox notice with assignee and when", () => {
    const notice = buildManagerVisitScheduledNotice({
      title: "Leaky faucet",
      scheduledLabel: "Sep 8, 10:00 AM",
      assigneeName: "Ace Plumbing",
      propertyLabel: "Lakeview Studio",
      residentName: "Test Resident",
    });
    expect(notice.subject).toBe("Visit scheduled: Leaky faucet");
    expect(notice.text).toContain("When: Sep 8, 10:00 AM");
    expect(notice.text).toContain("Assigned to: Ace Plumbing");
    expect(notice.text).toContain("Property: Lakeview Studio");
    expect(notice.text).toContain("Resident: Test Resident");
  });

  it("adds a one-hour end time for the calendar task slot", () => {
    expect(visitEndIso("2026-09-08T17:00:00.000Z")).toBe("2026-09-08T18:00:00.000Z");
  });

  it("formats a readable visit label", () => {
    const label = formatServiceVisitLabel("2026-09-08T17:00:00.000Z");
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe("2026-09-08T17:00:00.000Z");
  });

  it("prefixes service task titles consistently", () => {
    expect(scheduledTaskTitleForWorkOrder("Leaky faucet")).toBe("Service · Leaky faucet");
    expect(scheduledTaskTitleForWorkOrder("Service · Already")).toBe("Service · Already");
  });
});
