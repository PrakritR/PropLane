// @vitest-environment jsdom
//
// EVIDENCE HARNESS for the calendar + Tasks half of the Oct 3-4 round
// (studio plan claude-2/services-vendors-1004, area 3): Agenda rows that open
// the service / tour / task with no colour dots, and Tasks on the same four
// stages as Services (Open · Assigned · Scheduled · Completed).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { CalendarAgendaView, meetingToGridItems, type CalendarGridItem } from "@/components/portal/manager-calendar-views";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
function capture(name: string) {
  if (!EVIDENCE_DIR) return;
  captured.push({ name, html: document.body.innerHTML });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
});

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: "/portal/tasks" } }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => {
  const appUi = { showToast: () => {} };
  return { useAppUi: () => appUi, useConfirm: () => () => Promise.resolve(true) };
});
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [], ready: true }),
}));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-admin-scheduling")>()),
  formatRangeLabel: () => "Tomorrow",
  syncScheduleRecordsFromServer: () => Promise.resolve(true),
  formatAvailabilitySlotLabel: (slot: number) => `slot ${slot}`,
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  syncPropertyPipelineFromServer: () => Promise.resolve(true),
}));
vi.mock("@/lib/manager-portfolio-access", () => ({ buildManagerPropertyFilterOptions: () => [] }));
const tasks: unknown[] = [];
vi.mock("@/lib/manager-tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-tasks")>()),
  MANAGER_TASKS_EVENT: "manager-tasks-changed",
  fetchManagerTasks: () => Promise.resolve(tasks),
  createManagerTask: vi.fn(),
  updateManagerTask: vi.fn(),
  deleteManagerTask: vi.fn(),
  reapplyManagerTasksToCalendar: vi.fn(),
}));
vi.mock("@/lib/service-requests-storage", () => ({
  SERVICE_REQUESTS_EVENT: "axis:service-requests",
  syncServiceRequestsFromServer: () => Promise.resolve([]),
}));
vi.mock("@/components/portal/pro-task-form-modal", () => ({ ManagerTaskFormModal: () => null }));

afterEach(() => { tasks.length = 0; cleanup(); });

const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

function meeting(partial: Partial<DemoMeeting> & { id: string; startIso: string; dateStr: string }): DemoMeeting {
  const start = new Date(partial.startIso);
  return {
    source: "planned",
    sourceId: partial.id,
    endIso: new Date(start.getTime() + (partial.durationMinutes ?? 30) * 60000).toISOString(),
    startSlot: start.getHours() * 2 + (start.getMinutes() >= 30 ? 1 : 0),
    span: 1,
    durationMinutes: 30,
    title: "Tour · Casey Reyes",
    color: "",
    propertyTitle: "Alder House",
    kind: "tour",
    ...partial,
  };
}

describe("the Calendar's Agenda", () => {
  it("groups the week by day, one row per record, each with its own ⋯ and no colour dot", () => {
    const items: CalendarGridItem[] = [
      meeting({ id: "t1", startIso: "2026-09-26T10:00:00", dateStr: "2026-09-26" }),
      meeting({
        id: "s1", startIso: "2026-09-25T13:00:00", dateStr: "2026-09-25", kind: "service",
        title: "Vendor visit — Closet door", durationMinutes: 90, source: "external",
      }),
      meeting({
        id: "k1", startIso: "2026-09-26T09:00:00", dateStr: "2026-09-26", kind: "task",
        title: "Post September rent notice", allDay: true,
      }),
    ].flatMap(meetingToGridItems);
    render(
      <CalendarAgendaView dates={WEEK} items={items} todayDs="2026-09-24" onOpenItem={() => {}} onRescheduleTour={() => {}} />,
    );
    expect(document.querySelectorAll('[data-attr="calendar-agenda-row"]')).toHaveLength(3);
    expect(document.querySelectorAll('[data-attr="calendar-agenda-row-menu"]')).toHaveLength(3);
    capture("calendar-agenda");
  });
});

describe("the Tasks list", () => {
  it("is the Services list: Open · Assigned · Scheduled · Completed with rows and record menus", async () => {
    const { ManagerTaskList } = await import("@/components/portal/pro-task-list");
    tasks.push(
      { id: "task-1", title: "Fix the porch light", propertyId: "prop-1", propertyTitle: "12 Maple St", completed: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "task-2", title: "Post September rent notice", propertyId: "prop-1", propertyTitle: "12 Maple St", completed: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
    );
    render(<ManagerTaskList tabId="open" basePath="/portal" />);
    await waitFor(() => expect(screen.getByText("Fix the porch light")).toBeTruthy());
    for (const label of ["Open", "Assigned", "Scheduled", "Completed"]) {
      expect(screen.getByRole("link", { name: new RegExp(`^${label}`, "i") })).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: /Overdue/i })).toBeNull();
    capture("tasks-list-open");
  });
});
