"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  armFilterSheetDismissGuardFromFieldPick,
  fieldSelectEventTargetElement,
} from "@/components/ui/field-select-portal-interaction";

/** Pointer movement above this is a scroll gesture, not an option pick. */
export const FIELD_SELECT_LISTBOX_PICK_SLOP_PX = 8;

export const FIELD_SELECT_OPTION_VALUE_ATTR = "data-field-select-option-value";

function optionValueFromRow(row: HTMLElement): string | null {
  const fromShared = row.getAttribute(FIELD_SELECT_OPTION_VALUE_ATTR);
  if (fromShared !== null) return fromShared;
  const legacy = row.getAttribute("data-filter-option-value");
  return legacy !== null ? legacy : null;
}

/**
 * Portaled field-select menus often render under `document.body`, outside the Next.js root
 * where React 17+ attaches delegated listeners — synthetic handlers on rows never run in
 * production even though jsdom tests pass. Handle picks on the listbox natively.
 * Uses pointerup + slop so we never `preventDefault` on pointerdown, which would block scrolling.
 *
 * Returns a callback ref because the listbox mounts only while the menu is open.
 */
export function useFieldSelectListboxPointerPick(
  onPick: (value: string, event: PointerEvent) => void,
) {
  const onPickRef = useRef(onPick);
  const pressRef = useRef<{ id: number; x: number; y: number; value: string } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Written in an effect, never during render: the pick fires from a native pointerup, which
  // always lands after the commit that refreshed this ref.
  useEffect(() => {
    onPickRef.current = onPick;
  });

  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback((list: HTMLDivElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!list) return;

    const onPointerDown = (event: PointerEvent) => {
      const element = fieldSelectEventTargetElement(event.target);
      const row = element?.closest<HTMLElement>('[role="option"]');
      if (!row || !list.contains(row)) return;
      if (row.getAttribute("aria-disabled") === "true") return;
      const value = optionValueFromRow(row);
      if (value === null) return;
      pressRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        value,
      };
    };

    const clearPress = (pointerId?: number) => {
      const press = pressRef.current;
      if (!press) return;
      if (pointerId !== undefined && press.id !== pointerId) return;
      pressRef.current = null;
    };

    const onPointerUp = (event: PointerEvent) => {
      const press = pressRef.current;
      if (!press || press.id !== event.pointerId) return;
      pressRef.current = null;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (
        dx * dx + dy * dy >
        FIELD_SELECT_LISTBOX_PICK_SLOP_PX * FIELD_SELECT_LISTBOX_PICK_SLOP_PX
      ) {
        return;
      }
      armFilterSheetDismissGuardFromFieldPick();
      onPickRef.current(press.value, event);
    };

    const onPointerCancel = (event: PointerEvent) => {
      clearPress(event.pointerId);
    };

    list.addEventListener("pointerdown", onPointerDown);
    list.addEventListener("pointerup", onPointerUp);
    list.addEventListener("pointercancel", onPointerCancel);
    cleanupRef.current = () => {
      list.removeEventListener("pointerdown", onPointerDown);
      list.removeEventListener("pointerup", onPointerUp);
      list.removeEventListener("pointercancel", onPointerCancel);
    };
  }, []);
}
