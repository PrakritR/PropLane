"use client";

/**
 * The real Filter popover (`PortalFilterSortSheet`) for the home demo's list headers, loaded on demand: the
 * sheet pulls the modal / bottom-sheet stack in behind it, which the public home page should not carry in its
 * first load. Until the chunk arrives the header draws the same Filter icon (inert), so nothing jumps; every
 * prop is the real component's own.
 */

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { Filter } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import type { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";

const Sheet = dynamic(() => import("@/components/portal/portal-filter-sort-sheet").then((m) => m.PortalFilterSortSheet), {
  ssr: false,
  loading: () => <PortalIconAction icon={Filter} label="Filter" />,
});

/** Same helpers the real module exports (`portalFilterActiveCount`, `filterApplyLabel`), kept here so a panel can
 * count filters and word the footer without importing the sheet's module (and its modal stack) statically. */
export function portalFilterActiveCount(
  values: Array<string | number | boolean | null | undefined | readonly string[]>,
): number {
  return values.filter((v) => {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.trim().length > 0;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return Boolean(v);
  }).length;
}

export function filterApplyLabel(resultCount: number | undefined, noun: string | undefined): string {
  if (resultCount == null) return "Save";
  const word = noun?.trim() || "result";
  return `Show ${resultCount} ${resultCount === 1 ? word : `${word}s`}`;
}

export function DemoFilterSheet(props: ComponentProps<typeof PortalFilterSortSheet>) {
  return <Sheet {...props} />;
}
