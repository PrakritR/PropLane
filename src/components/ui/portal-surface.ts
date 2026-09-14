"use client";

import { useSyncExternalStore } from "react";

/**
 * Which shape a popup takes, decided in ONE place.
 *
 * Before this, the whole decision was `(max-width: 1023px)` → bottom sheet, and
 * that rule was declared twice (`ui/modal.tsx`, `portal-filter-sort-sheet.tsx`).
 * A manager with a browser window narrower than 1024px therefore got a phone
 * bottom sheet — grabber handle and all — on a Mac, with a mouse in their hand.
 * That is what every one of the captain's 2026-09-13 screenshots is.
 *
 * The fix is to ask two questions instead of one:
 *
 *   - WHAT is it?     a toolbar control behaves differently from a form.
 *   - HOW is it used? a mouse can hit a 24px target and reach a corner; a thumb
 *                     cannot, and wants the bottom of the screen.
 *
 * A narrow window on a mouse stays a popover, because what changed is the
 * window — not the fact that someone is pointing at it with a cursor.
 */

/** The five shapes every popup in the portal falls into. */
export type PortalSurfaceKind =
  /** A control that filters or sorts the thing behind it. */
  | "toolbar"
  /** Four fields or fewer that create something. */
  | "short-form"
  /** A longer creation form. */
  | "long-form"
  /** Grouped preferences that are saved, not created. */
  | "settings"
  /** A yes/no on something irreversible. */
  | "confirm";

export type PortalSurface = "popover" | "dialog" | "sheet";

export const SMALL_PORTAL_VIEWPORT_QUERY = "(max-width: 1023px)";
export const FINE_POINTER_QUERY = "(pointer: fine)";
/**
 * Genuinely no room beside anything — not merely "narrower than a laptop".
 *
 * The old rule used the `lg` breakpoint (1023px) for this, which is why a Mac
 * window at 900px got a phone sheet. 900px has ample room for a 380px popover;
 * what does not is a window around phone width, and that is what this asks.
 */
export const NO_ROOM_FOR_POPOVER_QUERY = "(max-width: 639px)";

export type PortalSurfaceInputs = {
  /** A mouse, trackpad or stylus — something that can hit a small target. */
  finePointer: boolean;
  /** Too narrow for a popover to sit beside anything (roughly phone width). */
  noRoomForPopover: boolean;
};

/**
 * The rule.
 *
 * The POINTER decides, and width only intervenes when a popover physically will
 * not fit. Resizing a desktop window does not turn a mouse into a thumb — that
 * conflation is the whole bug: at 900px the old rule handed a Mac a phone sheet
 * even though there was room for three popovers side by side.
 *
 * `confirm` never becomes a sheet: a destructive yes/no should interrupt, and a
 * sheet that can be swiped away is the wrong shape for a question you must
 * actually answer.
 */
export function resolvePortalSurface(
  kind: PortalSurfaceKind,
  { finePointer, noRoomForPopover }: PortalSurfaceInputs,
): PortalSurface {
  if (kind === "confirm") return "dialog";
  if (!finePointer) return "sheet";
  if (noRoomForPopover) return "sheet";
  return kind === "toolbar" ? "popover" : "dialog";
}

/** Max width for a surface, so a two-field form never gets a six-field frame. */
export function portalSurfaceWidthPx(kind: PortalSurfaceKind): number {
  switch (kind) {
    case "toolbar":
      return 380;
    case "short-form":
      return 440;
    case "long-form":
      return 620;
    case "settings":
      return 560;
    case "confirm":
      return 400;
  }
}

function subscribeMedia(query: string) {
  return (onStoreChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener("change", onStoreChange);
    return () => mql.removeEventListener("change", onStoreChange);
  };
}

function matchesMedia(query: string, serverValue: boolean) {
  return () => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return serverValue;
    return window.matchMedia(query).matches;
  };
}

/**
 * The live answer for one popup.
 *
 * Server-renders as the desktop shape: a sheet rendered first and then swapped
 * to a dialog is a visible jump, and the desktop shape is the more common one
 * for this portal.
 */
export function usePortalSurface(kind: PortalSurfaceKind): PortalSurface {
  const finePointer = useSyncExternalStore(
    subscribeMedia(FINE_POINTER_QUERY),
    matchesMedia(FINE_POINTER_QUERY, true),
    () => true,
  );
  const noRoomForPopover = useSyncExternalStore(
    subscribeMedia(NO_ROOM_FOR_POPOVER_QUERY),
    matchesMedia(NO_ROOM_FOR_POPOVER_QUERY, false),
    () => false,
  );
  return resolvePortalSurface(kind, { finePointer, noRoomForPopover });
}
