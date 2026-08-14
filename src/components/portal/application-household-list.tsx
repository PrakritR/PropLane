"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";
import { describeGroupBadge, type ApplicationGroup } from "@/lib/rental-application/application-groups";
import { dominantPropertyLabel, groupHouseLabel } from "@/lib/rental-application/group-house-label";

export function ApplicationHouseholdCluster({
  header,
  children,
}: {
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-border/80 bg-accent/10"
      data-attr="application-household-cluster"
    >
      {header ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">{header}</div>
      ) : null}
      <div className="divide-y divide-border/50">{children}</div>
    </div>
  );
}

export function ApplicationNestedListRow({
  children,
  nested = true,
}: {
  children: ReactNode;
  nested?: boolean;
}) {
  return (
    <div className={nested ? "border-l-2 border-primary/25 bg-background/60 pl-1" : undefined} data-attr="application-nested-list-row">
      {children}
    </div>
  );
}

export function ApplicationCosignerListRow({
  name,
  subtitle,
  preview,
  onOpen,
}: {
  name: string;
  subtitle?: string;
  preview?: string;
  onOpen: () => void;
}) {
  return (
    <ApplicationNestedListRow>
      <button
        type="button"
        onClick={onOpen}
        data-attr="application-cosigner-list-row"
        className="portal-inbox-row flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-foreground/[0.03] max-md:px-2.5"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{name}</span>
            <Badge tone="info">Co-signer</Badge>
          </div>
          {subtitle ? <span className="truncate text-xs text-muted">{subtitle}</span> : null}
          {preview ? <span className="truncate text-xs text-muted">{preview}</span> : null}
        </div>
        <span className="shrink-0 text-muted" aria-hidden>
          ›
        </span>
      </button>
    </ApplicationNestedListRow>
  );
}

export function householdClusterPropertyLabel(
  rows: ReadonlyArray<{ property: string }>,
): string | null {
  if (rows.length === 0) return null;
  const first = rows[0]?.property;
  if (!first) return null;
  return rows.every((row) => row.property === first) ? first : null;
}

export function householdClusterHeaderForRows(
  group: ApplicationGroup | null,
  rows: ReadonlyArray<{ property: string }>,
  groupOrdinal?: number | null,
) {
  // A GROUP anchors to the house most of its rows sit at. The strict
  // "every row shares one property" rule below returns null for a household split
  // across two addresses — which is exactly the real case (three at 5257, one at
  // 5259) — and dropped the house from the header entirely. A cluster with no
  // group keeps the strict rule: unrelated rows must not claim a shared house.
  const label = group ? dominantPropertyLabel(rows) : householdClusterPropertyLabel(rows);
  return householdClusterHeader(group, label, groupOrdinal);
}

export function householdClusterHeader(
  group: ApplicationGroup | null,
  propertyLabel?: string | null,
  groupOrdinal?: number | null,
) {
  const property =
    propertyLabel?.trim() ? stripPropertyRoomCountSuffix(propertyLabel.trim()) : "";
  if (!group && !property) return null;
  const badge = group ? describeGroupBadge(group) : null;
  // "5257 Brooklyn Ave NE Group 1 application" — the house is the most useful
  // thing on this row, so it leads even when the ordinal is unknown.
  const groupHeading = group ? `${groupHouseLabel(property || null, groupOrdinal ?? 1)} application` : "";
  return (
    <>
      {group ? (
        <>
          <span className="truncate text-xs font-semibold text-foreground">{groupHeading}</span>
          <span title={badge!.title}>
            <Badge tone={badge!.tone}>{badge!.label}</Badge>
          </span>
        </>
      ) : property ? (
        <span className="truncate text-xs font-semibold text-foreground">{property}</span>
      ) : null}
    </>
  );
}

export function ApplicationCosignerSection({
  submissions,
  primaryApplicationAxisId,
  onOpenCosigner,
}: {
  submissions: CosignerSubmission[];
  primaryApplicationAxisId: string;
  onOpenCosigner?: (index: number) => void;
}) {
  if (submissions.length === 0) return null;

  return (
    <PortalCollapsibleSection
      title="Co-signer application"
      defaultExpanded
      surfaceMuted={false}
      className="mt-4"
      contentClassName="p-4 pt-0"
      toggleDataAttr="application-cosigner-toggle"
      headerActions={<Badge tone="info">{submissions.length === 1 ? "1 co-signer" : `${submissions.length} co-signers`}</Badge>}
    >
      <ul className="divide-y divide-[var(--border)] rounded-2xl border border-border">
        {submissions.map((sub, index) => (
          <li key={`${sub.email}-${sub.submittedAt}-${index}`}>
            {onOpenCosigner ? (
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-foreground/[0.03]"
                data-attr="application-cosigner-roster-row"
                onClick={() => onOpenCosigner(index)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-medium text-foreground">{sub.fullName || "Co-signer"}</span>
                  {sub.email ? <span className="truncate text-[11px] text-muted">{sub.email}</span> : null}
                </span>
                <Badge tone="confirmed">Submitted</Badge>
              </button>
            ) : (
              <div className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-medium text-foreground">{sub.fullName || "Co-signer"}</span>
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
        <span className="font-mono text-foreground">{primaryApplicationAxisId.trim()}</span>
      </p>
    </PortalCollapsibleSection>
  );
}
