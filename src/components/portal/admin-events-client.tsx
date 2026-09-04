"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import {
  ManagerPortalFilterRow,
  ManagerPortalPageShell,
  ManagerPortalStatusPills,
  PORTAL_HEADER_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import {
  ADMIN_AVAILABILITY_STORAGE_KEY,
  acceptPartnerInquiryFromServer,
  adminAvailabilityStorageKey,
  declinePartnerInquiry,
  readPartnerInquiries,
  readPlannedEvents,
  syncScheduleRecordsFromServer,
  type PartnerInquiry,
  type PlannedEvent,
} from "@/lib/demo-admin-scheduling";
import { useManagerUserId } from "@/hooks/use-manager-user-id";

type MeetingsTab = "pending" | "upcoming" | "past";

function formatWindow(startIso: string, endIso: string): string {
  try {
    const start = new Date(startIso);
    const end = new Date(endIso);
    const day = start.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const from = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const to = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${day}, ${from}–${to}`;
  } catch {
    return "—";
  }
}

/**
 * Admin Meetings.
 *
 * This page used to open straight onto the availability week grid — an editor
 * where the list of people waiting on an answer belongs. Requests are the
 * landing view now; availability is still one click away, because publishing
 * hours is a periodic chore and answering a request is the daily one.
 */
export function AdminEventsClient() {
  const { userId, email } = useManagerUserId();
  const { showToast } = useAppUi();
  const [tab, setTab] = useState<MeetingsTab>("pending");
  const [showAvailability, setShowAvailability] = useState(false);
  const [tick, setTick] = useState(0);
  // Read once per refresh rather than during render: "is this in the past" must
  // be a stable answer for the whole render pass, not a clock read per row.
  const [now, setNow] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const bump = () => {
      setNow(Date.now());
      setTick((t) => t + 1);
    };
    bump();
    void syncScheduleRecordsFromServer().then(bump);
    const on = bump;
    window.addEventListener(ADMIN_UI_EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(ADMIN_UI_EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const pending = useMemo<PartnerInquiry[]>(() => {
    void tick;
    return readPartnerInquiries()
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.proposedStart.localeCompare(b.proposedStart));
  }, [tick]);

  const { upcoming, past } = useMemo(() => {
    void tick;
    const events = readPlannedEvents();
    const isPast = (e: PlannedEvent) => {
      const end = Date.parse(e.end || e.start);
      return Number.isFinite(end) ? end < now : false;
    };
    return {
      upcoming: events.filter((e) => !isPast(e)).sort((a, b) => a.start.localeCompare(b.start)),
      // Most recent first: the meeting that just happened is the one being
      // looked up, not the oldest one on record.
      past: events.filter(isPast).sort((a, b) => b.start.localeCompare(a.start)),
    };
  }, [tick, now]);

  const tabs = useMemo(
    () => [
      { id: "pending", label: "Pending", count: pending.length, dataAttr: "admin-meetings-tab-pending" },
      { id: "upcoming", label: "Upcoming", count: upcoming.length, dataAttr: "admin-meetings-tab-upcoming" },
      { id: "past", label: "Past", count: past.length, dataAttr: "admin-meetings-tab-past" },
    ],
    [pending.length, upcoming.length, past.length],
  );

  const respond = async (accept: boolean) => {
    const targets = pending.filter((r) => selectedIds.has(r.id));
    if (targets.length === 0) return;
    setBusy(true);
    try {
      let failed = 0;
      for (const row of targets) {
        if (accept) {
          const res = await acceptPartnerInquiryFromServer(row.id);
          if (!res.ok) failed += 1;
        } else if (!declinePartnerInquiry(row.id)) {
          failed += 1;
        }
      }
      await syncScheduleRecordsFromServer({ force: true });
      setNow(Date.now());
      setTick((t) => t + 1);
      setSelectedIds(new Set());
      if (failed > 0) {
        showToast(
          failed === targets.length
            ? "Could not update these requests."
            : `${failed} of ${targets.length} could not be updated.`,
        );
      } else {
        showToast(accept ? "Meeting confirmed." : "Request declined.");
      }
    } finally {
      setBusy(false);
    }
  };

  // Only a pending request can be answered. Confirmed and past meetings are a
  // record, so the dock stays out of the way on those tabs rather than showing
  // buttons that would do nothing.
  const bulkActions =
    tab === "pending" ? (
      <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          disabled={busy}
          data-attr="admin-meeting-confirm"
          onClick={() => respond(true)}
        >
          Confirm
        </Button>
        <Button
          type="button"
          variant="outline"
          className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
          disabled={busy}
          data-attr="admin-meeting-decline"
          onClick={() => respond(false)}
        >
          Decline
        </Button>
      </div>
    ) : null;

  const emptyCopy =
    tab === "pending"
      ? "No requests waiting on you."
      : tab === "upcoming"
        ? "No meetings scheduled."
        : "No past meetings.";

  /**
   * A row opens onto what the person wrote. That note is the thing staff read
   * before confirming, and it was previously nowhere on this page at all.
   */
  const detailBlock = (text: string | undefined, phone?: string) =>
    text?.trim() || phone ? (
      <div className="border-b border-border/50 bg-accent/10 px-4 py-3 text-sm">
        {text?.trim() ? (
          <p className="whitespace-pre-wrap leading-relaxed text-foreground">{text.trim()}</p>
        ) : (
          <p className="text-muted">No note left with this request.</p>
        )}
        {phone ? <p className="mt-2 text-xs text-muted">{phone}</p> : null}
      </div>
    ) : (
      <div className="border-b border-border/50 bg-accent/10 px-4 py-3 text-sm text-muted">
        No note left with this request.
      </div>
    );

  const rows =
    tab === "pending"
      ? pending.map((row) => (
          <div key={row.id}>
            <PortalPersonRecordRow
              name={`${row.name} · ${formatWindow(row.proposedStart, row.proposedEnd)}`}
              subtitle={[row.email, row.propertyTitle].filter(Boolean).join(" · ")}
              selected={expandedId === row.id}
              checked={selectedIds.has(row.id)}
              onSelectedChange={() => toggleSelected(row.id)}
              onOpen={() => setExpandedId((cur) => (cur === row.id ? null : row.id))}
              dataAttr="admin-meeting-row"
            />
            {expandedId === row.id ? detailBlock(row.notes, row.phone) : null}
          </div>
        ))
      : (tab === "upcoming" ? upcoming : past).map((event) => (
          <div key={event.id}>
            <PortalPersonRecordRow
              name={`${event.attendeeName || event.title} · ${formatWindow(event.start, event.end)}`}
              subtitle={[event.attendeeEmail, event.propertyTitle].filter(Boolean).join(" · ")}
              selected={expandedId === event.id}
              onOpen={() => setExpandedId((cur) => (cur === event.id ? null : event.id))}
              dataAttr="admin-meeting-row"
            />
            {expandedId === event.id
              ? detailBlock(event.notes || event.instructions, event.attendeePhone)
              : null}
          </div>
        ));

  return (
    <ManagerPortalPageShell
      title="Meetings"
      titleAside={
        <Button
          type="button"
          variant="outline"
          className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
          aria-pressed={showAvailability}
          data-attr="admin-meetings-availability-toggle"
          onClick={() => setShowAvailability((v) => !v)}
        >
          {showAvailability ? "← Requests" : "Availability"}
        </Button>
      }
      filterRow={
        showAvailability ? undefined : (
          <ManagerPortalFilterRow>
            <ManagerPortalStatusPills
              tabs={tabs}
              activeId={tab}
              onChange={(id) => {
                setTab(id as MeetingsTab);
                setSelectedIds(new Set());
                setExpandedId(null);
              }}
            />
          </ManagerPortalFilterRow>
        )
      }
    >
      {showAvailability ? (
        <PortalCalendarPanels
          storageKey={userId ? adminAvailabilityStorageKey(userId) : ADMIN_AVAILABILITY_STORAGE_KEY}
          defaultViewMode="month"
          pinMonthSchedule
          compactAvailability
          scheduleOwnerLabel={email}
          availabilityHeading="Availability"
        />
      ) : (
        <PortalRecordListSurface
          isEmpty={rows.length === 0}
          empty={<PortalDataTableEmpty icon="default" message={emptyCopy} />}
          bulkCount={tab === "pending" ? pending.filter((r) => selectedIds.has(r.id)).length : 0}
          bulkActions={bulkActions}
          dataAttr="admin-meetings-list"
        >
          {rows}
        </PortalRecordListSurface>
      )}
    </ManagerPortalPageShell>
  );
}
