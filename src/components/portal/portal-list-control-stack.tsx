"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";
import { HorizontalScrollCapture, HORIZONTAL_SCROLL_ATTR } from "@/components/portal/portal-horizontal-scroll";
import { PortalTitleActionsHost, usePublishTitleActions } from "@/components/portal/portal-title-actions-slot";
import { syncPortalMobileTopChrome } from "@/lib/portal-mobile-top-chrome";
import { cn } from "@/lib/utils";

/**
 * List command chrome — `variant="command"` is one horizontal toolbar (tabs · search ·
 * filters · utilities · + Add). {@link ManagerPortalPageShell} may inject `chromeTitle` /
 * `chromePrimaryAction` so the headline row is not duplicated.
 */
export function PortalListControlStack({
  filterRow,
  destinations,
  activeDestinationId,
  destinationAriaLabel = "Section views",
  destinationRow,
  search,
  activeFilterChips,
  className,
  /** When true, destination tabs respect page horizontal padding on mobile (no bleed). */
  destinationInset = false,
  /** When false, destination tabs scroll with the list instead of sticking under the mobile nav. */
  stickyDestinations = true,
  /** `toolbar` renders compact segment tabs (Communication Active / Unread / Archived). */
  destinationNavSize = "default",
  /** Equal-width destination tabs that fit one row on phones (house details, property detail). */
  destinationItemLayout = "auto",
  destinationDenseEqualRow = false,
  /** `command` composes destinations, search, filters, and utilities into one adaptive surface. */
  variant = "stacked",
  actions,
  chromeTitle,
  chromeTitleCount,
  chromePrimaryAction,
  chromeHideTitleOnMobile = false,
}: {
  /** Typically {@link PortalFilterSortSheet} (mobile sheet; optional desktop inline pills or panel modal). */
  filterRow?: ReactNode;
  destinations?: DestinationNavItem[];
  activeDestinationId?: string;
  destinationAriaLabel?: string;
  /** When set, renders instead of {@link DestinationNav} (e.g. local-state pill rows). */
  destinationRow?: ReactNode;
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    dataAttr?: string;
    ariaLabel?: string;
  };
  /** Removable chips when filters are active (Appendix F band 3). */
  activeFilterChips?: ReactNode;
  className?: string;
  destinationInset?: boolean;
  stickyDestinations?: boolean;
  destinationNavSize?: "default" | "toolbar";
  destinationItemLayout?: "auto" | "equal";
  destinationDenseEqualRow?: boolean;
  variant?: "stacked" | "command";
  /** Low-frequency utility controls that follow search/filter in the command layout. */
  actions?: ReactNode;
  /** Injected by {@link ManagerPortalPageShell} — title beside tabs on one command row. */
  chromeTitle?: string;
  chromeTitleCount?: number;
  chromePrimaryAction?: ReactNode;
  /** When true, visual title hides on phones (nav already names the section). */
  chromeHideTitleOnMobile?: boolean;
}) {
  const showDestinations = Boolean(destinationRow) || (destinations && destinations.length > 0);
  const showFindRow = Boolean(filterRow || search);
  const destinationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = destinationRef.current;
    if (!el || !showDestinations || !stickyDestinations) return;
    const sync = () => syncPortalMobileTopChrome(el);
    sync();
    const main = el.closest("#portal-main-content");
    const mobileBar = main?.querySelector(".portal-mobile-nav-bar");
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(sync);
      if (mobileBar) ro.observe(mobileBar);
      ro.observe(el);
    }
    window.addEventListener("resize", sync);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", sync);
      const mobileBar = main?.querySelector<HTMLElement>(".portal-mobile-nav-bar");
      if (mobileBar) syncPortalMobileTopChrome(mobileBar);
    };
  }, [showDestinations, stickyDestinations]);

  /*
   * A tab with no status pills and no search has nothing for a toolbar to
   * hold but its controls. Those go beside the page title (the shell owns a
   * slot for them) instead of into a white bar of their own; where no title
   * slot exists they render as a bare right-aligned row, never a card.
   */
  const controlsOnly = variant === "command" && !showDestinations && !search && Boolean(filterRow || actions);
  const controlsOnlyNode = controlsOnly ? (
    <div className="flex items-center gap-1 sm:gap-1.5 [&_button]:shrink-0 [&_a]:shrink-0" data-attr="portal-list-command-actions">
      {filterRow}
      {actions}
    </div>
  ) : null;
  const publishedToTitle = usePublishTitleActions(controlsOnlyNode, controlsOnly);

  if (!showDestinations && !showFindRow && !activeFilterChips && !actions) return null;

  if (controlsOnly) {
    if (publishedToTitle) {
      return activeFilterChips ? (
        <div className={cn("shrink-0", className)} data-slot="portal-list-control-stack" data-variant="command">
          <div className="min-w-0" data-attr="portal-list-active-filter-chips">{activeFilterChips}</div>
        </div>
      ) : null;
    }
    return (
      <div className={cn("shrink-0 space-y-2", className)} data-slot="portal-list-control-stack" data-variant="command">
        <div className="flex justify-end">{controlsOnlyNode}</div>
        {activeFilterChips ? <div className="min-w-0" data-attr="portal-list-active-filter-chips">{activeFilterChips}</div> : null}
      </div>
    );
  }

  const destinationContent =
    destinationRow ?? (
      <DestinationNav
        items={destinations!}
        activeId={activeDestinationId}
        ariaLabel={destinationAriaLabel}
        size={destinationNavSize}
        itemLayout={destinationItemLayout}
        denseEqualRow={destinationDenseEqualRow}
        appearance={variant === "command" ? "command" : "segmented"}
        className={cn(
          destinationNavSize === "toolbar"
            ? "gap-0.5 rounded-xl border-0 bg-transparent p-0"
            : variant === "stacked" &&
                "max-lg:rounded-none max-lg:border-0 max-lg:border-b max-lg:border-border max-lg:bg-transparent",
          variant === "stacked" &&
            destinationNavSize !== "toolbar" &&
            (destinationInset
              ? "max-lg:gap-2.5 max-lg:p-1"
              : "max-lg:gap-2.5 max-lg:px-2.5 max-lg:py-0 sm:max-lg:px-4"),
        )}
      />
    );

  if (variant === "command") {
    /*
     * ONE toolbar (Mobbin polish §10): tabs with counts · search · the active
     * filter chips · the view controls, on a single row at desktop width. The
     * second, icon-only bar that used to sit under the tabs is gone. On a
     * phone the tabs (and chips) are a horizontally scrolling sticky strip and
     * the search sits on its own line beneath — the same pieces, stacked.
     */
    const chipsNode = activeFilterChips ? (
      <div className="min-w-0 shrink-0" data-attr="portal-list-active-filter-chips">
        {activeFilterChips}
      </div>
    ) : null;
    const controlsNode = filterRow || actions ? (
      <div
        className={cn(
          "flex shrink-0 flex-nowrap items-center gap-0.5 sm:gap-1",
          "[&_button]:shrink-0 [&_a]:shrink-0",
        )}
        data-attr="portal-list-command-actions"
      >
        {filterRow}
        {actions}
      </div>
    ) : null;
    const titleNode = chromeTitle ? (
      <h1
        className={cn(
          "shrink-0 text-base font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-lg",
          chromeHideTitleOnMobile && "max-lg:sr-only",
        )}
        data-slot="portal-page-headline-title"
      >
        {chromeTitle}
        {typeof chromeTitleCount === "number" ? (
          <span className="ml-1.5 inline-flex rounded-full bg-accent px-2 py-0.5 text-xs font-semibold tabular-nums text-muted">
            {chromeTitleCount}
          </span>
        ) : null}
      </h1>
    ) : null;
    const chromeInjection = Boolean(chromeTitle || chromePrimaryAction);
    const primaryNode = chromePrimaryAction ? (
      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5" data-portal-action-slot="">
        <PortalTitleActionsHost className="flex items-center gap-1 sm:gap-1.5" />
        {chromePrimaryAction}
      </div>
    ) : null;
    const inlineSearchNode = search ? (
      <div
        className={cn(
          "relative min-w-[6rem]",
          chromeInjection ? "hidden min-w-0 flex-1 sm:flex" : "min-w-0 flex-1",
        )}
      >
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted"
          strokeWidth={1.75}
          aria-hidden
        />
        <Input
          type="search"
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          placeholder={search.placeholder}
          aria-label={search.ariaLabel ?? search.placeholder}
          className="portal-list-search h-10 min-h-10 w-full rounded-lg border-0 bg-transparent py-2 pl-8 pr-2 text-sm shadow-none outline-none focus:bg-[var(--secondary)]/50 focus:ring-0"
          data-attr={search.dataAttr ?? "portal-list-search"}
        />
      </div>
    ) : null;
    return (
      <div
        ref={stickyDestinations ? destinationRef : undefined}
        className={cn(
          "shrink-0",
          stickyDestinations &&
            "sticky z-[38] bg-background/95 backdrop-blur-md [top:var(--portal-mobile-top-chrome,0px)]",
          className,
        )}
        data-slot="portal-list-control-stack"
        data-variant="command"
        data-unified-chrome={chromeInjection ? "" : undefined}
        data-sticky={stickyDestinations ? "" : undefined}
      >
        <HorizontalScrollCapture className="min-w-0 rounded-xl border border-border bg-card px-1 py-1 shadow-sm sm:px-1.5">
          <div
            className="flex min-w-0 flex-nowrap items-center gap-1.5 sm:gap-2"
            data-attr="portal-list-command-toolbar"
          >
            {titleNode}
            {showDestinations ? (
              <div className="flex min-w-0 shrink-0 items-center gap-2" data-portal-list-destination-nav>
                {destinationContent}
              </div>
            ) : null}
            {inlineSearchNode}
            {chipsNode}
            {controlsNode}
            {primaryNode}
          </div>
        </HorizontalScrollCapture>
        {chromeInjection && search ? (
          <div
            className="mt-1.5 flex min-w-0 flex-nowrap items-center gap-1 rounded-xl border border-border bg-card px-2 py-1 shadow-sm sm:hidden"
            data-attr="portal-list-command-search-row"
          >
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted"
                strokeWidth={1.75}
                aria-hidden
              />
              <Input
                type="search"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={search.placeholder}
                aria-label={search.ariaLabel ?? search.placeholder}
                className="portal-list-search h-10 min-h-10 w-full rounded-lg border-0 bg-transparent py-2 pl-8 pr-2 text-sm shadow-none outline-none focus:bg-[var(--secondary)]/50 focus:ring-0"
                data-attr={search.dataAttr ?? "portal-list-search"}
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("shrink-0 space-y-2 max-lg:space-y-2.5", className)} data-slot="portal-list-control-stack">
      {showDestinations ? (
        <HorizontalScrollCapture
          className={cn(
            stickyDestinations && "sticky z-[38] bg-background/95 backdrop-blur-md",
            destinationInset ? "mx-0" : "-mx-2.5 sm:-mx-4",
            stickyDestinations && "[top:var(--portal-mobile-top-chrome,0px)]",
          )}
        >
          <div ref={destinationRef} data-portal-list-destination-nav>
            {destinationContent}
          </div>
        </HorizontalScrollCapture>
      ) : null}
      {showFindRow ? (
        <div className="flex w-full min-w-0 items-stretch gap-x-2 gap-y-3 max-md:flex-col md:items-center">
          {filterRow ? <div className="min-w-0 flex-1">{filterRow}</div> : null}
          {search ? (
            <div
              className={cn(
                "min-w-0",
                filterRow
                  ? "w-full md:max-w-[14rem] md:shrink-0"
                  : "flex-1 -mx-2.5 px-2.5 sm:-mx-4 sm:px-4",
              )}
            >
              <Input
                type="search"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={search.placeholder}
                aria-label={search.ariaLabel ?? search.placeholder}
                className="portal-list-search h-9 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                data-attr={search.dataAttr ?? "portal-list-search"}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {activeFilterChips ? <div className="min-w-0">{activeFilterChips}</div> : null}
    </div>
  );
}

PortalListControlStack.displayName = "PortalListControlStack";
