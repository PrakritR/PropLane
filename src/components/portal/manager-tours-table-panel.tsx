"use client";

/**
 * Tours as a resident-grouped table, matching the Payments list.
 *
 * The week grid answers "what does Wednesday look like"; this answers "who has a tour booked, and
 * when" — the question a manager opens the tab for. It reuses the Payments cluster shell and the
 * shared resident-identity rule so the same person heads the same-shaped group on both tabs.
 *
 * A row expands in place rather than routing to a detail page. That is the documented portal
 * pattern for "click for more" (see docs/portal-ui-system.md), and it keeps the whole list on
 * screen while a manager reads one tour.
 */
import { useMemo, useState } from "react";
import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  clusterManagerTourRows,
  pendingTourCount,
  type ManagerTourRow,
} from "@/lib/manager-tour-rows";
import { scheduledSendBadgeLabel, summariseScheduledSends } from "@/lib/scheduled-send-summary";
import { cn } from "@/lib/utils";

/** Reminder sends queued for a tour, keyed by tour row id. */
export type TourScheduledSends = Record<string, { sendAt: string; status?: string | null }[]>;

function tourTimeLabel(row: ManagerTourRow): string {
  const start = formatPacificDateTime(row.startIso);
  if (!row.endIso) return start;
  const end = new Date(row.endIso);
  if (Number.isNaN(end.getTime())) return start;
  // Same-day end times only need the clock, not the date again.
  const endLabel = end.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${start} – ${endLabel}`;
}

export function ManagerToursTablePanel({
  rows,
  scheduledSends = {},
  emptyMessage = "No tours booked yet. Tours a prospect schedules from a listing appear here.",
}: {
  rows: ManagerTourRow[];
  scheduledSends?: TourScheduledSends;
  emptyMessage?: string;
}) {
  const clusters = useMemo(() => clusterManagerTourRows(rows), [rows]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (clusters.length === 0) {
    return (
      <p className="px-1 py-8 text-center text-sm text-muted" data-attr="tours-table-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-attr="tours-resident-groups">
      {clusters.map((cluster) => {
        const pending = pendingTourCount(cluster.rows);
        const queued = scheduledSendBadgeLabel(
          summariseScheduledSends(cluster.rows.flatMap((row) => scheduledSends[row.id] ?? [])),
        );
        return (
          <ApplicationHouseholdCluster
            key={cluster.key}
            header={
              <>
                <span className="truncate text-xs font-semibold text-foreground">
                  {cluster.residentLabel}
                </span>
                {cluster.residentEmail &&
                cluster.residentEmail.toLowerCase() !== cluster.residentLabel.trim().toLowerCase() ? (
                  <span className="truncate text-xs text-muted">{cluster.residentEmail}</span>
                ) : null}
                {cluster.propertyLabel ? (
                  <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
                ) : null}
                <Badge tone="info">
                  {cluster.rows.length === 1 ? "1 tour" : `${cluster.rows.length} tours`}
                </Badge>
                {/* Pending means the guest is still waiting on a reply — the actionable state. */}
                {pending > 0 ? (
                  <Badge tone="pending">
                    <span data-attr="tours-cluster-pending">{pending} awaiting reply</span>
                  </Badge>
                ) : null}
                {queued ? (
                  <Badge tone="pending">
                    <span data-attr="tours-cluster-scheduled">{queued}</span>
                  </Badge>
                ) : null}
              </>
            }
          >
            {cluster.rows.map((row) => {
              const open = expandedId === row.id;
              return (
                <div key={row.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? null : row.id)}
                    aria-expanded={open}
                    data-attr="tours-table-row"
                    className={cn(
                      "flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-3 text-left",
                      "hover:bg-accent/20",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {tourTimeLabel(row)}
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted">
                      {[row.propertyLabel, row.roomLabel].filter(Boolean).join(" · ") || "—"}
                    </span>
                    <Badge tone={row.confirmed ? "confirmed" : "pending"}>
                      {row.statusLabel || (row.confirmed ? "Confirmed" : "Requested")}
                    </Badge>
                  </button>
                  {open ? (
                    <dl
                      className="grid gap-x-6 gap-y-2 border-t border-border/50 bg-card/40 px-3 py-3 text-sm sm:grid-cols-2"
                      data-attr="tours-table-row-detail"
                    >
                      <div>
                        <dt className="text-xs font-medium text-muted">When</dt>
                        <dd className="text-foreground">{tourTimeLabel(row)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted">Property</dt>
                        <dd className="text-foreground">{row.propertyLabel || "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted">Room</dt>
                        <dd className="text-foreground">{row.roomLabel || "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted">Status</dt>
                        <dd className="text-foreground">
                          {row.statusLabel || (row.confirmed ? "Confirmed" : "Requested")}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted">Email</dt>
                        <dd className="truncate text-foreground">{row.residentEmail || "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted">Phone</dt>
                        <dd className="text-foreground">{row.residentPhone || "—"}</dd>
                      </div>
                      {row.notes ? (
                        <div className="sm:col-span-2">
                          <dt className="text-xs font-medium text-muted">Notes</dt>
                          <dd className="whitespace-pre-wrap leading-relaxed text-foreground/90">
                            {row.notes}
                          </dd>
                        </div>
                      ) : null}
                      {(scheduledSends[row.id]?.length ?? 0) > 0 ? (
                        <div className="sm:col-span-2">
                          <dt className="text-xs font-medium text-muted">Scheduled reminders</dt>
                          <dd className="text-foreground">
                            {scheduledSends[row.id]!
                              .filter((send) => (send.status ?? "scheduled") === "scheduled")
                              .map((send) => formatPacificDateTime(send.sendAt))
                              .join(" · ") || "—"}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                </div>
              );
            })}
          </ApplicationHouseholdCluster>
        );
      })}
    </div>
  );
}
