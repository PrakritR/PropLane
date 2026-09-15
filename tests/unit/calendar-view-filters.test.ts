/**
 * Each Calendar view keeps only its kind (PLAN-0914-1710): a task never shows
 * on Tours, a tour never on Tasks, Google busy time only on All. The counts
 * on the tabs and the grid read the same filtered list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PORTAL_EMPTY_COPY } from "@/lib/portal-empty-copy";

const src = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");

describe("calendar views", () => {
  it("filters planned meetings by kind per view and shows busy time on All only", () => {
    expect(src).toContain('if (calendarView === "tours") return (meeting) => meeting.kind !== "task";');
    expect(src).toContain('if (calendarView === "tasks") return (meeting) => meeting.kind === "task";');
    expect(src).toMatch(/showGoogleBusy = portal === "manager" && \(schedulingHub \? availabilityView : calendarView === "all"\)/);
    expect(src).toContain('calendarView === "all" || calendarView === "services"');
  });

  it("counts tours and tasks apart from the same planned list the grid draws", () => {
    expect(src).toContain('plannedInWeek.filter((meeting) => meeting.kind !== "task").length');
    expect(src).toContain("return { all: tours + tasks + services, tours, tasks, bookings: 0, services };");
  });

  it("single-kind views read only; availability is edited on All and Tours", () => {
    expect(src).toContain("const calendarPanelsReadOnly = servicesOnlyView || tasksOnlyView;");
    expect(src).toContain('calendarView === "all" || calendarView === "tours"');
  });

  it("has an empty title for every view", () => {
    for (const view of ["all", "tours", "services", "tasks"] as const) {
      expect(PORTAL_EMPTY_COPY[`calendar.${view}`].title).toMatch(/week$/);
    }
  });

  it("Google Calendar is a glyph with a connection dot", () => {
    const dialog = readFileSync(join(process.cwd(), "src/components/portal/google-calendar-connect-dialog.tsx"), "utf8");
    expect(dialog).toContain("<PortalIconAction");
    expect(dialog).toContain('badge={connected === true ? "ok" : connected === false ? "warn" : null}');
    expect(dialog).not.toContain(">\n        Google Calendar\n      </Button>");
  });
});
