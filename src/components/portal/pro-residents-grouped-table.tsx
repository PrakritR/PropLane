"use client";

/**
 * The manager's Residents list: one white card per resident, the shape every
 * other portal list has (AGENTS.md → Portal UI system: "Every list tab copies
 * Properties"). An initials tile, the resident's NAME as the title,
 * "Room 4 · 5259 Brooklyn Ave" as the address line, glyph facts (email, lease
 * start) and the ⋯ the list surface draws on a selectable row — carrying that
 * row's actions.
 *
 * No grouping box, no nested table, no pill: the Potential / Current / Past tab
 * already says the stage, and "Incomplete application" — the one thing a row
 * still has to say — is plain fact text (`tests/unit/portal-list-rows-no-pills.test.ts`).
 * The clusters arrive grouped (by house or by resident) and are flattened in
 * that order, so a house's residents still sit together.
 */

import { BellRing, CalendarDays, Mail, Users } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import {
  residentHousingMeta,
  type ManagerResidentListRow,
} from "@/lib/manager-resident-list";
import type {
  ManagerResidentHouseCluster,
  ManagerResidentListCluster,
} from "@/lib/manager-resident-list-grouping";
import type { PortalListGroupMode } from "@/lib/portal-list-grouping";

function shortDateLabel(iso: string): string {
  const parts = iso.trim().split("-").map(Number);
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return iso;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

/** The clusters in display order, flattened to the rows the cards draw. */
function flattenResidentClusters(
  clusters: ManagerResidentListCluster[] | ManagerResidentHouseCluster[],
  groupMode: PortalListGroupMode,
): ManagerResidentListRow[] {
  if (groupMode === "house") {
    return (clusters as ManagerResidentHouseCluster[]).flatMap((cluster) => cluster.rows);
  }
  return (clusters as ManagerResidentListCluster[]).flatMap((cluster) =>
    cluster.kind === "resident" ? cluster.cluster.rows : cluster.rows,
  );
}

export function ManagerResidentsGroupedTable({
  clusters,
  groupMode,
  onOpenResident,
  selectedIds,
  onToggleSelected,
  selectable = false,
  nudgeEligibleIds,
  onNudge,
}: {
  clusters: ManagerResidentListCluster[] | ManagerResidentHouseCluster[];
  groupMode: PortalListGroupMode;
  /** Kept for callers; the card always names the property now that there is no house header above it. */
  showPropertyInRows?: boolean;
  onOpenResident: (row: ManagerResidentListRow) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  /** Kept for callers; there is no cluster header to select from any more. */
  onToggleCluster?: (ids: readonly string[]) => void;
  selectable?: boolean;
  /**
   * C252 (U035): Potential rows this manager can chase to finish their
   * application (`shouldOfferApplicationCompletionReminder`). Everything
   * else — Current, Past, an already-submitted Potential row — gets no
   * button at all, not a disabled one.
   */
  nudgeEligibleIds?: ReadonlySet<string>;
  onNudge?: (row: ManagerResidentListRow) => void;
}) {
  const select = (id: string) => (selectable && onToggleSelected ? () => onToggleSelected(id) : undefined);
  const dataAttr = groupMode === "house" ? "residents-house-groups" : "residents-resident-groups";
  const rows = flattenResidentClusters(clusters, groupMode);

  return (
    <div data-attr={dataAttr}>
      {rows.map((row) => {
        const name = row.name.trim();
        // A nameless in-progress application falls back to its email for the
        // title, so repeating it as a fact would print the same string twice.
        const email = row.email.trim().toLowerCase() === name.toLowerCase() ? "" : row.email.trim();
        const status = row.statusLabel?.trim() ?? "";
        const canNudge = Boolean(onNudge && nudgeEligibleIds?.has(row.id));
        return (
          // Wraps the row (rather than a `trailing`/`amount` prop) so the
          // button never lands INSIDE the row's own clickable `<button>` —
          // that prop duplicates its content there on phone, which nested a
          // `<button>` inside a `<button>` and broke the tap on small screens.
          <div key={row.id} className={canNudge ? "relative" : undefined}>
            <PortalApplicantRecordRow
              name={row.name}
              address={residentHousingMeta(row, true)}
              facts={
                <>
                  {email ? (
                    <PortalRowFact icon={Mail} srLabel="Email">
                      {email}
                    </PortalRowFact>
                  ) : null}
                  {row.residentSlotFact ? (
                    <PortalRowFact icon={Users} srLabel="Resident">
                      {row.residentSlotFact}
                    </PortalRowFact>
                  ) : null}
                  {row.leaseStart ? (
                    <PortalRowFact icon={CalendarDays} srLabel="Lease start">
                      {shortDateLabel(row.leaseStart)}
                    </PortalRowFact>
                  ) : null}
                  {status ? <span data-attr="resident-row-status">{status}</span> : null}
                </>
              }
              checked={selectable && selectedIds?.has(row.id)}
              onSelectedChange={select(row.id)}
              onOpen={() => onOpenResident(row)}
              dataAttr="resident-list-row"
            />
            {canNudge ? (
              <button
                type="button"
                data-attr="resident-row-nudge"
                aria-label={`Remind ${row.name.trim() || "this applicant"} to finish their application`}
                title="Remind to finish"
                className="absolute right-3 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted transition-colors hover:bg-accent/60 hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onNudge?.(row);
                }}
              >
                <BellRing className="size-4" strokeWidth={1.75} aria-hidden />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
