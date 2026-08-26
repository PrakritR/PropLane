import { describe, expect, it } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  clusterManagerLeaseListRows,
  leaseRowSortMs,
  sortManagerLeaseClustersForBucket,
  sortManagerLeaseRowsForBucket,
} from "@/lib/manager-lease-list";

function row(
  overrides: Partial<LeasePipelineRow> & Pick<LeasePipelineRow, "id" | "residentName" | "residentEmail">,
): LeasePipelineRow {
  return {
    unit: "5257 Brooklyn Ave NE · Room 1",
    stageLabel: "Manager Review",
    status: "Manager Review",
    updated: "Aug 12",
    updatedAtIso: "2026-08-12T18:00:00.000Z",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    thread: [],
    ...overrides,
  } as LeasePipelineRow;
}

describe("manager-lease-list", () => {
  it("clusters leases by resident email like tours", () => {
    const rows = [
      row({ id: "lease-1", residentName: "Alex Kim", residentEmail: "alex@example.com" }),
      row({
        id: "lease-2",
        residentName: "Alex Kim",
        residentEmail: "alex@example.com",
        unit: "4709A 8th Ave NE · Room 2",
      }),
      row({ id: "lease-3", residentName: "Jamie Lee", residentEmail: "jamie@example.com" }),
    ];
    const clusters = clusterManagerLeaseListRows(rows);
    expect(clusters).toHaveLength(2);
    const alex = clusters.find((cluster) => cluster.residentEmail === "alex@example.com");
    expect(alex?.rows).toHaveLength(2);
  });

  it("sorts active pipeline tabs oldest first and signed newest first", () => {
    const older = row({
      id: "lease-old",
      residentName: "Older Resident",
      residentEmail: "older@example.com",
      updatedAtIso: "2026-01-01T12:00:00.000Z",
    });
    const newer = row({
      id: "lease-new",
      residentName: "Newer Resident",
      residentEmail: "newer@example.com",
      updatedAtIso: "2026-02-01T12:00:00.000Z",
    });

    expect(sortManagerLeaseRowsForBucket([newer, older], "manager").map((entry) => entry.id)).toEqual([
      "lease-old",
      "lease-new",
    ]);
    expect(sortManagerLeaseRowsForBucket([older, newer], "completed").map((entry) => entry.id)).toEqual([
      "lease-new",
      "lease-old",
    ]);

    const clusters = sortManagerLeaseClustersForBucket(
      clusterManagerLeaseListRows([newer, older]),
      "manager",
    );
    expect(clusters.map((cluster) => cluster.rows[0]?.id)).toEqual(["lease-old", "lease-new"]);
    expect(leaseRowSortMs(newer)).toBeGreaterThan(leaseRowSortMs(older));
  });
});
