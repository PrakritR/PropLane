"use client";

import { useEffect, useRef } from "react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { firstNonEmptyTabToOpen } from "@/lib/portal-default-tab";

/**
 * Routed tab lists (Lease, Forms): when the address names no tab, move to the first tab
 * with rows instead of leaving the resident on an empty default. Decided once per bare
 * visit, after the counts are real (`ready`); an address that names a tab always wins.
 */
export function useOpenFirstNonEmptyTab<T extends string>({
  tabs,
  activeId,
  urlNamesTab,
  ready,
  hrefFor,
}: {
  tabs: ReadonlyArray<{ id: T; count?: number }>;
  activeId: T;
  urlNamesTab: boolean;
  ready: boolean;
  hrefFor: (id: T) => string;
}) {
  const navigate = usePortalNavigate();
  const decided = useRef(false);
  const countsKey = tabs.map((tab) => `${tab.id}:${tab.count ?? 0}`).join("|");
  useEffect(() => {
    if (urlNamesTab) {
      decided.current = false;
      return;
    }
    if (!ready || decided.current) return;
    decided.current = true;
    const next = firstNonEmptyTabToOpen(tabs, activeId, false);
    if (next) navigate(hrefFor(next), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `countsKey` stands for `tabs`; `hrefFor` is a pure builder
  }, [urlNamesTab, ready, countsKey, activeId, navigate]);
}
