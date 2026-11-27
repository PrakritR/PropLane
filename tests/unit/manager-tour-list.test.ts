import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManagerTourRows,
  tourRowsFromInquiries,
  countManagerTourRowsByBucket,
  filterManagerTourRows,
  sortManagerTourClustersForBucket,
  sortManagerTourRowsForBucket,
  tourReminderSummaryForCluster,
  tourReminderSummaryForRow,
  type ManagerTourListCluster,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { scheduledSendBadgeLabel } from "@/lib/scheduled-send-summary";

const baseRow = (
  overrides: Partial<ManagerTourRow> & Pick<ManagerTourRow, "id" | "startMs" | "bucket">,
): ManagerTourRow => ({
  source: "planned",
  sourceId: "plan-1",
  guestName: "Alex Kim",
  guestEmail: "alex@example.com",
  guestPhone: "",
  propertyTitle: "Oak House",
  propertyId: "prop-1",
  whenLabel: "Aug 3, 2:00 PM",
  startIso: "2026-08-03T21:00:00.000Z",
  endIso: "2026-08-03T21:30:00.000Z",
  endMs: 2,
  statusLabel: "Confirmed",
  tourFormat: "in_person",
  ...overrides,
});

describe("manager-tour-list", () => {
  it("buckets pending inquiries separately from confirmed tours", () => {
    const rows = buildManagerTourRows({ viewerUserId: "mgr-1", propertyIds: [] });
    const counts = countManagerTourRowsByBucket(rows);
    expect(counts.pending + counts.upcoming + counts.past).toBe(rows.length);
    for (const row of rows) {
      expect(["pending", "upcoming", "past"]).toContain(row.bucket);
    }
  });

  it("filters by bucket, property, and search", () => {
    const rows = [
      {
        id: "a",
        source: "inquiry" as const,
        sourceId: "inq-1",
        guestName: "Alex Kim",
        guestEmail: "alex@example.com",
        guestPhone: "",
        propertyTitle: "Oak House",
        propertyId: "prop-1",
        whenLabel: "Aug 3, 2:00 PM",
        startIso: "2026-08-03T21:00:00.000Z",
        endIso: "2026-08-03T21:30:00.000Z",
        startMs: 1,
        endMs: 2,
        statusLabel: "Pending",
        bucket: "pending" as const,
      },
      {
        id: "b",
        source: "planned" as const,
        sourceId: "plan-1",
        guestName: "Jamie Lee",
        guestEmail: "jamie@example.com",
        guestPhone: "",
        propertyTitle: "Pine House",
        propertyId: "prop-2",
        whenLabel: "Aug 4, 2:00 PM",
        startIso: "2026-08-04T21:00:00.000Z",
        endIso: "2026-08-04T21:30:00.000Z",
        startMs: 3,
        endMs: 4,
        statusLabel: "Confirmed",
        bucket: "upcoming" as const,
      },
    ];

    expect(filterManagerTourRows(rows, "pending", [], "").map((row) => row.id)).toEqual(["a"]);
    expect(filterManagerTourRows(rows, "upcoming", ["prop-2"], "").map((row) => row.id)).toEqual(["b"]);
    expect(filterManagerTourRows(rows, "upcoming", [], "pine").map((row) => row.id)).toEqual(["b"]);
  });

  it("sorts upcoming tours soonest-first within and across resident clusters", () => {
    const rows = [
      baseRow({ id: "late", startMs: 300, bucket: "upcoming", sourceId: "plan-late" }),
      baseRow({ id: "soon", startMs: 100, bucket: "upcoming", sourceId: "plan-soon" }),
    ];
    expect(sortManagerTourRowsForBucket(rows, "upcoming").map((row) => row.id)).toEqual([
      "soon",
      "late",
    ]);

    const clusters: ManagerTourListCluster[] = [
      {
        key: "a",
        residentLabel: "Alex Kim",
        residentEmail: "alex@example.com",
        propertyLabel: "Oak House",
        rows: [baseRow({ id: "a-late", startMs: 400, bucket: "upcoming", sourceId: "a-late" })],
      },
      {
        key: "b",
        residentLabel: "Jamie Lee",
        residentEmail: "jamie@example.com",
        propertyLabel: "Pine House",
        rows: [baseRow({ id: "b-soon", startMs: 50, bucket: "upcoming", sourceId: "b-soon" })],
      },
    ];
    expect(
      sortManagerTourClustersForBucket(clusters, "upcoming").map((cluster) => cluster.key),
    ).toEqual(["b", "a"]);
  });

  it("summarises scheduled tour reminders for rows and clusters", () => {
    const row = baseRow({ id: "planned-1", sourceId: "evt-1", bucket: "upcoming" });
    const reminders = [
      {
        id: "msg-1",
        sendAt: new Date(Date.now() + 60_000).toISOString(),
        status: "scheduled",
        tourPlannedEventId: "evt-1",
      },
    ] as ScheduledInboxMessageRecord[];

    expect(scheduledSendBadgeLabel(tourReminderSummaryForRow(row, reminders))).toBe(
      "1 reminder scheduled",
    );

    const cluster: ManagerTourListCluster = {
      key: "alex",
      residentLabel: "Alex Kim",
      residentEmail: "alex@example.com",
      propertyLabel: "Oak House",
      rows: [row],
    };
    expect(scheduledSendBadgeLabel(tourReminderSummaryForCluster(cluster, reminders))).toBe(
      "1 reminder scheduled",
    );
    expect(
      scheduledSendBadgeLabel(
        tourReminderSummaryForRow(
          baseRow({ id: "inq", source: "inquiry", sourceId: "inq-1", bucket: "pending" }),
          reminders,
        ),
      ),
    ).toBeNull();
  });
});

describe("a pending tour whose time has passed leaves Pending", () => {
  const inquiry = (id: string, windows: Array<{ start: string; end: string }>) =>
    ({
      id,
      kind: "tour",
      status: "pending",
      name: "Alex Kim",
      email: "alex@example.com",
      phone: "",
      propertyTitle: "Oak House",
      proposedStart: windows[0]!.start,
      proposedEnd: windows[0]!.end,
      requestedWindows: windows,
    }) as never;

  afterEach(() => vi.useRealTimers());

  it("moves an unanswered, fully elapsed request to Past as Expired; future ones stay Pending", () => {
    // Nov 27, 2026 9:00 AM Pacific.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T17:00:00.000Z"));
    const rows = tourRowsFromInquiries([
      inquiry("old", [{ start: "2026-11-21T18:00:00.000Z", end: "2026-11-21T18:30:00.000Z" }]),
      inquiry("today", [{ start: "2026-11-27T19:00:00.000Z", end: "2026-11-27T19:30:00.000Z" }]),
      inquiry("mixed", [
        { start: "2026-11-24T18:00:00.000Z", end: "2026-11-24T18:30:00.000Z" },
        { start: "2026-11-30T18:00:00.000Z", end: "2026-11-30T18:30:00.000Z" },
      ]),
    ]);
    const byInquiry = (id: string) => rows.filter((r) => r.sourceId === id);
    expect(byInquiry("old").map((r) => [r.bucket, r.statusLabel])).toEqual([["past", "Expired"]]);
    expect(byInquiry("today").map((r) => r.bucket)).toEqual(["pending"]);
    expect(byInquiry("mixed").map((r) => r.bucket)).toEqual(["pending", "pending"]);
    expect(countManagerTourRowsByBucket(rows)).toEqual({ pending: 3, upcoming: 0, past: 1 });
  });

  it("keeps a request Pending inside the 30 minute grace after its window ends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T19:40:00.000Z"));
    const rows = tourRowsFromInquiries([
      inquiry("just-ended", [{ start: "2026-11-27T19:00:00.000Z", end: "2026-11-27T19:30:00.000Z" }]),
    ]);
    expect(rows[0]!.bucket).toBe("pending");
    vi.setSystemTime(new Date("2026-11-27T20:01:00.000Z"));
    expect(
      tourRowsFromInquiries([
        inquiry("just-ended", [{ start: "2026-11-27T19:00:00.000Z", end: "2026-11-27T19:30:00.000Z" }]),
      ])[0]!.bucket,
    ).toBe("past");
  });
});
