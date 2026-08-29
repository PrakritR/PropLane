"use client";

import { useMemo } from "react";
import { ManagerToursGroupedTable } from "@/components/portal/manager-tours-grouped-table";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
import {
  buildManagerTourRows,
  clusterManagerTourListRows,
} from "@/lib/manager-tour-list";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { managerTourDetailHref } from "@/lib/portal-detail-routes";

export function ManagerResidentToursPanel({
  managerUserId,
  residentEmail,
  residentName,
}: {
  managerUserId: string | null;
  residentEmail: string;
  residentName: string;
}) {
  const navigate = usePortalNavigate();
  const normalizedEmail = residentEmail.trim().toLowerCase();

  const rows = useMemo(() => {
    if (!managerUserId || !normalizedEmail.includes("@")) return [];
    return buildManagerTourRows({ viewerUserId: managerUserId, propertyIds: [] }).filter(
      (row) => row.guestEmail?.trim().toLowerCase() === normalizedEmail,
    );
  }, [managerUserId, normalizedEmail]);

  const clusters = useMemo(() => clusterManagerTourListRows(rows), [rows]);

  if (!managerUserId) {
    return <p className="text-sm text-muted">Sign in to view tours.</p>;
  }

  if (rows.length === 0) {
    return (
      <PortalPropertyDetailSection>
        <PortalDataTableEmpty
          message={`No tours on file for ${residentName.trim() || "this resident"} yet.`}
        />
      </PortalPropertyDetailSection>
    );
  }

  return (
    <PortalPropertyDetailSection>
      <p className="mb-3 text-xs text-muted">
        Tour requests and confirmations for this resident account — including tour-only signups before an
        application is started.
      </p>
      <ManagerToursGroupedTable
        clusters={clusters}
        selectedIds={new Set()}
        onToggleSelected={() => {}}
        selectable={false}
        onRowClick={(row) => {
          const bucket =
            row.bucket === "pending" || row.bucket === "upcoming" || row.bucket === "past"
              ? row.bucket
              : "upcoming";
          navigate(managerTourDetailHref("/portal", bucket, row.id));
        }}
      />
    </PortalPropertyDetailSection>
  );
}
