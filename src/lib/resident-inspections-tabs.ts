import type { InspectionKind, InspectionStatus } from "@/lib/inspections/model";

/**
 * Resident Inspections header buttons (captain, 2026-09-25: every resident
 * list gets three right-side header buttons named per page — Inspections get
 * Upcoming / In progress / Done). Move-in / Move-out — a real, different kind
 * of inspection, not a status — moves into the header's Filter popover as a
 * "Type" field instead of being a top destination. The MANAGER Inspections
 * view is untouched: it keeps the real Move-in / Move-out destinations
 * (`inspections-panel.tsx` only switches to this bucket model for
 * `role === "resident"`, non-embedded).
 */
export type ResidentInspectionTab = "upcoming" | "in-progress" | "done";

export const RESIDENT_INSPECTION_TAB_ORDER: ResidentInspectionTab[] = ["upcoming", "in-progress", "done"];

export const RESIDENT_INSPECTION_TAB_LABELS: Record<ResidentInspectionTab, string> = {
  upcoming: "Upcoming",
  "in-progress": "In progress",
  done: "Done",
};

export const RESIDENT_INSPECTION_TYPE_LABELS: Record<InspectionKind, string> = {
  "move-in": "Move-in",
  "move-out": "Move-out",
};

export const RESIDENT_INSPECTION_TYPE_FILTER_OPTIONS = ["all", "move-in", "move-out"] as const;
export type ResidentInspectionTypeFilter = (typeof RESIDENT_INSPECTION_TYPE_FILTER_OPTIONS)[number];

export function parseResidentInspectionTypeFilter(
  raw: string | undefined | null,
): ResidentInspectionTypeFilter {
  if (raw && (RESIDENT_INSPECTION_TYPE_FILTER_OPTIONS as readonly string[]).includes(raw)) {
    return raw as ResidentInspectionTypeFilter;
  }
  return "all";
}

/**
 * A row with no filed report yet is Upcoming — nothing has started. A filed
 * report reads `draft`/`submitted` as In progress (the resident or manager is
 * still working through rooms) and `completed` as Done. Derived from the
 * report's own status, which already reflects whether/when it was finished
 * (`inspection_date` on the report is the date it covers, not a completion
 * timestamp, so status — not a date comparison — is the correct signal).
 */
export function residentInspectionTab(report: { status: InspectionStatus } | null | undefined): ResidentInspectionTab {
  if (!report) return "upcoming";
  if (report.status === "completed") return "done";
  return "in-progress";
}

export function parseResidentInspectionTab(raw: string | undefined | null): ResidentInspectionTab {
  if (raw && (RESIDENT_INSPECTION_TAB_ORDER as readonly string[]).includes(raw)) {
    return raw as ResidentInspectionTab;
  }
  return "upcoming";
}
