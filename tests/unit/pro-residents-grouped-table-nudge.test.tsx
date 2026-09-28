// @vitest-environment jsdom
/**
 * C252 (U035): a Potential resident row with an incomplete application had
 * only its plain "Incomplete application" status text — no action reachable
 * from the row itself, only from a checkbox-selected bulk bar or by opening
 * the full record. `ManagerResidentsGroupedTable` now renders a nudge button
 * directly on any row `nudgeEligibleIds` names, and nothing extra on any
 * other row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("ManagerResidentsGroupedTable nudge action (C252)", () => {
  it("renders a nudge button only for a row the caller marks eligible", () => {
    const onNudge = vi.fn();
    const incomplete = row({ id: "app-incomplete", name: "Jordan Lee", statusLabel: "Incomplete" });
    const approved = row({ id: "app-approved", name: "Maya Chen", statusLabel: "" });

    render(
      <ManagerResidentsGroupedTable
        clusters={clustersFor([incomplete, approved])}
        groupMode="resident"
        onOpenResident={() => {}}
        nudgeEligibleIds={new Set(["app-incomplete"])}
        onNudge={onNudge}
      />,
    );

    const buttons = screen.getAllByRole("button", { name: /Remind .* to finish their application/i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("Remind Jordan Lee to finish their application");
  });

  it("calls onNudge with the row and never opens the record", () => {
    const onNudge = vi.fn();
    const onOpenResident = vi.fn();
    const incomplete = row({ id: "app-incomplete", name: "Jordan Lee" });

    render(
      <ManagerResidentsGroupedTable
        clusters={clustersFor([incomplete])}
        groupMode="resident"
        onOpenResident={onOpenResident}
        nudgeEligibleIds={new Set(["app-incomplete"])}
        onNudge={onNudge}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remind Jordan Lee to finish their application" }));
    expect(onNudge).toHaveBeenCalledTimes(1);
    expect(onNudge).toHaveBeenCalledWith(expect.objectContaining({ id: "app-incomplete" }));
    expect(onOpenResident).not.toHaveBeenCalled();
  });

  it("renders no nudge button at all when the caller omits nudgeEligibleIds", () => {
    render(
      <ManagerResidentsGroupedTable
        clusters={clustersFor([row({ id: "app-1", name: "Jordan Lee" })])}
        groupMode="resident"
        onOpenResident={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Remind/i })).not.toBeInTheDocument();
  });
});
