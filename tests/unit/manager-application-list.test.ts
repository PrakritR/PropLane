import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicationRowSortMs,
  clusterApplicationListRows,
  sortApplicationClustersForBucket,
  sortApplicationRowsForBucket,
} from "@/lib/manager-application-list";

function row(
  overrides: Partial<DemoApplicantRow> & Pick<DemoApplicantRow, "id" | "name" | "email">,
): DemoApplicantRow {
  return {
    property: "5257 Brooklyn Ave NE",
    stage: "Pending",
    bucket: "pending",
    detail: "",
    ...overrides,
  };
}

describe("manager-application-list", () => {
  it("clusters applications by resident email like tours", () => {
    const rows = [
      row({ id: "APP-1", name: "Alex Kim", email: "alex@example.com" }),
      row({ id: "APP-2", name: "Alex Kim", email: "alex@example.com", property: "4709A 8th Ave NE" }),
      row({ id: "APP-3", name: "Jamie Lee", email: "jamie@example.com" }),
    ];
    const clusters = clusterApplicationListRows(rows);
    expect(clusters).toHaveLength(2);
    const alex = clusters.find((cluster) => cluster.residentEmail === "alex@example.com");
    expect(alex?.rows).toHaveLength(2);
  });

  it("sorts pending rows oldest first within and across clusters", () => {
    const older = row({
      id: "APP-OLD",
      name: "Older Applicant",
      email: "older@example.com",
      application: { submittedAt: "2026-01-01T12:00:00.000Z" } as DemoApplicantRow["application"],
    });
    const newer = row({
      id: "APP-NEW",
      name: "Newer Applicant",
      email: "newer@example.com",
      application: { submittedAt: "2026-02-01T12:00:00.000Z" } as DemoApplicantRow["application"],
    });
    const sortedRows = sortApplicationRowsForBucket([newer, older], "pending");
    expect(sortedRows.map((entry) => entry.id)).toEqual(["APP-OLD", "APP-NEW"]);

    const clusters = sortApplicationClustersForBucket(
      clusterApplicationListRows([newer, older]),
      "pending",
    );
    expect(clusters.map((cluster) => cluster.rows[0]?.id)).toEqual(["APP-OLD", "APP-NEW"]);
  });

  it("sorts rejected rows newest first", () => {
    const older = row({
      id: "APP-OLD",
      name: "Older Applicant",
      email: "older@example.com",
      bucket: "rejected",
      application: { submittedAt: "2026-01-01T12:00:00.000Z" } as DemoApplicantRow["application"],
    });
    const newer = row({
      id: "APP-NEW",
      name: "Newer Applicant",
      email: "newer@example.com",
      bucket: "rejected",
      application: { submittedAt: "2026-02-01T12:00:00.000Z" } as DemoApplicantRow["application"],
    });
    const sortedRows = sortApplicationRowsForBucket([older, newer], "rejected");
    expect(sortedRows.map((entry) => entry.id)).toEqual(["APP-NEW", "APP-OLD"]);
    expect(applicationRowSortMs(newer)).toBeGreaterThan(applicationRowSortMs(older));
  });
});
