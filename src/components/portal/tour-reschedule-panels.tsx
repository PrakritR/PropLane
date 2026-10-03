"use client";

/**
 * The two side panes of "Pick a new tour time" (C2-POP4, C2-TR1): who the
 * tour is about on the left, and on the right the updated tour card plus the
 * exact message the guest receives. Both follow each Day / Time pick.
 */
import { PopupMessagePreview } from "@/components/portal/popup-live-preview";
import type { ManagerTourRow } from "@/lib/manager-tour-list";
import { formatRescheduleWhenLabel } from "@/lib/tour-reschedule-slot-picker";

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "G"
  );
}

function tourDurationMinutes(row: ManagerTourRow): number {
  const ms = Date.parse(row.endIso) - Date.parse(row.startIso);
  return Number.isFinite(ms) && ms > 0 ? Math.max(30, Math.round(ms / 60000)) : 30;
}

export function placeLine(row: Pick<ManagerTourRow, "propertyTitle" | "roomLabel">): string {
  return [row.propertyTitle, row.roomLabel].filter(Boolean).join(" · ");
}

export function TourRescheduleContextCard({ row }: { row: ManagerTourRow }) {
  return (
    <div className="flex flex-col gap-3" data-attr="tour-reschedule-context">
      <span
        className="flex size-11 items-center justify-center rounded-full bg-accent text-sm font-bold text-primary"
        aria-hidden
      >
        {initialsOf(row.guestName)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-[15px] font-semibold text-foreground">{row.guestName || "Guest"}</p>
        <p className="truncate text-[13px] text-muted">{placeLine(row)}</p>
        <p className="mt-1 text-[13px] text-muted">
          Current: {formatRescheduleWhenLabel(row.startIso, tourDurationMinutes(row))}
        </p>
      </div>
    </div>
  );
}

export function TourReschedulePreviewCard({
  row,
  newStartIso,
  subject,
  body,
}: {
  row: ManagerTourRow;
  /** The picked new start, or null while the chosen day has no open time. */
  newStartIso: string | null;
  subject: string;
  body: string;
}) {
  const duration = tourDurationMinutes(row);
  const changed = Boolean(newStartIso) && newStartIso !== row.startIso;
  return (
    <div className="space-y-4" data-attr="tour-reschedule-preview">
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[15px] font-semibold text-foreground">{row.guestName || "Guest"}</p>
        <p className="text-[13px] text-muted">{placeLine(row)}</p>
        <dl className="mt-3 space-y-2 text-[13px]">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">New time</dt>
            <dd className="text-right font-semibold text-foreground" data-attr="tour-reschedule-preview-new">
              {newStartIso ? formatRescheduleWhenLabel(newStartIso, duration) : "No open times that day"}
            </dd>
          </div>
          {changed ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Was</dt>
              <dd className="text-right font-semibold text-foreground line-through decoration-muted/80">
                {formatRescheduleWhenLabel(row.startIso, duration)}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Guest receives</p>
        <PopupMessagePreview subject={subject} recipient={row.guestEmail || undefined} body={body} />
      </div>
    </div>
  );
}
