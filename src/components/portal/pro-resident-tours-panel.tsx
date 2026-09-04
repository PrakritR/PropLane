"use client";

import { useMemo } from "react";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Button } from "@/components/ui/button";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import {
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { buildManagerTourRows, type ManagerTourRow } from "@/lib/manager-tour-list";

function tourSubtitle(row: ManagerTourRow): string {
  return [row.propertyTitle, row.roomLabel, row.statusLabel].filter(Boolean).join(" · ");
}

function ResidentTourDetailPanel({ row }: { row: ManagerTourRow }) {
  return (
    <div className="space-y-4 px-3 py-2 text-sm sm:px-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-muted">When</p>
          <p className="text-foreground">{row.whenLabel}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Status</p>
          <p className="font-medium text-foreground">{row.statusLabel}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Property</p>
          <p className="text-foreground">{row.propertyTitle || "—"}</p>
        </div>
        {row.roomLabel ? (
          <div>
            <p className="text-xs font-medium text-muted">Room</p>
            <p className="text-foreground">{row.roomLabel}</p>
          </div>
        ) : null}
        {row.guestPhone?.trim() ? (
          <div>
            <p className="text-xs font-medium text-muted">Phone</p>
            <p className="text-foreground">{row.guestPhone.trim()}</p>
          </div>
        ) : null}
      </div>
      {row.notes?.trim() ? (
        <div>
          <p className="text-xs font-medium text-muted">Notes</p>
          <p className="whitespace-pre-wrap text-foreground">{row.notes.trim()}</p>
        </div>
      ) : null}
    </div>
  );
}

export function ManagerResidentToursPanel({
  managerUserId,
  residentEmail,
  residentName,
  tourId,
  buildTourDetailHref,
}: {
  managerUserId: string | null;
  residentEmail: string;
  residentName: string;
  tourId?: string;
  buildTourDetailHref?: (row: ManagerTourRow) => string;
}) {
  const navigate = usePortalNavigate();
  const normalizedEmail = residentEmail.trim().toLowerCase();

  const rows = useMemo(() => {
    if (!managerUserId || !normalizedEmail.includes("@")) return [];
    return buildManagerTourRows({ viewerUserId: managerUserId, propertyIds: [] })
      .filter((row) => row.guestEmail?.trim().toLowerCase() === normalizedEmail)
      .sort((a, b) => a.startMs - b.startMs);
  }, [managerUserId, normalizedEmail]);

  const detailRow = useMemo(() => {
    if (!tourId) return null;
    const decoded = decodeURIComponent(tourId);
    return rows.find((row) => row.id === decoded) ?? null;
  }, [rows, tourId]);

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(rows.length);

  if (!managerUserId) {
    return <p className="text-sm text-muted">Sign in to view tours.</p>;
  }

  if (tourId && detailRow) {
    return <ResidentTourDetailPanel row={detailRow} />;
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
        {rows.map((row) => (
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
                  onClick={() => {
                    if (buildTourDetailHref) {
                      navigate(buildTourDetailHref(row));
                      return;
                    }
                  }}
                >
                  <p className="text-sm font-semibold text-foreground">{row.whenLabel}</p>
                  <p className="mt-0.5 text-xs text-muted">{tourSubtitle(row)}</p>
                </button>
              </label>
            </div>
          </div>
        ))}
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
