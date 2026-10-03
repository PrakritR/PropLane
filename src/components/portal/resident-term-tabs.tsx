"use client";

import { useState } from "react";
import { ManagerPortalFilterRow } from "@/components/portal/portal-metrics";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  RESIDENT_TERM_LABELS,
  RESIDENT_TERM_ORDER,
  defaultResidentTerm,
  type ResidentTerm,
} from "@/lib/resident-term-split";

/**
 * Long term | Short term text tabs with counts - the resident portal's two
 * sections. State lives with the caller's list so the filter and the tabs share
 * one source; `section` only namespaces the analytics attributes.
 */
export function useResidentTermTab(counts: Record<ResidentTerm, number>, preferred?: ResidentTerm) {
  const [chosen, setChosen] = useState<ResidentTerm | null>(null);
  const term = chosen ?? defaultResidentTerm(counts, preferred);
  return [term, setChosen] as const;
}

export function ResidentTermTabs({
  section,
  term,
  counts,
  onChange,
}: {
  section: "applications" | "lease" | "payments";
  term: ResidentTerm;
  counts: Record<ResidentTerm, number>;
  onChange: (term: ResidentTerm) => void;
}) {
  return (
    <ManagerPortalFilterRow>
      <LocalDestinationNav
        appearance="command"
        items={RESIDENT_TERM_ORDER.map((id) => ({
          id,
          label: RESIDENT_TERM_LABELS[id],
          count: counts[id],
          dataAttr: `resident-${section}-term-${id === "short_term" ? "short" : "long"}`,
        }))}
        activeId={term}
        onChange={(id) => onChange(id as ResidentTerm)}
        ariaLabel="Stay length"
      />
    </ManagerPortalFilterRow>
  );
}
