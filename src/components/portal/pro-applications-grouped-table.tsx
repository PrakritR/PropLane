"use client";

/**
 * The manager's Applications list: one white card per application, the shape
 * every other portal list has (AGENTS.md → Portal UI system: "Every list tab
 * copies Properties"). An initials tile, the applicant's NAME as the title,
 * "Alder Row · Room 2" as the address line, a line of glyph facts, and the ⋯
 * the list surface draws on a selectable row — carrying that row's actions.
 *
 * No pills. The tab already says the bucket (Pending, Approved, Rejected), so
 * nothing on the row repeats it; what the row still has to say — when it was
 * submitted, a flagged screening, a household, an existing resident — is a
 * plain grey fact with a glyph (`tests/unit/portal-list-rows-no-pills.test.ts`).
 *
 * A household's applications sit together, each with the same household fact;
 * a co-signer is its own row under the applicant with a person tile. No
 * grouping box, no nested table: one row shape at every width.
 */

import { Clock, Home, Mail, ShieldAlert, ShieldCheck, Users } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import {
  applicationDateVerb,
  applicationPropertyMeta,
  applicationStageFact,
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

/** The screening fact — only when the check has answered. Pending, or no check at all, is silent. */
function screeningFact(row: DemoApplicantRow) {
  const status = resolveBackgroundCheckStatus(row);
  if (status === "flagged") {
    return (
      <PortalRowFact key="screening" icon={ShieldAlert} srLabel="Screening">
        Screening flagged
      </PortalRowFact>
    );
  }
  if (status === "passed") {
    return (
      <PortalRowFact key="screening" icon={ShieldCheck} srLabel="Screening">
        Screening passed
      </PortalRowFact>
    );
  }
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
        const group = household && cluster.group ? describeGroupBadge(cluster.group) : null;
        const householdSize = household ? cluster.rows.length : 0;
        return rows.flatMap((row) => {
          const name = applicantDisplayName(row);
          const email = row.email?.trim() ?? "";
          const signerKey = normalizeApplicationAxisId(row.id).toUpperCase();
          const cosigners = cosignerSubmissionsBySigner.get(signerKey) ?? [];
          const when = applicationSubmittedShort(row);
          const stage = applicationStageFact(row);

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
                  {when ? (
                    <PortalRowFact icon={Clock} srLabel="Date">
                      {applicationDateVerb(row)} {when}
                    </PortalRowFact>
                  ) : null}
                  {stage ? (
                    <PortalRowFact icon={Home} srLabel="Stage">
                      {stage}
                    </PortalRowFact>
                  ) : null}
                  {group ? (
                    <PortalRowFact icon={Users} srLabel="Group">
                      <span title={group.title}>{group.label}</span>
                    </PortalRowFact>
                  ) : household ? (
                    <PortalRowFact icon={Users} srLabel="Household">
                      Household of {householdSize}
                    </PortalRowFact>
                  ) : null}
                  {cosigners.length > 0 ? (
                    <PortalRowFact icon={Users} srLabel="Co-signers">
                      {cosigners.length} co-signer{cosigners.length === 1 ? "" : "s"}
                    </PortalRowFact>
                  ) : null}
                  {screeningFact(row)}
                </>
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
