import { describe, expect, it } from "vitest";
import {
  buildManagerTourRows,
  countManagerTourRowsByBucket,
  filterManagerTourRows,
} from "@/lib/manager-tour-list";

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
});
