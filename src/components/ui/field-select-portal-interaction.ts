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
 * Portaled field-select menus sit outside Radix/Vaul modal trees, so a pick has to be
 * handled natively rather than through React's delegated listeners. Every option list now
 * does that through `useFieldSelectListboxPointerPick` (pointerup + slop), and this
 * pointerdown helper has NO remaining call sites: picking on pointerdown reads the start of
 * a scroll drag as a selection, which is the bug that hook exists to avoid. Do not reuse it.
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

/** Unused: click-time variant of the pointerdown helper above; same caveat applies. */
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

/**
 * Portaled menus (field-select, row ⋯) sit outside Radix/Vaul modal trees.
 * Modal outside-click handlers must ignore them so a pick does not dismiss the sheet.
 */
/**
 * Is a portaled field-select menu (or any listbox it renders as, per
 * `isPortaledFieldSelectMenuTarget`) currently open anywhere in the document?
 *
 * A field-select menu's own Escape handling closes itself, but that listener
 * runs on `document` in the bubble phase — it always runs AFTER a Radix
 * `Dialog`/`Drawer`'s own Escape handling, which Radix registers on
 * `document` in the CAPTURE phase (see `@radix-ui/react-use-escape-keydown`).
 * So an Escape meant only to close the dropdown was also closing the whole
 * modal underneath it (BUILD-WAVE2 C090/C092). The fix hooks into Radix's own
 * `onEscapeKeyDown` prop (see `modal.tsx`): when a field-select menu is open,
 * that handler calls `preventDefault()`, which Radix's `DismissableLayer`
 * checks before dismissing — the modal stays open, and the menu's own
 * (slightly later) listener still closes just the dropdown.
 */
export function isAnyPortaledFieldSelectMenuOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`) || document.querySelector('[role="listbox"]'),
  );
}

export function isPortaledFieldSelectMenuTarget(target: EventTarget | null): boolean {
  const element = fieldSelectEventTargetElement(target);
  if (!element) return false;
  return Boolean(
    element.closest(`[${FIELD_SELECT_MENU_DATA_ATTR}]`) ||
      element.closest('[role="listbox"]') ||
      element.closest('[data-slot="portal-filter-dropdown-panel"]') ||
      element.closest('[data-attr="portal-filter-dropdown-panel"]') ||
      element.closest('[data-attr="record-actions-menu"]') ||
      element.closest('[data-attr="record-actions-trigger"]') ||
      element.closest("[data-radix-dropdown-menu-content]") ||
      element.closest("[data-radix-dropdown-menu-trigger]"),
  );
}
