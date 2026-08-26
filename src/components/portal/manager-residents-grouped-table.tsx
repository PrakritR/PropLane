"use client";

import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { DataList } from "@/components/ui/data-list";
import {
  residentHousingMeta,
  type ManagerResidentListCluster,
  type ManagerResidentListRow,
} from "@/lib/manager-resident-list";

function shortDateLabel(iso: string): string {
  const parts = iso.trim().split("-").map(Number);
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return iso;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

export function ManagerResidentsGroupedTable({
  clusters,
  showPropertyInRows,
  onOpenResident,
}: {
  clusters: ManagerResidentListCluster[];
  /** When a property filter is active, repeat the property on each row. */
  showPropertyInRows: boolean;
  onOpenResident: (row: ManagerResidentListRow) => void;
}) {
  return (
    <div className="space-y-3" data-attr="residents-resident-groups">
      {clusters.map((cluster) => (
        <ApplicationHouseholdCluster
          key={cluster.key}
          header={
            <>
              <span className="truncate text-xs font-semibold text-foreground">
                {cluster.residentLabel}
              </span>
              {cluster.residentEmail &&
              cluster.residentEmail.toLowerCase() !== cluster.residentLabel.trim().toLowerCase() ? (
                <span className="truncate text-xs text-muted">{cluster.residentEmail}</span>
              ) : null}
              {cluster.propertyLabel ? (
                <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
              ) : null}
              <Badge tone="info">
                {cluster.rows.length === 1 ? "1 resident" : `${cluster.rows.length} residents`}
              </Badge>
            </>
          }
        >
          <DataList
            hideColumnHeaders
            selectable={false}
            rows={cluster.rows.map((row) => ({
              id: row.id,
              data: row,
              primary: residentHousingMeta(row, showPropertyInRows),
              meta: row.email && row.email !== cluster.residentEmail ? row.email : undefined,
              trailing: row.leaseStart ? (
                <span className="text-sm tabular-nums text-muted">{shortDateLabel(row.leaseStart)}</span>
              ) : undefined,
              onClick: () => onOpenResident(row),
            }))}
            columns={[
              {
                id: "unit",
                header: "Unit",
                cell: (row) => residentHousingMeta(row, showPropertyInRows),
              },
              {
                id: "leaseStart",
                header: "Lease start",
                cell: (row) => (row.leaseStart ? shortDateLabel(row.leaseStart) : "—"),
                headerClassName: "text-right",
                cellClassName: "text-right tabular-nums text-muted",
              },
            ]}
          />
        </ApplicationHouseholdCluster>
      ))}
    </div>
  );
}
