import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calendarMeetingMatchesQuery } from "@/lib/manager-calendar-tour-meetings";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";

function meeting(overrides: Partial<DemoMeeting> = {}): DemoMeeting {
  return {
    id: "m1",
    source: "planned",
    sourceId: "src-1",
    startIso: "2026-09-16T17:00:00.000Z",
    endIso: "2026-09-16T17:30:00.000Z",
    dateStr: "2026-09-16",
    startSlot: 16,
    span: 1,
    durationMinutes: 30,
    title: "Tour · 5257 Brooklyn",
    color: "#2863f0",
    name: "Ambika Mago",
    email: "ambika@example.com",
    propertyTitle: "5257 Brooklyn Ave NE",
    kind: "tour",
    ...overrides,
  };
}

describe("calendarMeetingMatchesQuery", () => {
  it("keeps every meeting when the query is empty", () => {
    expect(calendarMeetingMatchesQuery(meeting(), "")).toBe(true);
    expect(calendarMeetingMatchesQuery(meeting(), "   ")).toBe(true);
  });

  it("matches title, guest, house, and kind", () => {
    const row = meeting();
    expect(calendarMeetingMatchesQuery(row, "brooklyn")).toBe(true);
    expect(calendarMeetingMatchesQuery(row, "ambika")).toBe(true);
    expect(calendarMeetingMatchesQuery(row, "TOUR")).toBe(true);
    expect(calendarMeetingMatchesQuery(row, "leak")).toBe(false);
  });
});

describe("Add task workspace", () => {
  it("keeps Title and Schedule in the shared stepped workspace", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-task-form-modal.tsx"), "utf8");
    expect(src).toContain("AddWorkspace");
    expect(src).not.toContain("PORTAL_MODAL_BODY_SCROLL_CLASS");
    expect(src).toContain('id="manager-task-title"');
    expect(src).toContain('id="manager-task-schedule-date"');
    expect(src).toContain("<AddWorkspace");
    expect(src).toContain('id: "when"');
    expect(src).toContain('htmlFor="manager-task-title"');
    expect(src).toContain('aria-label="Schedule date"');
  });
});
