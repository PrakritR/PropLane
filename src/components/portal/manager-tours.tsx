"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PortalListFab } from "@/components/portal/portal-list-fab";
import { togglePortalListClusterSelection } from "@/components/portal/application-household-list";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import { ManagerAddScheduledTourModal } from "@/components/portal/manager-add-scheduled-tour-modal";
import { ManagerToursGroupedTable } from "@/components/portal/manager-tours-grouped-table";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { PortalBulkMessageCarouselModal } from "@/components/portal/portal-bulk-message-carousel-modal";
import { Input } from "@/components/ui/input";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
import {
  ManagerPortalPageShell,
  PORTAL_COMMAND_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_STYLE,
} from "@/components/portal/portal-metrics";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
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
import { useScheduledTourReminders } from "@/hooks/use-scheduled-tour-reminders";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
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
  clusterManagerTourListRowsByMode,
  countManagerTourRowsByBucket,
  filterManagerTourRows,
  sortManagerTourClustersForBucket,
  sortManagerTourPropertyClustersForBucket,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";
import {
  DEFAULT_PORTAL_LIST_GROUP_MODE,
  isPropertyClusterList,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
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
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";

const TOUR_BUCKET_LABELS = MANAGER_TOUR_BUCKETS.map((id) => ({
  id,
  label: MANAGER_TOUR_BUCKET_LABELS[id],
}));

const BULK_BAR_BTN = PORTAL_BULK_BAR_BTN;

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

function tourNotifyMessageForRow(
  preview: TourNotifyPreview,
  row: ManagerTourRow,
  buildRescheduleCtx: (row: ManagerTourRow, times: TourRescheduleTimes) => ReturnType<typeof buildTourNotificationContext>,
): { subject: string; body: string } {
  const ctx = buildTourNotifyContext(row);
  if (preview.action === "confirm") {
    return { subject: TOUR_CONFIRMED_TENANT_SUBJECT, body: buildTourConfirmedTenantBody(ctx) };
  }
  if (preview.action === "decline") {
    return { subject: TOUR_REQUEST_REMOVED_TENANT_SUBJECT, body: buildTourRequestRemovedTenantBody(ctx) };
  }
  if (preview.action === "cancel") {
    return { subject: TOUR_CANCELED_TENANT_SUBJECT, body: buildTourCanceledTenantBody(ctx) };
  }
  const times = preview.rowTimes?.[row.id];
  if (!times) {
    return { subject: preview.subject, body: preview.body };
  }
  const rescheduleCtx = buildRescheduleCtx(row, times);
  const previous = { startIso: times.previousStartIso, endIso: times.previousEndIso };
  if (isUpcomingPlanned(row)) {
    return {
      subject: TOUR_RESCHEDULED_TENANT_SUBJECT,
      body: buildTourRescheduledTenantBody(rescheduleCtx, previous),
    };
  }
  return {
    subject: TOUR_RESCHEDULED_TENANT_SUBJECT,
    body: buildTourRescheduleConfirmRequestBody(rescheduleCtx, previous),
  };
}

function buildTourNotifyCarouselItems(
  preview: TourNotifyPreview,
  buildRescheduleCtx: (row: ManagerTourRow, times: TourRescheduleTimes) => ReturnType<typeof buildTourNotificationContext>,
) {
  return preview.rows.map((row) => {
    const { subject, body } = tourNotifyMessageForRow(preview, row, buildRescheduleCtx);
    return {
      id: row.id,
      label: `${row.guestName} · ${row.whenLabel}`,
      recipient: row.guestEmail,
      recipientPhone: row.guestPhone?.trim() || undefined,
      subject,
      body,
      emailAvailable: Boolean(row.guestEmail?.includes("@")),
      smsAvailable: Boolean(row.guestPhone?.trim()),
    };
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
  const { reminders: tourReminders, reload: reloadTourReminders } = useScheduledTourReminders();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId: userId });
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);
  const [shareTourOpen, setShareTourOpen] = useState(false);
  const [addTourOpen, setAddTourOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { selectedIds, setSelectedIds, toggleSelected } = usePortalRowSelection(`${bucket}:${groupMode}`);
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
    void reloadTourReminders();
    setTick((n) => n + 1);
  }, [reloadTourReminders]);

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
    () => filterManagerTourRows(allRows, bucket, propertyFilters, ""),
    [allRows, bucket, propertyFilters],
  );

  const clusters = useMemo(() => {
    const grouped = clusterManagerTourListRowsByMode(rowsForBucket, groupMode);
    if (isPropertyClusterList(groupMode, grouped)) {
      return sortManagerTourPropertyClustersForBucket(grouped, bucket);
    }
    return sortManagerTourClustersForBucket(grouped, bucket);
  }, [rowsForBucket, bucket, groupMode]);

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
      filterFieldCount={propertyOptions.length > 1 ? 2 : 1}
      mobileFlushBody
      constrainDropdownToTitleBand={false}
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => {
        setPropertyFilters([]);
        setGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE);
      }}
      dataAttr="tours-filter-sheet-open"
    >
      <PortalListGroupFilterFields
        groupMode={groupMode}
        onGroupModeChange={setGroupMode}
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        propertyDataAttr="tours-filter-property"
        groupModeDataAttr="tours-filter-group-mode"
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
    async (
      skipMessage: boolean,
      _channels?: unknown,
      draft?: NotificationConfirmDraft,
      opts?: {
        scope?: "all" | "single";
        singleId?: string;
        drafts?: Record<string, { subject: string; body: string }>;
      },
    ) => {
      if (!notifyPreview || notifyBusy) return;
      const preview = notifyPreview;
      const scope = opts?.scope ?? "all";
      const targetRows =
        scope === "single" && opts?.singleId
          ? preview.rows.filter((row) => row.id === opts.singleId)
          : opts?.drafts
            ? preview.rows.filter((row) => row.id in (opts.drafts ?? {}))
            : preview.rows;
      if (targetRows.length === 0) return;

      setNotifyBusy(true);
      try {
        const subject = draft?.subject?.trim() || preview.subject;
        const body = draft?.body?.trim() || preview.body;
        const useSharedDraft = targetRows.length === 1 && !opts?.drafts;

        const resolveRowMessage = (row: ManagerTourRow) => {
          const fromCarousel = opts?.drafts?.[row.id];
          if (fromCarousel) {
            return {
              subject: fromCarousel.subject.trim(),
              body: fromCarousel.body.trim(),
            };
          }
          if (useSharedDraft) {
            return { subject, body };
          }
          return tourNotifyMessageForRow(preview, row, buildRescheduleNotifyContext);
        };

        if (preview.action === "confirm") {
          for (const row of targetRows) {
            const { subject: rowSubject, body: rowBody } = resolveRowMessage(row);
            const result = await acceptPartnerInquiryFromServer(row.sourceId, {
              start: row.startIso,
              end: row.endIso,
              notifyTenant: !skipMessage,
              subject: rowSubject,
              body: rowBody,
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
          if (scope === "all") {
            setSelectedIds(new Set());
          } else if (opts?.singleId) {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.delete(opts.singleId!);
              return next;
            });
          }
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          const count = targetRows.length;
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
          for (const row of targetRows) {
            const { subject: rowSubject, body: rowBody } = resolveRowMessage(row);
            const ok = await deletePartnerInquiryFromServer(row.sourceId, {
              notifyTenant: !skipMessage,
              subject: rowSubject,
              body: rowBody,
            });
            if (!ok) {
              showToast("Could not decline tour request.");
              return;
            }
          }
          setNotifyPreview(null);
          if (scope === "all") {
            setSelectedIds(new Set());
          } else if (opts?.singleId) {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.delete(opts.singleId!);
              return next;
            });
          }
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          const count = targetRows.length;
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
          for (const row of targetRows) {
            const { subject: rowSubject, body: rowBody } = resolveRowMessage(row);
            const result = await cancelPlannedTourFromServer({
              plannedEventId: row.sourceId,
              notifyGuest: !skipMessage,
              subject: rowSubject,
              body: rowBody,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not cancel tour.");
              return;
            }
          }
          setNotifyPreview(null);
          if (scope === "all") {
            setSelectedIds(new Set());
          } else if (opts?.singleId) {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.delete(opts.singleId!);
              return next;
            });
          }
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          const count = targetRows.length;
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
          for (const row of targetRows) {
            const times = preview.rowTimes?.[row.id];
            if (!times) continue;
            const { subject: rowSubject, body: rowBody } = resolveRowMessage(row);
            if (isUpcomingPlanned(row)) {
              const result = await reschedulePlannedTourFromServer({
                plannedEventId: row.sourceId,
                start: times.newStartIso,
                end: times.newEndIso,
                notifyGuest: !skipMessage,
                subject: rowSubject,
                body: rowBody,
              });
              if (!result.ok) {
                showToast(result.error ?? "Could not reschedule tour.");
                return;
              }
              continue;
            }
            if (isPendingInquiry(row)) {
              const result = await proposePendingTourRescheduleFromServer({
                inquiryId: row.sourceId,
                previousStart: times.previousStartIso,
                previousEnd: times.previousEndIso,
                start: times.newStartIso,
                end: times.newEndIso,
                notifyGuest: !skipMessage,
                subject: rowSubject,
                body: rowBody,
              });
              if (!result.ok) {
                showToast(result.error ?? "Could not propose the new tour time.");
                return;
              }
            }
          }
          setNotifyPreview(null);
          if (scope === "all") {
            setSelectedIds(new Set());
          } else if (opts?.singleId) {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.delete(opts.singleId!);
              return next;
            });
          }
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          const count = targetRows.length;
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

  const toggleClusterSelection = useCallback(
    (ids: readonly string[]) => togglePortalListClusterSelection(setSelectedIds, ids),
    [setSelectedIds],
  );

  const renderGroupedTours = () => (
    <ManagerToursGroupedTable
      clusters={clusters}
      groupMode={groupMode}
      selectedIds={selectedIds}
      onToggleSelected={toggleSelected}
      onToggleCluster={toggleClusterSelection}
      onRowClick={openTourDetail}
      tourReminders={tourReminders}
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
      <BulkActionBar count={selectedIds.size} hideCount variant="payments">
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
        <Modal
          open
          title={
            rescheduleTimePicker.rows.length === 1 ? "Pick a new tour time" : "Pick new tour times"
          }
          onClose={() => setRescheduleTimePicker(null)}
          dense
          footer={
            <ModalFooter className="w-full justify-between gap-2">
              <span aria-hidden className="shrink-0" />
              <Button
                type="button"
                variant="primary"
                className={BULK_BAR_BTN}
                data-attr="tour-reschedule-continue"
                onClick={continueRescheduleFromPicker}
              >
                Continue
              </Button>
            </ModalFooter>
          }
          panelClassName="max-w-md"
        >
          <p className="text-sm text-muted">
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
        </Modal>
      ) : null}
      {notifyPreview && notifyPreviewRow ? (
        notifyPreview.rows.length > 1 ? (
          <PortalBulkMessageCarouselModal
            open
            title={
              notifyPreview.rows.length > 1
                ? `${TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].title} (${notifyPreview.rows.length})`
                : TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].title
            }
            intro={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].intro}
            items={buildTourNotifyCarouselItems(notifyPreview, buildRescheduleNotifyContext)}
            confirmLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmLabel}
            confirmLabelSingle={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmLabel}
            confirmLabelWithoutMessage={
              TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmLabelWithoutMessage
            }
            skipMessageLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].skipMessageLabel}
            confirmBusy={notifyBusy}
            confirmBusyLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmBusyLabel}
            onClose={() => {
              if (notifyBusy) return;
              setNotifyPreview(null);
            }}
            onConfirm={(scope, { skipMessage, channels, drafts, singleId }) =>
              void submitNotifyPreview(skipMessage, channels, undefined, {
                scope,
                singleId,
                drafts,
              })
            }
          />
        ) : (
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
        )
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
      titleInlineFilter={null}
      compactFilterRow
    >
      {modals}
      {bulkActionBar}

      <PortalListControlStack
        className="mb-2"
        variant="command"
        destinations={tabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: managerTourListHref(basePath, tab.id),
          count: tab.count,
          alert: tab.alert,
          dataAttr: `tours-bucket-${tab.id}`,
        }))}
        activeDestinationId={bucket}
        destinationAriaLabel="Tour status"
        filterRow={filterSheet}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_COMMAND_ACTION_BTN}
              data-attr="tours-settings-open"
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </Button>
            <Button
              type="button"
              className={PORTAL_COMMAND_PRIMARY_ACTION_BTN}
              style={PORTAL_COMMAND_PRIMARY_ACTION_STYLE}
              disabled={propertyOptions.length === 0}
              data-attr="tours-share-open"
              onClick={() => setShareTourOpen(true)}
            >
              Share tour
            </Button>
          </>
        }
        activeFilterChips={activeFilterChips}
      />

      <div className={PORTAL_LIST_PAGE_BODY}>
        {bucket === "pending" ? <TourProposalsPanel /> : null}

        {!authReady ? (
          <p className="text-sm text-muted">Loading tours…</p>
        ) : rowsForBucket.length === 0 ? null : (
          renderGroupedTours()
        )}
      </div>
      <PortalListFab
        onClick={() => setAddTourOpen(true)}
        disabled={propertyOptions.length === 0}
        ariaLabel="Schedule tour"
        dataAttr="tours-list-add"
      />

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
