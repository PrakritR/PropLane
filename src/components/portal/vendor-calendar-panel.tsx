"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { MEETING_CONFIRMED_COLOR, PortalCalendarPanels, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { FilterCollapsibleSection, FilterCheckboxList } from "@/components/portal/filter-field-lists";
import { VendorCalendarIntegrationsAction } from "@/components/portal/vendor-calendar-integrations-action";
import { GoogleCalendarPendingChangesBanner } from "@/components/portal/google-calendar-pending-changes-banner";
import {
  VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT,
  VENDOR_AVAILABILITY_CHANGED_EVENT,
  VendorAvailabilityEditor,
  type VendorAvailabilityFocus,
} from "@/components/portal/vendor-availability-editor";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
  VENDOR_BLOCK_MEETING_ID_PREFIX,
  type VendorAvailabilityRule,
} from "@/lib/vendor-availability";
import { vendorJobDetailHref } from "@/lib/portal-detail-routes";
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
    id: `${VENDOR_VISIT_MEETING_ID_PREFIX}${row.id}`,
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

const VENDOR_VISIT_MEETING_ID_PREFIX = "vendor-visit-";
const VENDOR_BLOCK_COLOR = "#94a3b8";

/**
 * A vendor's "block" rule as a calendar item: grey, drawn over the open hours it cuts out of.
 * It is the shared grid's own busy-block shape (`googleCalendarPrivate`, label "Blocked"), so the
 * Week / Day grid, Month and counts treat it like any other busy time. Clicking it re-opens the
 * availability editor, where it is removed.
 */
export function vendorBlockMeetings(rules: VendorAvailabilityRule[]): DemoMeeting[] {
  const out: DemoMeeting[] = [];
  for (const rule of rules) {
    if (rule.kind !== "block") continue;
    const midnight = new Date(`${rule.specificDate}T00:00:00`);
    if (Number.isNaN(midnight.getTime())) continue;
    const allDay = rule.startMinute <= 0 && rule.endMinute >= 1440;
    const start = new Date(midnight.getTime() + rule.startMinute * 60_000);
    const end = new Date(midnight.getTime() + rule.endMinute * 60_000);
    const durationMinutes = Math.max(SLOT_DURATION_MINUTES, rule.endMinute - rule.startMinute);
    out.push({
      id: `${VENDOR_BLOCK_MEETING_ID_PREFIX}${rule.id}`,
      source: "external",
      sourceId: rule.id,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      dateStr: rule.specificDate,
      startSlot: Math.max(0, Math.floor(rule.startMinute / SLOT_DURATION_MINUTES)),
      span: Math.max(1, Math.ceil(durationMinutes / SLOT_DURATION_MINUTES)),
      durationMinutes,
      title: "Blocked",
      color: VENDOR_BLOCK_COLOR,
      googleCalendarPrivate: true,
      allDay,
      notes: rule.note || undefined,
    });
  }
  return out;
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

/**
 * Vendor Calendar — the manager Calendar's own engine (`PortalCalendarPanels`, studio grid) with
 * Day / Week / Month / Agenda, not a separate view. One view, no tabs: services and blocked time
 * are the events, the vendor's weekly hours are the subtle open-hours shading. The round + opens
 * Block time and Weekly hours, both the existing canonical editor (`VendorAvailabilityEditor`) in
 * a pop-up; clicking a blocked time re-opens it, so removal always goes through one form.
 */
export function VendorCalendarPanel() {
  const { showToast } = useAppUi();
  const { userId, ready } = usePortalSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const demo = isDemoModeActive();
  const openEditor = useCallback((focus: VendorAvailabilityFocus, detail: { date?: string; slotIdx?: number } = {}) => {
    window.dispatchEvent(
      new CustomEvent(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, {
        detail: { date: toLocalDateStr(new Date()), ...detail, focus },
      }),
    );
  }, []);
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

  // The assistant's "Set availability" chip (VD23, 2026-09-27) is reachable
  // from any vendor page, so it navigates here with a query flag rather than
  // dispatching the open event directly — the editor only lives on THIS page,
  // and a same-page dispatch would be lost if no listener were mounted yet.
  useEffect(() => {
    const openAvailability = searchParams?.get("openAvailability") === "1";
    const weeklyHours = searchParams?.get("modal") === "weekly-hours";
    if (!openAvailability && !weeklyHours) return;
    // Old Settings > Availability links (`?modal=weekly-hours`) land on the Weekly hours pop-up.
    openEditor(weeklyHours ? "weekly" : "all");
    const params = new URLSearchParams(searchParams);
    params.delete("openAvailability");
    params.delete("modal");
    const query = params.toString();
    router.replace(`/vendor/calendar${query ? `?${query}` : ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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

  const blockMeetings = useMemo(() => vendorBlockMeetings(rules), [rules]);
  const externalMeetings = useMemo<DemoMeeting[]>(() => {
    const needle = listSearch.trim();
    const visits = needle ? searchedMeetings : propertyFiltered;
    const busy = needle
      ? [...googleBusyMeetings, ...blockMeetings].filter((meeting) => calendarMeetingMatchesQuery(meeting, needle))
      : [...googleBusyMeetings, ...blockMeetings];
    return [...visits, ...busy];
  }, [blockMeetings, googleBusyMeetings, listSearch, propertyFiltered, searchedMeetings]);

  /** A service visit opens its job record; a block has none (it re-opens the editor instead). */
  const recordHrefFor = useCallback(
    (meeting: DemoMeeting): string | null =>
      meeting.id.startsWith(VENDOR_VISIT_MEETING_ID_PREFIX) ? vendorJobDetailHref("/vendor", meeting.sourceId) : null,
    [],
  );
  const openRecord = useCallback((href: string) => router.push(href), [router]);

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
        search={{
          value: listSearch,
          onChange: setListSearch,
          placeholder: "Search calendar",
          dataAttr: "vendor-calendar-search",
        }}
        actions={
          <>
            {filterSheet}
            <VendorCalendarIntegrationsAction />
          </>
        }
        primary={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <PortalPrimaryIconAction label="Add to calendar" data-attr="vendor-calendar-add-menu" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-attr="vendor-calendar-add-menu-content">
              <DropdownMenuItem data-attr="vendor-calendar-block-time" onSelect={() => openEditor("block")}>
                Block time
              </DropdownMenuItem>
              <DropdownMenuItem data-attr="vendor-calendar-weekly-hours" onSelect={() => openEditor("weekly")}>
                Weekly hours
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <div className="portal-calendar-page-body mt-1 flex min-h-[min(72vh,52rem)] flex-1 flex-col bg-accent/30">
      <PortalCalendarPanels
        storageKey={storageKey}
        vendorViewer
        studioGrid
        calendarTab="all"
        defaultViewMode="week"
        // The manager Calendar's own grid: Day / Week / Month / Agenda with Today and the range
        // arrows (`studioGrid`). A vendor can read it but not paint it (`canEditAvailability` stays
        // off for `vendorViewer`); weekly hours and blocks are edited in the pop-up.
        compactAvailability
        bareSurface
        flowScroll
        calendarRefreshSignal={refreshSignal}
        externalMeetings={externalMeetings}
        recordHrefFor={recordHrefFor}
        onOpenRecord={openRecord}
        onVendorAvailabilityEdit={(date, slotIdx) => openEditor("block", { date, slotIdx })}
        onVendorAvailabilityRemove={(date, startSlot, endSlotExclusive) => {
          void handleVendorAvailabilityRemove(date, startSlot, endSlotExclusive);
        }}
      />
      </div>
      <VendorAvailabilityEditor dialog />
    </ManagerPortalPageShell>
  );
}
