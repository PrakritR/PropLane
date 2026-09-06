"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect, useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  PortalFilterDeferProvider,
  type PortalFilterDeferController,
} from "@/lib/portal-filter-draft";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
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
import { PORTAL_COMMAND_ACTION_BTN, PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import {
  fieldSelectMenuZIndex,
  useFieldSelectMenu,
} from "@/components/ui/field-select-menu";
import { useIsClient } from "@/hooks/use-is-client";
import {
  FILTER_SHEET_DISMISS_GUARD_MS,
  FILTER_SHEET_OPEN_SUPPRESS_MS,
  registerFilterSheetDismissGuard,
  registerFilterSheetOpenSuppress,
} from "@/components/ui/field-select-portal-interaction";
import { lockPortalScroll } from "@/lib/native/lock-portal-scroll";
import { cn } from "@/lib/utils";

const SMALL_PORTAL_VIEWPORT_QUERY = "(max-width: 1023px)";

function subscribeSmallPortalViewport(onStoreChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(SMALL_PORTAL_VIEWPORT_QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

function getSmallPortalViewport(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(SMALL_PORTAL_VIEWPORT_QUERY).matches;
}

function useSmallPortalViewport(): boolean {
  return useSyncExternalStore(subscribeSmallPortalViewport, getSmallPortalViewport, () => false);
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

function FilterSheetFooter({
  onReset,
  onSave,
}: {
  onReset: () => void;
  onSave: () => void;
}) {
  return (
    <ModalFooter className="w-full justify-between">
      <FilterResetLink onReset={onReset} />
      <Button type="button" variant="primary" className="rounded-full" onClick={onSave} data-attr="portal-filter-save">
        Save
      </Button>
    </ModalFooter>
  );
}

function FilterDropdownHeader({ onReset, onClose }: { onReset: () => void; onClose: () => void }) {
  return (
    <div
      data-field-select-host-chrome=""
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2"
    >
      <p className="text-sm font-semibold text-foreground">Filter</p>
      <div className="flex items-center gap-3">
        <FilterResetLink onReset={onReset} />
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
   * Opt out of the bottom-anchored viewport-filling sheet. Only for a sheet that already
   * fills most of the viewport (browse-homes) where the explicit props are documentary,
   * or for the legacy raised placement (`mobileSheetRaised`).
   */
  mobileSheetFillsViewport = true,
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
  const isMobile = useSmallPortalViewport();

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
      options?: { bypassDismissGuard?: boolean },
    ) => {
      const prev = openRef.current;
      const resolved = typeof next === "function" ? next(prev) : next;
      if (resolved && Date.now() < openSuppressUntilRef.current) return;
      /* Every portal filter surface dismisses only through the header ✕ (`close()`). */
      if (!resolved && !options?.bypassDismissGuard) return;
      applyOpenTransition(prev, resolved);
      if (!isControlled) setUncontrolledOpen(resolved);
      onOpenChange?.(resolved);
    },
    [applyOpenTransition, isControlled, onOpenChange],
  );

  const close = useCallback(() => {
    setFilterOpen(false, { bypassDismissGuard: true });
  }, [setFilterOpen]);

  const handleSheetOpenChange = useCallback(
    (next: boolean) => {
      setFilterOpen(next, { bypassDismissGuard: true });
    },
    [setFilterOpen],
  );

  const handleFilterShellOpenChange = useCallback(
    (next: boolean) => {
      if (next) setFilterOpen(true);
    },
    [setFilterOpen],
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

  const useMobileBottomSheet = isMobile;
  const panelSizeClass =
    panelSizeClassName ??
    (compactPanel
      ? portalFilterPanelSizeClass(filterFieldCount)
      : PORTAL_FILTER_PANEL_SIZE_CLASS);
  const panelHeightPx = portalFilterDropdownHeightPx(panelSizeClass);
  const panelWidthPx = portalFilterDropdownWidthPx(panelSizeClass);
  const dropdownOpen = desktopPresentation === "dropdown" && open && !isMobile;
  const { wrapRef, buttonRef, menuRect, portalHost } = useFieldSelectMenu({
    open: dropdownOpen,
    onOpenChange: handleFilterShellOpenChange,
    contentPx: panelHeightPx,
    minMenuWidth: panelWidthPx,
    align: "end",
    fullBleed: isMobile,
    constrainToTitleBand: constrainDropdownToTitleBand,
    filterDropdownAlign: dropdownAlign,
    closeOnOutsidePointerDown: false,
    closeOnEscape: false,
  });
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
      role="dialog"
      aria-label="Filter"
      data-slot="portal-filter-dropdown-panel"
        className={cn(
        panelSizeClass,
        isMobile && "max-lg:!w-screen max-lg:!max-w-[100vw] max-lg:border-x-0",
        "portal-filter-dropdown-panel relative z-50 flex flex-col overflow-visible overscroll-contain rounded-2xl border border-border bg-card shadow-[0_12px_40px_rgba(15,23,42,0.12)]",
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
      <FilterDropdownHeader onReset={handleReset} onClose={close} />
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
    </div>
  );

  const filterFooter = (save: () => void) =>
    mobileFooter ? (typeof mobileFooter === "function" ? mobileFooter(save) : mobileFooter) : (
      <FilterSheetFooter onReset={handleReset} onSave={save} />
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
        <Button
          ref={buttonRef}
          type="button"
          variant="outline"
          className={cn(
            commandStripTrigger
              ? cn(
                  PORTAL_COMMAND_ACTION_BTN,
                  "inline-flex w-auto items-center justify-center gap-1.5 whitespace-nowrap",
                )
              : compactTrigger
              ? cn(
                  PORTAL_HEADER_ACTION_BTN,
                  "inline-flex w-auto items-center justify-center gap-1.5 whitespace-nowrap max-md:px-2.5 md:px-3",
                )
              : "inline-flex h-9 min-w-0 w-full items-center justify-center gap-1.5 rounded-full text-xs font-semibold whitespace-nowrap",
          )}
          data-attr={dataAttr}
          aria-expanded={compactTrigger ? open : undefined}
          onClick={() => {
            setFilterOpen(true);
          }}
        >
          <SlidersHorizontal className={PORTAL_FILTER_ICON_CLASS} strokeWidth={2} aria-hidden />
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            Filter{activeCount > 0 ? ` · ${activeCount} active` : ""}
          </span>
        </Button>
        {dropdownOpen && isClient && menuRect && portalHost
          ? createPortal(
              <>
                <div
                  className="pointer-events-none fixed inset-0 bg-black/20"
                  style={{ zIndex: fieldSelectMenuZIndex(portalHost) - 1 }}
                  aria-hidden
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
          footer={<FilterSheetFooter onReset={handleReset} onSave={close} />}
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
