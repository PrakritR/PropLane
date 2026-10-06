// @vitest-environment jsdom
/**
 * Captain, 2026-10-06: the bell drawn over an incomplete applicant's row overlapped the ⋯. The row
 * carries no bell now; "Remind to finish" is reachable from the row's ⋯ menu (`residents-bulk-completion-reminder`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ManagerResidentsGroupedTable } from "@/components/portal/pro-residents-grouped-table";
import type { ManagerResidentListCluster } from "@/lib/manager-resident-list-grouping";
import type { ManagerResidentListRow } from "@/lib/manager-resident-list";

afterEach(() => {
  cleanup();
});

function row(over: Partial<ManagerResidentListRow> & Pick<ManagerResidentListRow, "id" | "name">): ManagerResidentListRow {
  return {
    email: "",
    propertyId: "prop-1",
    propertyLabel: "Prop One",
    roomLabel: "Room 1",
    leaseStart: "",
    ...over,
  };
}

function clustersFor(rows: ManagerResidentListRow[]): ManagerResidentListCluster[] {
  return rows.map((r) => ({
    kind: "resident" as const,
    cluster: { key: r.id, residentLabel: r.name, propertyLabel: r.propertyLabel, rows: [r] },
  }));
}

describe("ManagerResidentsGroupedTable rows carry no inline bell", () => {
  it("never renders a reminder bell beside the row's ⋯ — the reminder lives in the ⋯ menu", () => {
    const incomplete = row({ id: "app-incomplete", name: "Jordan Lee", statusLabel: "Incomplete" });
    const { container } = render(
      <ManagerResidentsGroupedTable clusters={clustersFor([incomplete])} groupMode="resident" onOpenResident={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /Remind/i })).toBeNull();
    expect(container.querySelector('[data-attr="resident-row-nudge"]')).toBeNull();
  });

  it("the Residents list keeps 'Remind to finish' in the ⋯ bulk menu and no row-level nudge", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/portal/pro-residents.tsx"), "utf8");
    expect(src).toContain('data-attr="residents-bulk-completion-reminder"');
    expect(src).not.toContain("nudgeEligibleIds");
    expect(src).not.toContain("onNudge");
  });
});
