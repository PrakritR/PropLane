"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalCalendarPanels, MEETING_CONFIRMED_COLOR, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import {
  VENDOR_AVAILABILITY_CHANGED_EVENT,
  VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT,
  VendorAvailabilityEditor,
} from "@/components/portal/vendor-settings-panel";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { CalendarClock } from "lucide-react";
import { readVendorWorkOrderRows, syncManagerWorkOrdersFromServer, MANAGER_WORK_ORDERS_EVENT } from "@/lib/manager-work-orders-storage";
import {
  SLOT_DURATION_MINUTES,
  startOfWeekMonday,
  toLocalDateStr,
  vendorAvailabilityStorageKey,
  installAvailabilityDateSetForStorageKey,
} from "@/lib/demo-admin-scheduling";
import { fetchVendorAvailability, isFlexibleWeeklyRule, slotKeysFromWeeklyRules, type VendorAvailabilityRule } from "@/lib/vendor-availability";
import { calendarMeetingMatchesQuery } from "@/lib/manager-calendar-tour-meetings";
import {
  vendorCalendarViewHref,
  type VendorCalendarViewTabId,
} from "@/lib/portal-detail-routes";
import { portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

const VENDOR_VISIT_DEFAULT_DURATION_MINUTES = 60;
const VENDOR_CALENDAR_BASE = "/vendor";

function vendorMeetingFromRow(row: DemoManagerWorkOrderRow): DemoMeeting | null {
  if (!row.scheduledAtIso) return null;
  const start = new Date(row.scheduledAtIso);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + VENDOR_VISIT_DEFAULT_DURATION_MINUTES * 60_000);
  return {
    id: `vendor-visit-${row.id}`,
    source: "external",
    sourceId: row.id,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateStr: toLocalDateStr(start),
    startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
    span: Math.max(1, Math.ceil(VENDOR_VISIT_DEFAULT_DURATION_MINUTES / SLOT_DURATION_MINUTES)),
    durationMinutes: VENDOR_VISIT_DEFAULT_DURATION_MINUTES,
    title: row.title,
    color: MEETING_CONFIRMED_COLOR,
    statusLabel: "Scheduled",
    propertyTitle: propertyLabel(row),
    propertyId: row.propertyId,
    notes: row.description || undefined,
  };
}

/** A disposable calendar paint cache derived wholly from the canonical availability API. */
export function installVendorAvailabilityPaintCache(
  storageKey: string,
  rules: VendorAvailabilityRule[],
  window: { from: Date; dayCount: number } = { from: new Date(), dayCount: 7 },
) {
  // Flexible is a legacy persisted rule shape. Project it to the historic
  // 8am–6pm window for painting only; reading the calendar must not rewrite it.
  const paintRules = rules.map((rule) =>
    isFlexibleWeeklyRule(rule)
      ? { ...rule, startMinute: 8 * 60, endMinute: 18 * 60, note: undefined }
      : rule,
  );
  const from = new Date(window.from);
  from.setHours(0, 0, 0, 0);
  const dayCount = Math.max(1, window.dayCount);
  const until = new Date(from);
  until.setDate(from.getDate() + dayCount);
  const keys = new Set(
    slotKeysFromWeeklyRules(paintRules, from, Math.ceil(dayCount / 7)).filter((key) => {
      const [date] = key.split(":");
      return Boolean(date && date >= toLocalDateStr(from) && date < toLocalDateStr(until));
    }),
  );
  for (const rule of rules) {
    if (rule.kind !== "open" && rule.kind !== "block") continue;
    if (rule.specificDate < toLocalDateStr(from) || rule.specificDate >= toLocalDateStr(until)) continue;
    const start = Math.floor(rule.startMinute / SLOT_DURATION_MINUTES);
    const end = Math.ceil(rule.endMinute / SLOT_DURATION_MINUTES);
    for (let slot = start; slot < end; slot += 1) {
      const key = `${rule.specificDate}:${slot}`;
      if (rule.kind === "open") keys.add(key);
      else keys.delete(key);
    }
  }
  installAvailabilityDateSetForStorageKey(keys, storageKey);
}

function paintWindowForCalendar(anchorDate: Date, view: VendorCalendarViewTabId): { from: Date; dayCount: number } {
  if (view === "month") {
    const from = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1, 12, 0, 0, 0);
    return { from, dayCount: new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate() };
  }
  if (view === "day") return { from: anchorDate, dayCount: 1 };
  return { from: startOfWeekMonday(anchorDate), dayCount: 7 };
}

/** Week grid that paints availability the same way the manager calendar does. */
export function VendorCalendarPanel({ view = "week" }: { view?: VendorCalendarViewTabId }) {
  const { userId, ready } = usePortalSession();
  const demo = isDemoModeActive();
  const [rows, setRows] = useState<DemoManagerWorkOrderRow[]>(() => readVendorWorkOrderRows());
  const [availabilityRules, setAvailabilityRules] = useState<VendorAvailabilityRule[] | null>(null);
  const [calendarRefreshSignal, setCalendarRefreshSignal] = useState(0);
  const [calendarAnchorDate, setCalendarAnchorDate] = useState(() => new Date());
  const [listSearch, setListSearch] = useState("");
  const [weekActionsHost, setWeekActionsHost] = useState<HTMLElement | null>(null);

  const storageKey = useMemo(() => (userId ? vendorAvailabilityStorageKey(userId) : null), [userId]);

  const applyCanonicalAvailability = useCallback((rules: VendorAvailabilityRule[]) => {
    setAvailabilityRules(rules);
  }, []);

  useEffect(() => {
    if (!storageKey || !availabilityRules) return;
    installVendorAvailabilityPaintCache(storageKey, availabilityRules, paintWindowForCalendar(calendarAnchorDate, view));
    setCalendarRefreshSignal((n) => n + 1);
  }, [availabilityRules, calendarAnchorDate, storageKey, view]);

  const reloadAvailability = useCallback(async () => {
    if (demo) return;
    // Loading is intentionally read-only. A flexible rule is still rendered
    // by the editor, but must never be rewritten just because the calendar
    // opened or its view changed.
    applyCanonicalAvailability(await fetchVendorAvailability());
  }, [applyCanonicalAvailability, demo]);

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
  }, []);

  useEffect(() => {
    void reloadAvailability();
  }, [reloadAvailability]);

  useEffect(() => {
    const onCanonicalAvailabilityChanged = (event: Event) => {
      const rules = (event as CustomEvent<{ rules?: VendorAvailabilityRule[] }>).detail?.rules;
      if (rules) applyCanonicalAvailability(rules);
      else void reloadAvailability();
    };
    window.addEventListener(VENDOR_AVAILABILITY_CHANGED_EVENT, onCanonicalAvailabilityChanged);
    return () => window.removeEventListener(VENDOR_AVAILABILITY_CHANGED_EVENT, onCanonicalAvailabilityChanged);
  }, [applyCanonicalAvailability, reloadAvailability]);

  const visitMeetings = useMemo<DemoMeeting[]>(() => {
    return rows
      .filter((r) => r.scheduledAtIso && r.bucket !== "completed")
      .map(vendorMeetingFromRow)
      .filter((meeting) => meeting !== null);
  }, [rows]);

  const vendorMeetings = useMemo(() => {
    const scoped = visitMeetings;
    const needle = listSearch.trim();
    if (!needle) return scoped;
    return scoped.filter((meeting) => calendarMeetingMatchesQuery(meeting, needle));
  }, [listSearch, visitMeetings]);

  const calendarTabs = useMemo(
    () => [
      {
        id: "list" as const,
        label: "List",
        count: visitMeetings.length,
        href: vendorCalendarViewHref(VENDOR_CALENDAR_BASE, "list"),
        dataAttr: "vendor-calendar-tab-list",
      },
      {
        id: "day" as const,
        label: "Day",
        href: vendorCalendarViewHref(VENDOR_CALENDAR_BASE, "day"),
        dataAttr: "vendor-calendar-tab-day",
      },
      {
        id: "week" as const,
        label: "Week",
        href: vendorCalendarViewHref(VENDOR_CALENDAR_BASE, "week"),
        dataAttr: "vendor-calendar-tab-week",
      },
      {
        id: "month" as const,
        label: "Month",
        href: vendorCalendarViewHref(VENDOR_CALENDAR_BASE, "month"),
        dataAttr: "vendor-calendar-tab-month",
      },
    ],
    [visitMeetings.length],
  );

  if (!demo && !ready) {
    return (
      <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav>
        <p className="text-sm font-semibold text-foreground">Loading calendar…</p>
      </ManagerPortalPageShell>
    );
  }

  if (!demo && !userId) {
    return (
      <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav>
        <p className="text-sm font-semibold text-foreground">Sign in to manage your availability.</p>
      </ManagerPortalPageShell>
    );
  }

  const searchNeedle = listSearch.trim();
  const searchMiss = Boolean(searchNeedle) && vendorMeetings.length === 0 && visitMeetings.length > 0;

  return (
    <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={calendarTabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: tab.href,
          count: tab.count,
          dataAttr: tab.dataAttr,
        }))}
        activeDestinationId={view}
        destinationAriaLabel="Calendar views"
        search={{
          value: listSearch,
          onChange: setListSearch,
          placeholder: "Search calendar",
          dataAttr: "vendor-calendar-search",
        }}
        actions={
          <div className="flex items-center gap-1">
            <PortalIconAction
              icon={CalendarClock}
              label="Set availability"
              data-attr="vendor-calendar-set-availability"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, {
                    detail: { date: toLocalDateStr(new Date()) },
                  }),
                );
              }}
            />
            <div ref={setWeekActionsHost} className="flex items-center" data-slot="calendar-week-actions-host" />
          </div>
        }
      />
      {searchMiss ? (
        <PortalListEmptyCard
          section="calendar"
          tone="muted"
          title={portalEmptyNoMatchTitle("events", listSearch)}
          clear={{
            label: "Clear search",
            onClick: () => setListSearch(""),
            dataAttr: "vendor-calendar-empty-clear-search",
          }}
          dataAttr="vendor-calendar-empty-search"
        />
      ) : view === "list" ? (
        <PortalRecordListSurface
          isEmpty={vendorMeetings.length === 0}
          emptyCard={{ title: "No scheduled services", section: "calendar" }}
          dataAttr="vendor-calendar-list"
        >
          {vendorMeetings.map((meeting) => (
            <PortalPropertyRecordRow
              key={meeting.id}
              title={meeting.title}
              address={meeting.propertyTitle ?? "—"}
              facts={new Date(meeting.startIso).toLocaleString()}
              dataAttr="vendor-calendar-list-row"
            />
          ))}
        </PortalRecordListSurface>
      ) : (
        <PortalCalendarPanels
          storageKey={storageKey}
          readOnly
          compactAvailability={view === "week"}
          defaultViewMode={view}
          viewMode={view}
          anchorDate={calendarAnchorDate}
          onAnchorDateChange={setCalendarAnchorDate}
          hideViewModeControl
          onVendorAvailabilityEdit={(date, slotIdx) => {
            window.dispatchEvent(new CustomEvent(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, { detail: { date, slotIdx } }));
          }}
          availabilityHeading="Availability"
          eventSummaryLabel="visit"
          calendarRefreshSignal={calendarRefreshSignal}
          externalMeetings={vendorMeetings}
          weekActionsHost={weekActionsHost}
          vendorViewer
        />
      )}
      <VendorAvailabilityEditor dialog />
    </ManagerPortalPageShell>
  );
}
