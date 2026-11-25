/**
 * @vitest-environment jsdom
 *
 * A prospect may propose several tour windows, and the Tours list files each one as its own row. Clicking the
 * Wednesday block in the manager Calendar has to open the WEDNESDAY row - the agenda's ⋯ → Reschedule then offers
 * a new time against the window the prospect actually asked for.
 *
 * Oracle: `tourRowsFromInquiries`, the Tours list's own row builder, which is what the detail view resolves by.
 * Plausible wrong behaviour this rejects: re-deriving the link from the inquiry id with window index 0, so every
 * block of a multi-window request opens the first window's row.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildScheduledTourMeetings } from "@/lib/manager-calendar-tour-meetings";
import { meetingRecordHref } from "@/lib/calendar-item-href";
import { tourRowsFromInquiries } from "@/lib/manager-tour-list";
import type { PartnerInquiry } from "@/lib/demo-admin-scheduling";

const VIEWER = "mgr-windows";
const WINDOWS = [
  { start: "2030-03-04T18:00:00.000Z", end: "2030-03-04T18:30:00.000Z" },
  { start: "2030-03-06T00:00:00.000Z", end: "2030-03-06T00:30:00.000Z" },
  { start: "2030-03-08T17:00:00.000Z", end: "2030-03-08T17:30:00.000Z" },
];

const inquiry = {
  id: "inq-3-windows",
  kind: "tour",
  status: "pending",
  name: "Ana Ruiz",
  email: "ana@example.com",
  propertyId: "house-1",
  propertyTitle: "5257 Brooklyn",
  managerUserId: VIEWER,
  requestedWindows: WINDOWS,
  createdAt: "2030-02-01T00:00:00.000Z",
} as unknown as PartnerInquiry;

beforeEach(() => {
  window.sessionStorage.clear();
  // The schedule store's own session cache, which `readPartnerInquiries` reads before any server sync.
  window.sessionStorage.setItem("axis_sched_cache_v1:axis_admin_partner_inquiries_v1", JSON.stringify([inquiry]));
});

describe("a calendar block of a request the free/busy projection stripped", () => {
  it("still carries a title", () => {
    const nameless = { ...(inquiry as unknown as Record<string, unknown>) };
    delete nameless.name;
    window.sessionStorage.setItem(
      "axis_sched_cache_v1:axis_admin_partner_inquiries_v1",
      JSON.stringify([nameless]),
    );
    const meetings = buildScheduledTourMeetings({ viewerUserId: VIEWER, propertyId: null, peers: [] }, null);
    expect(meetings).toHaveLength(3);
    for (const meeting of meetings) {
      expect(meeting.title).toBe("Tour · Tour request");
      expect(meeting.name).toBe("Tour request");
    }
  });
});

describe("a calendar block of a multi-window tour request", () => {
  it("opens the window that was clicked, not the first one", () => {
    const rows = tourRowsFromInquiries([inquiry]);
    expect(rows).toHaveLength(3);
    const meetings = buildScheduledTourMeetings({ viewerUserId: VIEWER, propertyId: null, peers: [] }, null).filter(
      (meeting) => meeting.source === "inquiry",
    );
    expect(meetings).toHaveLength(3);

    for (const [index, window] of WINDOWS.entries()) {
      const meeting = meetings.find((m) => m.startIso === window.start)!;
      expect(meeting, `meeting for window ${index}`).toBeTruthy();
      expect(meetingRecordHref("/portal", meeting, {}, Date.parse("2030-02-10T00:00:00Z"))).toBe(
        `/portal/tours/pending/${rows[index]!.id}`,
      );
    }
  });
});
