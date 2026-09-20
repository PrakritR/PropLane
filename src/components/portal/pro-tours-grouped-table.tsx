"use client";

/**
 * The manager's Tours list: one white card per tour, the shape every other
 * portal list has (AGENTS.md → Portal UI system: "Every list tab copies
 * Properties"). An initials tile, the GUEST as the title, "5259 Brooklyn Ave ·
 * Room 3" as the address line, glyph facts (when, email, phone, a scheduled
 * reminder) and the ⋯ the list surface draws on a selectable row.
 *
 * No grouping box and no pill: the Pending / Upcoming / Past tab says the
 * bucket, and what a row still has to say — "Virtual", "Next reminder Sep 30,
 * 5:00 PM", "Canceled" — is plain fact text with a glyph
 * (`tests/unit/portal-list-rows-no-pills.test.ts`). The clusters arrive grouped
 * (by house or by guest) and are flattened in that order.
 */

import { Bell, CalendarDays, Mail, Phone, Video } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import {
  type ManagerTourListCluster,
  type ManagerTourPropertyCluster,
  type ManagerTourRow,
  tourReminderMetaHint,
  tourReminderSummaryForRow,
} from "@/lib/manager-tour-list";
import { isPropertyClusterList, type PortalListGroupMode } from "@/lib/portal-list-grouping";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { scheduledSendBadgeLabel } from "@/lib/scheduled-send-summary";
import { tourFormatLabel } from "@/lib/tour-format";

/** "5259 Brooklyn Ave · Room 3" — or just the room when the list is scoped to one listing. */
function tourPlaceLine(row: ManagerTourRow, showPropertyColumn: boolean): string {
  const parts = showPropertyColumn ? [row.propertyTitle, row.roomLabel] : [row.roomLabel || row.propertyTitle];
  return parts.map((part) => part?.trim()).filter(Boolean).join(" · ") || "—";
}

/** The status only when it adds to the tab — Confirmed and Pending are the bucket. */
function tourStatusFact(row: ManagerTourRow): string {
  const status = row.statusLabel.trim();
  return status && status !== "Confirmed" && status !== "Pending" ? status : "";
}

/** "Next reminder Sep 30, 5:00 PM (+1 more)", else the bare count, else nothing. */
function tourReminderFact(row: ManagerTourRow, reminders: readonly ScheduledInboxMessageRecord[]): string | null {
  return tourReminderMetaHint(row, reminders) ?? scheduledSendBadgeLabel(tourReminderSummaryForRow(row, reminders));
}

/** The clusters in display order, flattened to the rows the cards draw. */
function flattenTourClusters(
  clusters: ManagerTourListCluster[] | ManagerTourPropertyCluster[],
  groupMode: PortalListGroupMode,
): ManagerTourRow[] {
  if (isPropertyClusterList(groupMode, clusters)) return clusters.flatMap((cluster) => cluster.rows);
  return (clusters as ManagerTourListCluster[]).flatMap((cluster) => cluster.rows);
}

export function ManagerToursGroupedTable({
  clusters,
  groupMode,
  selectedIds,
  onToggleSelected,
  onRowClick,
  showPropertyColumn = true,
  selectable = false,
  tourReminders = [],
}: {
  clusters: ManagerTourListCluster[] | ManagerTourPropertyCluster[];
  groupMode: PortalListGroupMode;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  /** Kept for callers; there is no cluster header to select from any more. */
  onToggleCluster?: (ids: readonly string[]) => void;
  onRowClick: (row: ManagerTourRow) => void;
  /** Drop the property from the place line when the list is scoped to one listing. */
  showPropertyColumn?: boolean;
  selectable?: boolean;
  tourReminders?: readonly ScheduledInboxMessageRecord[];
}) {
  const select = (id: string) => (selectable && onToggleSelected ? () => onToggleSelected(id) : undefined);
  const dataAttr = groupMode === "house" ? "tours-house-groups" : "tours-resident-groups";
  const rows = flattenTourClusters(clusters, groupMode);

  return (
    <div data-attr={dataAttr}>
      {rows.map((row) => {
        const name = row.guestName.trim() || "Guest";
        const email = row.guestEmail.trim().toLowerCase() === name.toLowerCase() ? "" : row.guestEmail.trim();
        const phone = row.guestPhone.trim();
        const reminder = tourReminderFact(row, tourReminders);
        const status = tourStatusFact(row);
        return (
          <PortalApplicantRecordRow
            key={row.id}
            name={name}
            address={tourPlaceLine(row, showPropertyColumn)}
            facts={
              <>
                <PortalRowFact icon={CalendarDays} srLabel="When">
                  {row.whenLabel}
                </PortalRowFact>
                {/* Only the non-default format is called out, so "Virtual" reads as the exception it is. */}
                {row.tourFormat === "virtual" ? (
                  <PortalRowFact icon={Video} srLabel="Format">
                    {tourFormatLabel(row.tourFormat)}
                  </PortalRowFact>
                ) : null}
                {email ? (
                  <PortalRowFact icon={Mail} srLabel="Email">
                    {email}
                  </PortalRowFact>
                ) : null}
                {phone ? (
                  <PortalRowFact icon={Phone} srLabel="Phone">
                    {phone}
                  </PortalRowFact>
                ) : null}
                {reminder ? (
                  <PortalRowFact icon={Bell} srLabel="Reminders">
                    <span data-attr="tours-row-scheduled">{reminder}</span>
                  </PortalRowFact>
                ) : null}
                {status ? <span data-attr="tour-row-status">{status}</span> : null}
              </>
            }
            checked={selectable && selectedIds?.has(row.id)}
            selectLabel={`${row.guestName} · ${row.whenLabel}`}
            onSelectedChange={select(row.id)}
            onOpen={() => onRowClick(row)}
            dataAttr="tour-list-row"
          />
        );
      })}
    </div>
  );
}
