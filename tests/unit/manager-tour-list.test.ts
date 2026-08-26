import { describe, expect, it } from "vitest";
import {
  buildManagerTourRows,
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
