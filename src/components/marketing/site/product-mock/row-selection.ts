"use client";

import { useState } from "react";

/**
 * Row selection the way the real lists keep it: the row's ⋯ ticks its (hidden) checkbox, and the list's menu is
 * built from the ONE selected row (`bulkActions={only ? rowMenu(only) : undefined}`), so a row's ⋯ items can open
 * that row's own pop-up (Edit, View) instead of a generic toast.
 */
export function useRowSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return {
    selected,
    isChecked: (id: string) => selected.has(id),
    set: (id: string, checked: boolean) =>
      setSelected((current) => {
        const next = new Set(current);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      }),
    clear: () => setSelected(new Set()),
    /** The id when exactly one row is selected. */
    only: selected.size === 1 ? [...selected][0]! : null,
  };
}
