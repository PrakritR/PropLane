import { describe, expect, it } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  clusterManagerLeaseListRows,
  leaseGroupedRowPrimary,
  leaseRowPlaceLine,
  leaseRowSortMs,
  leaseStageFact,
  leaseUpdatedShort,
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

  it("compacts grouped row primary when property is already in the cluster header", () => {
    const duplicateAddress = row({
      id: "lease-dup",
      residentName: "Alex Kim",
      residentEmail: "alex@example.com",
      unit: "5259 Brooklyn Ave NE · 9 rooms · 5259 Brooklyn Ave NE",
    });
    expect(leaseGroupedRowPrimary(duplicateAddress, "5259 Brooklyn Ave NE · 9 rooms")).toBe(
      "9 rooms",
    );

    const withRoom = row({
      id: "lease-room",
      residentName: "Alex Kim",
      residentEmail: "alex@example.com",
      unit: "5259 Brooklyn Ave NE · 9 rooms · Room 8",
    });
    expect(leaseGroupedRowPrimary(withRoom, "5259 Brooklyn Ave NE · 9 rooms")).toBe("Room 8");
  });

  it("draws the card's place line as property · room, never repeating either", () => {
    const withRoom = row({ id: "l1", residentName: "Alex Kim", residentEmail: "alex@example.com", unit: "5259 Brooklyn Ave NE · 9 rooms · Room 8" });
    expect(leaseRowPlaceLine(withRoom)).toBe("5259 Brooklyn Ave NE · Room 8");

    const propertyOnly = row({ id: "l2", residentName: "Alex Kim", residentEmail: "alex@example.com", unit: "5259 Brooklyn Ave NE · 9 rooms · 5259 Brooklyn Ave NE" });
    expect(leaseRowPlaceLine(propertyOnly)).toBe("5259 Brooklyn Ave NE");

    const plain = row({ id: "l3", residentName: "Alex Kim", residentEmail: "alex@example.com" });
    expect(leaseRowPlaceLine(plain)).toBe("5257 Brooklyn Ave NE · Room 1");

    const noUnit = row({ id: "l4", residentName: "Alex Kim", residentEmail: "alex@example.com", unit: "" });
    expect(leaseRowPlaceLine(noUnit)).toBe("—");
  });

  it("gives the stage as plain text with no tone", () => {
    expect(leaseStageFact(row({ id: "s1", residentName: "A", residentEmail: "a@x.com" }))).toBe("Manager Review");
    expect(leaseStageFact(row({ id: "s2", residentName: "A", residentEmail: "a@x.com", stageLabel: "", status: "Draft" } as Partial<LeasePipelineRow> & Pick<LeasePipelineRow, "id" | "residentName" | "residentEmail">))).toBe("Draft");
    expect(leaseStageFact(row({ id: "s3", residentName: "A", residentEmail: "a@x.com", stageLabel: "", status: "" } as Partial<LeasePipelineRow> & Pick<LeasePipelineRow, "id" | "residentName" | "residentEmail">))).toBeUndefined();
  });

  it("formats the update stamp as a short date, never an ISO string", () => {
    const now = new Date(2026, 8, 20, 12);
    const thisYear = row({ id: "u1", residentName: "A", residentEmail: "a@x.com", updatedAtIso: "2026-09-18T18:00:00.000Z", updated: "2026-09-18T18:00:00.000Z" });
    expect(leaseUpdatedShort(thisYear, now)).toBe("Updated Sep 18");

    const lastYear = row({ id: "u2", residentName: "A", residentEmail: "a@x.com", updatedAtIso: "2025-03-04T18:00:00.000Z" });
    expect(leaseUpdatedShort(lastYear, now)).toBe("Updated Mar 4, 2025");

    // No parseable stamp: the row's own short text, but an ISO-looking one is never printed.
    const textOnly = row({ id: "u3", residentName: "A", residentEmail: "a@x.com", updatedAtIso: "", updated: "Aug 12" });
    expect(leaseUpdatedShort(textOnly, now)).toBe("Updated Aug 12");
    const isoOnly = row({ id: "u4", residentName: "A", residentEmail: "a@x.com", updatedAtIso: "", updated: "2026-08-12T18:00:00.000Z" });
    expect(leaseUpdatedShort(isoOnly, now)).toBe("Updated Aug 12");
    const nothing = row({ id: "u5", residentName: "A", residentEmail: "a@x.com", updatedAtIso: "", updated: "" });
    expect(leaseUpdatedShort(nothing, now)).toBe("Updated —");

    // The suffixes ride along.
    const renewal = row({ id: "u6", residentName: "A", residentEmail: "a@x.com", updatedAtIso: "2026-09-18T18:00:00.000Z", pendingRenewal: true, status: "Manager Review" } as Partial<LeasePipelineRow> & Pick<LeasePipelineRow, "id" | "residentName" | "residentEmail">);
    expect(leaseUpdatedShort(renewal, now)).toBe("Updated Sep 18 · Renewal requested");
    const offPlatform = row({ id: "u7", residentName: "A", residentEmail: "a@x.com", updatedAtIso: "2026-09-18T18:00:00.000Z", status: "Fully Signed", externallySignedLease: true, fullySignedAt: "2026-09-18T18:00:00.000Z" } as Partial<LeasePipelineRow> & Pick<LeasePipelineRow, "id" | "residentName" | "residentEmail">);
    expect(leaseUpdatedShort(offPlatform, now)).toBe("Updated Sep 18 · Signed off-platform");
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
