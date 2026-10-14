"use client";

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { SHEET_MS, sheetEasing } from "@/components/ui/motion/tokens";
import {
  pushDragSample,
  resolveSheetRelease,
  scrimOpacityForOffset,
  type DragSample,
} from "@/lib/ui/sheet-release";

/** The panel's current vertical translation in px, including a running animation's value. */
export function liveTranslateY(element: HTMLElement): number {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 0;
  const transform = window.getComputedStyle(element).transform;
  if (!transform || transform === "none") return 0;
  try {
    return new DOMMatrixReadOnly(transform).m42;
  } catch {
    return 0;
  }
}

/** The element's current opacity, including a running animation's value. */
export function liveOpacity(element: HTMLElement): number {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 1;
  const value = Number.parseFloat(window.getComputedStyle(element).opacity);
  return Number.isFinite(value) ? value : 1;
}

type DragState = {
  pointerId: number;
  originY: number;
  height: number;
  y: number;
  samples: DragSample[];
  /** The panel's own inline transition, put back when the drag ends. */
  transition: string;
};

/**
 * A panel may carry a CSS `transition: transform …` for its entrance (`.axis-assistant-sheet`).
 * Every `pointermove` writes a new transform, and each write would start that transition over, so
 * the sheet would ease toward the finger instead of following it. Suppressed for the drag only.
 */
function suppressTransition(panel: HTMLElement): string {
  const previous = panel.style.transition;
  panel.style.transition = "none";
  return previous;
}

/**
 * Put the panel's transition back without animating the value it is sitting on: reading a layout
 * property first commits the current transform as the before-change style.
 */
function restoreTransition(panel: HTMLElement, transition: string) {
  void panel.offsetHeight;
  panel.style.transition = transition;
}

/**
 * The one drag-to-dismiss gesture for every phone sheet. The sheet follows the finger 1:1, the
 * scrim fades with the offset, and on release the sheet either settles back with a spring or
 * is handed to `onDismiss` from its live offset (the caller's exit animation reads
 * `liveTranslateY`, so the velocity of the throw is not lost). Grabbing a sheet that is still
 * animating in or out cancels that animation and continues from where it is on screen.
 */
export function useSheetDrag({
  getPanel,
  getScrim,
  onDismiss,
  reducedMotion,
  ignoreSelector = "button",
}: {
  getPanel: () => HTMLElement | null;
  getScrim?: () => HTMLElement | null;
  onDismiss: () => void;
  reducedMotion: boolean;
  /** A pointer-down inside this selector is a tap on a control, not the start of a drag. */
  ignoreSelector?: string;
}) {
  const stateRef = useRef<DragState | null>(null);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  const apply = useCallback(
    (y: number, height: number) => {
      const panel = getPanel();
      if (panel) panel.style.transform = y > 0 ? `translateY(${y}px)` : "";
      const scrim = getScrim?.();
      if (scrim) scrim.style.opacity = y > 0 ? String(scrimOpacityForOffset(y, height)) : "";
    },
    [getPanel, getScrim],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (ignoreSelector && (event.target as Element).closest?.(ignoreSelector)) return;
      const panel = getPanel();
      if (!panel) return;
      // Catch a sheet mid-flight: freeze it where it is, then drag from there.
      const startOffset = Math.max(0, liveTranslateY(panel));
      const scrim = getScrim?.();
      const startOpacity = scrim ? liveOpacity(scrim) : 1;
      if (typeof panel.getAnimations === "function") panel.getAnimations().forEach((a) => a.cancel());
      if (scrim && typeof scrim.getAnimations === "function") scrim.getAnimations().forEach((a) => a.cancel());
      const height = panel.offsetHeight;
      stateRef.current = {
        pointerId: event.pointerId,
        originY: event.clientY - startOffset,
        height,
        y: startOffset,
        samples: [{ t: event.timeStamp, y: startOffset }],
        transition: suppressTransition(panel),
      };
      if (startOffset > 0) {
        panel.style.transform = `translateY(${startOffset}px)`;
        if (scrim) scrim.style.opacity = String(startOpacity);
      }
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [getPanel, getScrim, ignoreSelector],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const y = Math.max(0, event.clientY - state.originY);
      state.y = y;
      state.samples = pushDragSample(state.samples, { t: event.timeStamp, y });
      apply(y, state.height);
    },
    [apply],
  );

  const finish = useCallback(
    (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      stateRef.current = null;
      const panel = getPanel();
      const scrim = getScrim?.();
      const { dismiss } = cancelled
        ? { dismiss: false }
        : resolveSheetRelease({ samples: state.samples, y: state.y, height: state.height });
      if (dismiss) {
        // Leave the inline offset in place: the exit animation continues from it.
        if (panel) restoreTransition(panel, state.transition);
        onDismissRef.current();
        return;
      }
      if (state.y <= 0 || !panel) {
        apply(0, state.height);
        if (panel) restoreTransition(panel, state.transition);
        return;
      }
      // Settle: spring from the live offset back to rest, scrim back to full.
      const from = state.y;
      const scrimFrom = scrim ? liveOpacity(scrim) : 1;
      apply(0, state.height);
      if (typeof panel.animate !== "function" || reducedMotion) {
        restoreTransition(panel, state.transition);
        return;
      }
      const settle = panel.animate(
        [{ transform: `translateY(${from}px)` }, { transform: "translateY(0px)" }],
        { duration: SHEET_MS.settle, easing: sheetEasing() },
      );
      // The CSS transition stays off until the spring lands, so the two never run the same move.
      const release = () => restoreTransition(panel, state.transition);
      settle.finished.then(release).catch(release);
      scrim?.animate?.([{ opacity: scrimFrom }, { opacity: 1 }], { duration: SHEET_MS.settle, easing: sheetEasing() });
    },
    [apply, getPanel, getScrim, reducedMotion],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event, false),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
  };
}
