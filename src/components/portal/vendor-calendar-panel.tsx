"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalCalendarPanels, MEETING_CONFIRMED_COLOR, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { VENDOR_AVAILABILITY_CHANGED_EVENT } from "@/components/portal/vendor-settings-panel";
import { readVendorWorkOrderRows, syncManagerWorkOrdersFromServer, MANAGER_WORK_ORDERS_EVENT } from "@/lib/manager-work-orders-storage";
import {
  readAvailabilityDateSetForStorageKey,
  SLOT_DURATION_MINUTES,
  toLocalDateStr,
  vendorAvailabilityStorageKey,
  writeAvailabilityDateSetForStorageKey,
} from "@/lib/demo-admin-scheduling";
import {
  convertFlexibleWeeklyRulesToWindows,
  fetchVendorAvailability,
  isFlexibleWeeklyRule,
  slotKeysFromWeeklyRules,
  type VendorAvailabilityRule,
} from "@/lib/vendor-availability";
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

function notifyAvailabilityChanged(rules: VendorAvailabilityRule[]) {
  window.dispatchEvent(new CustomEvent(VENDOR_AVAILABILITY_CHANGED_EVENT, { detail: { rules } }));
}

function hydratePaintedSlotsFromWeeklyRules(storageKey: string, rules: VendorAvailabilityRule[]) {
  const existing = readAvailabilityDateSetForStorageKey(storageKey);
  if (existing.size > 0) return;
  const keys = slotKeysFromWeeklyRules(rules, new Date(), 12);
  if (keys.length === 0) return;
  writeAvailabilityDateSetForStorageKey(new Set(keys), storageKey);
}

/** Week grid that paints availability the same way the manager calendar does. */
export function VendorCalendarPanel({ view = "all" }: { view?: VendorCalendarViewTabId }) {
  const { userId, ready } = usePortalSession();
  const demo = isDemoModeActive();
  const [rows, setRows] = useState<DemoManagerWorkOrderRow[]>(() => readVendorWorkOrderRows());
  const [calendarRefreshSignal, setCalendarRefreshSignal] = useState(0);
  const [listSearch, setListSearch] = useState("");
  const [weekActionsHost, setWeekActionsHost] = useState<HTMLElement | null>(null);

  const storageKey = useMemo(() => (userId ? vendorAvailabilityStorageKey(userId) : null), [userId]);

  const reloadAvailability = useCallback(async () => {
    if (demo) return;
    let rules = await fetchVendorAvailability();
    if (rules.some(isFlexibleWeeklyRule)) {
      const converted = await convertFlexibleWeeklyRulesToWindows(rules);
      if (converted) rules = converted;
    }
    if (storageKey) hydratePaintedSlotsFromWeeklyRules(storageKey, rules);
    notifyAvailabilityChanged(rules);
    setCalendarRefreshSignal((n) => n + 1);
  }, [demo, storageKey]);

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
  }, []);

  useEffect(() => {
    void reloadAvailability();
  }, [reloadAvailability]);

  const visitMeetings = useMemo<DemoMeeting[]>(() => {
    return rows
      .filter((r) => r.scheduledAtIso && r.bucket !== "completed")
      .map(vendorMeetingFromRow)
      .filter((meeting) => meeting !== null);
  }, [rows]);

  const vendorMeetings = useMemo(() => {
    const scoped = view === "services" ? visitMeetings : visitMeetings;
    const needle = listSearch.trim();
    if (!needle) return scoped;
    return scoped.filter((meeting) => calendarMeetingMatchesQuery(meeting, needle));
  }, [listSearch, view, visitMeetings]);

  const calendarTabs = useMemo(
    () => [
      {
        id: "all" as const,
        label: "All",
        count: visitMeetings.length,
        href: vendorCalendarViewHref(VENDOR_CALENDAR_BASE, "all"),
        dataAttr: "vendor-calendar-tab-all",
      },
      {
        id: "services" as const,
        label: "Services",
        count: visitMeetings.length,
        href: vendorCalendarViewHref(VENDOR_CALENDAR_BASE, "services"),
        dataAttr: "vendor-calendar-tab-services",
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
        actions={<div ref={setWeekActionsHost} className="flex items-center" data-slot="calendar-week-actions-host" />}
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
      ) : (
        <PortalCalendarPanels
          storageKey={storageKey}
          readOnly={false}
          compactAvailability
          defaultViewMode="week"
          availabilityHeading="Availability"
          eventSummaryLabel="visit"
          calendarRefreshSignal={calendarRefreshSignal}
          externalMeetings={vendorMeetings}
          weekActionsHost={weekActionsHost}
          vendorViewer
        />
      )}
    </ManagerPortalPageShell>
  );
}
