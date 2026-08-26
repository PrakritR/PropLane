"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { ManagerToursGroupedTable } from "@/components/portal/manager-tours-grouped-table";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
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
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
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
import { getPropertyById } from "@/lib/rental-application/data";
import { cancelPlannedTourFromServer } from "@/lib/tour-planned-change.client";
import {
  TOUR_CANCELED_TENANT_SUBJECT,
  TOUR_CONFIRMED_TENANT_SUBJECT,
  TOUR_REQUEST_REMOVED_TENANT_SUBJECT,
  buildTourCanceledTenantBody,
  buildTourConfirmedTenantBody,
  buildTourNotificationContext,
  buildTourRequestRemovedTenantBody,
} from "@/lib/tour-notifications";

const TOUR_BUCKET_LABELS = MANAGER_TOUR_BUCKETS.map((id) => ({
  id,
  label: MANAGER_TOUR_BUCKET_LABELS[id],
}));

const BULK_BAR_BTN = "h-9 min-h-0 shrink-0 whitespace-nowrap rounded-full px-3 text-[13px] sm:h-10 sm:px-4 sm:text-sm";

type TourNotifyAction = "confirm" | "decline" | "cancel";

type TourNotifyPreview = {
  action: TourNotifyAction;
  row: ManagerTourRow;
  subject: string;
  body: string;
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
  const { reminders, reload: reloadReminders } = useScheduledTourReminders();
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [shareTourOpen, setShareTourOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [notifyPreview, setNotifyPreview] = useState<TourNotifyPreview | null>(null);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [guestMessagePreview, setGuestMessagePreview] = useState<GuestMessagePreview | null>(null);
  const [guestMessageBusy, setGuestMessageBusy] = useState(false);

  const refresh = useCallback(async () => {
    await syncScheduleRecordsFromServer({ force: true });
    await reloadReminders();
    setTick((n) => n + 1);
  }, [reloadReminders]);

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

  const openApprovePreview = useCallback((row: ManagerTourRow) => {
    if (row.source !== "inquiry" || row.bucket !== "pending") return;
    const ctx = buildTourNotifyContext(row);
    setNotifyPreview({
      action: "confirm",
      row,
      subject: TOUR_CONFIRMED_TENANT_SUBJECT,
      body: buildTourConfirmedTenantBody(ctx),
    });
  }, []);

  const openDeclinePreview = useCallback((row: ManagerTourRow) => {
    if (row.source !== "inquiry" || row.bucket !== "pending") return;
    const ctx = buildTourNotifyContext(row);
    setNotifyPreview({
      action: "decline",
      row,
      subject: TOUR_REQUEST_REMOVED_TENANT_SUBJECT,
      body: buildTourRequestRemovedTenantBody(ctx),
    });
  }, []);

  const openCancelPreview = useCallback((row: ManagerTourRow) => {
    if (row.source !== "planned" || row.bucket !== "upcoming") return;
    const ctx = buildTourNotifyContext(row);
    setNotifyPreview({
      action: "cancel",
      row,
      subject: TOUR_CANCELED_TENANT_SUBJECT,
      body: buildTourCanceledTenantBody(ctx),
    });
  }, []);

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
        if (preview.action === "confirm") {
          const result = await acceptPartnerInquiryFromServer(preview.row.sourceId, {
            start: preview.row.startIso,
            end: preview.row.endIso,
            notifyTenant: !skipMessage,
            subject: draft?.subject,
            body: draft?.body,
          });
          if (!result.ok) {
            showToast(result.error ?? "Could not confirm tour.");
            return;
          }
          setNotifyPreview(null);
          setSelectedIds(new Set());
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          showToast(skipMessage ? "Tour confirmed." : "Tour confirmed and guest notified.");
          return;
        }

        if (preview.action === "decline") {
          const ok = await deletePartnerInquiryFromServer(preview.row.sourceId, {
            notifyTenant: !skipMessage,
            subject: draft?.subject,
            body: draft?.body,
          });
          if (!ok) {
            showToast("Could not decline tour request.");
            return;
          }
          setNotifyPreview(null);
          setSelectedIds(new Set());
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          showToast(skipMessage ? "Tour request declined." : "Tour declined and guest notified.");
          return;
        }

        if (preview.action === "cancel") {
          const result = await cancelPlannedTourFromServer({
            plannedEventId: preview.row.sourceId,
            notifyGuest: !skipMessage,
            subject: draft?.subject,
            body: draft?.body,
          });
          if (!result.ok) {
            showToast(result.error ?? "Could not cancel tour.");
            return;
          }
          setNotifyPreview(null);
          setSelectedIds(new Set());
          await refresh();
          if (tourIdProp) navigate(managerTourListHref(basePath, bucket));
          showToast(skipMessage ? "Tour cancelled." : "Tour cancelled and guest notified.");
        }
      } finally {
        setNotifyBusy(false);
      }
    },
    [basePath, bucket, navigate, notifyBusy, notifyPreview, refresh, showToast, tourIdProp],
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
      reminders={reminders}
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
      {detailRow.bucket === "pending" && detailRow.source === "inquiry" ? (
        <>
          <Button
            type="button"
            variant="outline"
            className={`${BULK_BAR_BTN} text-rose-800`}
            data-attr="tour-detail-decline"
            onClick={() => openDeclinePreview(detailRow)}
          >
            Decline
          </Button>
          <Button
            type="button"
            variant="primary"
            className={BULK_BAR_BTN}
            data-attr="tour-detail-approve"
            onClick={() => openApprovePreview(detailRow)}
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
          onClick={() => openCancelPreview(detailRow)}
        >
          Cancel tour
        </Button>
      ) : null}
    </>
  ) : null;

  const bulkActions = (
    <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
      {singleSelectedRow?.guestEmail?.includes("@") ? (
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
      {singleSelectedRow?.bucket === "pending" && singleSelectedRow.source === "inquiry" ? (
        <>
          <Button
            type="button"
            variant="outline"
            className={`${BULK_BAR_BTN} text-rose-800`}
            data-attr="tours-bulk-decline"
            onClick={() => openDeclinePreview(singleSelectedRow)}
          >
            Decline
          </Button>
          <Button
            type="button"
            variant="primary"
            className={BULK_BAR_BTN}
            data-attr="tours-bulk-approve"
            onClick={() => openApprovePreview(singleSelectedRow)}
          >
            Approve
          </Button>
        </>
      ) : null}
      {singleSelectedRow?.bucket === "upcoming" && singleSelectedRow.source === "planned" ? (
        <Button
          type="button"
          variant="outline"
          className={`${BULK_BAR_BTN} text-rose-800`}
          data-attr="tours-bulk-cancel"
          onClick={() => openCancelPreview(singleSelectedRow)}
        >
          Cancel tour
        </Button>
      ) : null}
    </div>
  );

  const modals = (
    <>
      {notifyPreview ? (
        <PortalNotificationPreviewModal
          open
          title={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].title}
          onClose={() => {
            if (notifyBusy) return;
            setNotifyPreview(null);
          }}
          recipient={notifyPreview.row.guestEmail}
          recipientPhone={notifyPreview.row.guestPhone?.trim() || undefined}
          subject={notifyPreview.subject}
          body={notifyPreview.body}
          intro={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].intro}
          skipMessageLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].skipMessageLabel}
          showChannelPicker
          emailAvailable={Boolean(notifyPreview.row.guestEmail?.includes("@"))}
          smsAvailable={Boolean(notifyPreview.row.guestPhone?.trim())}
          defaultViaSms={false}
          confirmLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmLabel}
          confirmLabelWithoutMessage={
            TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmLabelWithoutMessage
          }
          confirmBusy={notifyBusy}
          confirmBusyLabel={TOUR_NOTIFY_PREVIEW_COPY[notifyPreview.action].confirmBusyLabel}
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
      {selectedIds.size > 0 ? (
        <BulkActionBar count={selectedIds.size}>
          {bulkActions}
        </BulkActionBar>
      ) : null}

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
          <PortalDataTableEmpty
            message={
              bucket === "pending"
                ? "No pending tour requests"
                : bucket === "upcoming"
                  ? "No upcoming tours"
                  : "No past tours"
            }
          />
        ) : (
          renderGroupedTours()
        )}
      </div>

      <ShareLeadLinkModal
        open={shareTourOpen}
        onClose={() => setShareTourOpen(false)}
        kind="tour"
        properties={propertyOptions}
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
