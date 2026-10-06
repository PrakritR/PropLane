"use client";

import { FileText, MoreHorizontal } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { formatResidentShortDate } from "@/lib/manager-resident-lifecycle";

export type ManagerResidentDocumentRow = {
  id: string;
  name: string;
  date?: string;
  generated?: boolean;
  href?: string;
};

/** The document kinds, as the record's own section header tabs (captain, 2026-10-05 round 2). */
export const MANAGER_RESIDENT_DOC_TABS = [
  { id: "application", label: "Application" },
  { id: "lease", label: "Lease" },
  { id: "payments", label: "Payments" },
  { id: "inspections", label: "Inspections" },
  { id: "other", label: "Other" },
] as const;

export type ManagerResidentDocTabId = (typeof MANAGER_RESIDENT_DOC_TABS)[number]["id"];

/** How many files each kind holds — the caller draws the tabs, so it needs the counts. */
export function managerResidentDocCounts(
  sections: Partial<Record<ManagerResidentDocTabId, ManagerResidentDocumentRow[]>>,
): Record<ManagerResidentDocTabId, number> {
  const counts = {} as Record<ManagerResidentDocTabId, number>;
  for (const t of MANAGER_RESIDENT_DOC_TABS) counts[t.id] = sections[t.id]?.length ?? 0;
  return counts;
}

/**
 * The files of one resident. The kind tabs are NOT drawn here: they are the blue underline tabs
 * of the record's one section header card, so this panel is handed the open kind.
 */
export function ManagerResidentDocumentsPanel({
  sections,
  tab,
}: {
  sections: Partial<Record<ManagerResidentDocTabId, ManagerResidentDocumentRow[]>>;
  tab: ManagerResidentDocTabId;
}) {
  const rows = sections[tab] ?? [];

  const emptyLine =
    tab === "application"
      ? "No application documents yet."
      : tab === "lease"
        ? "No lease documents yet."
        : tab === "payments"
          ? "No payment documents yet."
          : tab === "inspections"
            ? "No inspection documents yet."
            : "No files yet.";

  return (
    <div className="rs40 flex min-h-0 flex-1 flex-col gap-2" data-attr="resident-documents-panel">
      <PortalRecordListSurface isEmpty={rows.length === 0} className="mt-0 plp-rows">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">{emptyLine}</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-3 border-t border-border/70 px-4 py-3 first:border-t-0"
            >
              <FileText className="size-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                {row.href ? (
                  <a href={row.href} className="truncate text-sm font-semibold text-foreground hover:underline">
                    {row.name}
                  </a>
                ) : (
                  <p className="truncate text-sm font-semibold text-foreground">{row.name}</p>
                )}
                {row.date ? (
                  <p className="text-xs text-muted tabular-nums">{formatResidentShortDate(row.date) || row.date}</p>
                ) : null}
              </div>
              <PortalIconAction
                icon={MoreHorizontal}
                label="File actions"
                data-attr={`resident-document-menu-${row.id}`}
                onClick={() => {
                  if (row.href) window.open(row.href, "_blank", "noopener");
                }}
              />
            </div>
          ))
        )}
      </PortalRecordListSurface>
    </div>
  );
}
