"use client";

import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ManagerPortalFilterRow, ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { InboxAvatar, InboxThreadEmpty, InboxTwoPane } from "@/components/portal/portal-inbox-ui";
import { PortalTitleActionsHost, useTitleActionsPublished } from "@/components/portal/portal-title-actions-slot";
import { cn } from "@/lib/utils";

/** Desktop shows list + detail together; phones use list-then-detail navigation. */
export function portalUsesDesktopSplit(breakpointPx = 1024): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia(`(min-width: ${breakpointPx}px)`).matches;
}

export function usePortalListDetail<TId extends string>({
  itemIds,
  onDetailOpenChange,
}: {
  itemIds: TId[];
  onDetailOpenChange?: (open: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<TId | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const openDetail = useCallback((id: TId) => {
    setSelectedId(id);
    setMobileDetailOpen(true);
  }, []);

  const closeDetail = useCallback(() => {
    setMobileDetailOpen(false);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setMobileDetailOpen(false);
  }, []);

  useEffect(() => {
    onDetailOpenChange?.(mobileDetailOpen && selectedId !== null);
  }, [mobileDetailOpen, selectedId, onDetailOpenChange]);

  useEffect(() => {
    if (itemIds.length === 0) {
      setSelectedId(null);
      setMobileDetailOpen(false);
      return;
    }
    setSelectedId((cur) => {
      if (cur && itemIds.includes(cur)) return cur;
      if (portalUsesDesktopSplit()) return itemIds[0] ?? null;
      return null;
    });
  }, [itemIds]);

  return {
    selectedId,
    setSelectedId,
    mobileDetailOpen,
    setMobileDetailOpen,
    openDetail,
    closeDetail,
    clearSelection,
    detailOpen: mobileDetailOpen && selectedId !== null,
  };
}

/** Detail pane header — back control, title + optional actions (Communication thread style). */
export function PortalDetailHeader({
  title,
  subtitle,
  avatarName,
  onBack,
  backLabel = "Back",
  hideBackText = false,
  bare = false,
  actions,
  /** When true, actions render only beside the title on md+ (footer or other mobile chrome owns actions). */
  suppressMobileActions = false,
  /** When true, actions stay in the title row on all breakpoints (horizontal scroll on narrow screens). */
  inlineActions = false,
  inlineActionsClassName,
  dataAttrBack = "portal-detail-back",
}: {
  title: string;
  subtitle?: string;
  avatarName?: string;
  onBack?: () => void;
  backLabel?: string;
  /** Hide visible back label; chevron only (accessibility label kept). */
  hideBackText?: boolean;
  /** No card chrome — sits on the portal page canvas. */
  bare?: boolean;
  actions?: ReactNode;
  suppressMobileActions?: boolean;
  inlineActions?: boolean;
  inlineActionsClassName?: string;
  dataAttrBack?: string;
}) {
  // The record's own actions (Approve · Download, Edit listing · Unlist) are
  // published into this header by the tab that owns them — see
  // portal-title-actions-slot. They used to sit in a bar pinned to the foot of
  // the page, which covered the last card and read as the page being cut off.
  const slotPublished = useTitleActionsPublished();
  const hasActions = Boolean(actions) || slotPublished;
  return (
    <header
      className={`portal-detail-header flex shrink-0 flex-col max-md:gap-2 md:gap-0 ${
        bare ? "bg-transparent" : "border-b border-border bg-card"
      }`}
    >
      <div className="flex items-center gap-0.5 px-1.5 py-1 max-md:py-1 md:gap-1 md:px-2 md:py-2 md:[padding-top:max(0.375rem,env(safe-area-inset-top,0px))]">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="flex min-h-8 shrink-0 items-center gap-0.5 rounded-lg px-1 text-sm font-medium text-primary hover:bg-accent/40 md:px-2"
            aria-label={backLabel}
            data-attr={dataAttrBack}
          >
            <ChevronLeft className="h-5 w-5" strokeWidth={2.25} />
            <span className={hideBackText ? "sr-only" : "max-md:sr-only"}>{backLabel}</span>
          </button>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-0.5 md:gap-2.5 md:px-1">
          {avatarName ? (
            <InboxAvatar name={avatarName} className="h-9 w-9 text-[11px] md:h-10 md:w-10 md:text-[12px]" />
          ) : null}
          {/* The record's name is the page's title: it reads as one, not as a list row. */}
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold tracking-tight text-foreground md:text-[17px]">{title}</p>
            {subtitle ? <p className="truncate text-[12.5px] text-muted">{subtitle}</p> : null}
          </div>
        </div>
        {/* The host stays mounted even while empty — a publisher only claims
            a slot it can see, so an unmounted host would never receive one. */}
        <div
          className={cn(
            inlineActions
              ? "flex max-w-[min(70%,24rem)] shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] md:max-w-none [&::-webkit-scrollbar]:hidden"
              : "hidden shrink-0 items-center gap-1.5 md:flex",
            !hasActions && "!hidden",
            inlineActionsClassName,
          )}
        >
          {actions}
          <PortalTitleActionsHost
            breakpoint={inlineActions ? undefined : "md-up"}
            className="flex items-center gap-1.5 [&_button]:!h-9 [&_button]:!min-h-0 [&_button]:!rounded-full [&_button]:!px-3.5 [&_button]:!text-[13px]"
          />
        </div>
      </div>
      <div
        className={cn(
          "w-full min-w-0 flex-col gap-2 border-t border-border/60 px-2 pb-2 pt-2 md:hidden",
          (actions && !suppressMobileActions && !inlineActions) || (slotPublished && !inlineActions) ? "flex" : "hidden",
        )}
      >
        {actions && !suppressMobileActions && !inlineActions ? actions : null}
        {inlineActions ? null : (
          <PortalTitleActionsHost
            breakpoint="below-md"
            className="flex flex-wrap items-center gap-1.5 [&_button]:!h-9 [&_button]:!min-h-0 [&_button]:!rounded-full [&_button]:!px-3.5 [&_button]:!text-[13px]"
          />
        )}
      </div>
    </header>
  );
}

/** Responsive list + detail shell (Communication inbox pattern). */
export function PortalListDetailPane({
  list,
  detail,
  detailOpen,
  className = "",
  mobileCompact = true,
  heightMode = "viewport",
}: {
  list: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  className?: string;
  mobileCompact?: boolean;
  heightMode?: "viewport" | "section";
}) {
  return (
    <InboxTwoPane
      mobileCompact={mobileCompact}
      heightMode={heightMode}
      className={className}
      threadOpen={detailOpen}
      list={list}
      thread={detail}
    />
  );
}

export function PortalListDetailPlaceholder({
  title = "Select an item",
  hint = "Choose a row on the left to view details.",
}: {
  title?: string;
  hint?: string;
}) {
  return <InboxThreadEmpty title={title} hint={hint} />;
}

/** Page chrome for list-detail manager sections (mirrors Communication shell). */
export function PortalListPageShell({
  title,
  titleAside,
  filterRow,
  children,
  hideMobileFilterRow = false,
  hideMobileTitleActions = false,
  mobileDetailReading = false,
  compactFilterRow = true,
}: {
  title: string;
  titleAside?: ReactNode;
  filterRow?: ReactNode;
  children: ReactNode;
  hideMobileFilterRow?: boolean;
  hideMobileTitleActions?: boolean;
  mobileDetailReading?: boolean;
  compactFilterRow?: boolean;
}) {
  const aside =
    titleAside && hideMobileTitleActions ? <div className="max-md:hidden">{titleAside}</div> : titleAside;

  return (
    <ManagerPortalPageShell
      title={title}
      titleAside={aside}
      compactFilterRow={compactFilterRow}
      mobileHideFilterRow={hideMobileFilterRow}
      mobileFlush={mobileDetailReading}
      filterRow={
        filterRow ? (
          <ManagerPortalFilterRow className="mb-0 max-md:min-w-0 max-md:flex-1 max-md:flex-nowrap max-md:gap-2">
            {filterRow}
          </ManagerPortalFilterRow>
        ) : undefined
      }
    >
      <div className="portal-list-detail max-md:mt-0 max-md:-mx-0.5 md:mt-1">{children}</div>
    </ManagerPortalPageShell>
  );
}
