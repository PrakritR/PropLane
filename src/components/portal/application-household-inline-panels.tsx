"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ApplicationCosignerPlannedCard } from "@/components/portal/manager-application-readonly-review";
import { groupMemberStatusBadge } from "@/components/portal/application-group-section";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import type { ApplicationGroup } from "@/lib/rental-application/application-groups";
import { summarizeGroupProgress } from "@/lib/rental-application/application-groups";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";

function HouseholdPanelCard({
  title,
  badge,
  children,
  "data-attr": dataAttr,
}: {
  title: string;
  badge?: React.ReactNode;
  children: ReactNode;
  "data-attr"?: string;
}) {
  return (
    <section
      className="rounded-2xl border border-border bg-card"
      data-attr={dataAttr}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {badge}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * Co-signer and group-application summaries rendered inside the Application tab
 * (below the Application / Background check toggle), not above it.
 */
export function ApplicationHouseholdInlinePanels({
  cosignerSubmissions = [],
  primaryApplicationAxisId,
  hasCosigner,
  onOpenCosigner,
  group = null,
  currentRowId,
  onOpenApplication,
}: {
  cosignerSubmissions?: CosignerSubmission[];
  primaryApplicationAxisId: string;
  hasCosigner?: string | null;
  onOpenCosigner?: (index: number) => void;
  group?: ApplicationGroup | null;
  currentRowId: string;
  onOpenApplication?: (applicationId: string) => void;
}) {
  const showCosigner = cosignerSubmissions.length > 0;
  const showGroup = Boolean(group);
  if (!showCosigner && !showGroup) return null;

  const groupProgress = group ? summarizeGroupProgress(group) : null;

  return (
    <div
      className={`grid gap-3 ${showCosigner && showGroup ? "md:grid-cols-2" : "grid-cols-1"}`}
      data-attr="application-household-inline-panels"
    >
      {showCosigner ? (
        <HouseholdPanelCard
          title="Co-signer application"
          data-attr="application-cosigner-inline-panel"
          badge={
            <Badge tone="info">
              {cosignerSubmissions.length === 1 ? "1 co-signer" : `${cosignerSubmissions.length} co-signers`}
            </Badge>
          }
        >
          <ul className="divide-y divide-border rounded-xl border border-border">
            {cosignerSubmissions.map((sub, index) => (
              <li key={`${sub.email}-${sub.submittedAt}-${index}`}>
                {onOpenCosigner ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-foreground/[0.03]"
                    data-attr="application-cosigner-inline-row"
                    onClick={() => onOpenCosigner(index)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {sub.fullName || "Co-signer"}
                      </span>
                      {sub.email ? <span className="truncate text-[11px] text-muted">{sub.email}</span> : null}
                    </span>
                    <Badge tone="confirmed">Submitted</Badge>
                    <span className="shrink-0 text-muted" aria-hidden>
                      ›
                    </span>
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {sub.fullName || "Co-signer"}
                      </span>
                      {sub.email ? <span className="truncate text-[11px] text-muted">{sub.email}</span> : null}
                    </span>
                    <Badge tone="confirmed">Submitted</Badge>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-muted">
            Linked to primary application{" "}
            <span className="font-mono text-foreground">
              {normalizeApplicationAxisId(primaryApplicationAxisId)}
            </span>
          </p>
          <div className="mt-3">
            <ApplicationCosignerPlannedCard hasCosigner={hasCosigner} />
          </div>
        </HouseholdPanelCard>
      ) : null}

      {showGroup && group ? (
        <HouseholdPanelCard
          title="Group application"
          data-attr="application-group-inline-panel"
          badge={groupProgress ? <Badge tone={groupProgress.tone}>{groupProgress.label}</Badge> : null}
        >
          <p className="mb-3 text-xs text-muted">
            PropLane Group ID <span className="font-mono text-foreground">{group.groupId}</span>
            {group.missingCount != null && group.missingCount > 0
              ? ` · waiting on ${group.missingCount} more ${group.missingCount === 1 ? "applicant" : "applicants"}`
              : ""}
          </p>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {group.members.map((member) => {
              const pill = groupMemberStatusBadge(member.status);
              const isCurrent = member.id === currentRowId;
              const body = (
                <>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {member.name}
                      {isCurrent ? <span className="ml-1.5 text-[11px] text-muted">(this application)</span> : null}
                      {member.role === "first" ? (
                        <span className="ml-1.5 text-[11px] text-muted">· organizer</span>
                      ) : null}
                    </span>
                    {member.email ? <span className="truncate text-[11px] text-muted">{member.email}</span> : null}
                  </span>
                  <Badge tone={pill.tone}>{pill.label}</Badge>
                  {onOpenApplication && !isCurrent ? (
                    <span className="shrink-0 text-muted" aria-hidden>
                      ›
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={member.id}>
                  {onOpenApplication && !isCurrent ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-foreground/[0.03]"
                      data-attr="application-group-member-row"
                      onClick={() => onOpenApplication(member.id)}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-3 py-2.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </HouseholdPanelCard>
      ) : null}
    </div>
  );
}
