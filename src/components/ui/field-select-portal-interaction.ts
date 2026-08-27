import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

/** How long a filter panel ignores an outside-dismiss after a list pick (ghost clicks). */
const FILTER_SHEET_DISMISS_GUARD_MS = 1000;

/** Ignore filter OPEN toggles briefly after another overlay dismisses (Radix menu → stray click). */
const FILTER_SHEET_OPEN_SUPPRESS_MS = 450;

let armFilterSheetDismissGuard: (() => void) | null = null;
let armFilterSheetOpenSuppress: (() => void) | null = null;

/**
 * Filter panels register a short dismiss guard so a synthesized click after a portaled
 * menu pick cannot close the whole sheet.
 */
export function registerFilterSheetDismissGuard(arm: () => void): () => void {
  armFilterSheetDismissGuard = arm;
  return () => {
    if (armFilterSheetDismissGuard === arm) armFilterSheetDismissGuard = null;
  };
}

/** Arm the guard before any portaled filter option pick (multi- or single-select). */
export function armFilterSheetDismissGuardFromFieldPick(): void {
  armFilterSheetDismissGuard?.();
}

export function registerFilterSheetOpenSuppress(arm: () => void): () => void {
  armFilterSheetOpenSuppress = arm;
  return () => {
    if (armFilterSheetOpenSuppress === arm) armFilterSheetOpenSuppress = null;
  };
}

/** Call before opening a modal/menu from a header action so a dismiss ghost click cannot open Filter. */
export function armFilterSheetOpenSuppressFromOverlayDismiss(): void {
  armFilterSheetOpenSuppress?.();
}

/** Pointer targets on option labels are often Text nodes — resolve to an Element for `closest`. */
export function fieldSelectEventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Text && target.parentElement) return target.parentElement;
  return null;
}

/**
 * Portaled field-select menus sit outside Radix/Vaul modal trees. Prefer
 * `useFieldSelectListboxPointerPick` (pointerup + slop) on the listbox so scrolling
 * is not mistaken for a pick. These handlers remain for legacy call sites.
 */
export function handlePortaledFieldSelectOptionPointerDown(
  event: ReactPointerEvent,
  action: () => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  armFilterSheetDismissGuardFromFieldPick();
  action();
}

/** Primary pick handler for portaled filter option rows (label / button). */
export function handlePortaledFieldSelectOptionClick(
  event: ReactMouseEvent,
  action: () => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  armFilterSheetDismissGuardFromFieldPick();
  action();
}

/**
 * Defer closing a portaled field menu until after the browser finishes the pick
 * gesture. Closing synchronously on pointerdown unmounts the menu before the
 * follow-up click lands, which on mobile can hit the sheet overlay and dismiss
 * the whole filter panel.
 */
export function deferAfterFieldSelectPick(action: () => void): void {
  armFilterSheetDismissGuardFromFieldPick();
  requestAnimationFrame(() => {
    requestAnimationFrame(action);
  });
}

export { FILTER_SHEET_DISMISS_GUARD_MS, FILTER_SHEET_OPEN_SUPPRESS_MS };

/** Menu roots portaled into open modal shells or `document.body` — modal outside-click handlers must ignore these. */
export const FIELD_SELECT_MENU_DATA_ATTR = "data-field-select-menu";

export function isPortaledFieldSelectMenuTarget(target: EventTarget | null): boolean {
  const element = fieldSelectEventTargetElement(target);
  if (!element) return false;
  return Boolean(
    element.closest(`[${FIELD_SELECT_MENU_DATA_ATTR}]`) ||
      element.closest('[role="listbox"]') ||
      element.closest('[data-slot="portal-filter-dropdown-panel"]') ||
      element.closest('[data-attr="portal-filter-dropdown-panel"]'),
  );
}
