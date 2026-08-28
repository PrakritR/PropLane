"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { ManagerAddScheduledTourModal } from "@/components/portal/manager-add-scheduled-tour-modal";
import { ManagerToursGroupedTable } from "@/components/portal/manager-tours-grouped-table";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Input } from "@/components/ui/input";
import { DestinationNav } from "@/components/ui/destination-nav";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import {
  PortalNotificationPreviewModal,
  type NotificationConfirmDraft,
} from "@/components/portal/portal-notification-preview-modal";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { TourProposalsPanel } from "@/components/portal/tour-proposals-panel";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import {
  acceptPartnerInquiryFromServer,
  deletePartnerInquiryFromServer,
  syncScheduleRecordsFromServer,
} from "@/lib/demo-admin-scheduling";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  buildManagerTourRows,
  clusterManagerTourListRows,
  countManagerTourRowsByBucket,
  filterManagerTourRows,
  sortManagerTourClustersForBucket,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  MANAGER_TOUR_BUCKET_LABELS,
  MANAGER_TOUR_BUCKETS,
  managerTourDetailHref,
  managerTourListHref,
  type ManagerTourBucketId,
} from "@/lib/portal-detail-routes";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForTour,
} from "@/lib/manager-scheduled-work-tasks";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  cancelPlannedTourFromServer,
  proposePendingTourRescheduleFromServer,
  reschedulePlannedTourFromServer,
} from "@/lib/tour-planned-change.client";
import {
  TOUR_CANCELED_TENANT_SUBJECT,
  TOUR_CONFIRMED_TENANT_SUBJECT,
  TOUR_REQUEST_REMOVED_TENANT_SUBJECT,
  TOUR_RESCHEDULED_TENANT_SUBJECT,
  buildTourCanceledTenantBody,
  buildTourConfirmedTenantBody,
  buildTourNotificationContext,
  buildTourRequestRemovedTenantBody,
  buildTourRescheduleConfirmRequestBody,
  buildTourRescheduledTenantBody,
} from "@/lib/tour-notifications";

const TOUR_BUCKET_LABELS = MANAGER_TOUR_BUCKETS.map((id) => ({
  id,
  label: MANAGER_TOUR_BUCKET_LABELS[id],
}));

const BULK_BAR_BTN = "h-9 min-h-0 shrink-0 whitespace-nowrap rounded-full px-3 text-[13px] sm:h-10 sm:px-4 sm:text-sm";

function isPendingInquiry(row: ManagerTourRow): boolean {
  return row.bucket === "pending" && row.source === "inquiry";
}

function isUpcomingPlanned(row: ManagerTourRow): boolean {
  return row.bucket === "upcoming" && row.source === "planned";
}

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function tourEndIsoFromStart(startIso: string, row: ManagerTourRow): string {
  const durationMs = Math.max(30 * 60 * 1000, Date.parse(row.endIso) - Date.parse(row.startIso));
  return new Date(Date.parse(startIso) + durationMs).toISOString();
}

type TourRescheduleTimes = {
  newStartIso: string;
  newEndIso: string;
  previousStartIso: string;
  previousEndIso: string;
};

type TourNotifyAction = "confirm" | "decline" | "cancel" | "reschedule";

type TourNotifyPreview = {
  action: TourNotifyAction;
  rows: ManagerTourRow[];
  subject: string;
  body: string;
  rowTimes?: Record<string, TourRescheduleTimes>;
};

type GuestMessagePreview = {
  email: string;
  phone?: string;
};

const TOUR_NOTIFY_PREVIEW_COPY: Record<
  TourNotifyAction,
  {
    title: string;
    intro: string;
    skipMessageLabel: string;
    confirmLabel: string;
    confirmLabelWithoutMessage: string;
    confirmBusyLabel: string;
  }
> = {
  confirm: {
    title: "Confirm tour",
    intro: "Confirming schedules the tour and sends this message to the guest.",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Confirm tour & send notification",
    confirmLabelWithoutMessage: "Confirm tour only",
    confirmBusyLabel: "Confirming…",
  },
  decline: {
    title: "Decline tour",
    intro: "Declining removes this tour request and sends this message to the guest.",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Decline & send notification",
    confirmLabelWithoutMessage: "Decline only",
    confirmBusyLabel: "Declining…",
  },
  cancel: {
    title: "Cancel tour",
    intro: "Cancelling removes this tour and sends this message to the guest.",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Cancel tour & send notification",
    confirmLabelWithoutMessage: "Cancel tour only",
    confirmBusyLabel: "Cancelling…",
  },
  reschedule: {
    title: "Reschedule tour",
    intro: "Review the notification below. The guest will be asked to confirm the new time.",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Send & ask guest to confirm",
    confirmLabelWithoutMessage: "Update time without messaging",
    confirmBusyLabel: "Sending…",
  },
};

function buildTourNotifyContext(row: ManagerTourRow) {
  const property = row.propertyId ? getPropertyById(row.propertyId) : undefined;
  return buildTourNotificationContext({
    origin: typeof window !== "undefined" ? window.location.origin : "",
    guestName: row.guestName,
    guestEmail: row.guestEmail,
    guestPhone: row.guestPhone || null,
    propertyId: row.propertyId || null,
    propertyTitle: row.propertyTitle || property?.title || "Property",
    propertyAddress: property?.address || null,
    roomLabel: row.roomLabel || null,
    tourStartIso: row.startIso,
    tourEndIso: row.endIso,
    notes: row.notes || null,
    managerLabel: "Property Manager",
    tourInquiryId: row.source === "inquiry" ? row.sourceId : null,
  });
}

export function ManagerTours({
  bucket = "pending",
  basePath = "/portal",
  tourId: tourIdProp,
}: {
  bucket?: ManagerTourBucketId;
  basePath?: string;
  tourId?: string;
}) {
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId: userId });
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [shareTourOpen, setShareTourOpen] = useState(false);
  const [addTourOpen, setAddTourOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [notifyPreview, setNotifyPreview] = useState<TourNotifyPreview | null>(null);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [guestMessagePreview, setGuestMessagePreview] = useState<GuestMessagePreview | null>(null);
  const [guestMessageBusy, setGuestMessageBusy] = useState(false);
  const [rescheduleTimePicker, setRescheduleTimePicker] = useState<{
    rows: ManagerTourRow[];
    startLocals: Record<string, string>;
  } | null>(null);

  const refresh = useCallback(async () => {
    await syncScheduleRecordsFromServer({ force: true });
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!authReady || !userId) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
    void refresh();
  }, [authReady, userId, refresh]);

  useEffect(() => {
    const onStorage = () => setTick((n) => n + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [bucket]);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, propertyTick],
  );

  const propertyLabelById = useMemo(
    () => new Map(propertyOptions.map((option) => [option.id, option.label])),
    [propertyOptions],
  );

  const allRows = useMemo(() => {
    void tick;
    if (!userId) return [];
    return buildManagerTourRows({
      viewerUserId: userId,
      propertyIds: propertyOptions.map((option) => option.id),
    });
  }, [tick, userId, propertyOptions]);

  const counts = useMemo(() => countManagerTourRowsByBucket(allRows), [allRows]);

  const rowsForBucket = useMemo(
    () => filterManagerTourRows(allRows, bucket, propertyFilters, searchQuery),
    [allRows, bucket, propertyFilters, searchQuery],
  );

  const clusters = useMemo(
    () =>
      sortManagerTourClustersForBucket(clusterManagerTourListRows(rowsForBucket), bucket),
    [rowsForBucket, bucket],
  );

  const selectedRows = useMemo(
    () => rowsForBucket.filter((row) => selectedIds.has(row.id)),
    [rowsForBucket, selectedIds],
  );
  const singleSelectedRow = selectedRows.length === 1 ? selectedRows[0]! : null;

  const detailRow = useMemo(() => {
    if (!tourIdProp) return null;
    const decoded = decodeURIComponent(tourIdProp);
    return rowsForBucket.find((row) => row.id === decoded) ?? allRows.find((row) => row.id === decoded) ?? null;
  }, [allRows, rowsForBucket, tourIdProp]);

  const tabs = useMemo(
    () =>
      TOUR_BUCKET_LABELS.map(({ id, label }) => ({
        id,
        label,
        count: counts[id],
        alert: id === "pending" && counts.pending > 0,
      })),
    [counts],
  );

  const filterTouchCount = propertyFilters.length > 0 ? 1 : 0;

  const filterSheet = (
    <PortalFilterSortSheet
      activeCount={filterTouchCount}
      compactPanel
      filterFieldCount={1}
      mobileFlushBody
      constrainDropdownToTitleBand
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => setPropertyFilters([])}
      dataAttr="tours-filter-sheet-open"
    >
      <ApplicationFilterSortFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        dataAttr="tours-filter-property"
      />
    </PortalFilterSortSheet>
  );

  const activeFilterChips =
    propertyFilters.length > 0 ? (
      <PortalActiveFilterChips
        chips={[
          {
            id: "property",
            label:
              propertyFilters.length === 1
                ? `Property: ${propertyLabelById.get(propertyFilters[0]!) ?? propertyFilters[0]}`
                : `${propertyFilters.length} properties`,
            onRemove: () => setPropertyFilters([]),
          },
        ]}
      />
    ) : null;

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openTourDetail = useCallback(
    (row: ManagerTourRow) => {
      navigate(managerTourDetailHref(basePath, bucket, row.id));
    },
    [basePath, bucket, navigate],
  );

  const openApprovePreview = useCallback((rows: ManagerTourRow[]) => {
    const eligible = rows.filter(isPendingInquiry);
    if (eligible.length === 0) return;
    const row = eligible[0]!;
    const ctx = buildTourNotifyContext(row);
    setNotifyPreview({
      action: "confirm",
      rows: eligible,
      subject: TOUR_CONFIRMED_TENANT_SUBJECT,
      body: buildTourConfirmedTenantBody(ctx),
    });
  }, []);

  const openDeclinePreview = useCallback((rows: ManagerTourRow[]) => {
    const eligible = rows.filter(isPendingInquiry);
    if (eligible.length === 0) return;
    const row = eligible[0]!;
    const ctx = buildTourNotifyContext(row);
    setNotifyPreview({
      action: "decline",
      rows: eligible,
      subject: TOUR_REQUEST_REMOVED_TENANT_SUBJECT,
      body: buildTourRequestRemovedTenantBody(ctx),
    });
  }, []);

  const openCancelPreview = useCallback((rows: ManagerTourRow[]) => {
    const eligible = rows.filter(isUpcomingPlanned);
    if (eligible.length === 0) return;
    const row = eligible[0]!;
    const ctx = buildTourNotifyContext(row);
    setNotifyPreview({
      action: "cancel",
      rows: eligible,
      subject: TOUR_CANCELED_TENANT_SUBJECT,
      body: buildTourCanceledTenantBody(ctx),
    });
  }, []);

  const openDeletePreview = useCallback(
    (rows: ManagerTourRow[]) => {
      if (rows.length === 0) return;
      if (rows.every(isPendingInquiry)) {
        openDeclinePreview(rows);
        return;
      }
      if (rows.every(isUpcomingPlanned)) {
        openCancelPreview(rows);
        return;
      }
      showToast("These tours can't be deleted together.");
    },
    [openCancelPreview, openDeclinePreview, showToast],
  );

  const openReschedulePreview = useCallback(
    (rows: ManagerTourRow[]) => {
      if (rows.length === 0) return;
      if (!rows.every((row) => isPendingInquiry(row) || isUpcomingPlanned(row))) {
        showToast("These tours can't be rescheduled from here.");
        return;
      }
      const hasPending = rows.some(isPendingInquiry);
      const hasUpcoming = rows.some(isUpcomingPlanned);
      if (hasPending && hasUpcoming) {
        showToast("Select only pending or only upcoming tours to reschedule together.");
        return;
      }
      const startLocals: Record<string, string> = {};
      for (const row of rows) {
        startLocals[row.id] = isoToDatetimeLocal(row.startIso);
      }
      setRescheduleTimePicker({ rows, startLocals });
    },
    [showToast],
  );

  const buildRescheduleNotifyContext = useCallback((row: ManagerTourRow, times: TourRescheduleTimes) => {
    const property = row.propertyId ? getPropertyById(row.propertyId) : undefined;
    return buildTourNotificationContext({
      origin: typeof window !== "undefined" ? window.location.origin : "",
      guestName: row.guestName,
      guestEmail: row.guestEmail,
      guestPhone: row.guestPhone || null,
      propertyId: row.propertyId || null,
      propertyTitle: row.propertyTitle || property?.title || "Property",
      propertyAddress: property?.address || null,
      roomLabel: row.roomLabel || null,
      tourStartIso: times.newStartIso,
      tourEndIso: times.newEndIso,
      notes: row.notes || null,
      managerLabel: "Property Manager",
      tourInquiryId: row.source === "inquiry" ? row.sourceId : null,
    });
  }, []);

  const continueRescheduleFromPicker = useCallback(() => {
    if (!rescheduleTimePicker) return;
    const rowTimes: Record<string, TourRescheduleTimes> = {};
    for (const row of rescheduleTimePicker.rows) {
      const newStartIso = datetimeLocalToIso(rescheduleTimePicker.startLocals[row.id] ?? "");
      if (!newStartIso) {
        showToast(`Pick a valid new time for ${row.guestName}.`);
        return;
      }
      rowTimes[row.id] = {
        newStartIso,
        newEndIso: tourEndIsoFromStart(newStartIso, row),
        previousStartIso: row.startIso,
        previousEndIso: row.endIso,
      };
    }
    const previewRow = rescheduleTimePicker.rows[0]!;
    const times = rowTimes[previewRow.id]!;
    const previous = { startIso: times.previousStartIso, endIso: times.previousEndIso };
    const ctx = buildRescheduleNotifyContext(previewRow, times);
    const body = isPendingInquiry(previewRow)
      ? buildTourRescheduleConfirmRequestBody(ctx, previous)
      : buildTourRescheduledTenantBody(ctx, previous);
    setRescheduleTimePicker(null);
    setNotifyPreview({
      action: "reschedule",
      rows: rescheduleTimePicker.rows,
      subject: TOUR_RESCHEDULED_TENANT_SUBJECT,
      body,
      rowTimes,
    });
  }, [buildRescheduleNotifyContext, rescheduleTimePicker, showToast]);

  const openGuestMessage = useCallback(
    (row: ManagerTourRow) => {
      const email = row.guestEmail?.trim() ?? "";
      if (!email.includes("@")) {
        showToast("No guest email on this tour.");
        return;
      }
      setGuestMessagePreview({
        email,
        phone: row.guestPhone?.trim() || undefined,
      });
    },
    [showToast],
  );

  const submitNotifyPreview = useCallback(
    async (skipMessage: boolean, _channels?: unknown, draft?: NotificationConfirmDraft) => {
      if (!notifyPreview || notifyBusy) return;
      const preview = notifyPreview;
      setNotifyBusy(true);
      try {
        const subject = draft?.subject?.trim() || preview.subject;
        const body = draft?.body?.trim() || preview.body;

        if (preview.action === "confirm") {
          for (const row of preview.rows) {
            const result = await acceptPartnerInquiryFromServer(row.sourceId, {
              start: row.startIso,
              end: row.endIso,
              notifyTenant: !skipMessage,
              subject,
              body,
              assignee: draft?.assignee ?? undefined,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not confirm tour.");
              return;
            }
            if (userId) {
              void createScheduledWorkTask(userId, {
                title: scheduledTaskTitleForTour(row.guestName),
                start: row.startIso,
                end: row.endIso,
                propertyId: row.propertyId,
                propertyTitle: row.propertyTitle,
                roomLabel: row.roomLabel,
                assignee: draft?.assignee ?? undefined,
                notes: row.guestEmail ? `Guest: ${row.guestEmail}` : undefined,
              });
            }
          }
          setNotifyPreview(null);
          setSelectedIds(new Set());
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          const count = preview.rows.length;
          showToast(
            skipMessage
              ? count === 1
                ? "Tour confirmed."
                : `${count} tours confirmed.`
              : count === 1
                ? "Tour confirmed and guest notified."
                : `${count} tours confirmed and guests notified.`,
          );
          return;
        }

        if (preview.action === "decline") {
          for (const row of preview.rows) {
            const ok = await deletePartnerInquiryFromServer(row.sourceId, {
              notifyTenant: !skipMessage,
              subject,
              body,
            });
            if (!ok) {
              showToast("Could not decline tour request.");
              return;
            }
          }
          setNotifyPreview(null);
          setSelectedIds(new Set());
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          const count = preview.rows.length;
          showToast(
            skipMessage
              ? count === 1
                ? "Tour request declined."
                : `${count} tour requests declined.`
              : count === 1
                ? "Tour declined and guest notified."
                : `${count} tours declined and guests notified.`,
          );
          return;
        }

        if (preview.action === "cancel") {
          for (const row of preview.rows) {
            const result = await cancelPlannedTourFromServer({
              plannedEventId: row.sourceId,
              notifyGuest: !skipMessage,
              subject,
              body,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not cancel tour.");
              return;
            }
          }
          setNotifyPreview(null);
          setSelectedIds(new Set());
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          const count = preview.rows.length;
          showToast(
            skipMessage
              ? count === 1
                ? "Tour cancelled."
                : `${count} tours cancelled.`
              : count === 1
                ? "Tour cancelled and guest notified."
                : `${count} tours cancelled and guests notified.`,
          );
          return;
        }

        if (preview.action === "reschedule") {
          const useSharedDraft = preview.rows.length === 1;
          for (const row of preview.rows) {
            const times = preview.rowTimes?.[row.id];
            if (!times) continue;
            if (isUpcomingPlanned(row)) {
              const result = await reschedulePlannedTourFromServer({
                plannedEventId: row.sourceId,
                start: times.newStartIso,
                end: times.newEndIso,
                notifyGuest: !skipMessage,
              });
              if (!result.ok) {
                showToast(result.error ?? "Could not reschedule tour.");
                return;
              }
              continue;
            }
            if (isPendingInquiry(row)) {
              const previous = { startIso: times.previousStartIso, endIso: times.previousEndIso };
              const rowCtx = buildRescheduleNotifyContext(row, times);
              const rowBody = useSharedDraft
                ? body
                : buildTourRescheduleConfirmRequestBody(rowCtx, previous);
              const result = await proposePendingTourRescheduleFromServer({
                inquiryId: row.sourceId,
                previousStart: times.previousStartIso,
                previousEnd: times.previousEndIso,
                start: times.newStartIso,
                end: times.newEndIso,
                notifyGuest: !skipMessage,
                subject: useSharedDraft ? subject : TOUR_RESCHEDULED_TENANT_SUBJECT,
                body: rowBody,
              });
              if (!result.ok) {
                showToast(result.error ?? "Could not propose the new tour time.");
                return;
              }
            }
          }
          setNotifyPreview(null);
          setSelectedIds(new Set());
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          const count = preview.rows.length;
          showToast(
            skipMessage
              ? count === 1
                ? "Tour updated."
                : `${count} tours updated.`
              : count === 1
                ? "Reschedule notification sent."
                : `Reschedule notifications sent for ${count} tours.`,
          );
        }
      } finally {
        setNotifyBusy(false);
      }
    },
    [
      basePath,
      bucket,
      buildRescheduleNotifyContext,
      navigate,
      notifyBusy,
      notifyPreview,
      refresh,
      showToast,
      tourIdProp,
      userId,
    ],
  );

  const submitGuestMessage = useCallback(
    async (_skip: boolean, channels?: { viaEmail?: boolean; viaSms?: boolean }, draft?: NotificationConfirmDraft) => {
      if (!guestMessagePreview || guestMessageBusy) return;
      const subject = draft?.subject?.trim() ?? "";
      const body = draft?.body?.trim() ?? "";
      if (!subject || !body) {
        showToast("Subject and message are required.");
        return;
      }
      setGuestMessageBusy(true);
      try {
        const result = await deliverPortalInboxMessage({
          eventCategory: "messages",
          fromName: "Property Manager",
          toEmails: [guestMessagePreview.email],
          subject,
          text: body,
          deliverViaEmail: channels?.viaEmail !== false,
          deliverViaSms: channels?.viaSms === true,
        });
        if (!result.ok) {
          showToast(result.error ?? "Message could not be sent.");
          return;
        }
        setGuestMessagePreview(null);
        showToast(result.skipped ? "Message saved to PropLane inbox." : "Message sent.");
      } finally {
        setGuestMessageBusy(false);
      }
    },
    [guestMessageBusy, guestMessagePreview, showToast],
  );

  const renderGroupedTours = () => (
    <ManagerToursGroupedTable
      clusters={clusters}
      selectedIds={selectedIds}
      onToggleSelected={toggleSelected}
      onRowClick={openTourDetail}
    />
  );

  const renderDetailPanel = (row: ManagerTourRow) => (
    <div className="space-y-4 px-3 py-2 text-sm sm:px-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-muted">Property</p>
          <p className="text-foreground">{row.propertyTitle}</p>
        </div>
        {row.roomLabel ? (
          <div>
            <p className="text-xs font-medium text-muted">Room</p>
            <p className="text-foreground">{row.roomLabel}</p>
          </div>
        ) : null}
        <div>
          <p className="text-xs font-medium text-muted">When</p>
          <p className="text-foreground">{row.whenLabel}</p>
        </div>
        {row.guestEmail ? (
          <div>
            <p className="text-xs font-medium text-muted">Email</p>
            <p className="truncate text-foreground">{row.guestEmail}</p>
          </div>
        ) : null}
        {row.guestPhone ? (
          <div>
            <p className="text-xs font-medium text-muted">Phone</p>
            <p className="text-foreground">{row.guestPhone}</p>
          </div>
        ) : null}
      </div>
      {row.notes ? (
        <div>
          <p className="text-xs font-medium text-muted">Notes</p>
          <p className="whitespace-pre-wrap leading-relaxed text-foreground/90">{row.notes}</p>
        </div>
      ) : null}
    </div>
  );

  const multiSelect = selectedRows.length > 1;
  const canBulkDecline = selectedRows.length > 0 && selectedRows.every(isPendingInquiry);
  const canBulkCancelPlanned = selectedRows.length > 0 && selectedRows.every(isUpcomingPlanned);
  const canBulkConfirm = canBulkDecline;
  const canBulkReschedule =
    selectedRows.length > 0 && selectedRows.every((row) => isPendingInquiry(row) || isUpcomingPlanned(row));

  const renderBulkActions = () => (
    <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
      {!multiSelect && singleSelectedRow?.guestEmail?.includes("@") ? (
        <Button
          type="button"
          variant="outline"
          className={BULK_BAR_BTN}
          data-attr="tours-bulk-message"
          onClick={() => openGuestMessage(singleSelectedRow)}
        >
          Message
        </Button>
      ) : null}
      {canBulkDecline || canBulkCancelPlanned ? (
        <Button
          type="button"
          variant="outline"
          className={`${BULK_BAR_BTN} text-rose-800`}
          data-attr="tours-bulk-delete"
          onClick={() => openDeletePreview(selectedRows)}
        >
          {multiSelect ? "Cancel" : "Delete"}
        </Button>
      ) : null}
      {canBulkReschedule ? (
        <Button
          type="button"
          variant="outline"
          className={BULK_BAR_BTN}
          data-attr="tours-bulk-reschedule"
          onClick={() => openReschedulePreview(selectedRows)}
        >
          Reschedule
        </Button>
      ) : null}
      {canBulkConfirm ? (
        <Button
          type="button"
          variant="primary"
          className={BULK_BAR_BTN}
          data-attr="tours-bulk-approve"
          onClick={() => openApprovePreview(selectedRows)}
        >
          {multiSelect ? "Confirm" : "Approve"}
        </Button>
      ) : null}
    </div>
  );

  const bulkActionBar =
    selectedIds.size > 0 ? (
      <BulkActionBar
        count={selectedIds.size}
        countLabel={(n) => `${n} tour${n === 1 ? "" : "s"} selected`}
      >
        {renderBulkActions()}
      </BulkActionBar>
    ) : null;

  const detailActions = detailRow ? (
    <>
      {detailRow.guestEmail?.includes("@") ? (
        <Button
          type="button"
          variant="outline"
          className={BULK_BAR_BTN}
          data-attr="tour-detail-message"
          onClick={() => openGuestMessage(detailRow)}
        >
          Message
        </Button>
      ) : null}
      {(isPendingInquiry(detailRow) || isUpcomingPlanned(detailRow)) ? (
        <Button
          type="button"
          variant="outline"
          className={BULK_BAR_BTN}
          data-attr="tour-detail-reschedule"
          onClick={() => openReschedulePreview([detailRow])}
        >
          Reschedule
        </Button>
      ) : null}
      {detailRow.bucket === "pending" && detailRow.source === "inquiry" ? (
        <>
          <Button
            type="button"
            variant="outline"
            className={`${BULK_BAR_BTN} text-rose-800`}
            data-attr="tour-detail-decline"
            onClick={() => openDeclinePreview([detailRow])}
          >
            Decline
          </Button>
          <Button
            type="button"
            variant="primary"
            className={BULK_BAR_BTN}
            data-attr="tour-detail-approve"
            onClick={() => openApprovePreview([detailRow])}
          >
            Approve
          </Button>
        </>
      ) : null}
      {detailRow.bucket === "upcoming" && detailRow.source === "planned" ? (
        <Button
          type="button"
          variant="outline"
          className={`${BULK_BAR_BTN} text-rose-800`}
          data-attr="tour-detail-cancel"
          onClick={() => openCancelPreview([detailRow])}
        >
          Cancel tour
        </Button>
      ) : null}
    </>
  ) : null;

  const notifyPreviewRow = notifyPreview?.rows[0] ?? null;

  const modals = (
    <>
      {rescheduleTimePicker ? (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div
            className="modal-panel w-full max-w-md rounded-3xl border border-border bg-card p-5 shadow-2xl"
            role="dialog"
            aria-labelledby="tour-reschedule-time-title"
          >
            <h2 id="tour-reschedule-time-title" className="text-lg font-semibold text-foreground">
              {rescheduleTimePicker.rows.length === 1 ? "Pick a new tour time" : "Pick new tour times"}
            </h2>
            <p className="mt-1 text-sm text-muted">
              Choose the proposed time for each tour. You will review the guest notification next.
            </p>
            <div className="mt-4 max-h-[min(50vh,20rem)] space-y-4 overflow-y-auto">
              {rescheduleTimePicker.rows.map((row) => (
                <label key={row.id} className="block text-xs font-medium text-muted">
                  <span className="text-foreground">
                    {row.guestName} · {row.propertyTitle}
                  </span>
                  <span className="mt-0.5 block font-normal">Current: {row.whenLabel}</span>
                  <Input
                    type="datetime-local"
                    className="mt-1"
                    value={rescheduleTimePicker.startLocals[row.id] ?? ""}
                    onChange={(e) =>
                      setRescheduleTimePicker((prev) =>
                        prev
                          ? {
                              ...prev,
                              startLocals: { ...prev.startLocals, [row.id]: e.target.value },
                            }
                          : prev,
                      )
                    }
                    data-attr="tour-reschedule-datetime"
                  />
                </label>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" className={BULK_BAR_BTN} onClick={() => setRescheduleTimePicker(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                className={BULK_BAR_BTN}
                data-attr="tour-reschedule-continue"
                onClick={continueRescheduleFromPicker}
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {notifyPreview && notifyPreviewRow ? (
        <PortalNotificationPreviewModal
          open
          title={
            notifyPreview.rows.length > 1
              ? `${TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].title} (${notifyPreview.rows.length})`
              : TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].title
          }
          onClose={() => {
            if (notifyBusy) return;
            setNotifyPreview(null);
          }}
          recipient={notifyPreviewRow.guestEmail}
          recipientPhone={notifyPreviewRow.guestPhone?.trim() || undefined}
          subject={notifyPreview.subject}
          body={notifyPreview.body}
          intro={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].intro}
          skipMessageLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].skipMessageLabel}
          showChannelPicker
          emailAvailable={Boolean(notifyPreviewRow.guestEmail?.includes("@"))}
          smsAvailable={Boolean(notifyPreviewRow.guestPhone?.trim())}
          defaultViaSms={false}
          confirmLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmLabel}
          confirmLabelWithoutMessage={
            TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmLabelWithoutMessage
          }
          confirmBusy={notifyBusy}
          confirmBusyLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmBusyLabel}
          assigneeKind={notifyPreview.action === "confirm" ? "tour" : undefined}
          assigneeTeamMembers={notifyPreview.action === "confirm" ? teamMembers : undefined}
          assigneeVendors={notifyPreview.action === "confirm" ? vendors : undefined}
          onConfirm={(skip, channels, draft) => void submitNotifyPreview(skip, channels, draft)}
        />
      ) : null}
      {guestMessagePreview ? (
        <PortalNotificationPreviewModal
          open
          title="Message guest"
          onClose={() => {
            if (guestMessageBusy) return;
            setGuestMessagePreview(null);
          }}
          recipient={guestMessagePreview.email}
          recipientPhone={guestMessagePreview.phone}
          subject=""
          body=""
          showSkipMessage={false}
          showChannelPicker
          emailAvailable
          smsAvailable={Boolean(guestMessagePreview.phone)}
          defaultViaSms={false}
          showSchedule={false}
          confirmLabel="Send message"
          confirmBusy={guestMessageBusy}
          confirmBusyLabel="Sending…"
          onConfirm={(_skip, channels, draft) => void submitGuestMessage(false, channels, draft)}
        />
      ) : null}
    </>
  );

  if (tourIdProp && detailRow) {
    return (
      <>
        {modals}
        {bulkActionBar}
        <PortalRecordDetailPage
          pageTitle="Tours"
          title={detailRow.guestName}
          subtitle={detailRow.whenLabel}
          avatarName={detailRow.guestName}
          backHref={managerTourListHref(basePath, bucket)}
          backLabel="Back to tours"
          hideBackText
          bareHeader
          dataAttrBack="tour-detail-back"
          inlineActions
          actions={detailActions}
        >
          {renderDetailPanel(detailRow)}
        </PortalRecordDetailPage>
      </>
    );
  }

  return (
    <ManagerPortalPageShell
      title="Tours"
      hideTitleOnMobileNav
      titleInlineFilter={filterSheet}
      compactFilterRow
      titleAside={
        <>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_HEADER_ACTION_BTN}
            data-attr="tours-settings-open"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </Button>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_HEADER_ACTION_BTN}
            disabled={propertyOptions.length === 0}
            data-attr="tours-share-open"
            onClick={() => setShareTourOpen(true)}
          >
            Share tour
          </Button>
        </>
      }
    >
      {modals}
      {bulkActionBar}

      <PortalListControlStack
        className="mb-2"
        destinationRow={
          <DestinationNav
            items={tabs.map((tab) => ({
              id: tab.id,
              label: tab.label,
              href: managerTourListHref(basePath, tab.id),
              count: tab.count,
              alert: tab.alert,
              dataAttr: `tours-bucket-${tab.id}`,
            }))}
            activeId={bucket}
            ariaLabel="Tour status"
            itemLayout="equal"
            denseEqualRow
            className="max-w-none"
          />
        }
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: "Search tours",
          dataAttr: "tours-search",
        }}
        activeFilterChips={activeFilterChips}
      />

      <div className={PORTAL_LIST_PAGE_BODY}>
        {bucket === "pending" ? <TourProposalsPanel /> : null}

        {!authReady ? (
          <p className="text-sm text-muted">Loading tours…</p>
        ) : rowsForBucket.length === 0 ? (
          <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
            <PortalListAddRow
              label="Add"
              ariaLabel="Schedule tour"
              icon={PORTAL_LIST_ADD_ICONS.application}
              onClick={() => setAddTourOpen(true)}
              disabled={propertyOptions.length === 0}
              dataAttr="tours-list-add"
            />
          </div>
        ) : (
          <>
            {renderGroupedTours()}
            <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
              <PortalListAddRow
                label="Add"
                ariaLabel="Schedule tour"
                icon={PORTAL_LIST_ADD_ICONS.application}
                onClick={() => setAddTourOpen(true)}
                disabled={propertyOptions.length === 0}
                dataAttr="tours-list-add"
              />
            </div>
          </>
        )}
      </div>

      <ShareLeadLinkModal
        open={shareTourOpen}
        onClose={() => setShareTourOpen(false)}
        kind="tour"
        properties={propertyOptions}
      />
      <ManagerAddScheduledTourModal
        open={addTourOpen}
        onClose={() => setAddTourOpen(false)}
        managerUserId={userId ?? ""}
        propertyTick={propertyTick}
        onSaved={() => {
          void refresh();
          if (bucket !== "upcoming") {
            navigate(managerTourListHref(basePath, "upcoming"));
          }
        }}
      />
      <ManagerPortalSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialTab="calendar"
        scopedTitle="Tours"
      />
    </ManagerPortalPageShell>
  );
}
