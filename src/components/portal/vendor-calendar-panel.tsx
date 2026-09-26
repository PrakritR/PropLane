"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { MEETING_CONFIRMED_COLOR, PortalCalendarPanels, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { FilterCollapsibleSection, FilterCheckboxList } from "@/components/portal/filter-field-lists";
import { GoogleCalendarConnectDialog } from "@/components/portal/google-calendar-connect-dialog";
import { GoogleCalendarPendingChangesBanner } from "@/components/portal/google-calendar-pending-changes-banner";
import { VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, VENDOR_AVAILABILITY_CHANGED_EVENT, VendorAvailabilityEditor } from "@/components/portal/vendor-settings-panel";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { readVendorWorkOrderRows, syncManagerWorkOrdersFromServer, MANAGER_WORK_ORDERS_EVENT } from "@/lib/manager-work-orders-storage";
import {
  SLOT_DURATION_MINUTES,
  toLocalDateStr,
  installAvailabilityDateSetForStorageKey,
} from "@/lib/demo-admin-scheduling";
import {
  fetchVendorAvailability,
  isFlexibleWeeklyRule,
  saveVendorBlockRule,
  slotKeysFromWeeklyRules,
  type VendorAvailabilityRule,
} from "@/lib/vendor-availability";
import {
  VENDOR_CALENDAR_VIEW_TABS,
  VendorCalendarViewTabId,
  vendorCalendarViewHref,
} from "@/lib/portal-detail-routes";
import { calendarMeetingMatchesQuery } from "@/lib/manager-calendar-tour-meetings";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isGoogleBusyIncompleteWarning, useGoogleCalendarBusyMeetings } from "@/hooks/use-google-calendar-busy";

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

const VENDOR_VISIT_DEFAULT_DURATION_MINUTES = 60;

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

const VENDOR_AVAILABILITY_PAINT_WINDOW_DAYS = 400;

/**
 * Project the vendor's canonical `/api/vendor/availability` rules onto the
 * date:slot key cache `PortalCalendarPanels` reads for its week grid. A wide
 * window (past + future ~13 months) so recurring weekly windows still paint
 * after the vendor navigates several weeks in either direction — the grid
 * itself only ever shows one week, but the cache has to cover wherever that
 * week lands.
 */
export function installVendorAvailabilityPaintCache(
  storageKey: string,
  rules: VendorAvailabilityRule[],
  window: { from: Date; dayCount: number } = { from: new Date(), dayCount: VENDOR_AVAILABILITY_PAINT_WINDOW_DAYS },
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

const VENDOR_CALENDAR_TAB_LABELS: Record<VendorCalendarViewTabId, string> = {
  all: "All",
  services: "Services",
  availability: "Availability",
};

/**
 * Vendor Calendar — the same week-grid engine the manager Calendar uses
 * (`PortalCalendarPanels`, `vendorViewer` mode), not a separate agenda list.
 * "Services" tab shows only scheduled visits; "Availability" only the
 * vendor's own painted windows; "All" both. Setting availability (weekly
 * hours + block a date) is delegated to the existing canonical editor
 * (`VendorAvailabilityEditor`) via `onVendorAvailabilityEdit` / the round "+" —
 * clicking a painted block re-opens that same editor rather than a bespoke
 * grid-level delete, so removal always goes through one form.
 */
export function VendorCalendarPanel({ tab = "all" }: { tab?: VendorCalendarViewTabId } = {}) {
  const { showToast } = useAppUi();
  const { userId, ready } = usePortalSession();
  const demo = isDemoModeActive();
  const [rows, setRows] = useState<DemoManagerWorkOrderRow[]>(() => readVendorWorkOrderRows());
  const [listSearch, setListSearch] = useState("");
  const [rules, setRules] = useState<VendorAvailabilityRule[]>([]);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);

  const storageKey = userId ? `vendor-calendar-availability-paint:${userId}` : null;

  const paintAndBump = useCallback(
    (nextRules: VendorAvailabilityRule[]) => {
      if (storageKey) installVendorAvailabilityPaintCache(storageKey, nextRules);
      setRefreshSignal((n) => n + 1);
    },
    [storageKey],
  );

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
  }, []);

  useEffect(() => {
    if (demo || !storageKey) return;
    void fetchVendorAvailability().then((next) => {
      setRules(next);
      paintAndBump(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, storageKey]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ rules?: VendorAvailabilityRule[] }>).detail;
      if (!detail?.rules) return;
      setRules(detail.rules);
      paintAndBump(detail.rules);
    };
    window.addEventListener(VENDOR_AVAILABILITY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(VENDOR_AVAILABILITY_CHANGED_EVENT, onChanged);
  }, [paintAndBump]);

  // The manager's Tours availability blocks get a one-click × on the run's
  // first cell (`PortalCalendarPanels`); this is the vendor equivalent — a
  // "block" rule for exactly this run's date + time range, which always wins
  // over a recurring weekly window for that one occurrence without deleting
  // the underlying rule (the same non-destructive shape "Block a date" already
  // uses in `VendorAvailabilityEditor`). The server route re-derives the
  // vendor from auth on every write, so this can never touch another vendor's
  // rules regardless of what this client sends.
  const handleVendorAvailabilityRemove = useCallback(
    async (dateStr: string, startSlot: number, endSlotExclusive: number) => {
      if (demo) {
        showToast("Availability changes are available on a live vendor account.");
        return;
      }
      const result = await saveVendorBlockRule({
        specificDate: dateStr,
        startMinute: startSlot * SLOT_DURATION_MINUTES,
        endMinute: endSlotExclusive * SLOT_DURATION_MINUTES,
      });
      if (!result.ok) {
        showToast(result.error ?? "Could not remove this time.");
        return;
      }
      const next = await fetchVendorAvailability(undefined, { force: true });
      setRules(next);
      paintAndBump(next);
    },
    [demo, paintAndBump, showToast],
  );

  // Read-only Google Calendar busy time for the vendor's OWN connected
  // account — reuses the same hook + endpoint shape the manager calendar
  // merges its Google busy blocks through (`use-google-calendar-busy.ts`),
  // pointed at the vendor's own clone of the events route. Disconnected and
  // configuration-error states resolve to an empty list without a toast (the
  // Google Calendar connect icon already shows that state); only an
  // incomplete/failed read — where busy time may be silently missing — warns,
  // matching `manager-tour-availability-modal.tsx`'s more conservative toast.
  const googleBusyMeetings = useGoogleCalendarBusyMeetings({
    enabled: !demo && Boolean(userId),
    endpoint: "/api/vendor/google-calendar/events",
    refreshSignal,
    onWarning: ({ warning, hint }) => {
      if (!isGoogleBusyIncompleteWarning(warning)) return;
      showToast(
        hint ?? "PropLane could not load all your Google Calendar busy time, so this grid may be missing conflicts.",
      );
    },
  });

  const allVisitMeetings = useMemo<DemoMeeting[]>(() => {
    return rows
      .filter((r) => r.scheduledAtIso && r.bucket !== "completed")
      .map(vendorMeetingFromRow)
      .filter((meeting) => meeting !== null);
  }, [rows]);

  const propertyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const meeting of allVisitMeetings) {
      if (meeting.propertyTitle) set.add(meeting.propertyTitle);
    }
    return [...set].sort().map((label) => ({ value: label, label }));
  }, [allVisitMeetings]);

  const propertyFiltered = useMemo(() => {
    if (propertyFilters.length === 0) return allVisitMeetings;
    return allVisitMeetings.filter((m) => m.propertyTitle && propertyFilters.includes(m.propertyTitle));
  }, [allVisitMeetings, propertyFilters]);

  const searchedMeetings = useMemo(() => {
    const needle = listSearch.trim();
    if (!needle) return propertyFiltered;
    return propertyFiltered.filter((meeting) => calendarMeetingMatchesQuery(meeting, needle));
  }, [listSearch, propertyFiltered]);

  const availabilityRuleCount = useMemo(() => rules.filter((r) => r.kind !== "event").length, [rules]);

  const tabCounts = useMemo<Record<VendorCalendarViewTabId, number>>(
    () => ({
      all: allVisitMeetings.length + availabilityRuleCount,
      services: allVisitMeetings.length,
      availability: availabilityRuleCount,
    }),
    [allVisitMeetings.length, availabilityRuleCount],
  );

  // Google busy time is context, not a service visit — it draws (and is
  // excluded from bookable availability, via the shared engine's own
  // open/taken-slot math) on "All" and "Availability", never on "Services".
  const showGoogleBusy = tab !== "services";
  const searchedGoogleBusy = useMemo(() => {
    if (!showGoogleBusy) return [];
    const needle = listSearch.trim();
    if (!needle) return googleBusyMeetings;
    return googleBusyMeetings.filter((meeting) => calendarMeetingMatchesQuery(meeting, needle));
  }, [googleBusyMeetings, listSearch, showGoogleBusy]);
  const externalMeetings = useMemo(() => {
    const base = tab === "availability" ? [] : searchedMeetings;
    return showGoogleBusy ? [...base, ...searchedGoogleBusy] : base;
  }, [tab, searchedMeetings, showGoogleBusy, searchedGoogleBusy]);
  const showAvailability = tab !== "services";

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

  const filterSheet =
    propertyOptions.length > 1 ? (
      <PortalFilterSortSheet
        activeCount={portalFilterActiveCount([propertyFilters])}
        onReset={() => setPropertyFilters([])}
        dataAttr="vendor-calendar-filter-open"
        commandStripTrigger
      >
        <FilterCollapsibleSection
          label="Property"
          summary={propertyFilters.length ? propertyFilters.join(", ") : "All properties"}
          empty={propertyFilters.length === 0}
          sectionId="property"
          menuOptionCount={propertyOptions.length}
          dataAttr="vendor-calendar-filter-property"
        >
          <FilterCheckboxList
            options={propertyOptions}
            selected={propertyFilters}
            onChange={setPropertyFilters}
            dataAttr="vendor-calendar-filter-property-list"
          />
        </FilterCollapsibleSection>
      </PortalFilterSortSheet>
    ) : null;

  return (
    <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav compactFilterRow>
      {!demo && userId ? (
        <GoogleCalendarPendingChangesBanner apiBase="/api/vendor/google-calendar" refreshSignal={refreshSignal} />
      ) : null}
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={VENDOR_CALENDAR_VIEW_TABS.map((id) => ({
          id,
          label: VENDOR_CALENDAR_TAB_LABELS[id],
          count: tabCounts[id],
          href: vendorCalendarViewHref("/vendor", id),
          dataAttr: `vendor-calendar-tab-${id}`,
        }))}
        activeDestinationId={tab}
        destinationAriaLabel="Calendar view"
        search={{
          value: listSearch,
          onChange: setListSearch,
          placeholder: "Search calendar",
          dataAttr: "vendor-calendar-search",
        }}
        actions={
          <>
            {filterSheet}
            <GoogleCalendarConnectDialog
              apiBase="/api/vendor/google-calendar"
              showVendorPushToggle
              onConnectionChange={() => setRefreshSignal((n) => n + 1)}
            />
          </>
        }
        primary={
          <PortalPrimaryIconAction
            label="Add availability"
            data-attr="vendor-calendar-set-availability"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, {
                  detail: { date: toLocalDateStr(new Date()) },
                }),
              );
            }}
          />
        }
      />
      <PortalCalendarPanels
        storageKey={showAvailability ? storageKey : null}
        vendorViewer
        hideViewModeControl
        defaultViewMode="week"
        calendarRefreshSignal={refreshSignal}
        externalMeetings={externalMeetings}
        onVendorAvailabilityEdit={(date, slotIdx) => {
          window.dispatchEvent(
            new CustomEvent(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, { detail: { date, slotIdx } }),
          );
        }}
        onVendorAvailabilityRemove={(date, startSlot, endSlotExclusive) => {
          void handleVendorAvailabilityRemove(date, startSlot, endSlotExclusive);
        }}
      />
      <VendorAvailabilityEditor dialog />
    </ManagerPortalPageShell>
  );
}
