"use client";

/**
 * The manager's Applications list: one white card per application, the shape
 * every other portal list has (AGENTS.md → Portal UI system: "Every list tab
 * copies Properties"). An initials tile, the applicant's NAME as the title,
 * "Alder Row · Room 2" as the address line, glyph facts, chips on the left,
 * the date in bold and a status chip on the right, and the ⋯ the list surface
 * draws on a selectable row — carrying that row's actions.
 *
 * A household's applications sit together, each with a "Household of N" chip;
 * a co-signer is its own row under the applicant with a person tile. No
 * grouping box, no nested table: one row shape at every width.
 */

import { Mail, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  PortalApplicantRecordRow,
  PortalRowFact,
  PortalRowStatusChip,
} from "@/components/portal/portal-record-row";
import {
  applicationDateVerb,
  applicationPropertyMeta,
  applicationStatusChip,
  applicationSubmittedShort,
} from "@/lib/manager-application-list";
import type { ApplicationListCluster } from "@/lib/rental-application/application-list-grouping";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { cosignerListSelectionId } from "@/lib/cosigner-list-selection";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { resolveBackgroundCheckStatus } from "@/lib/application-background-check";
import { describeGroupBadge } from "@/lib/rental-application/application-groups";

/** The screening chip — only when there is something to say. A row with no check is silent. */
function screeningBadge(row: DemoApplicantRow) {
  const status = resolveBackgroundCheckStatus(row);
  if (status === "pending_review") return <Badge key="screening" tone="warning">Screening pending</Badge>;
  if (status === "flagged") return <Badge key="screening" tone="danger">Screening flagged</Badge>;
  if (status === "passed") return <Badge key="screening" tone="success">Screening passed</Badge>;
  return null;
}

export function ManagerApplicationsGroupedTable({
  clusters,
  cosignerSubmissionsBySigner,
  onOpenApplication,
  onOpenCosigner,
  selectedIds,
  onToggleSelected,
  selectable = false,
}: {
  clusters: ApplicationListCluster[];
  cosignerSubmissionsBySigner: Map<string, CosignerSubmission[]>;
  onOpenApplication: (row: DemoApplicantRow) => void;
  onOpenCosigner: (row: DemoApplicantRow, index: number) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  selectable?: boolean;
  /** Kept for callers; the row draws its own tile. */
  rowIcon?: unknown;
}) {
  const select = (id: string) => (selectable && onToggleSelected ? () => onToggleSelected(id) : undefined);
  return (
    <div data-attr="applications-resident-groups">
      {clusters.flatMap((cluster) => {
        const household = cluster.kind === "household";
        const rows = household ? cluster.rows : [cluster.row];
        // "Group 2/3" when the group is known — who has submitted of who was
        // declared — else the plain count of rows that sit together.
        const groupBadge = household && cluster.group ? describeGroupBadge(cluster.group) : null;
        const householdSize = household ? cluster.rows.length : 0;
        return rows.flatMap((row) => {
          const name = applicantDisplayName(row);
          const status = applicationStatusChip(row);
          const email = row.email?.trim() ?? "";
          const signerKey = normalizeApplicationAxisId(row.id).toUpperCase();
          const cosigners = cosignerSubmissionsBySigner.get(signerKey) ?? [];
          const screening = screeningBadge(row);
          const when = applicationSubmittedShort(row);
          const badges = [
            screening,
            groupBadge ? (
              <Badge key="household" tone={groupBadge.tone}>
                <span title={groupBadge.title}>{groupBadge.label}</span>
              </Badge>
            ) : household ? (
              <Badge key="household" tone="info">Household of {householdSize}</Badge>
            ) : null,
            cosigners.length > 0 ? <Badge key="cosigners" tone="info">{cosigners.length} co-signer{cosigners.length === 1 ? "" : "s"}</Badge> : null,
            row.manuallyAdded ? <Badge key="added" tone="neutral">Added by you</Badge> : null,
          ].filter(Boolean);

          const out = [
            <PortalApplicantRecordRow
              key={row.id}
              name={name}
              address={applicationPropertyMeta(row)}
              facts={
                <>
                  {email && email.toLowerCase() !== name.trim().toLowerCase() ? (
                    <PortalRowFact icon={Mail} srLabel="Email">
                      {email}
                    </PortalRowFact>
                  ) : null}
                  {household ? (
                    <PortalRowFact icon={Users} srLabel="Household">
                      {rows.length} {rows.length === 1 ? "applicant" : "applicants"}
                    </PortalRowFact>
                  ) : null}
                </>
              }
              badge={badges.length > 0 ? <span className="flex flex-wrap gap-1.5">{badges}</span> : undefined}
              trailing={when ? `${applicationDateVerb(row)} ${when}` : undefined}
              chip={
                <PortalRowStatusChip tone={status.tone} dataAttr="application-row-status">
                  {status.label}
                </PortalRowStatusChip>
              }
              checked={selectable && selectedIds?.has(row.id)}
              onSelectedChange={select(row.id)}
              onOpen={() => onOpenApplication(row)}
              dataAttr="application-list-row"
            />,
          ];

          cosigners.forEach((sub, index) => {
            const selectionId = cosignerListSelectionId(row.id, sub, index);
            const cosignerName = sub.fullName || "Co-signer";
            out.push(
              <div key={`${row.id}-cosigner-${index}`} className="pl-6 max-md:pl-4" data-attr="application-cosigner-row">
                <PortalApplicantRecordRow
                  kind="cosigner"
                  name={cosignerName}
                  address={`Co-signer for ${name}`}
                  facts={
                    sub.email ? (
                      <PortalRowFact icon={Mail} srLabel="Email">
                        {sub.email}
                      </PortalRowFact>
                    ) : undefined
                  }
                  chip={
                    <PortalRowStatusChip tone="ok" dataAttr="application-row-status">
                      Signed
                    </PortalRowStatusChip>
                  }
                  checked={selectable && selectedIds?.has(selectionId)}
                  onSelectedChange={select(selectionId)}
                  onOpen={() => onOpenCosigner(row, index)}
                  dataAttr="application-cosigner-list-row"
                />
              </div>,
            );
          });
          return out;
        });
      })}
    </div>
  );
}
