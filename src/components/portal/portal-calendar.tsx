"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_ACTION_BTN,
} from "./portal-metrics";
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
import { TourProposalsPanel } from "@/components/portal/tour-proposals-panel";
import { ManagerPortfolioBookingsCalendar } from "@/components/portal/manager-portfolio-bookings-calendar";
import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { CalendarSectionShell } from "@/components/portal/calendar-section-shell";
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
  meetingsInWeek,
} from "@/lib/manager-calendar-tour-meetings";
import {
  calendarViewHref,
  parseCalendarViewTab,
  type CalendarViewTabId,
} from "@/lib/portal-detail-routes";

const MANAGER_PORTAL_BASE = "/portal";

export function PortalCalendar({
  portal,
  initialUserId,
  initialEmail,
  calendarView: calendarViewProp,
}: {
  portal: "manager" | "admin";
  initialUserId?: string | null;
  initialEmail?: string | null;
  /** Routed view tab (manager portal only). */
  calendarView?: CalendarViewTabId;
}) {
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
  const calendarView = portal === "manager" ? parseCalendarViewTab(calendarViewProp) : "tours";
  const [workOrderTick, setWorkOrderTick] = useState(0);
  const [calendarAnchorDate, setCalendarAnchorDate] = useState(() => new Date());


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

  const soleCalendarPropertyId = calendarEditingPropertyId;

  const availabilityStorageKeys = useMemo(() => {
    if (portal !== "manager" || !userId || activeCalendarPropertyFilters.length === 0) return [];
    return activeCalendarPropertyFilters.map((id) => managerPropertyAvailabilityStorageKey(userId, id));
  }, [portal, userId, activeCalendarPropertyFilters]);

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

  const [bookingsRefreshSignal, setBookingsRefreshSignal] = useState(0);
  const [linkAirbnbModalOpen, setLinkAirbnbModalOpen] = useState(false);

  const calendarTabCounts = useMemo(() => {
    if (portal !== "manager" || !userId) {
      return { tours: 0, bookings: 0, services: serviceCalendarMeetings.length };
    }
    void calendarRefreshSignal;
    void workOrderTick;
    void bookingsRefreshSignal;
    const tourFilter = calendarScheduledTourFilter ?? {
      viewerUserId: userId,
      propertyId: null,
      propertyIds: scopedCalendarPropertyIds,
      peers: [],
    };
    const tourMeetings = meetingsInWeek(
      buildScheduledTourMeetings(tourFilter, storageKey),
      calendarAnchorDate,
    );
    const servicesInWeek = meetingsInWeek(serviceCalendarMeetings, calendarAnchorDate);
    return { tours: tourMeetings.length, bookings: 0, services: servicesInWeek.length };
  }, [
    portal,
    userId,
    calendarScheduledTourFilter,
    storageKey,
    calendarRefreshSignal,
    workOrderTick,
    bookingsRefreshSignal,
    calendarAnchorDate,
    serviceCalendarMeetings,
    scopedCalendarPropertyIds,
  ]);

  const calendarTabs = useMemo(
    () => [
      {
        id: "tours" as const,
        label: "Tours",
        count: calendarTabCounts.tours,
        href: calendarViewHref(MANAGER_PORTAL_BASE, "tours"),
        dataAttr: "calendar-tab-tours",
      },
      {
        id: "bookings" as const,
        label: "Bookings",
        count: calendarTabCounts.bookings,
        href: calendarViewHref(MANAGER_PORTAL_BASE, "bookings"),
        dataAttr: "calendar-tab-bookings",
      },
      {
        id: "services" as const,
        label: "Service orders",
        count: calendarTabCounts.services,
        href: calendarViewHref(MANAGER_PORTAL_BASE, "services"),
        dataAttr: "calendar-tab-services",
      },
    ],
    [calendarTabCounts],
  );

  const bookingsView = calendarView === "bookings";
  const showTourAvailability = calendarView === "tours";
  const showServiceVisits = calendarView === "services";
  const servicesOnlyView = calendarView === "services";

  const mergedExternalMeetings = useMemo(() => {
    const base = portal === "manager" ? [...googleExternalMeetings] : [];
    if (showServiceVisits) base.push(...serviceCalendarMeetings);
    return base;
  }, [portal, googleExternalMeetings, serviceCalendarMeetings, showServiceVisits]);

  const calendarPanelsReadOnly =
    servicesOnlyView ||
    bookingsView ||
    (showTourAvailability && activeCalendarPropertyFilters.length !== 1);
  const calendarStorageKey = showTourAvailability && !bookingsView ? storageKey : servicesOnlyView ? null : storageKey;
  const calendarUnavailableMessage = servicesOnlyView
    ? "No scheduled service visits yet. Vendor visits and your own assigned work appear here once a visit time is set."
    : bookingsView
      ? "No houses in your portfolio yet."
      : activeCalendarPropertyFilters.length !== 1 && showTourAvailability
        ? "Select one house in the filter to edit tour availability. Tours across your portfolio still appear below."
        : "Select one house before creating tour windows.";


  const calendarFilterSheet =
    portal === "manager" ? (
      <PortalFilterSortSheet
        activeCount={portalFilterActiveCount([activeCalendarPropertyFilters])}
        compactPanel
        filterFieldCount={1}
        constrainDropdownToTitleBand
        mobileFlushBody
        className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
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

  const calendarShareTourButton =
    portal === "manager" ? (
      <Button
        type="button"
        variant="outline"
        className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
        disabled={shareableProperties.length === 0 || calendarView === "services" || bookingsView}
        title={
          calendarView === "services" || bookingsView
            ? "Switch to Tours to share a tour link"
            : shareableProperties.length === 0
              ? "List a property as active before sharing tour links"
              : "Share tour links"
        }
        onClick={() => setShareTourModalOpen(true)}
      >
        Share tour
      </Button>
    ) : null;

  const calendarGoogleCalendarButton =
    portal === "manager" ? (
      <GoogleCalendarConnectDialog
        className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
        onConnectionChange={() => setGoogleCalendarTick((n) => n + 1)}
      />
    ) : null;

  const calendarLinkAirbnbButton =
    portal === "manager" && bookingsView ? (
      <Button
        type="button"
        variant="outline"
        className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
        disabled={managerPropertyFilterOptions.length === 0}
        data-attr="portfolio-bookings-link-airbnb"
        onClick={() => setLinkAirbnbModalOpen(true)}
      >
        Link Airbnb
      </Button>
    ) : null;

  const calendarHeaderActions =
    portal === "manager" ? (
      <>
        {calendarGoogleCalendarButton}
        {calendarLinkAirbnbButton}
        {calendarShareTourButton}
      </>
    ) : null;

  const pageTitle = portal === "manager" ? "Calendar" : "Schedule meeting";

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
        titleInlineFilter={portal === "manager" ? calendarFilterSheet : undefined}
        titleAside={calendarHeaderActions ?? undefined}
        compactFilterRow={portal === "manager"}
      >
        {portal === "manager" ? (
          <PortalListControlStack
            className="mb-2"
            destinations={calendarTabs}
            activeDestinationId={calendarView}
            destinationAriaLabel="Calendar views"
          />
        ) : null}
        {portal === "manager" ? (
          <div className="portal-calendar-page-body mt-1 flex min-h-[min(72vh,52rem)] flex-1 flex-col">
            {bookingsView ? (
              <ManagerPortfolioBookingsCalendar
                propertyIds={scopedCalendarPropertyIds}
                showToast={showToast}
                refreshSignal={bookingsRefreshSignal}
              />
            ) : servicesOnlyView ? (
              <CalendarSectionShell
                title="Service orders"
                description="Scheduled vendor visits and work you assigned to yourself."
              >
                {propertiesLoading && managerProperties.length === 0 ? (
                  <p className="text-sm text-muted">Loading houses from the backend…</p>
                ) : (
                  <PortalCalendarPanels
                    key={`services-${scopedCalendarPropertyIds.join(",")}`}
                    storageKey={null}
                    calendarRefreshSignal={calendarRefreshSignal}
                    tourScopeLabel={tourScopeLabel}
                    bareSurface
                    unavailableMessage={
                      managerProperties.length === 0
                        ? "No houses found for this manager account yet."
                        : calendarUnavailableMessage
                    }
                    compactAvailability
                    availabilityHeading="Your availability"
                    externalMeetings={mergedExternalMeetings}
                    onGoogleCalendarRefresh={() => setGoogleCalendarTick((n) => n + 1)}
                    onMeetingsChanged={() => setCalendarRefreshSignal((n) => n + 1)}
                    readOnly
                    eventSummaryLabel="visit"
                    preferEventCountsInDayHeader
                    anchorDate={calendarAnchorDate}
                    onAnchorDateChange={setCalendarAnchorDate}
                    flowScroll
                  />
                )}
              </CalendarSectionShell>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                {showCoManagerCoordination ? (
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
                <TourProposalsPanel />
                {propertiesLoading && managerProperties.length === 0 ? (
                  <p className="text-sm text-muted">Loading houses from the backend…</p>
                ) : (
                  <PortalCalendarPanels
                    key={`${calendarStorageKey ?? "calendar-unavailable"}-tours-${scopedCalendarPropertyIds.join(",")}`}
            storageKey={calendarStorageKey}
            availabilityStorageKeys={
              availabilityStorageKeys.length > 1 ? availabilityStorageKeys : undefined
            }
            calendarRefreshSignal={calendarRefreshSignal}
            tourScopeLabel={tourScopeLabel}
            bareSurface
            unavailableMessage={
              portal === "manager" && managerProperties.length === 0
                ? "No houses found for this manager account yet."
                : calendarUnavailableMessage
            }
            compactAvailability
            availabilityHeading={portal === "manager" ? "Your availability" : "Schedule meeting"}
            scheduledTourFilter={
              calendarScheduledTourFilter && showTourAvailability ? calendarScheduledTourFilter : undefined
            }
            coManagerAvailabilityOverlays={showCoManagerCoordination ? coManagerAvailabilityOverlays : undefined}
            externalMeetings={portal === "manager" ? mergedExternalMeetings : undefined}
            onGoogleCalendarRefresh={() => setGoogleCalendarTick((n) => n + 1)}
            // Recompute the view-tab counts as soon as a tour is confirmed,
            // rescheduled, cancelled or deleted, instead of at the next reload.
            onMeetingsChanged={() => setCalendarRefreshSignal((n) => n + 1)}
            readOnly={portal === "manager" ? calendarPanelsReadOnly : false}
            eventSummaryLabel="tour"
            preferEventCountsInDayHeader
            anchorDate={calendarAnchorDate}
            onAnchorDateChange={setCalendarAnchorDate}
            flowScroll
            otherProperties={
              portal === "manager" && calendarEditingPropertyId
                ? managerProperties.filter((p) => {
                    if (p.id === calendarEditingPropertyId) return false;
                    if (activeCalendarPropertyFilters.length > 1) {
                      return activeCalendarPropertyFilters.includes(p.id);
                    }
                    return true;
                  })
                : undefined
            }
            onCopyWeekToHouses={
              portal === "manager" && userId && calendarEditingPropertyId
                ? (propertyIds, weekDateStrs, scope) => {
                    if (!userId || !calendarEditingPropertyId) return;
                    const srcKey = managerPropertyAvailabilityStorageKey(userId, calendarEditingPropertyId);
                    const srcSlots = readAvailabilityDateSetForStorageKey(srcKey);
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
      {portal === "manager" ? (
        <ChannelCalendarLinkModal
          open={linkAirbnbModalOpen}
          onClose={() => setLinkAirbnbModalOpen(false)}
          propertyIds={scopedCalendarPropertyIds}
          propertyOptions={managerPropertyFilterOptions}
          initialPropertyId={
            activeCalendarPropertyFilters.length === 1 ? activeCalendarPropertyFilters[0] : undefined
          }
          showToast={showToast}
          onChanged={() => setBookingsRefreshSignal((n) => n + 1)}
        />
      ) : null}
    </>
  );
}
