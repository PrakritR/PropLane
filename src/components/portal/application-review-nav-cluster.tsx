"use client";

import { ClipboardList, Home, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  ApplicationHouseholdCluster,
  ApplicationNestedListRow,
} from "@/components/portal/application-household-list";
import type { ApplicationReviewView } from "@/components/portal/application-review-launcher-row";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  screeningListTrailForApplicant,
  screeningListTrailForCosigner,
} from "@/lib/application-screening-list-meta";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import { cosignerShowsBackgroundCheck } from "@/lib/cosigner-screening";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import {
  applicationPropertyMeta,
  applicationSubmittedLabel,
} from "@/lib/manager-application-list";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { cn } from "@/lib/utils";

function NavCheckbox({
  checked,
  onChange,
  dataAttr,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  dataAttr: string;
  ariaLabel: string;
}) {
  return (
    <input
      type="checkbox"
      className="h-4 w-4 shrink-0 accent-primary"
      checked={checked}
      aria-label={ariaLabel}
      data-attr={dataAttr}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

export function screeningToneToBadge(
  tone: "pending" | "ready" | "running" | "complete" | "muted",
): "info" | "warning" | "muted" | "success" {
  if (tone === "complete") return "success";
  if (tone === "pending" || tone === "running") return "warning";
  if (tone === "ready") return "info";
  return "muted";
}

export function applicationStatusPill(row: DemoApplicantRow): { label: string; tone: "info" | "warning" | "muted" | "success" } {
  if (isWithdrawnApplicationRow(row)) return { label: "Withdrawn", tone: "muted" };
  if (row.bucket === "approved") return { label: "Approved", tone: "success" };
  if (row.bucket === "rejected") return { label: "Rejected", tone: "muted" };
  return { label: "Applied", tone: "info" };
}

export function ClusterNavRow({
  primary,
  meta,
  icon,
  statusPill,
  selected,
  checked,
  onCheck,
  onOpen,
  checkDataAttr,
  nested = false,
}: {
  primary: string;
  meta?: string;
  icon: React.ReactNode;
  statusPill?: { label: string; tone: "info" | "warning" | "muted" | "success" };
  selected?: boolean;
  checked?: boolean;
  onCheck?: () => void;
  onOpen: () => void;
  checkDataAttr: string;
  nested?: boolean;
}) {
  const row = (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.03]",
        selected && "bg-primary/5 shadow-[inset_3px_0_0_var(--color-primary)]",
        nested && "pl-4",
      )}
    >
      {onCheck ? (
        <NavCheckbox
          checked={Boolean(checked)}
          onChange={onCheck}
          dataAttr={checkDataAttr}
          ariaLabel={`Select ${primary}`}
        />
      ) : (
        <span className="w-4 shrink-0" aria-hidden />
      )}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{primary}</span>
        {meta ? <span className="mt-0.5 block truncate text-xs text-muted">{meta}</span> : null}
      </span>
      {statusPill ? <Badge tone={statusPill.tone}>{statusPill.label}</Badge> : null}
    </button>
  );

  return nested ? <ApplicationNestedListRow nested>{row}</ApplicationNestedListRow> : row;
}

export function ApplicationPropertySummaryCard({ row }: { row: DemoApplicantRow }) {
  const propertyMeta = applicationPropertyMeta(row);
  const room =
    row.assignedRoomChoice?.trim() ||
    row.application?.roomChoice1?.trim() ||
    propertyMeta.split(" · ").slice(1).join(" · ");

  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-2xl border border-border bg-card px-3.5 py-3 shadow-sm"
      data-attr="application-property-summary"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {propertyMeta.split(" · ")[0] || row.property || "Property"}
        </p>
        {room ? <p className="truncate text-xs text-muted">{room}</p> : null}
      </div>
      <Badge tone="info">Primary</Badge>
    </div>
  );
}

function propertyRowMeta(row: DemoApplicantRow): string {
  const propertyMeta = applicationPropertyMeta(row);
  const parts = propertyMeta.split(" · ").filter(Boolean);
  return parts.slice(1).join(" · ") || parts[0] || "—";
}

export function ApplicationReviewNavCluster({
  row,
  cosignerSubmissions = [],
  activeView,
  onActiveViewChange,
  onOpenCosigner,
  selectedRowIds,
  onToggleRowId,
  showPropertySummary = false,
}: {
  row: DemoApplicantRow;
  cosignerSubmissions?: CosignerSubmission[];
  activeView: ApplicationReviewView;
  onActiveViewChange: (view: ApplicationReviewView) => void;
  onOpenCosigner?: (index: number) => void;
  selectedRowIds?: Set<string>;
  onToggleRowId?: (id: string) => void;
  /** Legacy applications list may still show the standalone summary card. */
  showPropertySummary?: boolean;
}) {
  const showsScreening = applicationShowsBackgroundCheck(row);
  const screeningTrail = screeningListTrailForApplicant(row);
  const propertyMeta = applicationPropertyMeta(row);
  const propertyTitle = propertyMeta.split(" · ")[0] || row.property || "Property";
  const applicationStatus = applicationStatusPill(row);

  const scrollToView = (view: ApplicationReviewView) => {
    onActiveViewChange(view);
    const targetId =
      view === "background-check" ? "application-background-check-section" : "application-readonly-review";
    requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="space-y-3" data-attr="application-review-nav-cluster">
      {showPropertySummary ? <ApplicationPropertySummaryCard row={row} /> : null}

      <ApplicationHouseholdCluster>
        <ClusterNavRow
          primary={propertyTitle}
          meta={propertyRowMeta(row)}
          icon={<Home className="h-4 w-4" aria-hidden />}
          statusPill={{ label: "Current", tone: "info" }}
          onOpen={() => scrollToView("application")}
          checkDataAttr="application-review-select-property"
        />
        <ClusterNavRow
          nested
          primary="Application"
          meta={applicationSubmittedLabel(row)}
          icon={<ClipboardList className="h-4 w-4" aria-hidden />}
          statusPill={applicationStatus}
          selected={activeView === "application"}
          checked={selectedRowIds?.has(row.id)}
          onCheck={onToggleRowId ? () => onToggleRowId(row.id) : undefined}
          onOpen={() => scrollToView("application")}
          checkDataAttr="application-review-select-application"
        />

        {showsScreening ? (
          <ClusterNavRow
            nested
            primary="Background check"
            meta={screeningTrail.sub}
            icon={<Search className="h-4 w-4" aria-hidden />}
            statusPill={{
              label: screeningTrail.label,
              tone: screeningToneToBadge(screeningTrail.tone),
            }}
            selected={activeView === "background-check"}
            checked={selectedRowIds?.has(`${row.id}:screening`)}
            onCheck={onToggleRowId ? () => onToggleRowId(`${row.id}:screening`) : undefined}
            onOpen={() => scrollToView("background-check")}
            checkDataAttr="application-review-select-screening"
          />
        ) : null}

        {cosignerSubmissions.length > 0 ? (
          <>
            <p className="border-t border-dashed border-border/80 bg-accent/10 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-muted">
              Co-signer
            </p>
            {cosignerSubmissions.map((sub, index) => {
              const cosignerScreening = screeningListTrailForCosigner(sub);
              return (
                <div key={`${sub.email}-${index}`}>
                  <ClusterNavRow
                    nested
                    primary={sub.fullName || "Co-signer"}
                    meta={sub.email || undefined}
                    icon={<ClipboardList className="h-4 w-4" aria-hidden />}
                    onOpen={() => onOpenCosigner?.(index)}
                    checkDataAttr={`application-review-select-cosigner-${index}`}
                  />
                  {cosignerShowsBackgroundCheck(sub) ? (
                    <ClusterNavRow
                      nested
                      primary="Background check"
                      meta={cosignerScreening.sub}
                      icon={<Search className="h-4 w-4" aria-hidden />}
                      statusPill={{
                        label: cosignerScreening.label,
                        tone: screeningToneToBadge(cosignerScreening.tone),
                      }}
                      onOpen={() => onOpenCosigner?.(index)}
                      checkDataAttr={`application-review-select-cosigner-screening-${index}`}
                    />
                  ) : null}
                </div>
              );
            })}
          </>
        ) : null}
      </ApplicationHouseholdCluster>
    </div>
  );
}
