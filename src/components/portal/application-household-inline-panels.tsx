"use client";

import { Badge } from "@/components/ui/badge";
import { groupMemberStatusBadge } from "@/components/portal/application-group-section";
import {
  ReviewRow,
  ReviewSection,
} from "@/components/portal/manager-application-readonly-review";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import type { ApplicationGroup } from "@/lib/rental-application/application-groups";
import type { YesNo } from "@/lib/rental-application/types";

function yesNoLabel(value: YesNo | string | null | undefined): string {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return "—";
}

function cosignerIsYes(hasCosigner: string | null | undefined, submissions: CosignerSubmission[]): boolean {
  return hasCosigner === "yes" || submissions.length > 0;
}

function groupIsYes(applyingAsGroup: string | null | undefined, group: ApplicationGroup | null): boolean {
  return applyingAsGroup === "yes" || Boolean(group);
}

/**
 * Flat household summary at the top of the Application tab — co-signer and group
 * in a fixed order, matching the review card style without nested boxes.
 */
export function ApplicationHouseholdInlinePanels({
  cosignerSubmissions = [],
  hasCosigner,
  applyingAsGroup,
  onOpenCosigner,
  group = null,
  groupId = "",
  currentRowId,
  onOpenApplication,
}: {
  cosignerSubmissions?: CosignerSubmission[];
  hasCosigner?: string | null;
  applyingAsGroup?: string | null;
  onOpenCosigner?: (index: number) => void;
  group?: ApplicationGroup | null;
  groupId?: string;
  currentRowId: string;
  onOpenApplication?: (applicationId: string) => void;
}) {
  const cosignerYes = cosignerIsYes(hasCosigner, cosignerSubmissions);
  const groupYes = groupIsYes(applyingAsGroup, group);

  return (
    <ReviewSection title="Household" data-attr="application-household-inline-panels">
      <ReviewRow
        k="Co-signer"
        v={
          !cosignerYes ? (
            yesNoLabel(hasCosigner)
          ) : cosignerSubmissions.length === 0 ? (
            "Yes · not submitted yet"
          ) : (
            <ul className="space-y-1.5">
              {cosignerSubmissions.map((sub, index) => {
                const label = sub.fullName?.trim() || sub.email?.trim() || "Co-signer";
                const detail = sub.email?.trim() && sub.fullName?.trim() ? sub.email.trim() : null;
                if (!onOpenCosigner) {
                  return (
                    <li key={`${sub.email}-${index}`} className="text-foreground">
                      {label}
                      {detail ? <span className="block text-xs text-muted">{detail}</span> : null}
                    </li>
                  );
                }
                return (
                  <li key={`${sub.email}-${index}`}>
                    <button
                      type="button"
                      className="text-left font-medium text-foreground underline-offset-2 hover:underline"
                      data-attr="application-cosigner-inline-row"
                      onClick={() => onOpenCosigner(index)}
                    >
                      {label}
                    </button>
                    {detail ? <span className="block text-xs text-muted">{detail}</span> : null}
                  </li>
                );
              })}
            </ul>
          )
        }
      />
      <ReviewRow
        k="Group application"
        v={
          !groupYes ? (
            yesNoLabel(applyingAsGroup)
          ) : group && group.members.length > 0 ? (
            <div className="space-y-2">
              {groupId.trim() || group.groupId ? (
                <p className="text-xs text-muted">
                  Group ID{" "}
                  <span className="font-mono text-foreground">{group.groupId || groupId.trim()}</span>
                </p>
              ) : null}
              <ul className="space-y-1.5">
                {group.members.map((member) => {
                  const pill = groupMemberStatusBadge(member.status);
                  const isCurrent = member.id === currentRowId;
                  const label = (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span>{member.name}</span>
                      {isCurrent ? <span className="text-xs text-muted">(this application)</span> : null}
                      {member.role === "first" ? <span className="text-xs text-muted">· organizer</span> : null}
                      <Badge tone={pill.tone}>{pill.label}</Badge>
                    </span>
                  );
                  if (onOpenApplication && !isCurrent) {
                    return (
                      <li key={member.id}>
                        <button
                          type="button"
                          className="text-left font-medium text-foreground underline-offset-2 hover:underline"
                          data-attr="application-group-member-row"
                          onClick={() => onOpenApplication(member.id)}
                        >
                          {label}
                        </button>
                        {member.email ? <span className="block text-xs text-muted">{member.email}</span> : null}
                      </li>
                    );
                  }
                  return (
                    <li key={member.id} className="text-foreground">
                      {label}
                      {member.email ? <span className="block text-xs text-muted">{member.email}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <span>
              Yes
              {groupId.trim() ? (
                <>
                  {" "}
                  · Group ID <span className="font-mono">{groupId.trim()}</span>
                </>
              ) : null}
            </span>
          )
        }
      />
    </ReviewSection>
  );
}
