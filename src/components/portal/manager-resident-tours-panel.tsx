"use client";

import { useMemo, useState } from "react";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Button } from "@/components/ui/button";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import {
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { buildManagerTourRows, type ManagerTourRow } from "@/lib/manager-tour-list";

function tourSubtitle(row: ManagerTourRow): string {
  return [row.propertyTitle, row.roomLabel, row.statusLabel].filter(Boolean).join(" · ");
}

function tourDetailLines(row: ManagerTourRow): string[] {
  const lines = [tourSubtitle(row)];
  if (row.notes?.trim()) lines.push(row.notes.trim());
  return lines;
}

export function ManagerResidentToursPanel({
  managerUserId,
  residentEmail,
  residentName,
}: {
  managerUserId: string | null;
  residentEmail: string;
  residentName: string;
}) {
  const normalizedEmail = residentEmail.trim().toLowerCase();
  const [expandedTourId, setExpandedTourId] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!managerUserId || !normalizedEmail.includes("@")) return [];
    return buildManagerTourRows({ viewerUserId: managerUserId, propertyIds: [] })
      .filter((row) => row.guestEmail?.trim().toLowerCase() === normalizedEmail)
      .sort((a, b) => a.startMs - b.startMs);
  }, [managerUserId, normalizedEmail]);

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(rows.length);

  if (!managerUserId) {
    return <p className="text-sm text-muted">Sign in to view tours.</p>;
  }

  if (rows.length === 0) {
    return (
      <PortalPropertyDetailSection>
        <PortalDataTableEmpty
          message={`No tours on file for ${residentName.trim() || "this resident"} yet.`}
        />
      </PortalPropertyDetailSection>
    );
  }

  return (
    <>
      <PortalPropertyDetailSection contentClassName="space-y-0">
        {rows.map((row) => {
          const expanded = expandedTourId === row.id;
          return (
            <div key={row.id} className="border-b border-border last:border-b-0">
              <div className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    checked={selectedIds.has(row.id)}
                    data-attr={`resident-tour-select-${row.id}`}
                    onChange={() => toggleSelected(row.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    data-attr={`resident-tour-open-${row.id}`}
                    onClick={() => setExpandedTourId((current) => (current === row.id ? null : row.id))}
                  >
                    <p className="text-sm font-semibold text-foreground">{row.whenLabel}</p>
                    <p className="mt-0.5 text-xs text-muted">{tourSubtitle(row)}</p>
                  </button>
                </label>
              </div>
              {expanded ? (
                <div className="border-t border-border bg-accent/15 px-4 py-3 text-sm text-muted">
                  {tourDetailLines(row).map((line) => (
                    <p key={line} className="leading-relaxed">
                      {line}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </PortalPropertyDetailSection>

      {selectedIds.size > 0 ? (
        <BulkActionBar count={selectedIds.size} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            <Button
              type="button"
              variant="outline"
              className={PORTAL_BULK_BAR_BTN}
              data-attr="resident-tour-bulk-clear"
              onClick={clearSelection}
            >
              Clear selection
            </Button>
          </div>
        </BulkActionBar>
      ) : null}
    </>
  );
}
