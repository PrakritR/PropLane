"use client";

import { useEffect, useRef } from "react";
import type { CommunicationThreadFilters } from "@/lib/communication-thread-filters";
import { readStoredFromFilter, writeStoredFromFilter } from "@/lib/communication-from-filter";

/** Restores the per-viewer "From" filter after mount (SSR-safe) and saves every change. */
export function useCommunicationFromFilter(
  filters: CommunicationThreadFilters,
  setFilters: (update: (current: CommunicationThreadFilters) => CommunicationThreadFilters) => void,
): void {
  const restored = useRef(false);
  useEffect(() => {
    const stored = readStoredFromFilter();
    restored.current = true;
    if (stored !== "all") setFilters((current) => (current.from ? current : { ...current, from: stored }));
  }, [setFilters]);
  useEffect(() => {
    if (restored.current) writeStoredFromFilter(filters.from ?? "all");
  }, [filters.from]);
}
