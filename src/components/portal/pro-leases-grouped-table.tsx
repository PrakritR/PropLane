"use client";

import { FileText } from "lucide-react";
import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { ClusterNavRow } from "@/components/portal/application-review-nav-cluster";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  leaseGroupedRowMeta,
  leaseGroupedRowPrimary,
  leaseStatusPill,
  type ManagerLeaseListCluster,
} from "@/lib/manager-lease-list";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";

function ResidentLeaseClusterHeader({
  residentLabel,
  residentEmail,
  propertyLabel,
}: {
  residentLabel: string;
  residentEmail?: string | null;
  propertyLabel?: string | null;
}) {
  const email =
    residentEmail?.trim() &&
    residentEmail.trim().toLowerCase() !== residentLabel.trim().toLowerCase()
      ? residentEmail.trim()
      : "";
  const property = propertyLabel?.trim()
    ? stripPropertyRoomCountSuffix(propertyLabel.trim())
    : "";

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-sm font-semibold text-foreground">{residentLabel}</span>
      {email ? <span className="truncate text-xs text-muted">{email}</span> : null}
      {property ? <span className="truncate text-xs text-muted">{property}</span> : null}
    </div>
  );
}

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
      {clusters.map((cluster) => {
        const propertyLabel = cluster.propertyLabel?.trim()
          ? stripPropertyRoomCountSuffix(cluster.propertyLabel.trim())
          : null;

        return (
          <ApplicationHouseholdCluster
            key={cluster.key}
            header={
              <ResidentLeaseClusterHeader
                residentLabel={cluster.residentLabel}
                residentEmail={cluster.residentEmail}
                propertyLabel={propertyLabel}
              />
            }
          >
            {cluster.rows.map((row) => {
              const statusPill = leaseStatusPill(row);
              return (
                <ClusterNavRow
                  key={row.id}
                  primary={leaseGroupedRowPrimary(row, propertyLabel)}
                  meta={leaseGroupedRowMeta(row)}
                  icon={<FileText className="h-4 w-4" aria-hidden />}
                  statusPill={statusPill}
                  checked={selectable && selectedIds?.has(row.id)}
                  onCheck={
                    selectable && onToggleSelected ? () => onToggleSelected(row.id) : undefined
                  }
                  onOpen={() => onOpenLease(row)}
                  checkDataAttr={`lease-select-${row.id}`}
                />
              );
            })}
          </ApplicationHouseholdCluster>
        );
      })}
    </div>
  );
}
