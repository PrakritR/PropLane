"use client";

/**
 * The manager's Leases list: one white card per lease, the shape every other
 * portal list has (AGENTS.md → Portal UI system: "Every list tab copies
 * Properties"). An initials tile, the resident's NAME as the title,
 * "5259 Brooklyn Ave · Room 4" as the place line, glyph facts — email, the
 * stage as plain text, "Updated Sep 18" — and the ⋯ the list surface draws on
 * a selectable row, carrying that row's actions.
 *
 * The clusters keep the list's order (a resident's leases sit together) but
 * draw no grouping box, no nested row, no bare checkbox and no stage pill:
 * the tab says the bucket, and the stage is a fact only because one bucket
 * holds several stages (`tests/unit/portal-list-rows-no-pills.test.ts`).
 */

import { Clock, FileText, Mail, PenLine, Users } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  leaseRowPlaceLine,
  leaseStageFact,
  leaseUpdatedShort,
  leaseResidentSlotFact,
  leaseInitialsProgressFact,
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
  const select = (id: string) => (selectable && onToggleSelected ? () => onToggleSelected(id) : undefined);
  return (
    <div data-attr="leases-resident-groups">
      {clusters.flatMap((cluster) =>
        cluster.rows.map((row) => {
          const name = row.residentName?.trim() || cluster.residentLabel;
          const email = row.residentEmail?.trim() ?? "";
          const stage = leaseStageFact(row);
          return (
            <PortalApplicantRecordRow
              key={row.id}
              name={name}
              address={leaseRowPlaceLine(row)}
              facts={
                <>
                  {email && email.toLowerCase() !== name.trim().toLowerCase() ? (
                    <PortalRowFact icon={Mail} srLabel="Email">
                      {email}
                    </PortalRowFact>
                  ) : null}
                  {leaseResidentSlotFact(row) ? (
                    <PortalRowFact icon={Users} srLabel="Resident">
                      {leaseResidentSlotFact(row)}
                    </PortalRowFact>
                  ) : null}
                  {stage ? (
                    <PortalRowFact icon={FileText} srLabel="Stage">
                      {stage}
                    </PortalRowFact>
                  ) : null}
                  {leaseInitialsProgressFact(row) ? (
                    <PortalRowFact icon={PenLine} srLabel="Initials">
                      {leaseInitialsProgressFact(row)}
                    </PortalRowFact>
                  ) : null}
                  <PortalRowFact icon={Clock} srLabel="Last update">
                    {leaseUpdatedShort(row)}
                  </PortalRowFact>
                </>
              }
              checked={selectable && selectedIds?.has(row.id)}
              onSelectedChange={select(row.id)}
              onOpen={() => onOpenLease(row)}
              dataAttr="lease-list-row"
            />
          );
        }),
      )}
    </div>
  );
}
