"use client";

import { ChevronDown } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { deferAfterFieldSelectPick } from "@/components/ui/field-select-portal-interaction";
import {
  FIELD_SELECT_OPTION_VALUE_ATTR,
  useFieldSelectListboxPointerPick,
} from "@/components/ui/field-select-listbox-pick";
import { FIELD_SELECT_MENU_OPTION_CLASS } from "@/components/ui/field-select-styles";
import {
  FIELD_SELECT_MENU_LIST_MAX_HEIGHT_PX,
  FIELD_SELECT_MENU_SEARCH_PX,
  FIELD_SELECT_MENU_SHELL_CLASS,
  FIELD_SELECT_MENU_LISTBOX_SCROLL_CLASS,
  FIELD_SELECT_MENU_VISIBLE_ITEMS,
  FieldSelectMenuSearch,
  fieldSelectMenuContentPx,
  fieldSelectMenuListMaxHeightPx,
  fieldSelectMenuMatches,
  fieldSelectMenuZIndex,
  useFieldSelectMenu,
} from "@/components/ui/field-select-menu";
import { cn } from "@/lib/utils";

export const FILTER_FIELD_LABEL_CLASS =
  "mb-1 block text-xs font-semibold uppercase tracking-wide text-muted";

/** One source of the "5 rows visible, scroll for the rest" number — shared with all field-select menus. */
export const FILTER_LIST_VISIBLE_ROWS = FIELD_SELECT_MENU_VISIBLE_ITEMS;
export const FILTER_LIST_MAX_HEIGHT_PX = FIELD_SELECT_MENU_LIST_MAX_HEIGHT_PX;

/** Fixed portal filter shell — same width/height for modal, sheet, and desktop dropdown. */
export const PORTAL_FILTER_PANEL_WIDTH_CLASS = "w-[min(22rem,calc(100vw-2rem))]";
export const PORTAL_FILTER_PANEL_WIDTH_PX = 22 * 16;
export const PORTAL_FILTER_BROWSE_PANEL_WIDTH_PX = 28 * 16;

/** Parse fixed panel height from portal filter size class names (total shell height). */
export function portalFilterDropdownHeightPx(panelSizeClass: string): number {
  const maxRemMatch = panelSizeClass.match(/max-h-\[(\d+(?:\.\d+)?)rem\]/);
  if (maxRemMatch) return parseFloat(maxRemMatch[1]) * 16;
  const remMatch = panelSizeClass.match(/h-\[(\d+(?:\.\d+)?)rem\]/);
  if (remMatch) return parseFloat(remMatch[1]) * 16;
  if (panelSizeClass.includes("min(36rem")) {
    const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
    return Math.min(36 * 16, viewportH * 0.82);
  }
  if (panelSizeClass.includes("28rem")) return 28 * 16;
  return 10.5 * 16;
}

export function portalFilterDropdownWidthPx(panelSizeClass: string): number {
  return panelSizeClass.includes("28rem")
    ? PORTAL_FILTER_BROWSE_PANEL_WIDTH_PX
    : PORTAL_FILTER_PANEL_WIDTH_PX;
}
export const PORTAL_FILTER_PANEL_HEIGHT_CLASS = "h-[28rem]";
export const PORTAL_FILTER_PANEL_SIZE_CLASS = `${PORTAL_FILTER_PANEL_WIDTH_CLASS} ${PORTAL_FILTER_PANEL_HEIGHT_CLASS}`;
/** Single-field compact filter dropdown. */
export const PORTAL_FILTER_PANEL_COMPACT_HEIGHT_CLASS = "max-h-[10.5rem]";
export const PORTAL_FILTER_PANEL_COMPACT_MAX_CLASS = `h-auto ${PORTAL_FILTER_PANEL_COMPACT_HEIGHT_CLASS}`;
export const PORTAL_FILTER_PANEL_COMPACT_CLASS = `${PORTAL_FILTER_PANEL_WIDTH_CLASS} ${PORTAL_FILTER_PANEL_COMPACT_MAX_CLASS}`;
export const PORTAL_FILTER_PANEL_TWO_FIELD_HEIGHT_CLASS = "max-h-[14rem]";
export const PORTAL_FILTER_PANEL_TWO_FIELD_MAX_CLASS = `h-auto ${PORTAL_FILTER_PANEL_TWO_FIELD_HEIGHT_CLASS}`;
/**
 * Fixed chrome above a desktop filter panel's fields: the Filter / Reset / ✕ row.
 * MEASURED (58px), not derived from the utility classes — my arithmetic said 37px and the
 * 22rem panel it produced left 286px against a 292px menu, so menus quietly went back to
 * spilling. Re-measure if `FilterDropdownHeader` changes.
 */
export const PORTAL_FILTER_PANEL_CHROME_PX = 58;

/* 23rem, not 19rem: the panel must hold its own chrome (58px) PLUS a full menu (292px)
   plus the containment gap — 358px minimum. At 19rem/304px the menu fit the panel but
   painted over Reset and Close; at 22rem it cleared them but spilled below the panel. */
export const PORTAL_FILTER_PANEL_THREE_FIELD_HEIGHT_CLASS = "max-h-[23rem]";
export const PORTAL_FILTER_PANEL_THREE_FIELD_MAX_CLASS = `h-auto ${PORTAL_FILTER_PANEL_THREE_FIELD_HEIGHT_CLASS}`;
/* One field row measures 76px (label + 44px trigger + gap); four of them plus the panel
   header and padding need ~23rem. At 19rem the fourth field rendered BELOW the panel's
   bottom edge and was only reachable by scrolling — measured on Communication, whose
   filter is house/role/resident/sort. */
export const PORTAL_FILTER_PANEL_FOUR_FIELD_HEIGHT_CLASS = "max-h-[23rem]";
export const PORTAL_FILTER_PANEL_FOUR_FIELD_MAX_CLASS = `h-auto ${PORTAL_FILTER_PANEL_FOUR_FIELD_HEIGHT_CLASS}`;

/** Pick a fixed filter shell height from the number of filter rows (property, resident, sort, …). */
export function portalFilterPanelSizeClass(fieldCount: number): string {
  const heightClass =
    fieldCount >= 4
      ? PORTAL_FILTER_PANEL_FOUR_FIELD_MAX_CLASS
      : fieldCount === 3
        ? PORTAL_FILTER_PANEL_THREE_FIELD_MAX_CLASS
        : fieldCount === 2
          ? PORTAL_FILTER_PANEL_TWO_FIELD_MAX_CLASS
          : PORTAL_FILTER_PANEL_COMPACT_MAX_CLASS;
  return `${PORTAL_FILTER_PANEL_WIDTH_CLASS} ${heightClass}`;
}
/** Communication filter — four fields (house, role, resident, sort). */
export const PORTAL_FILTER_COMMUNICATION_PANEL_CLASS =
  `${PORTAL_FILTER_PANEL_WIDTH_CLASS} flex ${PORTAL_FILTER_PANEL_FOUR_FIELD_MAX_CLASS} flex-col overflow-hidden`;
/**
 * Default compact mobile sheet when callers do not override height. Fills the bottom sheet
 * with white down to the tab bar; filter fields stay at the top and scroll when needed.
 */
export const PORTAL_FILTER_COMPACT_MOBILE_SHEET_CLASS = "flex min-h-0 flex-1 flex-col";
/** @deprecated Use {@link PORTAL_FILTER_COMPACT_MOBILE_SHEET_CLASS} — same layout. */
export const PORTAL_FILTER_COMMUNICATION_MOBILE_SHEET_CLASS = PORTAL_FILTER_COMPACT_MOBILE_SHEET_CLASS;
/** Tall mobile sheet for browse-home filters (AI + manual fields). */
export const PORTAL_FILTER_BROWSE_MOBILE_SHEET_CLASS =
  "h-[min(82dvh,42rem)] min-h-[min(70dvh,34rem)]";

export const PORTAL_FILTER_BROWSE_PANEL_CLASS =
  "w-[min(28rem,calc(100vw-2rem))] h-[min(36rem,82vh)] min-h-[28rem]";
export const PORTAL_FILTER_BODY_CLASS =
  "flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2";

/** Shared filter trigger icon sizing (toolbar Filter buttons). */
export const PORTAL_FILTER_ICON_CLASS = "size-3.5 shrink-0";

const FILTER_TRIGGER_CLASS =
  "flex h-11 max-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-2xl border border-border bg-auth-input-bg px-4 py-2.5 text-left text-sm text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/25 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10 max-lg:rounded-xl";

/** Portal filter menus always show the search row (consistent with Resident/House pickers). */
export const FILTER_FIELD_MENU_ALWAYS_SHOW_SEARCH = true;

const FILTER_FIELD_MENU_SEARCH_PX = FILTER_FIELD_MENU_ALWAYS_SHOW_SEARCH
  ? FIELD_SELECT_MENU_SEARCH_PX
  : 0;

/** Estimated menu height (search row + 5 option rows) for positioning math. */
export const FILTER_MENU_CONTENT_PX = fieldSelectMenuContentPx(
  FIELD_SELECT_MENU_VISIBLE_ITEMS,
  FILTER_FIELD_MENU_SEARCH_PX,
);

/**
 * Fixed chrome above a raised filter sheet's scrolling body: drag handle plus the
 * title/close row. Measured at 75px; this over-reserves slightly, which is the SAFE
 * direction — under-reserving lets the menu paint over the sheet's only visible dismiss
 * control, and a phone has no Escape key to fall back on.
 */
export const PORTAL_FILTER_SHEET_CHROME_PX = 88;

/**
 * Floor height for a RAISED filter sheet, so its menus are always containable
 * (`computeFieldSelectMenuRectInHost` contains only when
 * `host.height - chrome - 8 >= contentPx`). Without a floor a one-field sheet is ~179px and
 * a full menu hung ~241px onto the dimmed scrim; without the chrome term the menu fitted
 * but painted over the sheet's own close control, which on a phone — no Escape key — can
 * leave the sheet undismissable. Derived from the widest menu plus the chrome plus the
 * containment gap plus a cushion, never a magic number.
 *
 * The cost is dead space under a lone field, knowingly accepted: correctness first. Growing
 * the sheet when a menu opens would move it, which is the defect this whole pattern exists
 * to remove. Leave that space as plain sheet background — do not fill it with invented UI.
 *
 * KNOWN LIMIT, accepted deliberately — below roughly 575px of VIEWPORT height this floor
 * stops being reachable, so menus render as many rows as fit and overhang the sheet onto the
 * scrim. The floor is applied through a `min()` against the raised max-height (see
 * `raisedMinHeight` in `vaul-bottom-sheet.tsx`), and under ~575px the clamp arm wins.
 * Checkable arithmetic: containment needs measured chrome 75 + menu 292 + containment gap 8
 * = 375px, while a raised sheet on a 390px-tall viewport can be at most
 * 390 - 125 (the 32vh offset) - 16 = 249px; even fully bottom-anchored the best case is
 * 390 - 16 = 374px, one pixel short. 375px of requirement does not fit in 249px of space, so
 * dropping the raised offset on short viewports would only trade one broken invariant for a
 * different one PLUS viewport-dependent placement — worse to reason about, worse to maintain.
 * What makes the degradation acceptable is that the CHROME GUARD STILL HOLDS: measured on
 * Leases at 844x390 the sheet is 217px and the menu overhangs by 134px showing 3 of 5 rows,
 * yet the menu stays fully on screen and the close control and title are 0% covered and
 * tappable. A landscape user is never trapped — they can dismiss and rotate. Fewer visible
 * rows in an unusual orientation is a degraded experience; a user stuck in a sheet would be a
 * defect.
 */
export const PORTAL_FILTER_RAISED_SHEET_MIN_HEIGHT_PX =
  FILTER_MENU_CONTENT_PX + PORTAL_FILTER_SHEET_CHROME_PX + 12;

type Option = { value: string; label: string };

type FilterFieldsAccordionContextValue = {
  openId: string | null;
  setOpenId: (id: string | null) => void;
};

const FilterFieldsAccordionContext = createContext<FilterFieldsAccordionContextValue | null>(null);

/** Mobile filter sheet: lock the sheet body while a portaled field menu is open. */
export const FilterSheetScrollLockContext = createContext<((locked: boolean) => void) | null>(null);

const FieldSelectMenuShellHeightContext = createContext<number | null>(null);

function useFieldSelectMenuShellHeight(fallbackPx: number): number {
  return useContext(FieldSelectMenuShellHeightContext) ?? fallbackPx;
}

const FilterMenuOptionCountContext = createContext<((count: number) => void) | null>(null);

/**
 * The menu's row count is REPORTED BY THE LIST THAT RENDERS IT, never mirrored beside it.
 * The count feeds `menuContentPx`, which feeds `resolveOpenUp`, so a hand-synced number that
 * drifted from the array silently changed a menu's height and its open direction with no
 * test failure — and two call sites inject their own leading "All" row, so the raw options
 * array a caller holds is not the rendered row count either. Registering runs in a LAYOUT
 * effect, so the corrected height is in place before the browser paints the menu.
 */
export function useRegisterFilterMenuOptionCount(renderedRowCount: number): void {
  const register = useContext(FilterMenuOptionCountContext);
  useLayoutEffect(() => {
    register?.(renderedRowCount);
  }, [register, renderedRowCount]);
}

export function useFilterAccordionClose(): () => void {
  const accordion = useContext(FilterFieldsAccordionContext);
  return () => accordion?.setOpenId(null);
}

/**
 * The "one open at a time" SCOPE, with no markup of its own. `PortalFilterSortSheet` wraps
 * every filter surface in one, so the scope is the PANEL rather than whichever component
 * happened to group some fields. Finances composes its sheet from two sibling groups
 * (`ReportFilterBar` + `FinancesRowFilters`), each of which used to own its own scope — so
 * Property and Resident could sit open at the same time, two menus stacked over one panel.
 */
export function FilterFieldsAccordionScope({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const setSheetScrollLocked = useContext(FilterSheetScrollLockContext);

  useLayoutEffect(() => {
    setSheetScrollLocked?.(openId !== null);
    return () => setSheetScrollLocked?.(false);
  }, [openId, setSheetScrollLocked]);

  return (
    <FilterFieldsAccordionContext.Provider value={{ openId, setOpenId }}>
      {children}
    </FilterFieldsAccordionContext.Provider>
  );
}

/**
 * One open dropdown at a time — Excel-style filter sheet behavior. Deliberately DEFERS to an
 * enclosing scope instead of opening a second one, so sibling groups inside a single sheet
 * still share one open field. `sectionId` must therefore be unique across the whole sheet,
 * not merely within a group.
 */
export function FilterFieldsAccordion({ children }: { children: ReactNode }) {
  const enclosingScope = useContext(FilterFieldsAccordionContext);
  const grid = <div className="grid gap-3 max-lg:gap-2.5">{children}</div>;
  return enclosingScope ? grid : <FilterFieldsAccordionScope>{grid}</FilterFieldsAccordionScope>;
}

export function filterMultiSelectSummary(
  selected: string[],
  options: Option[],
  allLabel = "All",
): string {
  if (selected.length === 0) return allLabel;
  if (selected.length === 1) {
    return options.find((o) => o.value === selected[0])?.label ?? selected[0] ?? allLabel;
  }
  return `${selected.length} selected`;
}

export function filterSingleSelectSummary(value: string, options: Option[], allLabel = "All"): string {
  if (!value) return allLabel;
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * Modal / form single-select — same trigger + portaled searchable list as filter fields,
 * without the filter-sheet accordion or deferred-apply wiring.
 */
export function PortalFormSingleSelect({
  label,
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  dataAttr,
  labelClassName = FILTER_FIELD_LABEL_CLASS,
  onPick,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  dataAttr?: string;
  labelClassName?: string;
  onPick?: () => void;
}) {
  const filterSheetScrollLock = useContext(FilterSheetScrollLockContext);
  const [open, setOpen] = useState(false);
  const [renderedOptionCount, setRenderedOptionCount] = useState<number | null>(null);

  const optionCount = renderedOptionCount ?? options.length;
  const showMenuSearch =
    FILTER_FIELD_MENU_ALWAYS_SHOW_SEARCH || optionCount > FILTER_LIST_VISIBLE_ROWS;
  const menuContentPx = fieldSelectMenuContentPx(
    optionCount,
    showMenuSearch ? FIELD_SELECT_MENU_SEARCH_PX : 0,
  );

  const summary = value
    ? (options.find((o) => o.value === value)?.label ?? value)
    : placeholder;
  const isPlaceholder = !value;

  const { listId, isClient, wrapRef, buttonRef, menuRect, portalHost } = useFieldSelectMenu({
    open: open && !disabled,
    onOpenChange: setOpen,
    contentPx: menuContentPx,
    preferOpenDown: true,
    matchTriggerWidth: true,
    closeOnOutsidePointerDown: filterSheetScrollLock === null,
  });

  const closeMenu = useCallback(() => {
    setOpen(false);
    onPick?.();
  }, [onPick]);

  const menu =
    open && !disabled && menuRect && isClient && portalHost ? (
      <div
        id={listId}
        data-field-select-menu=""
        data-vaul-no-drag=""
        className={cn(FIELD_SELECT_MENU_SHELL_CLASS, "bg-card flex min-h-0 flex-col overscroll-contain")}
        style={{
          position: menuRect.position,
          top: menuRect.top,
          left: menuRect.left,
          width: menuRect.width,
          height: "auto",
          minHeight: 0,
          maxHeight: menuRect.maxHeight,
          zIndex: fieldSelectMenuZIndex(portalHost),
          touchAction: "pan-y",
        }}
        onTouchMove={(event) => {
          event.stopPropagation();
        }}
        onTouchStart={(event) => {
          event.stopPropagation();
        }}
        onWheel={(event) => event.stopPropagation()}
      >
        <FieldSelectMenuShellHeightContext.Provider value={menuRect.maxHeight}>
          <FilterMenuOptionCountContext.Provider value={setRenderedOptionCount}>
            <FilterSingleSelectList
              options={options}
              value={value}
              onChange={onChange}
              onPick={closeMenu}
              dataAttr={dataAttr}
            />
          </FilterMenuOptionCountContext.Provider>
        </FieldSelectMenuShellHeightContext.Provider>
      </div>
    ) : null;

  return (
    <div ref={wrapRef} data-attr={dataAttr ? `${dataAttr}-wrap` : undefined}>
      <p className={labelClassName}>{label}</p>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${label}: ${summary}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        disabled={disabled}
        className={cn(FILTER_TRIGGER_CLASS, disabled && "cursor-not-allowed opacity-60")}
        data-attr={dataAttr ? `${dataAttr}-trigger` : undefined}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
      >
        <span
          aria-hidden
          className={cn(
            "block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left",
            isPlaceholder ? "text-muted/70" : "text-foreground",
          )}
        >
          {summary}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {menu && portalHost ? createPortal(menu, portalHost) : null}
    </div>
  );
}

/**
 * Filter field trigger + portaled overlay menu. Closed by default (single-line
 * summary + chevron); opening portals the option list over the trigger so the
 * fields below keep their exact position and the panel keeps its exact height.
 * The shell caps at {@link FILTER_MENU_CONTENT_PX} (search row + 5 option rows) and
 * otherwise sizes to its content; the child list (`FilterCheckboxList` /
 * `FilterSingleSelectList`) scrolls under that cap and supplies its own search box
 * when there are more than 5 options.
 */
export function FilterCollapsibleSection({
  label,
  summary,
  children,
  dataAttr,
  sectionId,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  empty = false,
  menuOptionCount,
}: {
  label: string;
  summary: string;
  children: ReactNode;
  dataAttr?: string;
  /** When inside {@link FilterFieldsAccordion}, only one section opens at a time. */
  sectionId?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** When true, summary uses placeholder styling (nothing selected). */
  empty?: boolean;
  /**
   * Option count used to size the portaled menu until the child list reports the rows it
   * actually renders (see {@link useRegisterFilterMenuOptionCount}, which overrides this
   * before paint). REQUIRED: a call site that omitted it fell back to a full 5 rows, so a
   * 2-option menu reserved height it never uses and could flip upward where its real
   * height would have fit below.
   */
  menuOptionCount: number;
}) {
  const accordion = useContext(FilterFieldsAccordionContext);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [renderedOptionCount, setRenderedOptionCount] = useState<number | null>(null);

  const openFromAccordion = sectionId && accordion ? accordion.openId === sectionId : undefined;
  const open = openFromAccordion ?? controlledOpen ?? uncontrolledOpen;

  const setOpen = (next: boolean) => {
    if (sectionId && accordion) {
      accordion.setOpenId(next ? sectionId : null);
    } else if (onOpenChange) {
      onOpenChange(next);
    } else {
      setUncontrolledOpen(next);
    }
  };

  /* The rendered row count, once the child list has reported it, always wins over the
     caller's prop — the two can no longer disagree about how tall the menu is. */
  const optionCount = renderedOptionCount ?? menuOptionCount;
  const showMenuSearch =
    FILTER_FIELD_MENU_ALWAYS_SHOW_SEARCH || optionCount > FILTER_LIST_VISIBLE_ROWS;
  /* Size the menu to its OWN option count, capped at 5 rows by `fieldSelectMenuContentPx`.
     A field with 5+ options always shows exactly 5 and scrolls the rest; a field with
     fewer ends the box after its last row instead of padding out empty rows. The header and
     search row are BUDGETED here rather than taken out of the rows: neither chrome row may
     be paid for with an option row. */
  const menuContentPx = fieldSelectMenuContentPx(
    optionCount,
    showMenuSearch ? FIELD_SELECT_MENU_SEARCH_PX : 0,
  );

  const filterSheetScrollLock = useContext(FilterSheetScrollLockContext);

  const { listId, isClient, wrapRef, buttonRef, menuRect, portalHost } = useFieldSelectMenu({
    open,
    onOpenChange: setOpen,
    contentPx: menuContentPx,
    preferOpenDown: true,
    matchTriggerWidth: true,
    /* Inside a filter sheet, scroll/backdrop gestures close the panel — not each field menu. */
    closeOnOutsidePointerDown: filterSheetScrollLock === null,
  });

  /* No scroll-into-view on open: containment comes first, so a low field is slid back
     inside its host — and only a host too short to seat the menu below its own chrome
     falls through to the viewport bound. Either way the field already gets its full 5
     rows, while scrolling the sheet body would move the very controls this pattern
     exists to keep stationary. */

  const menu =
    open && menuRect && isClient && portalHost ? (
      <div
        id={listId}
        data-field-select-menu=""
        data-vaul-no-drag=""
        className={cn(FIELD_SELECT_MENU_SHELL_CLASS, "bg-card flex min-h-0 flex-col overscroll-contain")}
        style={{
          position: menuRect.position,
          top: menuRect.top,
          left: menuRect.left,
          width: menuRect.width,
          /* `height: auto` under a hard cap is what makes a short list end early instead of
             padding empty rows; the cap is what keeps a long list at exactly 5. */
          height: "auto",
          minHeight: 0,
          maxHeight: menuRect.maxHeight,
          zIndex: fieldSelectMenuZIndex(portalHost),
          touchAction: "pan-y",
        }}
        /* Do not stop pointerdown propagation here — React 17+ dispatches from the root,
           so stopping on this shell prevents option handlers inside the menu from ever
           running. Outside-dismiss paths already ignore `[data-field-select-menu]`. */
        onTouchMove={(event) => {
          event.stopPropagation();
        }}
        onTouchStart={(event) => {
          event.stopPropagation();
        }}
        onWheel={(event) => event.stopPropagation()}
      >
        {/* The field name lives on the trigger's aria-label and a screen-reader-only row —
            repeating the label inside the portaled menu duplicated "PROPERTY" on other sheets. */}
        <FieldSelectMenuShellHeightContext.Provider value={menuRect.maxHeight}>
          <FilterMenuOptionCountContext.Provider value={setRenderedOptionCount}>
            {children}
          </FilterMenuOptionCountContext.Provider>
        </FieldSelectMenuShellHeightContext.Provider>
      </div>
    ) : null;

  const isPlaceholder = empty;

  return (
    <div ref={wrapRef} data-attr={dataAttr}>
      <p className={FILTER_FIELD_LABEL_CLASS}>{label}</p>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${label}: ${summary}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        className={FILTER_TRIGGER_CLASS}
        onClick={() => setOpen(!open)}
      >
        <span
          aria-hidden
          className={cn(
            "block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left",
            isPlaceholder ? "text-muted/70" : "text-foreground",
          )}
        >
          {summary}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {menu && portalHost ? createPortal(menu, portalHost) : null}
    </div>
  );
}

/** Multi-select checkbox list for filter menus — search appears once there are more than 5 options. */
export function FilterCheckboxList({
  options,
  selected,
  onChange,
  emptyMenuText = "No options",
  searchPlaceholder = "Search…",
  dataAttr,
}: {
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyMenuText?: string;
  searchPlaceholder?: string;
  dataAttr?: string;
}) {
  const [query, setQuery] = useState("");
  const showSearch = FILTER_FIELD_MENU_ALWAYS_SHOW_SEARCH || options.length > FILTER_LIST_VISIBLE_ROWS;
  const shellMaxHeightPx = useFieldSelectMenuShellHeight(FILTER_MENU_CONTENT_PX);
  /* The UNFILTERED list: the shell is sized for the rows this field can show, and a menu
     that resized itself while the user typed in its own search box would be worse. */
  useRegisterFilterMenuOptionCount(options.length);

  // Filtering only hides rows; `selected` is never mutated, so searching never
  // drops an already-selected option from the selection.
  const visibleOptions = useMemo(() => {
    if (!query.trim()) return options;
    return options.filter((opt) => fieldSelectMenuMatches(opt.label, query));
  }, [options, query]);

  const toggle = useCallback(
    (value: string) => {
      onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
    },
    [onChange, selected],
  );

  const listRef = useFieldSelectListboxPointerPick((value) => {
    toggle(value);
  });

  return (
    <div className="flex min-h-0 flex-col">
      {showSearch ? (
        <FieldSelectMenuSearch
          query={query}
          onQueryChange={setQuery}
          placeholder={searchPlaceholder}
          dataAttr={dataAttr ? `${dataAttr}-search` : undefined}
        />
      ) : null}
      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable="true"
        data-attr={dataAttr}
        /* Never `flex-1` here — a zero flex-basis collapses the auto-height shell that
           makes a short list end early. `flex-[0_1_auto]` shrinks only under the cap. */
        className={cn(FIELD_SELECT_MENU_LISTBOX_SCROLL_CLASS, "min-h-0 flex-[0_1_auto]")}
        style={{
          touchAction: "pan-y",
          maxHeight: fieldSelectMenuListMaxHeightPx(
            shellMaxHeightPx,
            showSearch ? FIELD_SELECT_MENU_SEARCH_PX : 0,
          ),
        }}
        onWheel={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        {options.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted">{emptyMenuText}</p>
        ) : visibleOptions.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted">No matches</p>
        ) : (
          visibleOptions.map((opt) => {
            const checked = selected.includes(opt.value);
            return (
              <label
                key={opt.value}
                role="option"
                aria-selected={checked}
                data-filter-option-value={opt.value}
                {...{ [FIELD_SELECT_OPTION_VALUE_ATTR]: opt.value }}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm",
                  FIELD_SELECT_MENU_OPTION_CLASS,
                  checked && "bg-primary/5",
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
                  checked={checked}
                  readOnly
                  tabIndex={-1}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate leading-snug text-foreground">{opt.label}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Single-select list for filter menus (sort, one-of scope pickers) — same trigger + search + 5-row treatment. */
export function FilterSingleSelectList({
  options,
  value,
  onChange,
  dataAttr,
  onPick,
  searchPlaceholder = "Search…",
}: {
  options: Option[];
  value: string;
  onChange: (next: string) => void;
  dataAttr?: string;
  /** Called after a value is chosen (e.g. close the parent dropdown). */
  onPick?: () => void;
  searchPlaceholder?: string;
}) {
  const [query, setQuery] = useState("");
  const showSearch = FILTER_FIELD_MENU_ALWAYS_SHOW_SEARCH || options.length > FILTER_LIST_VISIBLE_ROWS;
  const shellMaxHeightPx = useFieldSelectMenuShellHeight(FILTER_MENU_CONTENT_PX);
  /* Counts the rows this list RENDERS — which for the single-select callers includes the
     leading "All …" row they inject into `options` before passing it here. */
  useRegisterFilterMenuOptionCount(options.length);

  const visibleOptions = useMemo(() => {
    if (!query.trim()) return options;
    return options.filter((opt) => fieldSelectMenuMatches(opt.label, query));
  }, [options, query]);

  const listRef = useFieldSelectListboxPointerPick((pickedValue) => {
    onChange(pickedValue);
    if (onPick) deferAfterFieldSelectPick(onPick);
  });

  return (
    <div className="flex min-h-0 flex-col">
      {showSearch ? (
        <FieldSelectMenuSearch
          query={query}
          onQueryChange={setQuery}
          placeholder={searchPlaceholder}
          dataAttr={dataAttr ? `${dataAttr}-search` : undefined}
        />
      ) : null}
      <div
        ref={listRef}
        role="listbox"
        data-attr={dataAttr}
        /* Never `flex-1` here — a zero flex-basis collapses the auto-height shell that
           makes a short list end early. `flex-[0_1_auto]` shrinks only under the cap. */
        className={cn(FIELD_SELECT_MENU_LISTBOX_SCROLL_CLASS, "min-h-0 flex-[0_1_auto]")}
        style={{
          touchAction: "pan-y",
          maxHeight: fieldSelectMenuListMaxHeightPx(
            shellMaxHeightPx,
            showSearch ? FIELD_SELECT_MENU_SEARCH_PX : 0,
          ),
        }}
        onWheel={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        {visibleOptions.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted">No matches</p>
        ) : (
          visibleOptions.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value || "__all__"}
                type="button"
                role="option"
                aria-selected={active}
                data-filter-option-value={opt.value}
                {...{ [FIELD_SELECT_OPTION_VALUE_ATTR]: opt.value }}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm",
                  FIELD_SELECT_MENU_OPTION_CLASS,
                  active ? "bg-primary/10 text-foreground" : "text-foreground",
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-primary" aria-hidden>
                  {active ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate leading-snug">{opt.label}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Convenience wrapper: label + portaled multi-select dropdown. */
export function FilterMultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  allLabel = "All",
  emptyMenuText = "No options",
  dataAttr,
  sectionId,
}: {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel?: string;
  emptyMenuText?: string;
  dataAttr?: string;
  sectionId?: string;
}) {
  return (
    <FilterCollapsibleSection
      sectionId={sectionId}
      label={label}
      summary={filterMultiSelectSummary(selected, options, allLabel)}
      empty={selected.length === 0}
      menuOptionCount={options.length}
      dataAttr={dataAttr ? `${dataAttr}-trigger` : undefined}
    >
      <FilterCheckboxList
        options={options}
        selected={selected}
        onChange={onChange}
        emptyMenuText={emptyMenuText}
        dataAttr={dataAttr}
      />
    </FilterCollapsibleSection>
  );
}

/** Convenience wrapper: label + portaled single-select dropdown. */
export function FilterSingleSelectDropdown({
  label,
  options,
  value,
  onChange,
  placeholder = "All",
  dataAttr,
  sectionId,
}: {
  label: string;
  options: Option[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  dataAttr?: string;
  sectionId?: string;
}) {
  return (
    <FilterCollapsibleSection
      sectionId={sectionId}
      label={label}
      summary={filterSingleSelectSummary(value, options, placeholder)}
      empty={!value}
      menuOptionCount={options.length}
      dataAttr={dataAttr ? `${dataAttr}-trigger` : undefined}
    >
      <FilterSingleSelectList
        options={options}
        value={value}
        onChange={onChange}
        dataAttr={dataAttr}
      />
    </FilterCollapsibleSection>
  );
}
