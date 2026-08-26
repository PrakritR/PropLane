"use client";

import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { DataList } from "@/components/ui/data-list";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  leaseUnitMeta,
  leaseUpdatedLabel,
  type ManagerLeaseListCluster,
} from "@/lib/manager-lease-list";

export function ManagerLeasesGroupedTable({
  clusters,
  onOpenLease,
}: {
  clusters: ManagerLeaseListCluster[];
  onOpenLease: (row: LeasePipelineRow) => void;
}) {
  return (
    <div className="space-y-3" data-attr="leases-resident-groups">
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
                {cluster.rows.length === 1 ? "1 lease" : `${cluster.rows.length} leases`}
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
              primary: leaseUpdatedLabel(row),
              meta: leaseUnitMeta(row),
              onClick: () => onOpenLease(row),
            }))}
            columns={[
              {
                id: "updated",
                header: "Updated",
                cell: (row) => (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span>{leaseUpdatedLabel(row)}</span>
                    {row.pendingRenewal ? <Badge tone="warning">Renewal</Badge> : null}
                    {row.leaseKind === "joint_bundle" ? <Badge tone="neutral">Joint bundle</Badge> : null}
                  </span>
                ),
              },
              {
                id: "unit",
                header: "Unit",
                cell: (row) => leaseUnitMeta(row),
              },
            ]}
          />
        </ApplicationHouseholdCluster>
      ))}
    </div>
  );
}
