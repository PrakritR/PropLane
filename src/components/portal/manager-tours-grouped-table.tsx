"use client";

import { ApplicationHouseholdCluster, PortalListClusterSelectCheckbox } from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { DataList } from "@/components/ui/data-list";
import {
  type ManagerTourListCluster,
  type ManagerTourPropertyCluster,
  type ManagerTourRow,
  tourReminderMetaHint,
  tourReminderSummaryForCluster,
} from "@/lib/manager-tour-list";
import { isPropertyClusterList, type PortalListGroupMode } from "@/lib/portal-list-grouping";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { scheduledSendBadgeLabel } from "@/lib/scheduled-send-summary";

function tourLocationMeta(
  row: ManagerTourRow,
  showPropertyColumn: boolean,
  groupMode: PortalListGroupMode,
  tourReminders: readonly ScheduledInboxMessageRecord[],
): string {
  const parts: string[] = [];
  const location = tourLocationMetaBase(row, showPropertyColumn, groupMode);
  if (location !== "—") parts.push(location);
  const reminder = tourReminderMetaHint(row, tourReminders);
  if (reminder) parts.push(reminder);
  return parts.join(" · ") || "—";
}

function tourLocationMetaBase(row: ManagerTourRow, showPropertyColumn: boolean, groupMode: PortalListGroupMode): string {
  if (groupMode === "house") {
    return [row.guestName, row.roomLabel].filter(Boolean).join(" · ") || "—";
  }
  if (!showPropertyColumn) {
    return row.roomLabel?.trim() || "—";
  }
  return [row.propertyTitle, row.roomLabel].filter(Boolean).join(" · ");
}

export function ManagerToursGroupedTable({
  clusters,
  groupMode,
  selectedIds,
  onToggleSelected,
  onToggleCluster,
  onRowClick,
  showPropertyColumn = true,
  selectable = true,
  tourReminders = [],
}: {
  clusters: ManagerTourListCluster[] | ManagerTourPropertyCluster[];
  groupMode: PortalListGroupMode;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleCluster?: (ids: readonly string[]) => void;
  onRowClick: (row: ManagerTourRow) => void;
  /** Hide the property column when the list is scoped to one listing. */
  showPropertyColumn?: boolean;
  selectable?: boolean;
  tourReminders?: readonly ScheduledInboxMessageRecord[];
}) {
  const locationHeader =
    groupMode === "house" ? "Guest" : showPropertyColumn ? "Property" : "Room";

  const renderReminderBadge = (clusterRows: ManagerTourRow[]) => {
    const label = scheduledSendBadgeLabel(
      tourReminderSummaryForCluster({ rows: clusterRows }, tourReminders),
    );
    return label ? (
      <Badge tone="pending">
        <span data-attr="tours-cluster-scheduled">{label}</span>
      </Badge>
    ) : null;
  };

  const renderTourDataList = (listRows: ManagerTourRow[]) => (
    <DataList
      hideColumnHeaders
      selectable={selectable}
      rows={listRows.map((row) => ({
        id: row.id,
        data: row,
        primary: row.whenLabel,
        meta: tourLocationMeta(row, showPropertyColumn, groupMode, tourReminders),
        selected: selectedIds.has(row.id),
        onSelectedChange: () => onToggleSelected(row.id),
        onClick: () => onRowClick(row),
      }))}
      columns={[
        { id: "when", header: "When", cell: (row) => row.whenLabel },
        {
          id: "location",
          header: locationHeader,
          cell: (row) => tourLocationMeta(row, showPropertyColumn, groupMode, tourReminders),
        },
      ]}
    />
  );

  const renderClusterCheckbox = (rows: ManagerTourRow[], label: string) =>
    onToggleCluster && selectable ? (
      <PortalListClusterSelectCheckbox
        ids={rows.map((row) => row.id)}
        selectedIds={selectedIds}
        onToggleCluster={onToggleCluster}
        ariaLabel={`Select all ${label}`}
      />
    ) : null;

  const dataAttr = groupMode === "house" ? "tours-house-groups" : "tours-resident-groups";

  if (isPropertyClusterList(groupMode, clusters)) {
    return (
      <div className="space-y-3" data-attr={dataAttr}>
        {clusters.map((cluster) => (
          <ApplicationHouseholdCluster
            key={cluster.key}
            headerLeading={renderClusterCheckbox(cluster.rows, cluster.propertyLabel)}
            header={
              <>
                <span className="truncate text-xs font-semibold text-foreground">
                  {cluster.propertyLabel}
                </span>
                <Badge tone="info">
                  {cluster.rows.length === 1 ? "1 tour" : `${cluster.rows.length} tours`}
                </Badge>
                {renderReminderBadge(cluster.rows)}
              </>
            }
          >
            {renderTourDataList(cluster.rows)}
          </ApplicationHouseholdCluster>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-attr={dataAttr}>
      {(clusters as ManagerTourListCluster[]).map((cluster) => (
        <ApplicationHouseholdCluster
          key={cluster.key}
          headerLeading={renderClusterCheckbox(cluster.rows, cluster.residentLabel)}
          header={
            <>
              <span className="truncate text-xs font-semibold text-foreground">
                {cluster.residentLabel}
              </span>
              {cluster.residentEmail &&
              cluster.residentEmail.toLowerCase() !== cluster.residentLabel.trim().toLowerCase() ? (
                <span className="truncate text-xs text-muted">{cluster.residentEmail}</span>
              ) : null}
              {showPropertyColumn && cluster.propertyLabel ? (
                <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
              ) : null}
              <Badge tone="info">
                {cluster.rows.length === 1 ? "1 tour" : `${cluster.rows.length} tours`}
              </Badge>
              {renderReminderBadge(cluster.rows)}
            </>
          }
        >
          {renderTourDataList(cluster.rows)}
        </ApplicationHouseholdCluster>
      ))}
    </div>
  );
}
