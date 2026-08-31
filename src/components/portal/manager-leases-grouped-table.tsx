"use client";

import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  leaseUnitMeta,
  leaseUpdatedLabel,
  type ManagerLeaseListCluster,
} from "@/lib/manager-lease-list";

export function ManagerLeasesGroupedTable({
  clusters,
  onOpenLease,
  selectedIds,
  onToggleSelected,
  selectable = true,
}: {
  clusters: ManagerLeaseListCluster[];
  onOpenLease: (row: LeasePipelineRow) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  selectable?: boolean;
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
          {cluster.rows.map((row) => {
            const unit = leaseUnitMeta(row);
            return (
              <PortalPropertyRecordRow
                key={row.id}
                // Unit leads: the resident's name is already the cluster header,
                // so repeating it here would make every row in a group read the
                // same. Fall back to the updated stamp when a row has no unit.
                title={unit || leaseUpdatedLabel(row)}
                address={unit ? leaseUpdatedLabel(row) : ""}
                badge={
                  row.pendingRenewal || row.leaseKind === "joint_bundle" ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {row.pendingRenewal ? <Badge tone="warning">Renewal</Badge> : null}
                      {row.leaseKind === "joint_bundle" ? <Badge tone="neutral">Joint bundle</Badge> : null}
                    </span>
                  ) : undefined
                }
                checked={selectedIds?.has(row.id) ?? false}
                onSelectedChange={
                  selectable && onToggleSelected ? () => onToggleSelected(row.id) : undefined
                }
                onOpen={() => onOpenLease(row)}
                dataAttr="lease-list-row"
              />
            );
          })}
        </ApplicationHouseholdCluster>
      ))}
    </div>
  );
}
