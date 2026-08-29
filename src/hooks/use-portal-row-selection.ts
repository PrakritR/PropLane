"use client";

import { useCallback, useEffect, useState } from "react";

/** Checkbox multi-select for manager portal list tables. Clears when `resetKey` changes (tab/bucket). */
export function usePortalRowSelection(resetKey?: string | number) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectedIds(new Set());
  }, [resetKey]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  return { selectedIds, setSelectedIds, toggleSelected, clearSelection };
}
