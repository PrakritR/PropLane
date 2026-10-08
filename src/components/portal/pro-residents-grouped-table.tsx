"use client";

/**
 * The manager's Residents list: one white card per resident, the shape every
 * other portal list has (AGENTS.md → Portal UI system: "Every list tab copies
 * Properties"). An initials tile, the resident's NAME as the title,
 * "Room 4 · 5259 Brooklyn Ave" as the address line, glyph facts (email, lease
 * start) and the ⋯ the list surface draws on a selectable row — carrying that
 * row's actions.
 *
 * No nested table, no pill: the Potential / Current / Past tab already says the
 * stage, and "Incomplete application" — the one thing a row still has to say —
 * is plain fact text (`tests/unit/portal-list-rows-no-pills.test.ts`).
 *
 * With `groupByHouse` (Sort by House, the default) the rows sit under sticky,
 * collapsible house headers that carry the house and a count, A to Z with
 * "No house" last, and the place line drops the house the header already says.
 * Sort by Name or Recently updated is the same rows as one flat list.
 */

import { CalendarDays, Mail, Users } from "lucide-react";
import { PortalGroupedRecordList } from "@/components/portal/portal-grouped-record-list";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import {
  residentHousingMeta,
  type ManagerResidentListRow,
} from "@/lib/manager-resident-list";
import type {
  ManagerResidentHouseCluster,
  ManagerResidentListCluster,
} from "@/lib/manager-resident-list-grouping";
import type { PortalListGroupMode } from "@/lib/portal-list-grouping";

/** The catch-all house header: a resident whose property is not known. */
export const RESIDENT_NO_HOUSE_LABEL = "No house";

/** A resident belongs to the house they live (or applied) in. */
export const residentHouseLabel = (row: ManagerResidentListRow) => row.propertyLabel;
/** Two houses that share a name stay two groups when they have different ids. */
export const residentHouseId = (row: ManagerResidentListRow) => row.propertyId || row.propertyLabel;

function shortDateLabel(iso: string): string {
  const parts = iso.trim().split("-").map(Number);
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return iso;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

/** The clusters in display order, flattened to the rows the cards draw. */
function flattenResidentClusters(
  clusters: ManagerResidentListCluster[] | ManagerResidentHouseCluster[],
  groupMode: PortalListGroupMode,
): ManagerResidentListRow[] {
  if (groupMode === "house") {
    return (clusters as ManagerResidentHouseCluster[]).flatMap((cluster) => cluster.rows);
  }
  return (clusters as ManagerResidentListCluster[]).flatMap((cluster) =>
    cluster.kind === "resident" ? cluster.cluster.rows : cluster.rows,
  );
}

export function ManagerResidentsGroupedTable({
  clusters,
  rows: rowsProp,
  groupMode = "house",
  groupByHouse = false,
  searchActive = false,
  onOpenResident,
  selectedIds,
  onToggleSelected,
  selectable = false,
}: {
  clusters?: ManagerResidentListCluster[] | ManagerResidentHouseCluster[];
  /** The rows in the order to show them. When set, `clusters` is ignored. */
  rows?: ManagerResidentListRow[];
  groupMode?: PortalListGroupMode;
  /**
   * Draw the rows under sticky, collapsible house headers (A to Z, "No house"
   * last, 25 rows per house until "Show all"). Off, the rows are a flat list
   * and each place line names its house.
   */
  groupByHouse?: boolean;
  /** A non-empty search box: opens every house that still has a match. */
  searchActive?: boolean;
  /** Kept for callers; the flat list always names the property. */
  showPropertyInRows?: boolean;
  onOpenResident: (row: ManagerResidentListRow) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  /** Kept for callers; there is no cluster header to select from any more. */
  onToggleCluster?: (ids: readonly string[]) => void;
  selectable?: boolean;
}) {
  const select = (id: string) => (selectable && onToggleSelected ? () => onToggleSelected(id) : undefined);
  const dataAttr = groupMode === "house" ? "residents-house-groups" : "residents-resident-groups";
  const rows = rowsProp ?? flattenResidentClusters(clusters ?? [], groupMode);

  const renderRow = (row: ManagerResidentListRow, includeProperty: boolean) => {
    const name = row.name.trim();
    // A nameless in-progress application falls back to its email for the
    // title, so repeating it as a fact would print the same string twice.
    const email = row.email.trim().toLowerCase() === name.toLowerCase() ? "" : row.email.trim();
    const status = row.statusLabel?.trim() ?? "";
    return (
      <PortalApplicantRecordRow
        name={row.name}
        address={residentHousingMeta(row, includeProperty)}
        facts={
          <>
            {email ? (
              <PortalRowFact icon={Mail} srLabel="Email">
                {email}
              </PortalRowFact>
            ) : null}
            {row.residentSlotFact ? (
              <PortalRowFact icon={Users} srLabel="Resident">
                {row.residentSlotFact}
              </PortalRowFact>
            ) : null}
            {row.leaseStart ? (
              <PortalRowFact icon={CalendarDays} srLabel="Lease start">
                {shortDateLabel(row.leaseStart)}
              </PortalRowFact>
            ) : null}
            {status ? <span data-attr="resident-row-status">{status}</span> : null}
          </>
        }
        checked={selectable && selectedIds?.has(row.id)}
        onSelectedChange={select(row.id)}
        onOpen={() => onOpenResident(row)}
        dataAttr="resident-list-row"
      />
    );
  };

  if (groupByHouse) {
    return (
      <PortalGroupedRecordList
        items={rows}
        groupLabel={residentHouseLabel}
        groupId={residentHouseId}
        otherLabel={RESIDENT_NO_HOUSE_LABEL}
        itemKey={(row) => row.id}
        // The header says the house, so the place line is just the room.
        renderItem={(row) => renderRow(row, false)}
        listKey="residents"
        searchActive={searchActive}
        dataAttr={dataAttr}
      />
    );
  }

  return (
    <div data-attr={dataAttr}>
      {rows.map((row) => (
        <div key={row.id}>{renderRow(row, true)}</div>
      ))}
    </div>
  );
}
