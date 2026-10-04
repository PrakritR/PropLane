import { describe, expect, it } from "vitest";
import {
  calendarRecordHref,
  calendarTourBucket,
  meetingRecordHref,
  meetingRecordTarget,
} from "@/lib/calendar-item-href";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";

const NOW = Date.parse("2026-10-04T12:00:00Z");

function meeting(over: Partial<DemoMeeting>): DemoMeeting {
  return {
    id: "m1",
    source: "planned",
    sourceId: "src-1",
    startIso: "2026-10-08T16:00:00Z",
    endIso: "2026-10-08T17:00:00Z",
    dateStr: "2026-10-08",
    startSlot: 18,
    span: 2,
    durationMinutes: 60,
    title: "Item",
    color: "",
    ...over,
  } as DemoMeeting;
}

describe("calendarRecordHref - one builder per record kind", () => {
  it("builds each kind's own href", () => {
    expect(calendarRecordHref("/portal", { kind: "work-order", id: "wo 1", bucket: "scheduled" })).toBe("/portal/services/work-orders/scheduled/wo%201");
    expect(calendarRecordHref("/portal", { kind: "service-request", id: "sr1", bucket: "approved" })).toBe("/portal/services/requests/approved/sr1");
    expect(calendarRecordHref("/portal", { kind: "tour", id: "t1", bucket: "upcoming" })).toBe("/portal/tours/upcoming/t1");
    expect(calendarRecordHref("/portal", { kind: "task", id: "k1", tab: "assigned" })).toBe("/portal/tasks/assigned/k1");
    expect(calendarRecordHref("/portal", { kind: "booking", id: "bk|1" })).toBe("/portal/bookings/bk%7C1/overview");
  });
});

describe("meetingRecordHref", () => {
  it("a service opens its work order with the bucket read from the row", () => {
    const m = meeting({ id: "manager-service-wo1", source: "external", sourceId: "wo1", kind: "service" });
    expect(meetingRecordHref("/portal", m, { workOrderBucket: () => "scheduled" }, NOW)).toBe("/portal/services/work-orders/scheduled/wo1");
    expect(meetingRecordHref("/portal", m, { workOrderBucket: () => "open" }, NOW)).toBe("/portal/services/work-orders/open/wo1");
  });

  it("an add-on service opens its request when no work order matches", () => {
    const m = meeting({ id: "manager-service-sr1", source: "external", sourceId: "sr1", kind: "service" });
    expect(meetingRecordHref("/portal", m, { serviceRequestBucket: () => "approved" }, NOW)).toBe("/portal/services/requests/approved/sr1");
  });

  it("a service whose bucket cannot be resolved falls back to the dialog (null), never a dead link", () => {
    const m = meeting({ id: "manager-service-gone", source: "external", sourceId: "gone", kind: "service" });
    expect(meetingRecordHref("/portal", m, {}, NOW)).toBeNull();
    expect(meetingRecordHref("/portal", m, { workOrderBucket: () => undefined }, NOW)).toBeNull();
  });

  it("a Google service event has no record", () => {
    expect(meetingRecordHref("/portal", meeting({ id: "google_x", source: "external", kind: "service" }), { workOrderBucket: () => "open" }, NOW)).toBeNull();
  });

  it("a tour opens by its stage: pending inquiry, upcoming, past", () => {
    expect(meetingRecordHref("/portal", meeting({ kind: "tour", source: "inquiry", sourceId: "i1" }), {}, NOW)).toBe("/portal/tours/pending/i1");
    expect(meetingRecordHref("/portal", meeting({ kind: "tour" }), {}, NOW)).toBe("/portal/tours/upcoming/src-1");
    expect(calendarTourBucket({ source: "planned", endIso: "2026-10-01T10:00:00Z" }, NOW)).toBe("past");
    expect(meetingRecordHref("/portal", meeting({ kind: "partner" }), {}, NOW)).toBe("/portal/tours/upcoming/src-1");
  });

  it("a Google tour event has no record", () => {
    expect(meetingRecordHref("/portal", meeting({ kind: "tour", source: "external" }), {}, NOW)).toBeNull();
  });

  it("a task opens on the tab it sits on, Open when unknown", () => {
    const m = meeting({ kind: "task", sourceTaskId: "k1" });
    expect(meetingRecordHref("/portal", m, { taskTab: () => "scheduled" }, NOW)).toBe("/portal/tasks/scheduled/k1");
    expect(meetingRecordHref("/portal", m, {}, NOW)).toBe("/portal/tasks/open/k1");
    expect(meetingRecordHref("/portal", meeting({ kind: "task" }), {}, NOW)).toBeNull();
  });

  it("personal Google busy time has no record", () => {
    expect(meetingRecordTarget(meeting({ googleCalendarPrivate: true, kind: "tour" }), {}, NOW)).toBeNull();
  });
});
