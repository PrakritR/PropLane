"use client";

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
  screeningTrailToneClassName,
} from "@/lib/application-screening-list-meta";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import { cosignerShowsBackgroundCheck } from "@/lib/cosigner-screening";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import {
  applicationPropertyMeta,
  applicationSubmittedLabel,
} from "@/lib/manager-application-list";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
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
      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      checked={checked}
      aria-label={ariaLabel}
      data-attr={dataAttr}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

function ClusterNavRow({
  primary,
  meta,
  trail,
  trailTone,
  selected,
  checked,
  onCheck,
  onOpen,
  checkDataAttr,
  nested = false,
}: {
  primary: string;
  meta?: string;
  trail?: string;
  trailTone?: "pending" | "ready" | "running" | "complete" | "muted";
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
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-foreground/[0.03]",
        selected && "bg-primary/5 shadow-[inset_3px_0_0_var(--color-primary)]",
        nested && "max-md:pl-4",
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
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{primary}</span>
        {meta ? <span className="mt-0.5 block truncate text-xs text-muted">{meta}</span> : null}
      </span>
      {trail ? (
        <span className={cn("shrink-0 text-xs font-semibold", screeningTrailToneClassName(trailTone ?? "muted"))}>
          {trail}
        </span>
      ) : null}
      <span className="shrink-0 text-muted" aria-hidden>
        ›
      </span>
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

export function ApplicationReviewNavCluster({
  row,
  cosignerSubmissions = [],
  activeView,
  onActiveViewChange,
  onOpenCosigner,
  selectedRowIds,
  onToggleRowId,
  showPropertySummary = true,
}: {
  row: DemoApplicantRow;
  cosignerSubmissions?: CosignerSubmission[];
  activeView: ApplicationReviewView;
  onActiveViewChange: (view: ApplicationReviewView) => void;
  onOpenCosigner?: (index: number) => void;
  selectedRowIds?: Set<string>;
  onToggleRowId?: (id: string) => void;
  showPropertySummary?: boolean;
}) {
  const applicantName = applicantDisplayName(row);
  const showsScreening = applicationShowsBackgroundCheck(row);
  const screeningTrail = screeningListTrailForApplicant(row);

  const scrollToView = (view: ApplicationReviewView) => {
    onActiveViewChange(view);
    const targetId = view === "background-check" ? "application-background-check-section" : "application-readonly-review";
    requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="space-y-3" data-attr="application-review-nav-cluster">
      {showPropertySummary ? <ApplicationPropertySummaryCard row={row} /> : null}

      <ApplicationHouseholdCluster
        header={
          <>
            <span className="w-full truncate text-sm font-semibold text-foreground">{applicantName}</span>
            {row.email?.trim() ? (
              <span className="truncate text-xs text-muted">{row.email.trim()}</span>
            ) : null}
            <Badge tone="info">1 application</Badge>
          </>
        }
      >
        <ClusterNavRow
          primary="Application"
          meta={`${applicationSubmittedLabel(row)}${applicationPropertyMeta(row) !== "—" ? ` · ${applicationPropertyMeta(row)}` : ""}`}
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
            trail={screeningTrail.label}
            trailTone={screeningTrail.tone}
            selected={activeView === "background-check"}
            checked={selectedRowIds?.has(`${row.id}:screening`)}
            onCheck={
              onToggleRowId ? () => onToggleRowId(`${row.id}:screening`) : undefined
            }
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
                    onOpen={() => onOpenCosigner?.(index)}
                    checkDataAttr={`application-review-select-cosigner-${index}`}
                  />
                  {cosignerShowsBackgroundCheck(sub) ? (
                    <ClusterNavRow
                      nested
                      primary="Background check"
                      meta={cosignerScreening.sub}
                      trail={cosignerScreening.label}
                      trailTone={cosignerScreening.tone}
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
