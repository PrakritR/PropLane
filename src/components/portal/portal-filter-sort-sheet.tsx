"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect, useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PortalFilterDeferProvider,
  type PortalFilterDeferController,
} from "@/lib/portal-filter-draft";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { Modal, MODAL_HEADER_CLOSE_CLASS, ModalFooter } from "@/components/ui/modal";
import { VaulBottomSheet } from "@/components/ui/vaul-bottom-sheet";
import {
  PORTAL_FILTER_PANEL_SIZE_CLASS,
  PORTAL_FILTER_PANEL_WIDTH_CLASS,
  PORTAL_FILTER_BODY_CLASS,
  PORTAL_FILTER_ICON_CLASS,
  PORTAL_FILTER_COMPACT_MOBILE_SHEET_CLASS,
  PORTAL_FILTER_RAISED_SHEET_MIN_HEIGHT_PX,
  portalFilterDropdownHeightPx,
  portalFilterDropdownWidthPx,
  portalFilterPanelSizeClass,
  FilterFieldsAccordionScope,
  FilterSheetScrollLockContext,
} from "@/components/portal/filter-field-lists";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import {
  fieldSelectMenuZIndex,
  useFieldSelectMenu,
} from "@/components/ui/field-select-menu";
import { useIsClient } from "@/hooks/use-is-client";
import {
  FIELD_SELECT_MENU_DATA_ATTR,
  FILTER_SHEET_DISMISS_GUARD_MS,
  FILTER_SHEET_OPEN_SUPPRESS_MS,
  registerFilterSheetDismissGuard,
  registerFilterSheetOpenSuppress,
} from "@/components/ui/field-select-portal-interaction";
import { lockPortalScroll } from "@/lib/native/lock-portal-scroll";
import { useSafeAreaInsets } from "@/hooks/use-safe-area-insets";
import { usePortalSurface } from "@/components/ui/portal-surface";
import { cn } from "@/lib/utils";


/**
 * The mobile Filter surface (anchored popover vs. Vaul bottom sheet) is chosen ONCE, at the
 * moment the panel opens, and held for that panel's whole life — never re-evaluated on
 * scroll/resize/nested-field-menu-open. The popover only exists for `desktopPresentation
 * === "dropdown"` (the only presentation with an anchored path at all) and only when the
 * trigger is genuinely measurable with real room below it; otherwise fall back to the
 * existing bottom sheet exactly as before.
 */
export const PORTAL_FILTER_POPOVER_MIN_SPACE_BELOW_PX = 260;
export const PORTAL_FILTER_POPOVER_MAX_FIELDS = 4;

export function resolveMobileFilterPopover(args: {
  trigger: HTMLElement | null;
  desktopPresentation: "inline" | "panel" | "dropdown";
  compactPanel: boolean;
  filterFieldCount: number;
  hasExtraModalContent: boolean;
  insets: { bottom: number; bottomNav: number };
}): boolean {
  const { trigger, desktopPresentation, compactPanel, filterFieldCount, hasExtraModalContent, insets } = args;
  // `panel` and `inline` keep the sheet — only `dropdown` has an anchored path at all.
  if (desktopPresentation !== "dropdown") return false;
  if (!compactPanel) return false;
  if (filterFieldCount > PORTAL_FILTER_POPOVER_MAX_FIELDS) return false;
  if (hasExtraModalContent) return false;
  // An unmeasurable trigger cannot honestly claim there is room below it — fail safe to the sheet.
  if (!trigger) return false;
  const rect = trigger.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return false;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const spaceBelow = viewportHeight - rect.bottom - 12 - insets.bottom - insets.bottomNav;
  return spaceBelow >= PORTAL_FILTER_POPOVER_MIN_SPACE_BELOW_PX;
}

function FilterResetLink({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button"
      className="text-xs font-semibold text-primary hover:underline"
      onClick={onReset}
      data-attr="portal-filter-reset"
    >
      Reset
    </button>
  );
}

/**
 * What the primary action promises.
 *
 * "Save" says nothing about the consequence, so the only way to find out
 * whether a filter combination leaves anything behind is to apply it and look.
 * The count comes from the SAME predicate the list renders from — the caller
 * passes the length of the rows the draft filters would produce — so "Show 0
 * tasks" warns before the commit rather than after it. A caller that cannot
 * cheaply compute that passes nothing and keeps the plain label.
 */
export function filterApplyLabel(resultCount: number | undefined, noun: string | undefined): string {
  if (resultCount == null) return "Save";
  const word = noun?.trim() || "result";
  return `Show ${resultCount} ${resultCount === 1 ? word : `${word}s`}`;
}

function FilterSheetFooter({
  onReset,
  onSave,
  applyLabel,
}: {
  onReset: () => void;
  onSave: () => void;
  applyLabel?: ReactNode;
}) {
  return (
    <ModalFooter className="w-full justify-between">
      <FilterResetLink onReset={onReset} />
      <Button type="button" variant="primary" className="rounded-full" onClick={onSave} data-attr="portal-filter-save">
        {applyLabel ?? "Save"}
      </Button>
    </ModalFooter>
  );
}

/**
 * Title and dismiss only.
 *
 * Reset used to sit up here as well, which put it a long way from the action it
 * undoes and gave the panel two competing controls in its top-right corner. It
 * now lives in the footer next to Apply, so the panel reads title → fields →
 * what you can do about them.
 */
function FilterDropdownHeader({ onClose }: { onClose: () => void }) {
  return (
    <div
      data-field-select-host-chrome=""
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2"
    >
      <p className="text-sm font-semibold text-foreground">Filter</p>
      <button
        type="button"
        className={MODAL_HEADER_CLOSE_CLASS}
        aria-label="Close filters"
        onClick={onClose}
        data-attr="portal-filter-close"
      >
        <X className="h-4 w-4" strokeWidth={2.25} />
      </button>
    </div>
  );
}

function FilterPanelFields({
  children,
  extraModalContent,
  onReset,
  compact = false,
  scrollLocked = false,
}: {
  children: ReactNode;
  extraModalContent?: ReactNode;
  onReset: () => void;
  compact?: boolean;
  /** A portaled field menu is open — freeze this scroll region so it cannot drift under it. */
  scrollLocked?: boolean;
}) {
  /* `fields` is shared by ALL THREE presentations (mobile sheet, desktop dropdown, desktop
     panel). The dropdown gives it a FIXED inline height inside `overflow-hidden`, so without
     `min-h-0 flex-1` here plus a real scroll region below, a long field list is silently
     clipped with no scrollbar instead of scrolling to its last option. */
  return (
    <div className={compact ? "flex min-h-0 flex-col overflow-visible" : "flex min-h-0 flex-1 flex-col"}>
      {!compact ? (
        <div className="flex shrink-0 justify-end px-3 pb-1">
          <FilterResetLink onReset={onReset} />
        </div>
      ) : null}
      <div
        className={cn(
          "min-h-0 overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]",
          !compact && "flex-1",
          scrollLocked ? "overflow-y-hidden" : "overflow-y-auto",
        )}
      >
        <div className="flex min-w-0 max-w-full flex-col gap-3 max-lg:gap-2.5">
          {children}
          {extraModalContent}
        </div>
      </div>
    </div>
  );
}

function FilterDropdownBody({
  children,
  extraModalContent,
  onReset,
  compact,
}: {
  children: ReactNode;
  extraModalContent?: ReactNode;
  onReset: () => void;
  compact: boolean;
}) {
  const [scrollLocked, setScrollLocked] = useState(false);
  return (
    <FilterSheetScrollLockContext.Provider value={setScrollLocked}>
      <FilterFieldsAccordionScope>
        <FilterPanelFields
          onReset={onReset}
          extraModalContent={extraModalContent}
          compact={compact}
          scrollLocked={scrollLocked}
        >
          {children}
        </FilterPanelFields>
      </FilterFieldsAccordionScope>
    </FilterSheetScrollLockContext.Provider>
  );
}

/**
 * Compact portal toolbar filter pattern (Communication / Payments):
 * `inline` — mobile Vaul bottom sheet + inline controls from `md` up (default).
 * `panel` — Filter button on all breakpoints; sheet on mobile, modal on desktop.
 * `dropdown` — Filter button on all breakpoints; anchored popover on `md+`,
 *   bottom sheet on phones (field menus scroll reliably inside the sheet).
 */
export function PortalFilterSortSheet({
  children,
  activeCount = 0,
  onReset = () => {},
  dataAttr = "portal-filter-sheet-open",
  extraModalContent,
  className,
  desktopPresentation = "dropdown",
  compactPanel = true,
  /** Number of filter rows — sizes the desktop dropdown (1 = property only, 3 = property + resident + sort). */
  filterFieldCount = 1,
  /** Override fixed panel dimensions (modal / desktop dropdown). */
  panelSizeClassName,
  /** Override mobile sheet inner height/layout (default compact 14rem strip). */
  mobileSheetClassName,
  /** When false, sheet body uses horizontal padding like standard modals. */
  mobileFlushBody = false,
  mobileFooter,
  /**
   * The primary action's label, turning "Save" into "Show 12 tasks".
   *
   * It is rendered INSIDE the draft provider, which is the whole reason it is a
   * node and not a number: while the panel is open the page's own state is
   * deliberately stale, so a count passed in from the caller's render would
   * report the filters as they were before this edit. A node placed here can
   * read the PENDING values with `usePortalFilterDraftValues` and count what
   * pressing the button will actually produce.
   */
  applyLabel,
  /**
   * Fill the viewport instead of ending where the content ends.
   *
   * This used to default to TRUE, which is why a four-field filter sheet opened
   * as a full-height phone panel with a band of empty white between its last
   * field and its Save button. A sheet now hugs its content up to the sheet's
   * own ceiling; only a surface that genuinely fills the screen (browse-homes)
   * opts back in.
   */
  mobileSheetFillsViewport = false,
  /** Legacy raised placement — leaves a gap above the tab bar; prefer the default fill. */
  mobileSheetRaised = false,
  /** Keep portal popovers inside the page content instead of covering an adjacent rail. */
  constrainDropdownToTitleBand = true,
  /** Pin the desktop dropdown's left edge to the trigger (command-strip filters on the left). */
  dropdownAlign = "start",
  commandStripTrigger = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: {
  children: ReactNode;
  activeCount?: number;
  onReset?: () => void;
  dataAttr?: string;
  extraModalContent?: ReactNode;
  className?: string;
  desktopPresentation?: "inline" | "panel" | "dropdown";
  compactPanel?: boolean;
  filterFieldCount?: number;
  panelSizeClassName?: string;
  mobileSheetClassName?: string;
  mobileFlushBody?: boolean;
  mobileFooter?: ReactNode | ((close: () => void) => ReactNode);
  applyLabel?: ReactNode;
  mobileSheetFillsViewport?: boolean;
  mobileSheetRaised?: boolean;
  /** Enabled by default; outside a portal page this safely falls back to viewport bounds. */
  constrainDropdownToTitleBand?: boolean;
  /** Desktop dropdown horizontal alignment to the Filter trigger. */
  dropdownAlign?: "start" | "end";
  /** Match list command-strip outline buttons (Properties Share, Residents Filter). */
  commandStripTrigger?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const dismissGuardUntilRef = useRef(0);
  const openSuppressUntilRef = useRef(0);
  const deferControllerRef = useRef<PortalFilterDeferController | null>(null);
  const openRef = useRef(false);
  const dropdownPanelRef = useRef<HTMLDivElement | null>(null);
  /*
   * Whether this is a touch surface, NOT merely whether the window is narrow.
   *
   * The old rule was width alone, so a Mac with a browser window under 1024px
   * was handed a phone bottom sheet — grabber handle included — which is what
   * every one of the captain's 2026-09-13 screenshots is. `usePortalSurface`
   * asks about the pointer first and keeps width only as the tiebreak for a
   * touchscreen laptop. See `ui/portal-surface.ts`.
   */
  const isMobile = usePortalSurface("toolbar") === "sheet";
  const insets = useSafeAreaInsets();
  // Decided ONCE per open (in `setFilterOpen`, or the controlled-case safety net below) and
  // held for the panel's whole life — nothing else may write this.
  const [mobilePopover, setMobilePopover] = useState(false);
  const decidedForOpenRef = useRef(false);

  // Synced in a layout effect, not during render: the dismiss-guard callbacks
  // that read it run from pointer handlers and layout effects, both after this.
  useLayoutEffect(() => {
    openRef.current = open;
  });

  const armSheetDismissGuard = useCallback(() => {
    dismissGuardUntilRef.current = Date.now() + FILTER_SHEET_DISMISS_GUARD_MS;
  }, []);

  const armSheetOpenSuppress = useCallback(() => {
    openSuppressUntilRef.current = Date.now() + FILTER_SHEET_OPEN_SUPPRESS_MS;
  }, []);

  useEffect(() => registerFilterSheetDismissGuard(armSheetDismissGuard), [armSheetDismissGuard]);
  useEffect(() => registerFilterSheetOpenSuppress(armSheetOpenSuppress), [armSheetOpenSuppress]);

  useEffect(() => {
    if (!open) setFilterMenuOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return lockPortalScroll();
  }, [open]);

  const applyOpenTransition = useCallback((prev: boolean, next: boolean) => {
    if (next && !prev) {
      deferControllerRef.current?.snapshotFromApplied();
    } else if (!next && prev) {
      deferControllerRef.current?.commitAll();
    }
  }, []);

  const setFilterOpen = useCallback(
    (
      next: boolean | ((prev: boolean) => boolean),
      options?: { bypassDismissGuard?: boolean; trigger?: HTMLElement | null },
    ) => {
      const prev = openRef.current;
      const resolved = typeof next === "function" ? next(prev) : next;
      if (resolved && Date.now() < openSuppressUntilRef.current) return;
      /* Every portal filter surface dismisses only through the header ✕ (`close()`). */
      if (!resolved && !options?.bypassDismissGuard) return;
      applyOpenTransition(prev, resolved);
      if (resolved && !prev) {
        // Decide the mobile surface HERE, in the same batch as the open state, so the
        // first render of the open panel already has the right surface. `buttonRef`
        // (from `useFieldSelectMenu`) isn't in scope yet at this point in the component,
        // so every real open call site below passes its element explicitly as `trigger`.
        decidedForOpenRef.current = true;
        setMobilePopover(
          resolveMobileFilterPopover({
            trigger: options?.trigger ?? null,
            desktopPresentation,
            compactPanel,
            filterFieldCount,
            hasExtraModalContent: extraModalContent != null,
            insets,
          }),
        );
      } else if (!resolved && prev) {
        decidedForOpenRef.current = false;
        setMobilePopover(false);
      }
      if (!isControlled) setUncontrolledOpen(resolved);
      onOpenChange?.(resolved);
    },
    [
      applyOpenTransition,
      isControlled,
      onOpenChange,
      desktopPresentation,
      compactPanel,
      filterFieldCount,
      extraModalContent,
      insets,
    ],
  );

  const close = useCallback(() => {
    setFilterOpen(false, { bypassDismissGuard: true });
  }, [setFilterOpen]);

  /**
   * Close from a POINTER — the trigger or the backdrop. A multi-select pick
   * inside a portaled field menu can be followed by a synthesized "ghost"
   * click that lands wherever the finger was, and if that is the Filter button
   * or the dim behind the panel it must not throw the sheet away mid-filter.
   * The field menus arm `dismissGuardUntilRef` on every pick for exactly this;
   * ✕ and Escape are deliberate and bypass it.
   */
  const closeFromPointer = useCallback(() => {
    if (Date.now() < dismissGuardUntilRef.current) return;
    close();
  }, [close]);

  const handleSheetOpenChange = useCallback(
    (next: boolean) => {
      setFilterOpen(next, { bypassDismissGuard: true });
    },
    [setFilterOpen],
  );

  const handleFilterShellOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setFilterOpen(true);
        return;
      }
      // `false` here is the shell hook's Escape (outside-pointer dismissal is
      // off for the shell). A portaled field menu open INSIDE the panel owns
      // that Escape — its own listener closes it in this same event — so the
      // panel only closes when no menu is on screen; the next Escape then
      // reaches the panel. Closing here is the same commit as the header ✕,
      // so nothing a manager picked is lost (PRP-386).
      if (document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)) return;
      close();
    },
    [close, setFilterOpen],
  );

  const isClient = useIsClient();
  const compactTrigger = desktopPresentation === "panel" || desktopPresentation === "dropdown";

  useEffect(() => {
    if (!open) return;
    document.documentElement.setAttribute("data-portal-filter-open", "");
    return () => {
      document.documentElement.removeAttribute("data-portal-filter-open");
    };
  }, [open]);

  const handleReset = useCallback(() => {
    deferControllerRef.current?.resetAll();
    onReset();
  }, [onReset]);

  const useMobileBottomSheet = isMobile && !mobilePopover;
  const panelSizeClass =
    panelSizeClassName ??
    (compactPanel
      ? portalFilterPanelSizeClass(filterFieldCount)
      : PORTAL_FILTER_PANEL_SIZE_CLASS);
  const panelHeightPx = portalFilterDropdownHeightPx(panelSizeClass);
  const panelWidthPx = portalFilterDropdownWidthPx(panelSizeClass);
  const dropdownOpen = desktopPresentation === "dropdown" && open && (!isMobile || mobilePopover);
  const { wrapRef, buttonRef, menuRect, portalHost } = useFieldSelectMenu({
    open: dropdownOpen,
    onOpenChange: handleFilterShellOpenChange,
    contentPx: panelHeightPx,
    minMenuWidth: mobilePopover ? Math.min(panelWidthPx, 22 * 16) : panelWidthPx,
    align: "end",
    fullBleed: false,
    constrainToTitleBand: constrainDropdownToTitleBand,
    filterDropdownAlign: dropdownAlign,
    closeOnOutsidePointerDown: false,
    // Escape is the one universally expected way out of a dialog; the shell
    // hook returns focus to the Filter button as it closes.
    closeOnEscape: true,
  });

  /**
   * Safety net for the CONTROLLED case: `open` can be driven by a parent without going
   * through `setFilterOpen` (which is where the decision normally lands, in the same batch
   * as the open state). `decidedForOpenRef` guarantees this never recomputes — and
   * therefore never swaps surfaces mid-interaction — for an open panel that already got
   * its decision from `setFilterOpen`.
   */
  useLayoutEffect(() => {
    if (!open) {
      decidedForOpenRef.current = false;
      setMobilePopover(false);
      return;
    }
    if (decidedForOpenRef.current) return;
    decidedForOpenRef.current = true;
    setMobilePopover(
      resolveMobileFilterPopover({
        trigger: buttonRef.current,
        desktopPresentation,
        compactPanel,
        filterFieldCount,
        hasExtraModalContent: extraModalContent != null,
        insets,
      }),
    );
  }, [open, desktopPresentation, compactPanel, filterFieldCount, extraModalContent, insets, buttonRef]);

  // A dialog takes focus when it opens: a keyboard or screen-reader user
  // otherwise lands nowhere and cannot reach the controls (PRP-386). The
  // panel itself is the target (`tabIndex={-1}`), so the "Filter" dialog is
  // announced and the first Tab reaches Reset.
  useEffect(() => {
    if (!dropdownOpen || !menuRect) return;
    const panel = dropdownPanelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    panel.focus({ preventScroll: true });
  }, [dropdownOpen, menuRect]);

  // Focus returns to the trigger when the desktop dropdown closes by ✕, the
  // backdrop, or the trigger — the Escape path already does this in the hook.
  const wasDropdownOpenRef = useRef(false);
  useEffect(() => {
    if (wasDropdownOpenRef.current && !dropdownOpen) {
      const active = document.activeElement;
      if (!active || active === document.body) buttonRef.current?.focus({ preventScroll: true });
    }
    wasDropdownOpenRef.current = dropdownOpen;
  }, [buttonRef, dropdownOpen]);
  /* Both branches leave the height to the sheet — see PORTAL_FILTER_COMPACT_MOBILE_SHEET_CLASS. */
  const resolvedMobileSheetClass = mobileSheetClassName ?? PORTAL_FILTER_COMPACT_MOBILE_SHEET_CLASS;
  /* `filterMenuOpen` is set from the mobile sheet or desktop dropdown scroll-lock provider
     while a field menu is open, so the panel body stops scrolling under the portaled list. */
  /* One accordion scope per SHEET, not per field group: a sheet composed from sibling
     groups (Finances = ReportFilterBar + FinancesRowFilters) would otherwise hold one open
     menu per group and stack them over the panel. */
  const fields = (
    <FilterFieldsAccordionScope>
      <FilterPanelFields
        onReset={handleReset}
        extraModalContent={extraModalContent}
        compact={compactPanel}
        scrollLocked={filterMenuOpen}
      >
        {children}
      </FilterPanelFields>
    </FilterFieldsAccordionScope>
  );

  const filterDropdownPanel = (
    <div
      ref={dropdownPanelRef}
      role="dialog"
      aria-label="Filter"
      tabIndex={-1}
      data-slot="portal-filter-dropdown-panel"
      /* Lets the stylesheet follow the one resolver rather than re-deriving it
         from a media query that disagreed with the computed position. */
      data-surface={isMobile && !mobilePopover ? "sheet" : "popover"}
        className={cn(
        panelSizeClass,
        isMobile && !mobilePopover && "max-lg:!w-screen max-lg:!max-w-[100vw] max-lg:border-x-0",
        "portal-filter-dropdown-panel relative z-50 flex flex-col overflow-visible overscroll-contain rounded-2xl border border-border bg-card shadow-[0_12px_40px_rgba(15,23,42,0.12)] outline-none",
        isMobile && "max-lg:rounded-xl",
      )}
      style={
        menuRect
          ? {
              position: "fixed",
              top: menuRect.top,
              left: menuRect.left,
              width: menuRect.width,
              maxHeight: menuRect.maxHeight,
              height: "auto",
              zIndex: portalHost ? fieldSelectMenuZIndex(portalHost) : 10000,
            }
          : undefined
      }
      data-attr="portal-filter-dropdown-panel"
    >
      <FilterDropdownHeader onClose={close} />
      <div
        className={cn(
          compactPanel
            ? "flex min-h-0 flex-col overflow-visible px-3 py-2"
            : PORTAL_FILTER_BODY_CLASS,
          !compactPanel && "flex-1",
        )}
      >
        <FilterDropdownBody
          onReset={handleReset}
          extraModalContent={extraModalContent}
          compact={compactPanel}
        >
          {children}
        </FilterDropdownBody>
      </div>
      {/* Pinned: the fields above scroll once they outgrow the panel, and the
          thing you press must not scroll away with them. */}
      <div className="shrink-0 border-t border-border px-3 py-2">
        <FilterSheetFooter onReset={handleReset} onSave={close} applyLabel={applyLabel} />
      </div>
    </div>
  );

  const filterFooter = (save: () => void) =>
    mobileFooter ? (typeof mobileFooter === "function" ? mobileFooter(save) : mobileFooter) : (
      <FilterSheetFooter onReset={handleReset} onSave={save} applyLabel={applyLabel} />
    );

  return (
    <PortalFilterDeferProvider controllerRef={deferControllerRef}>
      <>
      <div
        ref={wrapRef}
        className={cn(
          "relative inline-flex min-w-0 max-w-full",
          commandStripTrigger
            ? "w-fit min-w-0 shrink-0"
            : compactTrigger
              ? "w-fit shrink-0 md:w-[10.75rem] md:max-w-[10.75rem]"
              : "w-fit flex-1 md:hidden",
          className,
        )}
      >
        {commandStripTrigger ? (
          // Compact plain icon in the list command row. The active count stays in
          // the accessible name (and a dot) rather than a second label.
          <PortalIconAction
            ref={buttonRef}
            icon={SlidersHorizontal}
            label={activeCount > 0 ? `Filter · ${activeCount} active` : "Filter"}
            active={activeCount > 0}
            className="relative"
            data-attr={dataAttr}
            aria-expanded={open}
            onClick={() => {
              if (open) closeFromPointer();
              else setFilterOpen(true, { trigger: buttonRef.current });
            }}
          />
        ) : (
        <Button
          ref={buttonRef}
          type="button"
          variant="outline"
          className={cn(
            compactTrigger
              ? cn(
                  PORTAL_HEADER_ACTION_BTN,
                  "inline-flex w-auto items-center justify-center gap-1.5 whitespace-nowrap max-md:px-2.5 md:px-3",
                )
              : "inline-flex h-9 min-w-0 w-full items-center justify-center gap-1.5 rounded-full text-xs font-semibold whitespace-nowrap",
          )}
          data-attr={dataAttr}
          aria-expanded={compactTrigger ? open : undefined}
          onClick={() => {
            // The trigger toggles: a second press closes (same commit as ✕).
            if (open) closeFromPointer();
            else setFilterOpen(true, { trigger: buttonRef.current });
          }}
        >
          <SlidersHorizontal className={PORTAL_FILTER_ICON_CLASS} strokeWidth={2} aria-hidden />
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            Filter{activeCount > 0 ? ` · ${activeCount} active` : ""}
          </span>
        </Button>
        )}
        {dropdownOpen && isClient && menuRect && portalHost
          ? createPortal(
              <>
                {/* The dim reads as modal, so a click on it closes the panel —
                    committing the draft filters exactly as ✕ does. Portaled
                    field menus sit above it, so a click inside one never lands
                    here; the outside-pointerdown dismissal stays off in the
                    shell hook for that same reason. */}
                <div
                  className={cn(
                    "fixed inset-0 cursor-default",
                    /* An anchored popover is a toolbar control, not a modal: the
                       whole reason to anchor it is that you can still SEE the
                       list you are filtering. Dimming that list defeats the
                       point, so the layer here is a click-catcher only. The
                       full-bleed mobile sheet keeps its dim, because there it
                       really is covering the page. */
                    useMobileBottomSheet ? "bg-black/20" : "bg-transparent",
                  )}
                  style={{ zIndex: fieldSelectMenuZIndex(portalHost) - 1 }}
                  aria-hidden
                  data-attr="portal-filter-dropdown-backdrop"
                  onClick={closeFromPointer}
                />
                {filterDropdownPanel}
              </>,
              portalHost,
            )
          : null}
      </div>
      {!compactTrigger ? (
        <div className="hidden min-w-0 flex-wrap items-center gap-1.5 sm:gap-2.5 md:flex md:gap-3">
          {children}
        </div>
      ) : null}
      {useMobileBottomSheet && open ? (
        <VaulBottomSheet
          dismissible={false}
          open
          onOpenChange={handleSheetOpenChange}
          title="Filter"
          flushBody={mobileFlushBody}
          autoElevate={mobileSheetRaised}
          fillViewport={mobileSheetFillsViewport && !mobileSheetRaised}
          minHeightPx={mobileSheetRaised ? PORTAL_FILTER_RAISED_SHEET_MIN_HEIGHT_PX : undefined}
          lockBodyScroll={filterMenuOpen}
          maxHeightClass={
            mobileSheetFillsViewport && !mobileSheetRaised
              ? "max-h-[min(92dvh,calc(100dvh-var(--portal-native-bottom-nav-inset,0px)-0.5rem))]"
              : undefined
          }
          assistantContext="Filter"
          // `filterFooter` is a render prop: it hands `close` to a footer that
          // wires it to a button's onClick and never calls it while rendering.
          // The compiler cannot see through the indirection and assumes any
          // function receiving `close` may invoke it during render, and `close`
          // reads the dismiss-guard refs. The single caller passing a function
          // (`resident-housing-browse.tsx`) does exactly `onClick={close}`.
          // eslint-disable-next-line react-hooks/refs
          footer={filterFooter(close)}
        >
          <FilterSheetScrollLockContext.Provider value={setFilterMenuOpen}>
            <div
              className={cn(
                "flex w-full max-w-full flex-col overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]",
                /* `VaulBottomSheet`'s `lockBodyScroll` works by putting `overflow-hidden` on
                   its own body div, which a descendant's own `overflow-y-auto` defeats. So the
                   sheet's scroll containers have to stand down while a portaled field menu is
                   open, or the prop is inert for this caller. */
                filterMenuOpen ? "overflow-y-hidden" : "overflow-y-auto",
                mobileFlushBody && "px-4",
                resolvedMobileSheetClass,
              )}
            >
              {fields}
            </div>
          </FilterSheetScrollLockContext.Provider>
        </VaulBottomSheet>
      ) : desktopPresentation === "panel" ? (
        <Modal
          open={open}
          onClose={close}
          dismissBlocked
          title="Filter"
          fullPage={false}
          panelClassName={cn(
            panelSizeClass,
            PORTAL_FILTER_PANEL_WIDTH_CLASS,
            "portal-filter-dropdown-panel flex flex-col overflow-hidden bg-card",
          )}
          dense
          scrollableContent
          assistantContext="Filter"
          footer={<FilterSheetFooter onReset={handleReset} onSave={close} applyLabel={applyLabel} />}
        >
          <FilterSheetScrollLockContext.Provider value={setFilterMenuOpen}>
            {fields}
          </FilterSheetScrollLockContext.Provider>
        </Modal>
      ) : null}
    </>
    </PortalFilterDeferProvider>
  );
}

/** Count non-default property / resident / sort filters for the mobile badge. */
export function portalFilterActiveCount(
  values: Array<string | number | boolean | null | undefined | readonly string[]>,
): number {
  return values.filter((v) => {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.trim().length > 0;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return Boolean(v);
  }).length;
}
