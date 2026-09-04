"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useIsClient } from "@/hooks/use-is-client";
import { FIELD_SELECT_MENU_DATA_ATTR, fieldSelectEventTargetElement } from "@/components/ui/field-select-portal-interaction";

/**
 * Shared machinery for the one portaled field-select dropdown pattern used by
 * `CheckboxMultiSelect` / `FieldSingleSelect` (form + toolbar fields) and by the
 * portal filter fields (`filter-field-lists.tsx`). The menu is rendered into an
 * open modal/drawer shell (or `document.body` as a fallback) so it overlays the
 * trigger instead of pushing sibling controls down or resizing the panel, and it
 * caps its option list at {@link FIELD_SELECT_MENU_VISIBLE_ITEMS} rows and scrolls
 * the rest. Do not fork a second positioning implementation — extend this one.
 */

/** Rows visible before the option list starts scrolling. Single source of the "5". */
export const FIELD_SELECT_MENU_VISIBLE_ITEMS = 5;
export const FIELD_SELECT_MENU_ITEM_HEIGHT_PX = 40;
/** Height reserved for the in-menu search row (input + padding). */
export const FIELD_SELECT_MENU_SEARCH_PX = 52;

/**
 * Height reserved for the in-menu field-name header.
 *
 * NOTHING RENDERS THE HEADER TODAY: the filter trigger row already prints the field
 * label, so repeating it inside the portaled menu showed "PROPERTY" twice. Both this
 * constant and {@link FieldSelectMenuHeader} are kept for a surface that genuinely
 * covers its own trigger label.
 *
 * If you re-add one, it must be paid for out of the menu's own box (pass it as
 * `extraPx` to {@link fieldSelectMenuContentPx}) WITHOUT costing an option row — the
 * five-row rule is not negotiable — and WITHOUT pushing the menu past what its host can
 * contain BELOW ITS CHROME. The binding constraint is the 3-field filter panel: 23rem/368px,
 * its own Filter/Reset/✕ chrome a MEASURED 58px (`PORTAL_FILTER_PANEL_CHROME_PX`), and an
 * 8px containment gap, against a header-less menu (search row + five option rows) of 264px.
 * Changing it means re-checking `portalFilterPanelSizeClass` against
 * `computeFieldSelectMenuRectInHost`'s `hostCanContainMenu`, which subtracts the chrome.
 */
export const FIELD_SELECT_MENU_HEADER_PX = 28;

/**
 * Height of exactly 5 option rows. The cap is applied to the portaled SHELL (via
 * {@link fieldSelectMenuContentPx} → `menuRect.maxHeight`), not to the list itself,
 * so a short list keeps the menu sized to its real content.
 */
export const FIELD_SELECT_MENU_LIST_MAX_HEIGHT_PX =
  FIELD_SELECT_MENU_VISIBLE_ITEMS * FIELD_SELECT_MENU_ITEM_HEIGHT_PX;

/** Portaled surface (border/shadow/opaque bg) that overlays the trigger. */
export const FIELD_SELECT_MENU_SHELL_CLASS =
  "field-dropdown-menu flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border shadow-[0_16px_40px_-12px_rgba(15,23,42,0.35)]";

/** Scrollable option list — a shrinkable flex child (`flex: 0 1 auto`) so the shell
 * still sizes to its real content and the list scrolls once the shell hits its cap.
 * Never `flex-1` here: a zero flex-basis collapses the auto-height shell.
 */
export const FIELD_SELECT_MENU_LISTBOX_SCROLL_CLASS =
  "min-h-0 overflow-y-auto overscroll-contain py-1 [-webkit-overflow-scrolling:touch] touch-pan-y";

/** Short menus (≤5 options, no search) — size to content with no inner scrollbar. */
export const FIELD_SELECT_MENU_LISTBOX_FIT_CLASS = "overflow-visible py-1";

export function fieldSelectMenuFitsWithoutScroll(optionCount: number, searchPx = 0): boolean {
  return searchPx === 0 && optionCount <= FIELD_SELECT_MENU_VISIBLE_ITEMS;
}

const FIELD_SELECT_MENU_SEARCH_INPUT_CLASS =
  "h-9 w-full rounded-xl border border-border bg-auth-input-bg pl-8 pr-3 text-sm text-foreground outline-none placeholder:text-muted/70 focus:border-primary/40 focus:ring-2 focus:ring-primary/10";

const OPEN_FIELD_SELECT_MODAL_SELECTORS = [
  '[data-slot="modal-vaul-drawer"][data-state="open"]',
  '[data-slot="modal-radix-dialog"][data-state="open"]',
  '[data-slot="vaul-bottom-sheet"][data-state="open"]',
];

/**
 * Portal menus into an open modal/drawer shell when present. Radix `hideOthers` and Vaul
 * mark every `document.body` sibling outside the dialog tree as aria-hidden, so body-
 * portaled menus look correct but cannot receive clicks and Vaul treats scroll as an
 * outside dismiss. Prefer the open Vaul sheet or filter panel host with absolute coords.
 */
export function resolveFieldSelectMenuPortal(): HTMLElement {
  const vaulSheetOpen = document.querySelector<HTMLElement>(
    '[data-slot="vaul-bottom-sheet"][data-state="open"]',
  );
  if (vaulSheetOpen) return vaulSheetOpen;

  /* Filter sheets mount only while `open` — `data-state` can lag a frame behind the host. */
  const vaulSheet = document.querySelector<HTMLElement>('[data-slot="vaul-bottom-sheet"]');
  if (vaulSheet) return vaulSheet;

  for (const selector of OPEN_FIELD_SELECT_MODAL_SELECTORS) {
    if (selector === '[data-slot="vaul-bottom-sheet"][data-state="open"]') continue;
    const host = document.querySelector<HTMLElement>(selector);
    if (host) return host;
  }
  const openFilterPanel = document.querySelector<HTMLElement>(
    '[data-slot="portal-filter-dropdown-panel"]',
  );
  if (openFilterPanel) return openFilterPanel;
  return document.body;
}

/**
 * Marks a host's FIXED chrome (drag handle + title row, or the filter panel's
 * Filter/Reset/✕ row) so a portaled menu is never placed over it. Measured at runtime
 * rather than assumed, because the chrome differs per host and a stale constant would
 * silently start hiding the close control again.
 */
export const FIELD_SELECT_HOST_CHROME_ATTR = "data-field-select-host-chrome";

/** Height of the host's fixed chrome, measured from the host's top edge. */
export function fieldSelectHostTopInsetPx(host: HTMLElement): number {
  const chrome = [...host.querySelectorAll<HTMLElement>(`[${FIELD_SELECT_HOST_CHROME_ATTR}]`)];
  if (chrome.length === 0) return 0;
  const hostTop = host.getBoundingClientRect().top;
  return chrome.reduce((lowest, el) => {
    const { bottom, height } = el.getBoundingClientRect();
    return height > 0 ? Math.max(lowest, bottom - hostTop) : lowest;
  }, 0);
}

export function fieldSelectMenuZIndex(portalHost: HTMLElement): number {
  if (portalHost === document.body) return 10000;
  if (portalHost.matches('[data-slot="vaul-bottom-sheet"]')) return 100;
  if (portalHost.matches('[data-slot="portal-filter-dropdown-panel"]')) return 30;
  return 80;
}

export type FieldSelectMenuRect = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  position: "fixed" | "absolute";
};

/**
 * Content height for `count` option rows (capped at 5) plus optional `extraPx`
 * (e.g. a search row). Callers pass this to size the menu and decide open-up.
 */
export function fieldSelectMenuContentPx(count: number, extraPx = 0): number {
  const rows = Math.min(Math.max(count, 1), FIELD_SELECT_MENU_VISIBLE_ITEMS);
  return rows * FIELD_SELECT_MENU_ITEM_HEIGHT_PX + 12 + extraPx;
}

/**
 * Which way a menu opens, in FOUR ordered rules. The order is the whole design — do not
 * reorder them or fold them together:
 *
 * 1. Fits below → open down. `preferOpenDown` is a PREFERENCE, not a lock, and this is
 *    where it is honoured.
 * 2. Fits fully above → open UP, whatever the preference says. Rules 1 and 2 are the
 *    always-five-rows guarantee, so they come FIRST: a menu that would be clipped a row
 *    short below while the space above fits it whole must take the space above.
 * 3. Neither side fits and there is no preference → the roomier side wins.
 * 4. Neither side fits and down is preferred → hysteresis. Flipping up costs the user the
 *    established "filter menus open BELOW the trigger" placement, so it has to BUY at least
 *    one more whole option row ({@link FIELD_SELECT_MENU_ITEM_HEIGHT_PX}); otherwise a 1px
 *    difference flips the menu over the fields it was opened from for no visible gain. This
 *    arbitrates ONLY the leftover case where neither side can show five rows, which is
 *    exactly where the stickiness cannot cost a row.
 */
export function resolveOpenUp(
  spaceBelow: number,
  spaceAbove: number,
  contentPx: number,
  preferOpenDown: boolean,
): boolean {
  if (spaceBelow >= contentPx) return false;
  if (spaceAbove >= contentPx) return true;
  if (!preferOpenDown) return spaceAbove > spaceBelow;
  return spaceAbove >= spaceBelow + FIELD_SELECT_MENU_ITEM_HEIGHT_PX;
}

/** Scrollable list height inside a portaled menu shell (search row excluded). */
export function fieldSelectMenuListMaxHeightPx(shellMaxHeight: number, searchPx = 0): number {
  return Math.max(
    FIELD_SELECT_MENU_ITEM_HEIGHT_PX,
    shellMaxHeight - searchPx - 8,
  );
}

/** Right-align a fixed filter panel to its trigger and clamp inside the viewport. */
export function computePortalFilterDropdownRect(
  button: HTMLButtonElement,
  panelHeightPx: number,
  options?: {
    widthPx?: number;
    fullBleed?: boolean;
    horizontalBoundary?: Pick<DOMRect, "left" | "right">;
    /** Filter panels always open below the trigger — never flip above it. */
    preferOpenDown?: boolean;
    /** `start` pins the panel's left edge to the trigger; default `end` right-aligns. */
    alignToTrigger?: "start" | "end";
  },
): FieldSelectMenuRect {
  const rect = button.getBoundingClientRect();
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const fullBleed = options?.fullBleed ?? false;
  const viewportPadding = fullBleed ? 0 : 12;
  const preferredWidth = options?.widthPx ?? 22 * 16;
  const boundaryLeft = fullBleed
    ? 0
    : Math.max(viewportPadding, options?.horizontalBoundary?.left ?? viewportPadding);
  const boundaryRight = fullBleed
    ? viewportW
    : Math.min(viewportW - viewportPadding, options?.horizontalBoundary?.right ?? viewportW - viewportPadding);
  const availableWidth = Math.max(0, boundaryRight - boundaryLeft);
  const width = fullBleed ? viewportW : Math.min(preferredWidth, availableWidth);

  let left: number;
  if (fullBleed) {
    left = 0;
  } else if (options?.alignToTrigger === "start") {
    left = Math.min(Math.max(boundaryLeft, rect.left), boundaryRight - width);
  } else {
    left = rect.right - width;
    const startAlignedLeft = rect.left;
    if (left < boundaryLeft && startAlignedLeft + width <= boundaryRight) {
      left = startAlignedLeft;
    } else {
      left = Math.min(Math.max(boundaryLeft, left), boundaryRight - width);
    }
  }

  const gap = 8;
  const spaceBelow = viewportH - rect.bottom - viewportPadding;
  const spaceAbove = rect.top - viewportPadding;
  const preferOpenDown = options?.preferOpenDown ?? false;
  const openUp = preferOpenDown
    ? false
    : spaceBelow < panelHeightPx && spaceAbove > spaceBelow;
  // The 120px floor exists so a menu is never a useless sliver — but it must not exceed the space
  // that actually exists, or the menu runs past the viewport edge and its last rows become
  // unreachable: the list cannot scroll to content that was laid out off-screen. Clamp to the
  // larger side when neither fits, so the floor costs the user the shorter direction, not the
  // bottom of the list.
  const spaceFor = openUp ? spaceAbove - gap : spaceBelow - gap;
  const roomiest = Math.max(spaceAbove - gap, spaceBelow - gap);
  const maxHeight = Math.min(
    panelHeightPx,
    Math.max(Math.min(120, roomiest), spaceFor),
  );
  const top = openUp
    ? Math.max(viewportPadding, rect.top - maxHeight - gap)
    : rect.bottom + gap;

  return { top, left, width, maxHeight, position: "fixed" };
}

/** Position a field menu inside an open filter dropdown (or other non-body host). */
export function computeFieldSelectMenuRectInHost(
  button: HTMLButtonElement,
  contentPx: number,
  host: HTMLElement,
  options?: {
    minWidth?: number;
    hostPaddingPx?: number;
    preferOpenDown?: boolean;
    matchTriggerWidth?: boolean;
    /**
     * Viewport y (px) the menu may grow down to — a LAST RESORT, used only when the host
     * cannot fit `contentPx` on either side of the trigger. Containment is preferred: a
     * menu escaping its sheet onto the dimmed page reads as broken. But a host shorter than
     * the menu (a one-field sheet) would otherwise crush it to a single row, and showing
     * all five rows outranks staying inside. Omit to clamp to the host unconditionally.
     */
    bottomBoundPx?: number;
    /**
     * When true, keep the menu inside the host box (mobile sheets). Filter dropdown
     * panels intentionally spill below the panel shell — see the filter-panel branch.
     */
    strictHostContainment?: boolean;
    /**
     * Height of the host's FIXED chrome (drag handle, title, close, Reset) measured from
     * the host's top. The menu is never placed over it. Without this the clamp treated
     * chrome as free space and a contained menu covered the sheet's own close control —
     * on a phone, where there is no Escape key, that can leave the sheet undismissable.
     */
    topInsetPx?: number;
  },
): FieldSelectMenuRect {
  const hostRect = host.getBoundingClientRect();
  const rect = button.getBoundingClientRect();
  const gap = 4;
  const hostPadding = options?.hostPaddingPx ?? 12;
  const maxMenuWidth = Math.max(120, hostRect.width - hostPadding * 2);
  const minWidth = options?.minWidth ?? 0;
  const matchTriggerWidth = options?.matchTriggerWidth ?? false;
  const width = matchTriggerWidth
    ? rect.width
    : Math.min(Math.max(minWidth, rect.width), maxMenuWidth);

  let left = rect.left - hostRect.left;
  if (!matchTriggerWidth) {
    left = Math.min(Math.max(hostPadding, left), hostRect.width - width - hostPadding);
  }

  /* The host's fixed chrome is NOT free space — placing a menu over it hides the sheet's
     own close control, and a phone has no Escape key to fall back on. Every placement
     below starts at `safeTop`, never at the host's top edge. */
  const topInset = options?.topInsetPx ?? 0;
  const safeTop = topInset + gap;
  const spaceAbove = rect.top - hostRect.top - topInset - gap;
  const hostSpaceBelow = hostRect.bottom - rect.bottom - gap;
  const triggerTopInHost = rect.top - hostRect.top;
  const triggerBottomInHost = rect.bottom - hostRect.top;
  const preferOpenDown = options?.preferOpenDown ?? false;
  const strictHostContainment = options?.strictHostContainment ?? false;
  const inFilterDropdownPanel = host.matches('[data-slot="portal-filter-dropdown-panel"]');

  /* Desktop filter panel: always open DOWN and size to the viewport below the trigger.
     The menu may paint past the panel's bottom edge — that is intentional. */
  if (preferOpenDown && inFilterDropdownPanel) {
    const bottomBound = options?.bottomBoundPx ?? hostRect.bottom;
    const spaceBelow = bottomBound - rect.bottom - gap;
    const top = triggerBottomInHost + gap;
    const maxHeight = Math.min(
      contentPx,
      Math.max(FIELD_SELECT_MENU_ITEM_HEIGHT_PX + 12, spaceBelow),
    );
    if (maxHeight > 0) {
      return { top, left, width, maxHeight, position: "absolute" };
    }
  }

  if (preferOpenDown && strictHostContainment) {
    const hostMetricsReady = hostRect.height > 0 && rect.height > 0;
    if (hostMetricsReady) {
      const hostBottom = hostRect.height - gap;
      let top = Math.max(safeTop, triggerBottomInHost + gap);
      let maxHeight = Math.min(contentPx, hostBottom - top);

      if (maxHeight < FIELD_SELECT_MENU_ITEM_HEIGHT_PX + 12) {
        maxHeight = Math.min(contentPx, hostRect.height - topInset - gap * 2);
        top = Math.max(safeTop, hostBottom - maxHeight);
      }

      if (maxHeight > 0) {
        return { top, left, width, maxHeight, position: "absolute" };
      }
    }
  }

  /*
   * Containment first. A menu that escapes its sheet onto the dimmed page reads as broken,
   * so whenever the HOST is tall enough to hold the whole menu BELOW ITS CHROME we keep it
   * inside — even when neither side of the trigger alone has room, by sliding it back into
   * that box. That can overlap the trigger by the shortfall, which is the lesser cost: the
   * alternative is a menu hanging off the sheet, or one crushed below five rows.
   */
  const hostCanContainMenu = hostRect.height - topInset - gap * 2 >= contentPx;
  if (hostCanContainMenu) {
    const openUpInside = resolveOpenUp(hostSpaceBelow, spaceAbove, contentPx, preferOpenDown);
    const anchored = openUpInside
      ? triggerTopInHost - contentPx - gap
      : triggerBottomInHost + gap;
    const top = Math.min(Math.max(safeTop, anchored), hostRect.height - contentPx - gap);
    return { top, left, width, maxHeight: contentPx, position: "absolute" };
  }

  /* Host too short to hold the menu at all (a one-field sheet). Showing all five rows
     outranks staying inside, so fall back to the viewport bound when one was offered. */
  const bottomBound = options?.bottomBoundPx ?? hostRect.bottom;
  const spaceBelow = bottomBound - rect.bottom - gap;
  const openUp = resolveOpenUp(spaceBelow, spaceAbove, contentPx, preferOpenDown);
  const maxHeight = Math.min(
    contentPx,
    Math.max(FIELD_SELECT_MENU_ITEM_HEIGHT_PX + 12, openUp ? spaceAbove - gap : spaceBelow - gap),
  );
  const top = openUp
    ? Math.max(safeTop, triggerTopInHost - maxHeight - gap)
    : Math.max(safeTop, triggerBottomInHost + gap);

  return { top, left, width, maxHeight, position: "absolute" };
}

export function computeFieldSelectMenuRect(
  button: HTMLButtonElement,
  contentPx: number,
  portalHost: HTMLElement,
  options?: {
    minWidth?: number;
    preferOpenDown?: boolean;
    matchTriggerWidth?: boolean;
    /**
     * Height of the host's FIXED chrome measured from the host's top, exactly as in
     * {@link computeFieldSelectMenuRectInHost}. The rule is universal — there is no
     * "except in a modal" carve-out — because a modal that happens to be tall enough
     * today stops being tall enough the next time its content changes, silently.
     */
    topInsetPx?: number;
  },
): FieldSelectMenuRect {
  const rect = button.getBoundingClientRect();
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const viewportPadding = 12;
  const gap = 4;
  const contentHeight = contentPx;
  const topInset = options?.topInsetPx ?? 0;
  const hostTop = topInset > 0 ? portalHost.getBoundingClientRect().top : 0;
  /* This menu is `position: fixed`, so the host's chrome has to be translated into
     viewport coordinates before it can be honoured. Every placement below starts here. */
  const topBound = Math.max(viewportPadding, hostTop + topInset + gap);
  const preferOpenDown = options?.preferOpenDown ?? false;
  const matchTriggerWidth = options?.matchTriggerWidth ?? false;
  const spaceBelow = viewportH - rect.bottom - viewportPadding;
  const spaceAbove = rect.top - topBound;
  const openUp = resolveOpenUp(spaceBelow, spaceAbove, contentHeight, preferOpenDown);
  const maxHeight = Math.min(
    contentHeight,
    Math.max(FIELD_SELECT_MENU_ITEM_HEIGHT_PX + 12, openUp ? spaceAbove - 8 : spaceBelow - 8),
  );
  const minWidth = options?.minWidth ?? 0;
  const width = matchTriggerWidth
    ? rect.width
    : Math.min(minWidth > 0 ? minWidth : rect.width, viewportW - viewportPadding * 2);
  const left = matchTriggerWidth
    ? rect.left
    : Math.min(Math.max(viewportPadding, rect.left), viewportW - width - viewportPadding);
  const top = openUp
    ? Math.max(topBound, rect.top - maxHeight - gap)
    : Math.max(topBound, rect.bottom + gap);
  return {
    top,
    left,
    width,
    maxHeight,
    position: "fixed",
  };
}

/**
 * Owns the portaled-menu lifecycle for one trigger: rect computation (re-run on
 * scroll/resize), outside-pointerdown to close, and Escape to close + return focus
 * to the trigger. `open` is controlled by the caller so it can be driven by an
 * accordion (one-open-at-a-time) or local state.
 */
export function useFieldSelectMenu({
  open,
  onOpenChange,
  contentPx,
  minMenuWidth,
  align = "start",
  preferOpenDown = false,
  matchTriggerWidth = false,
  fullBleed = false,
  constrainToTitleBand = false,
  filterDropdownAlign = "end",
  closeOnOutsidePointerDown = true,
  closeOnEscape = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentPx: number;
  /** When set, the portaled menu is at least this wide (filter fields). */
  minMenuWidth?: number;
  /** `end` right-aligns the menu to the trigger (portal filter dropdown). */
  align?: "start" | "end";
  /** Portal filter fields always open below the trigger (mobile sheets, bottom fields). */
  preferOpenDown?: boolean;
  /** Align menu width/left to the trigger (mobile filter sheet edge-to-edge). */
  matchTriggerWidth?: boolean;
  /** Mobile filter dropdown spans the viewport with even side insets. */
  fullBleed?: boolean;
  /** Keep a title-row dropdown inside that title band's horizontal content bounds. */
  constrainToTitleBand?: boolean;
  /** Horizontal alignment for the portal filter dropdown shell (`align === "end"` path). */
  filterDropdownAlign?: "start" | "end";
  /**
   * When false, outside pointerdown does not call `onOpenChange(false)` — use for the
   * portal filter shell, which closes only via its scrim / header / toggle.
   */
  closeOnOutsidePointerDown?: boolean;
  /** When false, Escape does not call `onOpenChange(false)` (portal filter shell). */
  closeOnEscape?: boolean;
}) {
  const listId = useId();
  const isClient = useIsClient();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuRect, setMenuRect] = useState<FieldSelectMenuRect | null>(null);
  // State, not a render-time read of `portalHostRef`. The host is resolved by
  // querying the DOM, so neither the ref read nor the resolver call is safe
  // during render. It is set alongside `menuRect` in the same layout effect, so
  // both land in one commit and the portal still appears on the same paint.
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const portalHostRef = useRef<HTMLElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const closeOnOutsidePointerDownRef = useRef(closeOnOutsidePointerDown);
  const closeOnEscapeRef = useRef(closeOnEscape);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);
  useEffect(() => {
    closeOnOutsidePointerDownRef.current = closeOnOutsidePointerDown;
  }, [closeOnOutsidePointerDown]);
  useEffect(() => {
    closeOnEscapeRef.current = closeOnEscape;
  }, [closeOnEscape]);

  useLayoutEffect(() => {
    if (!open) {
      portalHostRef.current = null;
      return;
    }
    portalHostRef.current = resolveFieldSelectMenuPortal();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      setPortalHost(null);
      return;
    }
    const updateMenuRect = () => {
      const button = buttonRef.current;
      if (!button) return;
      const portalHost = portalHostRef.current ?? resolveFieldSelectMenuPortal();
      setPortalHost(portalHost);
      const inFilterPanel =
        portalHost !== document.body &&
        portalHost.matches('[data-slot="portal-filter-dropdown-panel"]');
      const inVaulSheet =
        portalHost !== document.body && portalHost.matches('[data-slot="vaul-bottom-sheet"]');
      const inModalDialog =
        portalHost !== document.body && portalHost.matches('[data-slot="modal-radix-dialog"]');
      const useHostAnchoredMenu = inFilterPanel || inVaulSheet || inModalDialog;
      setMenuRect(
        align === "end"
          ? computePortalFilterDropdownRect(button, contentPx, {
              widthPx: minMenuWidth,
              fullBleed,
              preferOpenDown: true,
              alignToTrigger: filterDropdownAlign,
              horizontalBoundary: constrainToTitleBand
                ? (button
                    .closest('[data-slot="portal-page-title-band"], [data-slot="portal-page-shell"]')
                    ?.getBoundingClientRect() ?? undefined)
                : undefined,
            })
          : useHostAnchoredMenu
            ? computeFieldSelectMenuRectInHost(button, contentPx, portalHost, {
                minWidth: minMenuWidth,
                preferOpenDown: preferOpenDown || inVaulSheet || inModalDialog,
                matchTriggerWidth: matchTriggerWidth || inVaulSheet || inModalDialog,
                hostPaddingPx: inVaulSheet ? 0 : undefined,
                topInsetPx: fieldSelectHostTopInsetPx(portalHost),
                strictHostContainment: inVaulSheet || inModalDialog,
                bottomBoundPx: window.innerHeight - 12,
              })
            : computeFieldSelectMenuRect(button, contentPx, portalHost, {
                minWidth: minMenuWidth,
                preferOpenDown,
                matchTriggerWidth,
                /* Same rule in a modal/dialog host as in a sheet: never over the chrome
                   that carries the close control. `document.body` has none to measure. */
                topInsetPx:
                  portalHost === document.body ? 0 : fieldSelectHostTopInsetPx(portalHost),
              }),
      );
    };
    updateMenuRect();
    window.addEventListener("resize", updateMenuRect);
    window.addEventListener("scroll", updateMenuRect, true);
    return () => {
      window.removeEventListener("resize", updateMenuRect);
      window.removeEventListener("scroll", updateMenuRect, true);
    };
  }, [
    align,
    open,
    contentPx,
    minMenuWidth,
    preferOpenDown,
    matchTriggerWidth,
    fullBleed,
    constrainToTitleBand,
    filterDropdownAlign,
  ]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closeOnEscapeRef.current) {
        onOpenChangeRef.current(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    const onPointerDownOutside = (event: PointerEvent) => {
      if (!closeOnOutsidePointerDownRef.current) return;
      const element = fieldSelectEventTargetElement(event.target);
      if (!element) return;
      if (wrapRef.current?.contains(element)) return;
      // A click inside ANY portaled field-select menu must not close this one.
      if (element.closest(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)) return;
      const list = document.getElementById(listId);
      if (list?.contains(element)) return;
      // Defer so a portaled option's pointerdown can arm a parent dismiss guard first
      // (this listener runs in capture phase, before the option handler).
      requestAnimationFrame(() => {
        onOpenChangeRef.current(false);
      });
    };
    document.addEventListener("pointerdown", onPointerDownOutside, true);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDownOutside, true);
    };
  }, [listId, open]);

  return {
    listId,
    isClient,
    wrapRef,
    buttonRef,
    menuRect,
    portalHost: menuRect && isClient ? portalHost : null,
  };
}

/**
 * Field name shown at the top of a portaled filter menu, for a host whose own field label
 * the menu covers. CURRENTLY UNUSED — portal filter menus dropped it because the trigger
 * row keeps its label visible, so rendering both duplicated the field name. Budgeted as
 * {@link FIELD_SELECT_MENU_HEADER_PX}; see that constant before adopting or restyling it.
 */
export function FieldSelectMenuHeader({ label }: { label: string }) {
  return (
    <p className="field-dropdown-menu-surface shrink-0 truncate border-b border-border px-3 py-1 text-[11px] font-semibold uppercase leading-4 tracking-wide text-muted">
      {label}
    </p>
  );
}

/**
 * Search box shown at the top of a menu once its option list is long enough to scroll.
 * Its row uses `field-dropdown-menu-surface`, never `bg-card`: that token resolves to
 * `rgba(255,255,255,.94)` on some themes, which is invisible over the opaque menu shell
 * but plainly see-through wherever the menu overhangs the page behind it.
 */
export function FieldSelectMenuSearch({
  query,
  onQueryChange,
  placeholder = "Search…",
  dataAttr,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  placeholder?: string;
  dataAttr?: string;
}) {
  return (
    <div className="field-dropdown-menu-surface relative shrink-0 border-b border-border px-2 py-2">
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        aria-hidden
      />
      <input
        type="text"
        inputMode="search"
        autoComplete="off"
        className={FIELD_SELECT_MENU_SEARCH_INPUT_CLASS}
        placeholder={placeholder}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        data-attr={dataAttr}
      />
    </div>
  );
}

/** Case-insensitive substring match used by every searchable field-select menu. */
export function fieldSelectMenuMatches(label: string, query: string): boolean {
  return label.toLowerCase().includes(query.trim().toLowerCase());
}
