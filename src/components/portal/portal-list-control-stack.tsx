"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";
import { HorizontalScrollCapture, HORIZONTAL_SCROLL_ATTR } from "@/components/portal/portal-horizontal-scroll";
import { syncPortalMobileTopChrome } from "@/lib/portal-mobile-top-chrome";
import { cn } from "@/lib/utils";

/**
 * Appendix F — Communication-style list chrome (exactly three bands above data):
 * 1. Title + axis switch + actions — {@link ManagerPortalPageShell} / {@link PageHeader}
 * 2. Routed destination tabs with counts — `destinations` below
 * 3. Filter & sort + search — `filterRow` + `search`; active filters as `activeFilterChips`
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

  if (!showDestinations && !showFindRow && !activeFilterChips && !actions) return null;

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
    const showToolRow = Boolean(filterRow || search || actions);
    const chipsNode = activeFilterChips ? (
      <div className="min-w-0 shrink-0" data-attr="portal-list-active-filter-chips">
        {activeFilterChips}
      </div>
    ) : null;
    const searchNode = search ? (
      <div className="relative min-w-[6rem] flex-1">
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
    ) : (
      <div className="min-w-0 flex-1" aria-hidden />
    );
    const controlsNode = filterRow || actions ? (
      <div
        className={cn(
          "flex shrink-0 flex-nowrap items-center gap-0.5 overflow-x-auto sm:gap-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "[&_button]:shrink-0 [&_a]:shrink-0",
        )}
        data-attr="portal-list-command-actions"
      >
        {filterRow}
        {actions}
      </div>
    ) : null;
    return (
      <div
        ref={stickyDestinations ? destinationRef : undefined}
        className={cn(
          "shrink-0",
          // Sticky the whole command chrome (tabs + Settings/actions), not only the
          // destination strip — Settings lived outside the old sticky wrapper (PRP-389).
          stickyDestinations &&
            "sticky z-[38] bg-background/95 backdrop-blur-md [top:var(--portal-mobile-top-chrome,0px)]",
          className,
        )}
        data-slot="portal-list-control-stack"
        data-variant="command"
        data-sticky={stickyDestinations ? "" : undefined}
      >
        <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card shadow-sm lg:flex-row lg:items-center lg:gap-2 lg:pr-2">
          {showDestinations ? (
            <HorizontalScrollCapture
              className={cn(
                "min-w-0 border-border px-1 pt-1 lg:shrink-0 lg:border-b-0 lg:py-1",
                showToolRow && "max-lg:border-b",
              )}
            >
              <div className="flex items-center gap-2" data-portal-list-destination-nav>
                {destinationContent}
                {/* Chips ride in the scrolling strip on phones, beside search on desktop. */}
                <span className="lg:hidden">{chipsNode}</span>
              </div>
            </HorizontalScrollCapture>
          ) : null}
          {showToolRow || chipsNode ? (
            <div
              className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 px-1.5 py-1 sm:gap-1.5 sm:px-2 lg:px-0 lg:py-0"
              data-attr="portal-list-command-utilities"
            >
              {searchNode}
              <span className="hidden lg:contents">{chipsNode}</span>
              {controlsNode}
            </div>
          ) : null}
        </div>
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
