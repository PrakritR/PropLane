"use client";

import { Children, Fragment, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  BookOpen,
  CalendarClock,
  CalendarOff,
  CalendarPlus,
  CalendarSync,
  ClipboardCheck,
  Coins,
  Copy,
  Download,
  Phone,
  RefreshCw,
  Bell,
  Search,
  Send,
  Settings,
  Settings2,
  Share2,
  Filter,
  Upload,
  Wrench,
  X,
  UserPlus,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { DestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";
import { HorizontalScrollCapture, HORIZONTAL_SCROLL_ATTR } from "@/components/portal/portal-horizontal-scroll";
import { usePublishTitleActions } from "@/components/portal/portal-title-actions-slot";
import { syncPortalMobileTopChrome } from "@/lib/portal-mobile-top-chrome";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { cn } from "@/lib/utils";

/**
 * The list command band's whole icon vocabulary (`docs/portal-list-section-layout.md`
 * § "Command bar: icons only, one filled primary") — Filter · Settings ·
 * Share · Copy are the common case, the rest are the section-specific glyphs
 * already documented there (Calendar's Availability included).
 */
const PORTAL_LIST_BAND_ALLOWED_ICONS = new Set<LucideIcon>([
  Filter, // Filter (funnel)
  Settings, // Settings / Defaults — the product's one settings glyph (16 list bands use it)
  Settings2, // legacy alias; kept so an older caller does not trip the guard
  Share2, // Share link
  Copy, // Copy link
  CalendarPlus, // Add availability
  CalendarOff, // Block dates
  CalendarSync, // Link calendars
  RefreshCw, // Update from sheet
  BookOpen, // Vendor catalog
  Wrench, // Payment setup
  Phone, // Set up messaging
  CalendarClock, // Availability (Calendar band)
  Download, // Export CSV (N025)
  Coins, // Plan credit (admin Accounts, S27)
  Upload, // Upload / Import (documents, leases, properties)
  Send, // Send application link (Applications band)
  UserPlus, // Assign (service record, Vendor & schedule)
  Pencil, // Edit (service record, Service)
  Bell, // Send reminder (resident record: payments, lease signing, application consent)
  ClipboardCheck, // Add inspection (resident record: Move-in → Forms)
]);

/** `Add <noun>` — the one accessible-name shape a list band's primary uses. */
export function portalListAddPrimaryLabel(nounLabel: string): string {
  return `Add ${nounLabel}`;
}

/** Flatten Fragments/arrays into a flat list of real elements, same shape as record-action-menu's leaf walk. */
function flattenBandChildren(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment || child.type === "div") {
      out.push(...flattenBandChildren((child.props as { children?: ReactNode }).children));
      return;
    }
    out.push(child);
  });
  return out;
}

/**
 * Dev-only contract check for the list command band: only the documented
 * icon vocabulary, never a visibly labeled pill, never a ✕, and the primary's
 * accessible name reads "Add <noun>". This reports rather than throws —
 * several shipped panels (Properties' primary still says "Create", the
 * vendor catalog toolbar still has a ✕) have not adopted the rule yet, and a
 * throwing assertion would crash their render instead of just naming the gap
 * for the worker that owns that file to fix.
 */
function assertPortalListBandContract(filterRow: ReactNode, actions: ReactNode, primary: ReactNode) {
  if (process.env.NODE_ENV === "production") return;
  for (const leaf of [...flattenBandChildren(filterRow), ...flattenBandChildren(actions)]) {
    if (leaf.type === PortalIconAction) {
      const icon = (leaf.props as { icon?: LucideIcon }).icon;
      if (icon === X) {
        console.error("[portal-list-control-stack] a list band never draws a ✕ — found one in filterRow/actions.");
      } else if (icon && !PORTAL_LIST_BAND_ALLOWED_ICONS.has(icon)) {
        console.error(
          `[portal-list-control-stack] an icon outside the documented list-band vocabulary reached filterRow/actions: ${icon.displayName ?? icon.name ?? "unknown icon"} (docs/portal-list-section-layout.md).`,
        );
      }
      continue;
    }
    const props = leaf.props as { children?: ReactNode };
    const visibleText = typeof props.children === "string" ? props.children.trim() : "";
    if (visibleText && (leaf.type === "button" || leaf.type === "a")) {
      console.error(
        `[portal-list-control-stack] a labeled pill ("${visibleText}") reached the list band — utilities are icon-only (PortalIconAction).`,
      );
    }
  }
  if (isValidElement(primary) && primary.type === PortalPrimaryIconAction) {
    const label = (primary.props as { label?: string }).label ?? "";
    // "New message" is the one create action named for what it starts (C2-CM6).
    if (!/^(Add\s|New message$)/i.test(label)) {
      console.error(
        `[portal-list-control-stack] the band's primary accessible name is "${label}" — it must read "Add <noun>" (portalListAddPrimaryLabel).`,
      );
    }
  }
}

/** The row marker every shared record row carries (`portal-record-row.tsx`). */
const RECORD_ROW_SELECTOR = "[data-record-row]";

/**
 * How many record rows the page is showing right now - counted from the rows
 * in the DOM (a search, a filter, a tab or a collapsed group all change it), not
 * from a number each list has to remember to pass. Returns 0 until a row exists.
 */
function useShownRecordCount(ref: { current: HTMLElement | null }, enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const root: ParentNode = el.closest('[data-slot="portal-page-shell"]') ?? el.parentElement ?? document;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setCount(root.querySelectorAll(RECORD_ROW_SELECTOR).length);
    };
    const schedule = () => {
      if (frame) return;
      frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : (setTimeout(measure, 0) as unknown as number);
    };
    measure();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(schedule);
    observer.observe(root as Node, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [ref, enabled]);
  return count;
}

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
  primary,
  embedded = false,
  recordCount,
  controlsInBand = false,
  stats,
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
    inputClassName?: string;
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
  /**
   * The section's ONE prominent action — a {@link PortalPrimaryIconAction} —
   * drawn last in the command bar. It used to float alone in a headline row
   * above the list (PLAN-0914-1345 removed that row): nothing sits above the
   * command bar now but the app bar.
   */
  primary?: ReactNode;
  /** When true, render inside a parent card (Communication list header) — no nested bordered surface. */
  embedded?: boolean;
  /** Overrides the "N records" figure the tools line derives from the rows on screen. */
  recordCount?: number;
  /**
   * A tab with no tabs and no search keeps its controls in its own band instead of publishing them
   * into the record header, so a record's constant header icons (Edit, Delete) are never replaced.
   */
  controlsInBand?: boolean;
  /**
   * A PortalStatStrip between the tabs and the tools line (money lists: the bucket totals).
   * A band that carries one scrolls with the page instead of sticking, so the strip never
   * pins a third of a phone screen.
   */
  stats?: ReactNode;
}) {
  assertPortalListBandContract(filterRow, actions, primary);
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
   * hold but its controls; they still get the same card as every other tab.
   */
  const controlsOnly = !controlsInBand && variant === "command" && !showDestinations && !search && Boolean(filterRow || actions || primary);
  /*
   * The list's icon actions and its round + sit on the title row, at the right
   * (approved list anatomy: title, then Filter / Settings icons and the blue +).
   * The page shell that owns the title provides the slot; with no slot (a stack
   * inside a record page, a test) they render in the band as before.
   */
  const controlsNode =
    variant === "command" && !embedded && (filterRow || actions || primary) ? (
      <div className="flex items-center gap-1 sm:gap-1.5 [&_button]:shrink-0 [&_a]:shrink-0" data-attr="portal-list-command-actions">
        {filterRow}
        {actions}
        {primary}
      </div>
    ) : null;
  const publishedToTitle = usePublishTitleActions(controlsNode, controlsNode != null, { pageOnly: !controlsOnly });
  const toolsRef = useRef<HTMLDivElement>(null);
  const showToolsLine = variant === "command" && !embedded && Boolean(search || activeFilterChips);
  const shownCount = useShownRecordCount(toolsRef, showToolsLine);
  const count = recordCount ?? shownCount;

  if (!showDestinations && !showFindRow && !activeFilterChips && !actions && !primary) return null;

  if (controlsOnly) {
    if (publishedToTitle) {
      return activeFilterChips ? (
        <div className={cn("shrink-0", className)} data-slot="portal-list-control-stack" data-variant="command">
          <div className="min-w-0" data-attr="portal-list-active-filter-chips">{activeFilterChips}</div>
        </div>
      ) : null;
    }
    /*
     * Controls with no tabs and no search (Vendors) still get the
     * same card as every other section — never a bare right-aligned row on
     * the canvas, which is what "three loose pills" looked like.
     */
    return (
      <div className={cn("shrink-0 space-y-2", className)} data-slot="portal-list-control-stack" data-variant="command">
        <div className="flex min-w-0 items-center justify-end border-b border-border px-4 py-1.5 lg:px-[22px]">{controlsNode}</div>
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
    const showToolRow = Boolean(filterRow || search || actions || primary);
    const chipsNode = activeFilterChips ? (
      <div className="min-w-0 shrink-0" data-attr="portal-list-active-filter-chips">
        {activeFilterChips}
      </div>
    ) : null;
    const searchNode = search ? (
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-0 top-1/2 size-4 -translate-y-1/2 text-muted/70"
          strokeWidth={1.75}
          aria-hidden
        />
        <Input
          id="portal-list-search"
          type="search"
          name="q"
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          placeholder={search.placeholder}
          aria-label={search.ariaLabel ?? search.placeholder}
          className={cn(
            // Borderless inline search on the tools line: glyph, 13.5px, no field chrome.
            "portal-list-search h-[30px] min-h-[30px] w-full rounded-md border-0 bg-transparent py-0 pl-7 pr-2 text-[13.5px] shadow-none outline-none focus:bg-transparent focus:ring-0 max-lg:min-h-11",
            search.inputClassName,
          )}
          data-attr={search.dataAttr ?? "portal-list-search"}
          data-search=""
        />
      </div>
    ) : (
      <div className="min-w-0 flex-1" aria-hidden />
    );
    const inlineControlsNode = filterRow || actions || primary ? (
      <div
        className={cn(
          "flex shrink-0 flex-nowrap items-center gap-0.5 overflow-x-auto sm:gap-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "[&_button]:shrink-0 [&_a]:shrink-0",
        )}
        data-attr="portal-list-command-actions"
      >
        {filterRow}
        {actions}
        {primary}
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
            !embedded &&
            !stats &&
            "sticky z-[38] bg-background/95 backdrop-blur-md [top:var(--portal-mobile-top-chrome,0px)]",
          embedded && "border-t border-border/60",
          className,
        )}
        data-slot="portal-list-control-stack"
        data-variant="command"
        data-embedded={embedded ? "" : undefined}
        data-sticky={stickyDestinations && !embedded && !stats ? "" : undefined}
      >
        {embedded ? (
          <HorizontalScrollCapture
            className={cn(
              "flex min-w-0 flex-row flex-nowrap items-center gap-1.5 overflow-x-auto px-1 py-1 sm:gap-2 sm:pr-1",
              "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            )}
            data-attr="portal-list-command-embedded-row"
            {...{ [HORIZONTAL_SCROLL_ATTR]: "" }}
          >
            {showDestinations ? (
              // The tabs yield (and scroll in their own box) before the round + does: a crowded
              // band used to scroll as a whole and push the + off the card's right edge on a phone.
              <div className="flex min-w-0 shrink items-center gap-2 overflow-x-auto py-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-portal-list-destination-nav>
                {destinationContent}
                <span className="lg:hidden">{chipsNode}</span>
              </div>
            ) : null}
            {showToolRow || chipsNode ? (
              <div
                className="flex shrink-0 grow flex-nowrap items-center gap-1 sm:gap-1.5"
                data-attr="portal-list-command-utilities"
              >
                {searchNode}
                <span className="hidden lg:contents">{chipsNode}</span>
                {inlineControlsNode}
              </div>
            ) : null}
          </HorizontalScrollCapture>
        ) : (
          // The header band under the title: underline tabs with counts, a hairline, then ONE
          // tools line (search glyph + field, the derived "N records") with its own hairline.
          // Padding is the page's 22px (16px on a phone); the page shell lets this band run
          // edge to edge (globals.css, `data-slot="portal-list-control-stack"`).
          <div className="min-w-0 bg-background" data-attr="portal-list-band">
            {showDestinations ? (
              <div className="flex min-w-0 items-end gap-2 border-b border-border px-[22px] max-lg:px-4">
                <HorizontalScrollCapture className="min-w-0 flex-1">
                  <div className="flex items-center gap-2" data-portal-list-destination-nav>
                    {destinationContent}
                  </div>
                </HorizontalScrollCapture>
                {publishedToTitle ? null : <div className="shrink-0 self-center py-1">{inlineControlsNode}</div>}
              </div>
            ) : null}
            {stats ? (
              <div className="min-w-0 px-[22px] pb-1.5 pt-3.5 max-lg:px-4" data-attr="portal-list-stats">
                {stats}
              </div>
            ) : null}
            {showToolRow || chipsNode ? (
              showToolsLine || (!showDestinations && !publishedToTitle) ? (
                <div
                  ref={toolsRef}
                  className="flex min-w-0 items-center gap-2 border-b border-border px-[22px] py-1.5 max-lg:px-4"
                  data-attr="portal-list-command-utilities"
                >
                  {searchNode}
                  {chipsNode}
                  {count > 0 ? (
                    <span className="shrink-0 text-[12.5px] tabular-nums text-muted/75" data-slot="portal-list-count">
                      {count} {count === 1 ? "record" : "records"}
                    </span>
                  ) : null}
                  {!showDestinations && !publishedToTitle ? inlineControlsNode : null}
                </div>
              ) : null
            ) : null}
          </div>
        )}
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
                id="portal-list-search"
                type="search"
                name="q"
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
