"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { Share2 } from "lucide-react";
import { ManagerPortalPageShell } from "./portal-metrics";
import { PortalCalendarPanels } from "./portal-calendar-panels";
import {
  ADMIN_AVAILABILITY_STORAGE_KEY,
  managerPropertyAvailabilityStorageKey,
  readAvailabilityDateSetForStorageKey,
  readCalendarShareAvailability,
  registerManagerForProperty,
  syncScheduleRecordsFromServer,
  writeAvailabilityDateSetForStorageKeyToServer,
  writeCalendarShareAvailability,
} from "@/lib/demo-admin-scheduling";
import {
  defaultAvailabilityKindForCalendarView,
  managerKindAvailabilityStorageKey,
  type AvailabilityKind,
} from "@/lib/manager-availability-kinds";
import {
  coManagerOverlaysFromPeers,
  listPropertyCalendarPeers,
  propertyHasMultipleCalendarManagers,
  type CoManagerCalendarPeerDto,
} from "@/lib/co-manager-calendar";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions, MANAGER_PORTFOLIO_REFRESH_EVENTS } from "@/lib/manager-portfolio-access";
import { buildManagerShareablePropertyOptions } from "@/lib/manager-property-links";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { GoogleCalendarConnectDialog } from "@/components/portal/google-calendar-connect-dialog";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import {
  isGoogleBusyIncompleteWarning,
  useGoogleCalendarBusyMeetings,
} from "@/hooks/use-google-calendar-busy";
import { listManagerServiceCalendarMeetings } from "@/lib/manager-service-calendar";
import {
  MANAGER_WORK_ORDERS_EVENT,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import {
  buildScheduledTourMeetings,
  calendarMeetingMatchesQuery,
  meetingsInWeek,
} from "@/lib/manager-calendar-tour-meetings";
import {
  CALENDAR_VIEW_TABS,
  CALENDAR_VIEW_TAB_LABELS,
  calendarViewHref,
  parseCalendarViewTab,
  toursHubHref,
  type CalendarViewTabId,
  type ToursHubTabId,
  type VendorCalendarViewTabId,
} from "@/lib/portal-detail-routes";

import { resolveDefaultTourAvailabilityConfig } from "@/lib/tour-slot-math";
import {
  buildCalendarCopyDestinationHouses,
  resolveCalendarCopySourcePropertyId,
} from "@/lib/calendar-copy-availability";
import { VendorCalendarPanel } from "@/components/portal/vendor-calendar-panel";

const MANAGER_PORTAL_BASE = "/portal";

export type PortalCalendarPortal = "manager" | "admin" | "vendor";

type PortalCalendarProps = {
  portal: PortalCalendarPortal;
  initialUserId?: string | null;
  initialEmail?: string | null;
  calendarView?: CalendarViewTabId;
  schedulingHub?: boolean;
  toursHubTab?: import("@/lib/portal-detail-routes").ToursHubTabId;
  vendorCalendarView?: VendorCalendarViewTabId;
};

export function PortalCalendar(props: PortalCalendarProps) {
  if (props.portal === "vendor") return <VendorCalendarPanel view={props.vendorCalendarView ?? "all"} />;
  return <PortalCalendarManager {...props} portal={props.portal} />;
}
const NO_DEFAULT_TOUR_AVAILABILITY = resolveDefaultTourAvailabilityConfig({ enabled: false });

function PortalCalendarManager({
  portal,
  initialUserId,
  initialEmail,
  calendarView: calendarViewProp,
  schedulingHub = false,
  toursHubTab: toursHubTabProp,
}: Omit<PortalCalendarProps, "portal"> & { portal: "manager" | "admin" }) {
  const { userId, email, ready: authReady } = useManagerUserId({
    userId: initialUserId,
    email: initialEmail,
  });
  const { showToast } = useAppUi();
  const [calendarRefreshSignal, setCalendarRefreshSignal] = useState(0);
  const [calendarPropertyFilters, setCalendarPropertyFilters] = useState<string[]>([]);
  const demoCalendarDefaultAppliedRef = useRef(false);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [shareTourModalOpen, setShareTourModalOpen] = useState(false);
  const [coManagerPeers, setCoManagerPeers] = useState<CoManagerCalendarPeerDto[]>([]);
  const [shareAvailability, setShareAvailability] = useState(false);
  const [googleCalendarTick, setGoogleCalendarTick] = useState(0);
  const calendarView: CalendarViewTabId =
    portal === "manager" && !schedulingHub ? parseCalendarViewTab(calendarViewProp) : "all";
  const toursHubTab: ToursHubTabId = toursHubTabProp ?? "tours";
  const [workOrderTick, setWorkOrderTick] = useState(0);
  const [calendarAnchorDate, setCalendarAnchorDate] = useState(() => new Date());
  const [listSearch, setListSearch] = useState("");

  useEffect(() => {
    if (portal !== "manager") return;
    const bump = () => setWorkOrderTick((n) => n + 1);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    void syncManagerWorkOrdersFromServer().then(() => bump());
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
  }, [portal]);

  useEffect(() => {
    if (portal !== "manager") return;
    const bump = () => setPropertyTick((n) => n + 1);
    for (const eventName of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
      window.addEventListener(eventName, bump);
    }
    return () => {
      for (const eventName of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
        window.removeEventListener(eventName, bump);
      }
    };
  }, [portal]);

  // Shared with the per-property availability calendar so both screens show the
  // same conflicts (F-CAL-6). Only this one toasts the connection warnings.
  const googleExternalMeetings = useGoogleCalendarBusyMeetings({
    enabled: portal === "manager" && authReady && Boolean(userId),
    refreshSignal: calendarRefreshSignal + googleCalendarTick,
    onWarning: ({ warning, hint }) => {
      if (warning === "calendar_api_disabled") {
        showToast(hint ?? "Enable the Google Calendar API in Google Cloud Console, then refresh this page.");
      } else if (warning === "calendar_oauth_not_configured" || warning === "calendar_not_connected") {
        showToast(hint ?? "Google Calendar sync is not ready yet.");
      } else if (isGoogleBusyIncompleteWarning(warning)) {
        showToast(
          hint ??
            "PropLane could not load every Google Calendar event for these dates, so some busy time may be missing.",
        );
      }
    },
  });

  useEffect(() => {
    if (portal !== "manager" || !authReady || !userId) return;
    let cancelled = false;
    void syncPropertyPipelineFromServer()
      .finally(() => {
        if (cancelled) return;
        setPropertiesLoading(false);
        setPropertyTick((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [portal, authReady, userId]);

  const managerPropertyFilterOptions = useMemo(() => {
    if (portal !== "manager" || !userId) return [];
    void propertyTick;
    return buildManagerPropertyFilterOptions(userId);
  }, [portal, userId, propertyTick]);

  const managerProperties = useMemo(
    () => managerPropertyFilterOptions.map((property) => ({ id: property.id, name: property.label })),
    [managerPropertyFilterOptions],
  );

  // In the /demo sandbox, pre-select the first property so the calendar opens
  // populated (availability + tours) instead of on the "Select a house" blank.
  useEffect(() => {
    if (!isDemoModeActive() || portal !== "manager" || demoCalendarDefaultAppliedRef.current) return;
    const first = managerProperties[0];
    if (!first) return;
    demoCalendarDefaultAppliedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time demo default once seeded properties arrive
    setCalendarPropertyFilters([first.id]);
  }, [portal, managerProperties]);

  const activeCalendarPropertyFilters = useMemo(
    () => calendarPropertyFilters.filter((id) => managerProperties.some((property) => property.id === id)),
    [calendarPropertyFilters, managerProperties],
  );

  /** Empty property filter = entire portfolio (not "none selected"). */
  const scopedCalendarPropertyIds = useMemo(() => {
    if (activeCalendarPropertyFilters.length > 0) return activeCalendarPropertyFilters;
    return managerProperties.map((property) => property.id);
  }, [activeCalendarPropertyFilters, managerProperties]);

  const calendarEditingPropertyId =
    activeCalendarPropertyFilters.length === 1 ? activeCalendarPropertyFilters[0]! : "";

  const availabilityCopySourcePropertyId = useMemo(
    () => resolveCalendarCopySourcePropertyId(activeCalendarPropertyFilters, scopedCalendarPropertyIds),
    [activeCalendarPropertyFilters, scopedCalendarPropertyIds],
  );

  const copyDestinationHouses = useMemo(
    () =>
      buildCalendarCopyDestinationHouses(
        availabilityCopySourcePropertyId,
        managerProperties,
        activeCalendarPropertyFilters,
      ),
    [availabilityCopySourcePropertyId, managerProperties, activeCalendarPropertyFilters],
  );
  const [weekActionsHost, setWeekActionsHost] = useState<HTMLDivElement | null>(null);

  const soleCalendarPropertyId = calendarEditingPropertyId;

  const availabilityStorageKeys = useMemo(() => {
    if (portal !== "manager" || !userId || scopedCalendarPropertyIds.length === 0) return [];
    return scopedCalendarPropertyIds.map((id) => managerPropertyAvailabilityStorageKey(userId, id));
  }, [portal, userId, scopedCalendarPropertyIds]);

  const shareableProperties = useMemo(() => {
    if (portal !== "manager") return [];
    void propertyTick;
    return buildManagerShareablePropertyOptions(userId);
  }, [portal, userId, propertyTick]);

  useEffect(() => {
    if (portal !== "manager" || !userId || !soleCalendarPropertyId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear co-manager state when scope is unavailable
      setCoManagerPeers([]);
      setShareAvailability(false);
      return;
    }
    let cancelled = false;
    const loadPeers = async () => {
      await syncScheduleRecordsFromServer();
      if (cancelled) return;
      setShareAvailability(readCalendarShareAvailability(userId, soleCalendarPropertyId));
      try {
        const res = await fetch(
          `/api/portal/co-manager-calendar?propertyId=${encodeURIComponent(soleCalendarPropertyId)}`,
          { cache: "no-store", credentials: "include" },
        );
        if (!res.ok) {
          const localPeers = listPropertyCalendarPeers(userId, soleCalendarPropertyId).map((peer) => ({
            ...peer,
            sharesAvailability: peer.isSelf ? readCalendarShareAvailability(userId, soleCalendarPropertyId) : false,
            slots: [] as string[],
          }));
          if (!cancelled) setCoManagerPeers(localPeers);
          return;
        }
        const body = (await res.json()) as { peers?: CoManagerCalendarPeerDto[] };
        if (!cancelled) setCoManagerPeers(Array.isArray(body.peers) ? body.peers : []);
      } catch {
        if (!cancelled) {
          setCoManagerPeers(
            listPropertyCalendarPeers(userId, soleCalendarPropertyId).map((peer) => ({
              ...peer,
              sharesAvailability: peer.isSelf ? readCalendarShareAvailability(userId, soleCalendarPropertyId) : false,
              slots: [],
            })),
          );
        }
      }
    };
    void loadPeers();
    return () => {
      cancelled = true;
    };
  }, [portal, userId, soleCalendarPropertyId, calendarRefreshSignal, propertyTick]);

  const calendarPeers = useMemo(
    () =>
      soleCalendarPropertyId && userId
        ? listPropertyCalendarPeers(userId, soleCalendarPropertyId)
        : [],
    [userId, soleCalendarPropertyId, propertyTick, coManagerPeers],
  );

  const calendarScheduledTourFilter = useMemo(
    () =>
      portal === "manager" && userId
        ? {
            viewerUserId: userId,
            propertyId: soleCalendarPropertyId || null,
            propertyIds: scopedCalendarPropertyIds,
            peers: calendarPeers,
          }
        : null,
    [portal, userId, soleCalendarPropertyId, scopedCalendarPropertyIds, calendarPeers],
  );

  const coManagerAvailabilityOverlays = useMemo(
    () => (userId ? coManagerOverlaysFromPeers(coManagerPeers, userId) : []),
    [coManagerPeers, userId],
  );

  const showCoManagerCoordination =
    portal === "manager" &&
    Boolean(soleCalendarPropertyId && userId && propertyHasMultipleCalendarManagers(userId, soleCalendarPropertyId));

  const setShareAvailabilityPreference = useCallback(
    (next: boolean) => {
      if (!userId || !soleCalendarPropertyId) return;
      setShareAvailability(next);
      writeCalendarShareAvailability(userId, soleCalendarPropertyId, next);
      setCoManagerPeers((prev) =>
        prev.map((peer) => (peer.isSelf ? { ...peer, sharesAvailability: next } : peer)),
      );
      showToast(next ? "Co-managers can see your availability for this house." : "Your availability is private.");
    },
    [userId, soleCalendarPropertyId, showToast],
  );

  // Register this manager as a tour host for the selected property so the public
  // booking page can discover combined availability across all linked managers.
  useEffect(() => {
    if (portal !== "manager" || !userId || !soleCalendarPropertyId) return;
    const label = email || userId;
    registerManagerForProperty(userId, soleCalendarPropertyId, label);
  }, [portal, userId, email, soleCalendarPropertyId]);

  const storageKey = useMemo(() => {
    if (portal === "admin") return ADMIN_AVAILABILITY_STORAGE_KEY;
    if (!userId) return null;
    if (!calendarEditingPropertyId) return null;
    return managerPropertyAvailabilityStorageKey(userId, calendarEditingPropertyId);
  }, [portal, userId, calendarEditingPropertyId]);

  const tourScopeLabel = useMemo(() => {
    if (portal !== "manager") return undefined;
    if (activeCalendarPropertyFilters.length === 1) {
      const name = managerProperties.find((p) => p.id === soleCalendarPropertyId)?.name;
      return name ? `Calendar · ${name}` : undefined;
    }
    if (scopedCalendarPropertyIds.length > 1) {
      return activeCalendarPropertyFilters.length > 1
        ? `Calendar · ${activeCalendarPropertyFilters.length} houses`
        : `Calendar · All houses (${scopedCalendarPropertyIds.length})`;
    }
    return undefined;
  }, [
    portal,
    activeCalendarPropertyFilters,
    soleCalendarPropertyId,
    scopedCalendarPropertyIds,
    managerProperties,
  ]);


  const serviceCalendarMeetings = useMemo(() => {
    if (portal !== "manager" || !userId) return [] as DemoMeeting[];
    void workOrderTick;
    return listManagerServiceCalendarMeetings(
      userId,
      scopedCalendarPropertyIds.length > 0 ? scopedCalendarPropertyIds : null,
    );
  }, [portal, userId, scopedCalendarPropertyIds, workOrderTick]);

  const calendarTabCounts = useMemo(() => {
    if (portal !== "manager" || !userId) {
      return { all: 0, tours: 0, tasks: 0, bookings: 0, services: serviceCalendarMeetings.length };
    }
    void calendarRefreshSignal;
    void workOrderTick;
    const tourFilter = calendarScheduledTourFilter ?? {
      viewerUserId: userId,
      propertyId: null,
      propertyIds: scopedCalendarPropertyIds,
      peers: [],
    };
    const plannedInWeek = meetingsInWeek(
      buildScheduledTourMeetings(tourFilter, storageKey),
      calendarAnchorDate,
    );
    const tours = plannedInWeek.filter((meeting) => meeting.kind !== "task").length;
    const tasks = plannedInWeek.length - tours;
    const services = meetingsInWeek(serviceCalendarMeetings, calendarAnchorDate).length;
    return { all: tours + tasks + services, tours, tasks, bookings: 0, services };
  }, [
    portal,
    userId,
    calendarScheduledTourFilter,
    storageKey,
    calendarRefreshSignal,
    workOrderTick,
    calendarAnchorDate,
    serviceCalendarMeetings,
    scopedCalendarPropertyIds,
  ]);

  const calendarTabs = useMemo(
    () =>
      schedulingHub
        ? [
            {
              id: "tours" as const,
              label: "Tours",
              count: calendarTabCounts.tours,
              href: toursHubHref(MANAGER_PORTAL_BASE, "tours"),
              dataAttr: "tours-hub-tab-tours",
            },
            {
              id: "services" as const,
              label: "Service orders",
              count: calendarTabCounts.services,
              href: toursHubHref(MANAGER_PORTAL_BASE, "services"),
              dataAttr: "tours-hub-tab-services",
            },
          ]
        : // The Calendar section's own views (PLAN-0914-1710): one grid, four ways to read it.
          CALENDAR_VIEW_TABS.map((id) => ({
            id,
            label: CALENDAR_VIEW_TAB_LABELS[id],
            count: calendarTabCounts[id],
            href: calendarViewHref(MANAGER_PORTAL_BASE, id),
            dataAttr: `calendar-view-tab-${id}`,
          })),
    [calendarTabCounts, schedulingHub],
  );

  // Open tour slots (availability) draw where tours are booked from: All and Tours.
  const availabilityView = schedulingHub ? toursHubTab === "tours" : calendarView === "all" || calendarView === "tours";
  const showServiceVisits = schedulingHub ? toursHubTab === "services" : calendarView === "all" || calendarView === "services";
  const servicesOnlyView = schedulingHub ? toursHubTab === "services" : calendarView === "services";
  const tasksOnlyView = !schedulingHub && calendarView === "tasks";
  /*
   * Which planned meetings a view keeps. Tours: tours only (booked, pending,
   * co-manager). Tasks: tasks with a due time only. Services shows none of them
   * (its events come in as service visits). All keeps everything.
   */
  const scheduledMeetingViewFilter = useMemo<((meeting: DemoMeeting) => boolean) | undefined>(() => {
    if (schedulingHub || calendarView === "all") return undefined;
    if (calendarView === "tours") return (meeting) => meeting.kind !== "task";
    if (calendarView === "tasks") return (meeting) => meeting.kind === "task";
    return () => false;
  }, [schedulingHub, calendarView]);

  const scheduledMeetingFilter = useMemo<((meeting: DemoMeeting) => boolean) | undefined>(() => {
    const needle = listSearch.trim();
    const viewFilter = scheduledMeetingViewFilter;
    if (!needle && !viewFilter) return undefined;
    return (meeting) => {
      if (viewFilter && !viewFilter(meeting)) return false;
      return calendarMeetingMatchesQuery(meeting, needle);
    };
  }, [listSearch, scheduledMeetingViewFilter]);

  // The Calendar section is the operations overview: it answers "is anyone going into this
  // property, or is anything scheduled to be done there". That means BOTH scheduled tours and
  // service visits, not just the manager's own Google events. Previously service visits were
  // merged only for the Tours hub's Services tab, so Calendar → Availability could only ever
  // render 0 events while the Tours tab showed the very same week with two.
  // Google busy time is context, not a PropLane event: it draws on All (and on the
  // hub's Tours view), never on a single-kind tab.
  const showGoogleBusy = portal === "manager" && (schedulingHub ? availabilityView : calendarView === "all");
  const mergedExternalMeetings = useMemo(() => {
    const base = showGoogleBusy ? [...googleExternalMeetings] : [];
    if (showServiceVisits) base.push(...serviceCalendarMeetings);
    const needle = listSearch.trim();
    if (!needle) return base;
    return base.filter((meeting) => calendarMeetingMatchesQuery(meeting, needle));
  }, [showGoogleBusy, googleExternalMeetings, serviceCalendarMeetings, showServiceVisits, listSearch]);

  const calendarSearchNeedle = listSearch.trim();
  const calendarSearchMatchCount = useMemo(() => {
    if (!calendarSearchNeedle || portal !== "manager" || !userId) return 0;
    void calendarRefreshSignal;
    void workOrderTick;
    const tourFilter = calendarScheduledTourFilter ?? {
      viewerUserId: userId,
      propertyId: null,
      propertyIds: scopedCalendarPropertyIds,
      peers: [],
    };
    const viewFilter = scheduledMeetingViewFilter;
    const planned = meetingsInWeek(
      buildScheduledTourMeetings(tourFilter, storageKey),
      calendarAnchorDate,
    ).filter((meeting) => {
      if (viewFilter && !viewFilter(meeting)) return false;
      return calendarMeetingMatchesQuery(meeting, calendarSearchNeedle);
    });
    return planned.length + meetingsInWeek(mergedExternalMeetings, calendarAnchorDate).length;
  }, [
    calendarSearchNeedle,
    portal,
    userId,
    calendarRefreshSignal,
    workOrderTick,
    calendarScheduledTourFilter,
    scopedCalendarPropertyIds,
    storageKey,
    calendarAnchorDate,
    scheduledMeetingViewFilter,
    mergedExternalMeetings,
  ]);

  // Stage B (kind-scoped availability, PLAN-0914-1710): Services and Tasks now
  // edit their own kind directly through `availabilityKeysByKind` below, so no
  // Calendar view forces the panel read-only anymore.
  const calendarPanelsReadOnly = false;
  const calendarStorageKey =
    availabilityView && activeCalendarPropertyFilters.length === 1 ? storageKey : null;
  const calendarUnavailableMessage = servicesOnlyView
    ? "No scheduled service visits yet. Vendor visits and your own assigned work appear here once a visit time is set."
    : tasksOnlyView
      ? "No tasks with a due time yet. Give a task a due date and time and it appears here."
      : "Add a property before setting tour availability.";

  /** Manager-only per-kind services/tasks keys — tours keeps its existing per-house storage. */
  const managerKindKeys = useMemo(() => {
    if (portal !== "manager" || !userId) return null;
    return {
      services: [managerKindAvailabilityStorageKey(userId, "services")],
      tasks: [managerKindAvailabilityStorageKey(userId, "tasks")],
    };
  }, [portal, userId]);

  /**
   * Which kind(s) `PortalCalendarPanels` reads/writes for the current view.
   * Absent for admin (and whenever there is nothing manager-owned to key off
   * of) so it falls back to EXACTLY today's single-union behaviour there.
   */
  const availabilityKeysByKind = useMemo<Partial<Record<AvailabilityKind, string[]>> | undefined>(() => {
    if (portal !== "manager" || !userId || !managerKindKeys) return undefined;
    if (schedulingHub) {
      // The hub's Services tab renders its own read-only visits panel (below) —
      // this call site only ever reaches the Tours tab, so always tours-only.
      return availabilityStorageKeys.length > 0 ? { tours: availabilityStorageKeys } : undefined;
    }
    if (calendarView === "services") return { services: managerKindKeys.services };
    if (calendarView === "tasks") return { tasks: managerKindKeys.tasks };
    if (calendarView === "tours") {
      return availabilityStorageKeys.length > 0 ? { tours: availabilityStorageKeys } : undefined;
    }
    // "all"
    return {
      ...(availabilityStorageKeys.length > 0 ? { tours: availabilityStorageKeys } : {}),
      services: managerKindKeys.services,
      tasks: managerKindKeys.tasks,
    };
  }, [portal, userId, managerKindKeys, schedulingHub, calendarView, availabilityStorageKeys]);

  const editKind: AvailabilityKind = defaultAvailabilityKindForCalendarView(schedulingHub ? "all" : calendarView);

  /** Services/Tasks tabs are now directly editable (Stage B), so the empty state must not block "Add availability". */
  const canEditKindAvailability = portal === "manager" && Boolean(userId);


  const calendarFilterSheet =
    portal === "manager" ? (
      <PortalFilterSortSheet
        activeCount={portalFilterActiveCount([activeCalendarPropertyFilters])}
        compactPanel
        commandStripTrigger
        dropdownAlign="start"
        filterFieldCount={1}
        mobileFlushBody
        onReset={() => setCalendarPropertyFilters([])}
        dataAttr="calendar-filter-sheet-open"
      >
        <ApplicationFilterSortFields
          propertyOptions={managerPropertyFilterOptions}
          propertyFilters={activeCalendarPropertyFilters}
          onPropertyFiltersChange={setCalendarPropertyFilters}
          dataAttr="calendar-filter-property"
        />
      </PortalFilterSortSheet>
    ) : null;

  const calendarGoogleCalendarButton =
    portal === "manager" ? (
      <GoogleCalendarConnectDialog onConnectionChange={() => setGoogleCalendarTick((n) => n + 1)} />
    ) : null;

  const calendarShareTourButton =
    portal === "manager" && schedulingHub && availabilityView ? (
      <PortalIconAction
        icon={Share2}
        label={shareableProperties.length === 0 ? "Share tour links (list a property first)" : "Share tour links"}
        disabled={shareableProperties.length === 0}
        data-attr="calendar-share-tour"
        onClick={() => setShareTourModalOpen(true)}
      />
    ) : null;

  /*
    No Settings here. The panel behind it is entirely TOUR rules — notice
    required, auto-confirm, tour reminders — and the Tours section already owns
    them. On the Calendar it read as "calendar settings" and opened something
    else, which is worse than not offering it.
  */
  const calendarSettingsButton = null;

  const calendarCommandActions =
    portal === "manager" ? (
      <>
        {calendarFilterSheet}
        {calendarSettingsButton}
        {calendarGoogleCalendarButton}
        {calendarShareTourButton}
        <div ref={setWeekActionsHost} className="flex items-center" data-slot="calendar-week-actions-host" />
      </>
    ) : null;

  const pageTitle =
    portal === "manager" ? (schedulingHub ? "Tours" : "Calendar") : "Schedule meeting";

  if (portal === "manager" && !authReady) {
    return (
      <ManagerPortalPageShell
        title={pageTitle}

      >
        <p className="text-sm text-muted">{propertiesLoading ? "Loading houses…" : "Loading calendar…"}</p>
      </ManagerPortalPageShell>
    );
  }
  if (portal === "manager" && !userId) {
    return (
      <ManagerPortalPageShell
        title={pageTitle}

      >
        <p className="text-sm text-muted">Sign in to manage your availability.</p>
      </ManagerPortalPageShell>
    );
  }

  return (
    <>
      <ManagerPortalPageShell
        title={pageTitle}
        hideTitleOnMobileNav
        titleInlineFilter={null}
        compactFilterRow={portal === "manager"}
      >
        {portal === "manager" ? (
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
            activeDestinationId={schedulingHub ? toursHubTab : calendarView}
            destinationAriaLabel={schedulingHub ? "Tours views" : "Calendar views"}
            search={{
              value: listSearch,
              onChange: setListSearch,
              placeholder: schedulingHub ? "Search tours" : "Search calendar",
              dataAttr: schedulingHub ? "tours-hub-search" : "manager-calendar-search",
            }}
            actions={calendarCommandActions}
          />
        ) : null}
        {portal === "manager" ? (
          <div className="portal-calendar-page-body mt-1 flex min-h-[min(72vh,52rem)] flex-1 flex-col bg-accent/30">
            {portal === "manager" && calendarSearchNeedle && calendarSearchMatchCount === 0 && !propertiesLoading ? (
              <div className="pt-2">
                <PortalListEmptyCard
                  section="calendar"
                  tone="muted"
                  title={portalEmptyNoMatchTitle("events", listSearch)}
                  clear={{
                    label: "Clear search",
                    onClick: () => setListSearch(""),
                    dataAttr: "calendar-empty-clear-search",
                  }}
                  dataAttr="calendar-empty-search"
                />
              </div>
            ) : !schedulingHub &&
            (servicesOnlyView || tasksOnlyView) &&
            calendarTabCounts[calendarView] === 0 &&
            !propertiesLoading &&
            !canEditKindAvailability ? (
              <div className="pt-2">
                <PortalListEmptyCard
                  section="calendar"
                  title={portalEmptyCopy(`calendar.${calendarView}` as PortalEmptyCopyKey).title}
                  sibling={portalEmptySibling(calendarTabs, calendarView)}
                  dataAttr="calendar-empty"
                />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                {showCoManagerCoordination && availabilityView ? (
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={shareAvailability}
                      onChange={(e) => setShareAvailabilityPreference(e.target.checked)}
                    />
                    <span>
                      <span className="font-semibold text-foreground">Share availability with co-managers</span>
                      <span className="mt-0.5 block text-xs text-muted">
                        Linked managers on this house can see when you are open for tours. You only see their
                        availability when they opt in too.
                      </span>
                    </span>
                  </label>
                ) : null}
                {propertiesLoading && managerProperties.length === 0 ? (
                  <p className="text-sm text-muted">Loading houses from the backend…</p>
                ) : (
                  <PortalCalendarPanels
                    key={`${calendarStorageKey ?? "calendar-unavailable"}-avail-${scopedCalendarPropertyIds.join(",")}-${schedulingHub ? toursHubTab : calendarView}`}
            storageKey={calendarStorageKey}
            availabilityStorageKeys={
              availabilityView && availabilityStorageKeys.length > 0 ? availabilityStorageKeys : undefined
            }
            availabilityKeysByKind={portal === "manager" ? availabilityKeysByKind : undefined}
            editKind={editKind}
            calendarRefreshSignal={calendarRefreshSignal}
            tourScopeLabel={tourScopeLabel}
            bareSurface
            unavailableMessage={
              portal === "manager" && managerProperties.length === 0
                ? "No houses found for this manager account yet."
                : calendarUnavailableMessage
            }
            compactAvailability
            weekActionsHost={weekActionsHost}
            availabilityHeading={
              portal === "manager"
                ? schedulingHub && availabilityView
                  ? "Tour availability"
                  : schedulingHub
                    ? "Tour schedule"
                    : "Schedule"
                : "Schedule meeting"
            }
            defaultTourAvailability={portal === "manager" ? NO_DEFAULT_TOUR_AVAILABILITY : undefined}
            scheduledTourFilter={
              (availabilityView || tasksOnlyView) && calendarScheduledTourFilter ? calendarScheduledTourFilter : undefined
            }
            scheduledMeetingFilter={scheduledMeetingFilter}
            coManagerAvailabilityOverlays={showCoManagerCoordination ? coManagerAvailabilityOverlays : undefined}
            externalMeetings={portal === "manager" ? mergedExternalMeetings : undefined}
            onGoogleCalendarRefresh={() => setGoogleCalendarTick((n) => n + 1)}
            // Recompute the view-tab counts as soon as a tour is confirmed,
            // rescheduled, cancelled or deleted, instead of at the next reload.
            onMeetingsChanged={() => setCalendarRefreshSignal((n) => n + 1)}
            readOnly={portal === "manager" ? calendarPanelsReadOnly : false}
            eventSummaryLabel={schedulingHub && servicesOnlyView ? "visit" : schedulingHub ? "tour" : "event"}
            preferEventCountsInDayHeader
            anchorDate={calendarAnchorDate}
            onAnchorDateChange={setCalendarAnchorDate}
            flowScroll
            otherProperties={portal === "manager" ? copyDestinationHouses : undefined}
            onCopyWeekToHouses={
              portal === "manager" &&
              userId &&
              availabilityCopySourcePropertyId &&
              availabilityView &&
              !servicesOnlyView
                ? (propertyIds, weekDateStrs, scope) => {
                    if (!userId || scopedCalendarPropertyIds.length === 0) return;
                    const srcSlots = new Set<string>();
                    for (const propertyId of scopedCalendarPropertyIds) {
                      const key = managerPropertyAvailabilityStorageKey(userId, propertyId);
                      for (const slot of readAvailabilityDateSetForStorageKey(key)) {
                        srcSlots.add(slot);
                      }
                    }
                    const weekStrs = new Set(weekDateStrs);
                    const slotsToCopy =
                      scope === "entire"
                        ? [...srcSlots]
                        : [...srcSlots].filter((key) => weekStrs.has(key.split(":")[0] ?? ""));
                    void Promise.all(
                      propertyIds.map((pid) => {
                        const dstKey = managerPropertyAvailabilityStorageKey(userId, pid);
                        const dstSlots = new Set(readAvailabilityDateSetForStorageKey(dstKey));
                        for (const slot of slotsToCopy) dstSlots.add(slot);
                        return writeAvailabilityDateSetForStorageKeyToServer(dstSlots, dstKey);
                      }),
                    )
                      .then((results) => {
                        if (results.some((ok) => !ok)) showToast("Could not save every house schedule to backend.");
                        return syncScheduleRecordsFromServer({ force: true });
                      })
                      .finally(() => setCalendarRefreshSignal((n) => n + 1));
                    const destNames = propertyIds
                      .map((id) => managerProperties.find((p) => p.id === id)?.name ?? id)
                      .join(", ");
                    showToast(
                      scope === "entire"
                        ? `Full schedule copied to: ${destNames}.`
                        : `This week's schedule copied to: ${destNames}.`,
                    );
                  }
                : undefined
            }
                  />
                )}
              </div>
            )}
          </div>
        ) : (
          <PortalCalendarPanels
            key={storageKey ?? "calendar-unavailable"}
            storageKey={storageKey}
            calendarRefreshSignal={calendarRefreshSignal}
            availabilityHeading="Schedule meeting"
            compactAvailability
          />
        )}
      </ManagerPortalPageShell>
      {portal === "manager" ? (
        <ShareLeadLinkModal
          open={shareTourModalOpen}
          onClose={() => setShareTourModalOpen(false)}
          kind="tour"
          properties={shareableProperties}
          preselectedPropertyId={soleCalendarPropertyId || undefined}
        />
      ) : null}
    </>
  );
}
