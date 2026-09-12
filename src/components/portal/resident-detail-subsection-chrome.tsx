"use client";

import type { ReactNode } from "react";
import { Pencil, Settings2, SlidersHorizontal } from "lucide-react";
import { LocalDestinationNav, type LocalDestinationNavItem } from "@/components/ui/destination-nav";
import { cn } from "@/lib/utils";

/**
 * One compact button in the record-detail command strip: an icon, and the word
 * beside it from `md` up. Kept as a plain button rather than the site Button so
 * the strip reads as a toolbar (Mobbin record-detail rows), not a row of CTAs.
 */
function ChromeAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  dataAttr,
  title,
}: {
  icon: typeof Pencil;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  dataAttr: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      data-attr={dataAttr}
      disabled={disabled}
      title={title}
      aria-label={label}
      onClick={() => onClick?.()}
      className={cn(
        "portal-pressable inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border bg-card px-3 text-[13px] font-semibold text-foreground transition-colors",
        "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-card",
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted" strokeWidth={1.8} aria-hidden />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

/**
 * Shared command strip for manager resident-detail tabs (PRP-395).
 * Always renders Filter · Settings · Edit so every tab has the same shape —
 * Filter defaults to disabled (status lives in the pills beside it); Settings/Edit
 * stay visible and disable when the tab has nothing to open.
 */
export function ResidentDetailCommandToolbar({
  filter,
  onSettings,
  onEdit,
  settingsDisabled,
  editDisabled,
  settingsLabel = "Settings",
  editLabel = "Edit",
}: {
  filter?: ReactNode;
  onSettings?: () => void;
  onEdit?: () => void;
  settingsDisabled?: boolean;
  editDisabled?: boolean;
  settingsLabel?: string;
  editLabel?: string;
}) {
  return (
    <>
      {filter ?? (
        <ChromeAction
          icon={SlidersHorizontal}
          label="Filter"
          dataAttr="resident-detail-filter"
          disabled
          title="Status filters live in the pills above"
        />
      )}
      <ChromeAction
        icon={Settings2}
        label={settingsLabel}
        dataAttr="resident-detail-settings"
        disabled={settingsDisabled || !onSettings}
        onClick={onSettings}
      />
      <ChromeAction
        icon={Pencil}
        label={editLabel}
        dataAttr="resident-detail-edit"
        disabled={editDisabled || !onEdit}
        onClick={onEdit}
      />
    </>
  );
}

/**
 * The strip above a resident-detail tab's content: status buckets on the left,
 * Filter · Settings · Edit on the right, ONE row.
 *
 * It used to be two full-width bars stacked — a segmented control the width
 * of the page with three words in it, then a white bar holding three outline
 * buttons — which pushed the record itself below the fold. The buckets are a
 * compact segmented control now, and the actions are icon buttons beside them.
 */
export function ResidentDetailSubsectionChrome({
  bucketItems,
  activeBucketId,
  onBucketChange,
  bucketAriaLabel,
  denseEqualRow = false,
  filter,
  onSettings,
  onEdit,
  settingsDisabled,
  editDisabled,
  settingsLabel,
  editLabel,
  activeFilterChips,
  className,
}: {
  bucketItems: LocalDestinationNavItem[];
  activeBucketId: string;
  onBucketChange: (id: string) => void;
  bucketAriaLabel: string;
  denseEqualRow?: boolean;
  filter?: ReactNode;
  onSettings?: () => void;
  onEdit?: () => void;
  settingsDisabled?: boolean;
  editDisabled?: boolean;
  settingsLabel?: string;
  editLabel?: string;
  activeFilterChips?: ReactNode;
  className?: string;
}) {
  void denseEqualRow;
  return (
    <div className={className ?? "mb-3 shrink-0 space-y-2"}>
      <div className="flex items-center justify-between gap-2">
        <div
          className={cn(
            "min-w-0 flex-1 md:min-w-[320px]",
            // Four pipeline stages need the room; three buckets do not.
            bucketItems.length >= 4 ? "md:max-w-[720px]" : "md:max-w-[520px]",
          )}
        >
          <LocalDestinationNav
            items={bucketItems}
            activeId={activeBucketId}
            onChange={onBucketChange}
            ariaLabel={bucketAriaLabel}
            size="toolbar"
            itemLayout="equal"
            denseEqualRow
            className="max-lg:rounded-2xl max-lg:border max-lg:border-border max-lg:bg-accent/30 max-lg:p-1"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5" data-slot="resident-detail-command-strip">
          <ResidentDetailCommandToolbar
            filter={filter}
            onSettings={onSettings}
            onEdit={onEdit}
            settingsDisabled={settingsDisabled}
            editDisabled={editDisabled}
            settingsLabel={settingsLabel}
            editLabel={editLabel}
          />
        </div>
      </div>
      {activeFilterChips ? <div className="flex flex-wrap gap-1.5">{activeFilterChips}</div> : null}
    </div>
  );
}
