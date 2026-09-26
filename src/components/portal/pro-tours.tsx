"use client";

import { isDemoModeActive } from "@/lib/demo/demo-session";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tourFormatLabel } from "@/lib/tour-format";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import { AddResidentWizard } from "@/components/portal/resident-wizard";
import { ManagerToursGroupedTable } from "@/components/portal/pro-tours-grouped-table";
import { ManagerTourAvailabilityModal } from "@/components/portal/manager-tour-availability-modal";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { PortalBulkMessageCarouselModal } from "@/components/portal/portal-bulk-message-carousel-modal";
import { Input } from "@/components/ui/input";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import {
  getSettingsEntryPoint,
  settingsDialogTitlePrefix,
} from "@/components/portal/settings-entry-points";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { FinancesExportMenu, type FinancesExportItem } from "@/components/portal/finances/finances-export-menu";
import { CalendarClock, CalendarPlus, MessageSquare, Settings, Share2, Trash2, XCircle } from "lucide-react";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  PortalNotificationPreviewModal,
  type NotificationConfirmDraft,
} from "@/components/portal/portal-notification-preview-modal";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useScheduledTourReminders } from "@/hooks/use-scheduled-tour-reminders";
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
  managerTourRowsFromProposals,
  mergePendingTourRowsWithProposals,
  type TourProposalListItem,
} from "@/lib/manager-tour-proposal-rows";
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
  deletePlannedTourFromServer,
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
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";

const toursSettingsEntry = getSettingsEntryPoint("tours");

const TOUR_BUCKET_LABELS = MANAGER_TOUR_BUCKETS.map((id) => ({
  id,
  label: MANAGER_TOUR_BUCKET_LABELS[id],
}));

const BULK_BAR_BTN = PORTAL_BULK_BAR_BTN;
/**
 * Tour detail header actions are icons, not words: Message / Reschedule /
 * Cancel are navigation on a phone-width header. Approve and Decline on a
 * pending request stay as words — a decision that messages a prospect is
 * never a bare glyph.
 */
const TOUR_DETAIL_ICON_BTN = "h-10 min-h-10 w-10 rounded-full px-0";

function isPendingInquiry(row: ManagerTourRow): boolean {
  return row.bucket === "pending" && row.source === "inquiry";
}

function isPendingProposal(row: ManagerTourRow): boolean {
  return row.bucket === "pending" && row.source === "proposal";
}

function isUpcomingPlanned(row: ManagerTourRow): boolean {
  return row.bucket === "upcoming" && row.source === "planned";
}

/** Requests and planned tours can be deleted; a reschedule proposal is declined instead. */
function isDeletableTour(row: ManagerTourRow): boolean {
  return row.source === "inquiry" || row.source === "planned";
}

/** A live tour the guest is still expecting — deleting it offers them a message. */
function isLiveTour(row: ManagerTourRow): boolean {
  return isPendingInquiry(row) || isUpcomingPlanned(row);
}

function tourHasGuestContact(row: ManagerTourRow): boolean {
  return Boolean(row.guestEmail?.includes("@") || row.guestPhone?.trim());
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

type TourNotifyAction = "confirm" | "decline" | "cancel" | "reschedule" | "delete";

type TourNotifyPreview = {
  action: TourNotifyAction;
  rows: ManagerTourRow[];
  subject: string;
  body: string;
  rowTimes?: Record<string, TourRescheduleTimes>;
  /** Delete only: past rows that go with the live ones, with no message. */
  silentRows?: ManagerTourRow[];
};

type GuestMessagePreview = {
  email: string;
  phone?: string;
};

const TOUR_NOTIFY_PREVIEW_COPY: Record<
  TourNotifyAction,
  {
    title: string;
    skipMessageLabel: string;
    confirmLabel: string;
    confirmLabelWithoutMessage: string;
    confirmBusyLabel: string;
  }
> = {
  confirm: {
    title: "Confirm tour",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Confirm tour & send notification",
    confirmLabelWithoutMessage: "Confirm tour only",
    confirmBusyLabel: "Confirming…",
  },
  decline: {
    title: "Decline tour",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Decline & send notification",
    confirmLabelWithoutMessage: "Decline only",
    confirmBusyLabel: "Declining…",
  },
  cancel: {
    title: "Cancel tour",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Cancel tour & send notification",
    confirmLabelWithoutMessage: "Cancel tour only",
    confirmBusyLabel: "Cancelling…",
  },
  reschedule: {
    title: "Reschedule tour",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Send & ask guest to confirm",
    confirmLabelWithoutMessage: "Update time without messaging",
    confirmBusyLabel: "Sending…",
  },
  delete: {
    title: "Delete tour",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Delete tour & send notification",
    confirmLabelWithoutMessage: "Delete tour only",
    confirmBusyLabel: "Deleting…",
  },
};

/** The message a deleted live tour sends: a request is "removed", a confirmed tour is "cancelled". */
function tourDeleteMessageForRow(row: ManagerTourRow): { subject: string; body: string } {
  const ctx = buildTourNotifyContext(row);
  if (row.source === "inquiry") {
    return { subject: TOUR_REQUEST_REMOVED_TENANT_SUBJECT, body: buildTourRequestRemovedTenantBody(ctx) };
  }
  return { subject: TOUR_CANCELED_TENANT_SUBJECT, body: buildTourCanceledTenantBody(ctx) };
}

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
    tourFormat: row.tourFormat,
    tourStartIso: row.startIso,
    tourEndIso: row.endIso,
    notes: row.notes || null,
    managerLabel: "Property Manager",
    tourInquiryId: row.source === "inquiry" ? row.sourceId : null,
    replyOptions: {
      // The preview knows whether a guest can receive SMS, but cannot know
      // whether the deployed email Reply-To secret is configured. The server
      // re-evaluates this before delivery and supplies the authoritative copy.
      smsSelected: false,
      smsAvailable: Boolean(row.guestPhone?.trim()),
      emailSelected: Boolean(row.guestEmail?.includes("@")),
      emailReplyAvailable: false,
    },
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
  if (preview.action === "delete") {
    return tourDeleteMessageForRow(row);
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

const EMPTY_LEASE_KEYS = { axisIds: new Set<string>(), emails: new Set<string>() };

export function ManagerTours({
  bucket = "pending",
  basePath = "/portal",
  tourId: tourIdProp,
  tourDetailTab: tourDetailTabProp,
  embedded = false,
  scopedPropertyId,
  scopedPropertyLabel,
  tourListHref: tourListHrefOverride,
  tourDetailHref: tourDetailHrefOverride,
}: {
  bucket?: ManagerTourBucketId;
  basePath?: string;
  tourId?: string;
  /** The tour record's own rail tab (docs/agents/record-page.md); undefined = Overview. */
  tourDetailTab?: import("@/lib/portal-detail-routes").TourDetailTabId;
  /** Property detail tab — no duplicate page title shell. */
  embedded?: boolean;
  /** Limit the list to one property and hide the portfolio property filter. */
  scopedPropertyId?: string;
  scopedPropertyLabel?: string;
  tourListHref?: (bucket: ManagerTourBucketId) => string;
  tourDetailHref?: (bucket: ManagerTourBucketId, tourId: string) => string;
}) {
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const { userId, ready: authReady } = useManagerUserId();
  const { reminders: tourReminders, reload: reloadTourReminders } = useScheduledTourReminders();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId: userId });
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [tourSearch, setTourSearch] = useState("");
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);
  const [shareTourOpen, setShareTourOpen] = useState(false);
  const [addTourOpen, setAddTourOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [notifyPreview, setNotifyPreview] = useState<TourNotifyPreview | null>(null);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [guestMessagePreview, setGuestMessagePreview] = useState<GuestMessagePreview | null>(null);
  const [guestMessageBusy, setGuestMessageBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ManagerTourRow[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [rescheduleTimePicker, setRescheduleTimePicker] = useState<{
    rows: ManagerTourRow[];
    startLocals: Record<string, string>;
  } | null>(null);
  const [tourProposals, setTourProposals] = useState<TourProposalListItem[]>([]);
  const [proposalBusy, setProposalBusy] = useState(false);

  const loadTourProposals = useCallback(async () => {
    // The Seattle Homes sandbox seeds tours directly (`demo-guided-data.ts`'s
    // `schedule`), never through the separate tour-inquiry-proposal flow —
    // never fetch this auth-gated route from `/demo`.
    if (scopedPropertyId || isDemoModeActive()) {
      setTourProposals([]);
      return;
    }
    try {
      const res = await fetch("/api/portal-tour-inquiries/proposals", { credentials: "include" });
      if (res.status === 401) return;
      const data = (await res.json().catch(() => ({}))) as { proposals?: TourProposalListItem[] };
      setTourProposals(Array.isArray(data.proposals) ? data.proposals : []);
    } catch {
      /* leave the list as-is on a transient failure */
    }
  }, [scopedPropertyId]);

  const refresh = useCallback(async () => {
    await syncScheduleRecordsFromServer({ force: true });
    void reloadTourReminders();
    await loadTourProposals();
    setTick((n) => n + 1);
  }, [loadTourProposals, reloadTourReminders]);

  useEffect(() => {
    if (!authReady || !userId) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
    void refresh();
  }, [authReady, userId, refresh]);

  useEffect(() => {
    void loadTourProposals();
  }, [loadTourProposals]);

  useEffect(() => {
    const onStorage = () => setTick((n) => n + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, propertyTick],
  );

  const listHrefForBucket = useCallback(
    (targetBucket: ManagerTourBucketId) =>
      tourListHrefOverride?.(targetBucket) ?? managerTourListHref(basePath, targetBucket),
    [basePath, tourListHrefOverride],
  );

  const detailHrefForTour = useCallback(
    (targetBucket: ManagerTourBucketId, tourId: string) =>
      tourDetailHrefOverride?.(targetBucket, tourId) ??
      managerTourDetailHref(basePath, targetBucket, tourId),
    [basePath, tourDetailHrefOverride],
  );

  const scopedPropertyIds = useMemo(
    () => (scopedPropertyId ? [scopedPropertyId] : propertyOptions.map((option) => option.id)),
    [scopedPropertyId, propertyOptions],
  );

  const effectivePropertyFilters = scopedPropertyId ? [scopedPropertyId] : propertyFilters;

  const propertyLabelById = useMemo(
    () => new Map(propertyOptions.map((option) => [option.id, option.label])),
    [propertyOptions],
  );

  const allRows = useMemo(() => {
    void tick;
    if (!userId) return [];
    // The workspace is the scope (applied inside the builder); the property
    // OPTIONS are a filter control, so an account that has not finished syncing
    // its houses must not read as "no tours".
    return buildManagerTourRows({
      viewerUserId: userId,
      propertyIds: scopedPropertyId ? [scopedPropertyId] : null,
    }).filter((row) => workspaceContainsProperty(row.propertyId));
  }, [tick, userId, scopedPropertyId]);

  const counts = useMemo(() => countManagerTourRowsByBucket(allRows), [allRows]);

  const pendingProposalRows = useMemo(() => {
    if (bucket !== "pending" && !counts.pending) return [];
    const inquiryRows = allRows.filter((row) => row.bucket === "pending" && row.source === "inquiry");
    let rows = managerTourRowsFromProposals(tourProposals, inquiryRows)
      // Proposals come back from the server for the whole account; the active
      // workspace narrows them the same way it narrows the inquiries above.
      .filter((row) => workspaceContainsProperty(row.propertyId));
    if (effectivePropertyFilters.length > 0) {
      rows = rows.filter((row) => row.propertyId && effectivePropertyFilters.includes(row.propertyId));
    }
    return rows;
  }, [allRows, tourProposals, effectivePropertyFilters, bucket, counts.pending]);

  const rowsForBucket = useMemo(() => {
    const filtered = filterManagerTourRows(allRows, bucket, effectivePropertyFilters, "");
    const rows =
      bucket !== "pending" || scopedPropertyId ? filtered : mergePendingTourRowsWithProposals(filtered, pendingProposalRows);
    // The search box narrows the current bucket only; the tab counts stay the bucket totals.
    return rows.filter((row) =>
      matchesPortalListSearch(
        tourSearch,
        row.guestName,
        row.guestEmail,
        row.guestPhone,
        row.propertyTitle,
        row.roomLabel,
        row.whenLabel,
        row.statusLabel,
      ),
    );
  }, [allRows, bucket, effectivePropertyFilters, scopedPropertyId, pendingProposalRows, tourSearch]);

  const displayCounts = useMemo(() => {
    if (scopedPropertyId || pendingProposalRows.length === 0) return counts;
    const pendingRows = filterManagerTourRows(allRows, "pending", effectivePropertyFilters, "");
    const mergedPending = mergePendingTourRowsWithProposals(pendingRows, pendingProposalRows);
    return { ...counts, pending: mergedPending.length };
  }, [allRows, counts, effectivePropertyFilters, pendingProposalRows, scopedPropertyId]);

  const clusters = useMemo(() => {
    const grouped = clusterManagerTourListRowsByMode(rowsForBucket, groupMode);
    if (isPropertyClusterList(groupMode, grouped)) {
      return sortManagerTourPropertyClustersForBucket(grouped, bucket);
    }
    return sortManagerTourClustersForBucket(grouped, bucket);
  }, [rowsForBucket, bucket, groupMode]);

  const { selectedIds, setSelectedIds, toggleSelected } = usePortalRowSelection(bucket);
  const selectedTourRows = useMemo(
    () => rowsForBucket.filter((row) => selectedIds.has(row.id)),
    [rowsForBucket, selectedIds],
  );
  const singleSelectedTourRow = selectedTourRows.length === 1 ? selectedTourRows[0]! : null;

  const toggleTourCluster = useCallback(
    (ids: readonly string[]) => {
      setSelectedIds((prev) => {
        const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
        const next = new Set(prev);
        for (const id of ids) {
          if (allSelected) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    },
    [setSelectedIds],
  );

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
        count: displayCounts[id],
        alert: id === "pending" && displayCounts.pending > 0,
      })),
    [displayCounts],
  );

  const filterTouchCount = !scopedPropertyId && propertyFilters.length > 0 ? 1 : 0;

  const filterSheet = scopedPropertyId ? null : (
    <PortalFilterSortSheet
      activeCount={filterTouchCount}
      compactPanel
      commandStripTrigger
      filterFieldCount={propertyOptions.length > 1 ? 2 : 1}
      mobileFlushBody
      constrainDropdownToTitleBand={false}
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

  // C026/C032 — CSV + PDF export of the visible tab, respecting the same
  // property filters and search the list itself is currently applying. The
  // server route re-derives ownership/workspace scope; these query params are
  // only "what to show", never "who may see it".
  const toursExportItems: FinancesExportItem[] = useMemo(() => {
    const params = new URLSearchParams({ bucket });
    if (effectivePropertyFilters.length > 0) params.set("propertyIds", effectivePropertyFilters.join(","));
    if (tourSearch.trim()) params.set("q", tourSearch.trim());
    const base = `/api/portal/tours-export?${params.toString()}`;
    return [
      { id: "csv", label: "Export CSV", href: `${base}&format=csv`, dataAttr: "tours-export-csv" },
      { id: "pdf", label: "Export PDF", href: `${base}&format=pdf`, dataAttr: "tours-export-pdf" },
    ];
  }, [bucket, effectivePropertyFilters, tourSearch]);

  const activeFilterChips =
    !scopedPropertyId && propertyFilters.length > 0 ? (
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
      navigate(detailHrefForTour(bucket, row.id));
    },
    [bucket, detailHrefForTour, navigate],
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

  /**
   * The record header's one-click decline (C029/C030, recommended build: a
   * quick generic confirm from the header; the row ⋯ / bulk bar keeps the
   * editable reason-message flow above via `openDeclinePreview`). No message
   * preview, no skip-messaging toggle — a plain "are you sure", then the
   * guest gets the same default removal notice `openDeclinePreview` sends.
   */
  const quickDeclineFromHeader = useCallback(
    async (row: ManagerTourRow) => {
      if (!isPendingInquiry(row)) return;
      const ok = await confirm({
        title: "Decline tour",
        description: `Decline ${row.guestName || "this prospect"}'s tour request for ${row.whenLabel}? They'll be notified.`,
        confirmLabel: "Decline",
        tone: "danger",
        dataAttr: "tour-detail-decline-confirm",
      });
      if (!ok) return;
      const ctx = buildTourNotifyContext(row);
      const result = await deletePartnerInquiryFromServer(row.sourceId, {
        notifyTenant: true,
        subject: TOUR_REQUEST_REMOVED_TENANT_SUBJECT,
        body: buildTourRequestRemovedTenantBody(ctx),
      });
      if (!result.ok) {
        showToast(result.error ?? "Could not decline tour request.");
        return;
      }
      await refresh();
      navigate(listHrefForBucket(bucket));
      showToast("Tour declined and guest notified.");
    },
    [confirm, refresh, navigate, bucket, showToast],
  );

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

  /**
   * One request per row. A planned tour goes through the server delete (row
   * dropped, reminder cancelled, Google event removed); a request goes through
   * the request-removal route with `purge`, so it is dropped rather than left
   * as a declined row. The guest is messaged only when asked.
   */
  const deleteTourRow = useCallback(
    async (
      row: ManagerTourRow,
      message: { notify: boolean; subject?: string; body?: string; channels?: { viaEmail?: boolean; viaSms?: boolean } },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (row.source === "planned") {
        const result = await deletePlannedTourFromServer({
          plannedEventId: row.sourceId,
          notifyGuest: message.notify,
          subject: message.subject,
          body: message.body,
          deliverViaEmail: message.channels?.viaEmail !== false,
          deliverViaSms: message.channels?.viaSms === true,
        });
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }
      if (row.source === "inquiry") {
        const result = await deletePartnerInquiryFromServer(row.sourceId, {
          notifyTenant: message.notify,
          subject: message.subject,
          body: message.body,
          purge: true,
        });
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }
      return { ok: false, error: "Reschedule proposals are declined, not deleted." };
    },
    [],
  );

  /**
   * Past, cancelled and declined tours get a plain confirm. A live tour the
   * guest can still be reached about opens the notification sheet first — the
   * same one Cancel uses — so dropping it silently is a choice, not the default.
   */
  const openDeletePrompt = useCallback(
    (rows: ManagerTourRow[]) => {
      const eligible = rows.filter(isDeletableTour);
      if (eligible.length === 0) {
        showToast("Reschedule proposals are declined, not deleted.");
        return;
      }
      const liveRows = eligible.filter((row) => isLiveTour(row) && tourHasGuestContact(row));
      if (liveRows.length === 0) {
        setDeleteConfirm(eligible);
        return;
      }
      const first = liveRows[0]!;
      const { subject, body } = tourDeleteMessageForRow(first);
      setNotifyPreview({
        action: "delete",
        rows: liveRows,
        subject,
        body,
        silentRows: eligible.filter((row) => !liveRows.includes(row)),
      });
    },
    [showToast],
  );

  const submitDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm || deleteBusy) return;
    const rows = deleteConfirm;
    setDeleteBusy(true);
    try {
      for (const row of rows) {
        const result = await deleteTourRow(row, { notify: false });
        if (!result.ok) {
          showToast(result.error ?? "Could not delete tour.");
          return;
        }
      }
      setDeleteConfirm(null);
      setSelectedIds(new Set());
      await refresh();
      if (tourIdProp) navigate(listHrefForBucket(bucket));
      showToast(rows.length === 1 ? "Tour deleted." : `${rows.length} tours deleted.`);
    } finally {
      setDeleteBusy(false);
    }
  }, [bucket, deleteBusy, deleteConfirm, deleteTourRow, listHrefForBucket, navigate, refresh, setSelectedIds, showToast, tourIdProp]);

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
      tourFormat: row.tourFormat,
      tourStartIso: times.newStartIso,
      tourEndIso: times.newEndIso,
      notes: row.notes || null,
      managerLabel: "Property Manager",
      tourInquiryId: row.source === "inquiry" ? row.sourceId : null,
      replyOptions: {
        smsSelected: false,
        smsAvailable: Boolean(row.guestPhone?.trim()),
        emailSelected: Boolean(row.guestEmail?.includes("@")),
        emailReplyAvailable: false,
      },
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

  const decideTourProposals = useCallback(
    async (rows: ManagerTourRow[], decision: "approve" | "discard") => {
      const eligible = rows.filter(isPendingProposal);
      if (eligible.length === 0 || proposalBusy) return;
      setProposalBusy(true);
      try {
        for (const row of eligible) {
          const actionId = row.proposalActionId?.trim();
          if (!actionId) continue;
          const res = await fetch("/api/portal-tour-inquiries/proposals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ actionId, decision }),
          });
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(data.error ?? "Could not update tour proposal.");
        }
        setSelectedIds(new Set());
        await refresh();
        if (tourIdProp) navigate(listHrefForBucket(bucket));
        const count = eligible.length;
        showToast(
          decision === "approve"
            ? count === 1
              ? "Tour confirmed and guest notified."
              : `${count} tours confirmed and guests notified.`
            : count === 1
              ? "Tour proposal discarded."
              : `${count} tour proposals discarded.`,
        );
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not update tour proposal.");
        await loadTourProposals();
      } finally {
        setProposalBusy(false);
      }
    },
    [bucket, listHrefForBucket, loadTourProposals, navigate, proposalBusy, refresh, setSelectedIds, showToast, tourIdProp],
  );

  const submitNotifyPreview = useCallback(
    async (
      skipMessage: boolean,
      channels?: { viaEmail?: boolean; viaSms?: boolean },
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
              deliverViaEmail: channels?.viaEmail !== false,
              deliverViaSms: channels?.viaSms === true,
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
          await refresh();
          if (tourIdProp) navigate(listHrefForBucket(bucket));
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
            const result = await deletePartnerInquiryFromServer(row.sourceId, {
              notifyTenant: !skipMessage,
              subject: rowSubject,
              body: rowBody,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not decline tour request.");
              return;
            }
          }
          setNotifyPreview(null);
          await refresh();
          if (tourIdProp) navigate(listHrefForBucket(bucket));
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
              deliverViaEmail: channels?.viaEmail !== false,
              deliverViaSms: channels?.viaSms === true,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not cancel tour.");
              return;
            }
          }
          setNotifyPreview(null);
          await refresh();
          if (tourIdProp) navigate(listHrefForBucket(bucket));
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

        if (preview.action === "delete") {
          for (const row of targetRows) {
            const { subject: rowSubject, body: rowBody } = resolveRowMessage(row);
            const result = await deleteTourRow(row, {
              notify: !skipMessage,
              subject: rowSubject,
              body: rowBody,
              channels,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not delete tour.");
              return;
            }
          }
          // The past rows picked alongside the live ones have no one to tell;
          // they go once the whole selection is being processed.
          const silentRows = scope === "single" ? [] : preview.silentRows ?? [];
          for (const row of silentRows) {
            const result = await deleteTourRow(row, { notify: false });
            if (!result.ok) {
              showToast(result.error ?? "Could not delete tour.");
              return;
            }
          }
          setNotifyPreview(null);
          setSelectedIds(new Set());
          await refresh();
          if (tourIdProp) navigate(listHrefForBucket(bucket));
          const count = targetRows.length + silentRows.length;
          showToast(
            skipMessage
              ? count === 1
                ? "Tour deleted."
                : `${count} tours deleted.`
              : count === 1
                ? "Tour deleted and guest notified."
                : `${count} tours deleted and guests notified.`,
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
                deliverViaEmail: channels?.viaEmail !== false,
                deliverViaSms: channels?.viaSms === true,
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
                deliverViaEmail: channels?.viaEmail !== false,
                deliverViaSms: channels?.viaSms === true,
              });
              if (!result.ok) {
                showToast(result.error ?? "Could not propose the new tour time.");
                return;
              }
            }
          }
          setNotifyPreview(null);
          await refresh();
          if (tourIdProp) navigate(listHrefForBucket(bucket));
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
      deleteTourRow,
      listHrefForBucket,
      navigate,
      notifyBusy,
      notifyPreview,
      refresh,
      setSelectedIds,
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
      groupMode={groupMode}
      selectable
      selectedIds={selectedIds}
      onToggleSelected={toggleSelected}
      onToggleCluster={toggleTourCluster}
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
        <div>
          <p className="text-xs font-medium text-muted">Format</p>
          <p className="text-foreground" data-attr="tour-detail-format">{tourFormatLabel(row.tourFormat)}</p>
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
          className={TOUR_DETAIL_ICON_BTN}
          data-attr="tour-detail-message"
          aria-label="Message guest"
          title="Message"
          onClick={() => openGuestMessage(detailRow)}
        >
          <MessageSquare className="size-[18px] shrink-0" aria-hidden />
        </Button>
      ) : null}
      {(isPendingInquiry(detailRow) || isUpcomingPlanned(detailRow)) ? (
        <Button
          type="button"
          variant="outline"
          className={TOUR_DETAIL_ICON_BTN}
          data-attr="tour-detail-reschedule"
          aria-label="Reschedule tour"
          title="Reschedule"
          onClick={() => openReschedulePreview([detailRow])}
        >
          <CalendarClock className="size-[18px] shrink-0" aria-hidden />
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
      {isPendingProposal(detailRow) ? (
        <>
          <Button
            type="button"
            variant="outline"
            className={`${BULK_BAR_BTN} text-rose-800`}
            data-attr="tour-detail-proposal-discard"
            disabled={proposalBusy}
            onClick={() => decideTourProposals([detailRow], "discard")}
          >
            Decline
          </Button>
          <Button
            type="button"
            variant="primary"
            className={BULK_BAR_BTN}
            data-attr="tour-detail-proposal-approve"
            disabled={proposalBusy}
            onClick={() => decideTourProposals([detailRow], "approve")}
          >
            Approve
          </Button>
        </>
      ) : null}
      {detailRow.bucket === "upcoming" && detailRow.source === "planned" ? (
        <Button
          type="button"
          variant="outline"
          className={`${TOUR_DETAIL_ICON_BTN} text-rose-800`}
          data-attr="tour-detail-cancel"
          aria-label="Cancel tour"
          title="Cancel tour"
          onClick={() => openCancelPreview([detailRow])}
        >
          <XCircle className="size-[18px] shrink-0" aria-hidden />
        </Button>
      ) : null}
      {isDeletableTour(detailRow) ? (
        <Button
          type="button"
          variant="outline"
          className={`${TOUR_DETAIL_ICON_BTN} !text-danger`}
          data-attr="tour-detail-delete"
          aria-label="Delete tour"
          title="Delete tour"
          onClick={() => openDeletePrompt([detailRow])}
        >
          <Trash2 className="size-[18px] shrink-0" aria-hidden />
        </Button>
      ) : null}
    </>
  ) : null;

  const messageBulkRow =
    singleSelectedTourRow?.guestEmail?.includes("@") ? singleSelectedTourRow : null;
  const canBulkReschedule =
    selectedTourRows.length > 0 &&
    selectedTourRows.every((row) => isPendingInquiry(row) || isUpcomingPlanned(row)) &&
    !(selectedTourRows.some(isPendingInquiry) && selectedTourRows.some(isUpcomingPlanned));
  const allSelectedPendingInquiry =
    selectedTourRows.length > 0 && selectedTourRows.every(isPendingInquiry);
  const allSelectedPendingProposal =
    selectedTourRows.length > 0 && selectedTourRows.every(isPendingProposal);
  const allSelectedUpcomingPlanned =
    selectedTourRows.length > 0 && selectedTourRows.every(isUpcomingPlanned);

  const listBulkActions =
    selectedTourRows.length > 0 ? (
      <>
        {messageBulkRow ? (
          <Button
            type="button"
            variant="outline"
            className={BULK_BAR_BTN}
            data-attr="tours-bulk-message"
            onClick={() => openGuestMessage(messageBulkRow)}
          >
            Message
          </Button>
        ) : null}
        {canBulkReschedule ? (
          <Button
            type="button"
            variant="outline"
            className={BULK_BAR_BTN}
            data-attr="tours-bulk-reschedule"
            onClick={() => openReschedulePreview(selectedTourRows)}
          >
            Reschedule
          </Button>
        ) : null}
        {bucket === "pending" && allSelectedPendingInquiry ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={BULK_BAR_BTN}
              data-attr="tours-bulk-decline"
              onClick={() => openDeclinePreview(selectedTourRows)}
            >
              Reject
            </Button>
            <Button
              type="button"
              variant="primary"
              className={BULK_BAR_BTN}
              data-attr="tours-bulk-approve"
              onClick={() => openApprovePreview(selectedTourRows)}
            >
              Approve
            </Button>
          </>
        ) : null}
        {bucket === "pending" && allSelectedPendingProposal ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={BULK_BAR_BTN}
              data-attr="tours-bulk-proposal-discard"
              disabled={proposalBusy}
              onClick={() => decideTourProposals(selectedTourRows, "discard")}
            >
              Reject
            </Button>
            <Button
              type="button"
              variant="primary"
              className={BULK_BAR_BTN}
              data-attr="tours-bulk-proposal-approve"
              disabled={proposalBusy}
              onClick={() => decideTourProposals(selectedTourRows, "approve")}
            >
              Approve
            </Button>
          </>
        ) : null}
        {bucket === "upcoming" && allSelectedUpcomingPlanned ? (
          <Button
            type="button"
            variant="outline"
            className={`${BULK_BAR_BTN} text-rose-800`}
            data-attr="tours-bulk-cancel"
            onClick={() => openCancelPreview(selectedTourRows)}
          >
            Cancel tour
          </Button>
        ) : null}
        {selectedTourRows.every(isDeletableTour) ? (
          // `danger` is what the row ⋯ menu keys on to group this under its
          // divider and arm the stray-tap guard.
          <Button
            type="button"
            variant="danger"
            className={BULK_BAR_BTN}
            data-attr="tours-bulk-delete"
            onClick={() => openDeletePrompt(selectedTourRows)}
          >
            Delete
          </Button>
        ) : null}
      </>
    ) : null;

  const notifyPreviewRow = notifyPreview?.rows[0] ?? null;

  const deleteConfirmRow = deleteConfirm?.[0] ?? null;

  const modals = (
    <>
      {deleteConfirm && deleteConfirmRow ? (
        <Modal
          open
          title={deleteConfirm.length === 1 ? "Delete tour" : `Delete ${deleteConfirm.length} tours`}
          onClose={() => {
            if (deleteBusy) return;
            setDeleteConfirm(null);
          }}
          footer={
            <ModalFooter>
              <Button type="button" variant="outline" disabled={deleteBusy} onClick={() => setDeleteConfirm(null)}>
                Keep {deleteConfirm.length === 1 ? "tour" : "tours"}
              </Button>
              <Button
                type="button"
                variant="danger"
                data-attr="tours-delete-confirm"
                disabled={deleteBusy}
                onClick={() => submitDeleteConfirm()}
              >
                {deleteBusy ? "Deleting…" : deleteConfirm.length === 1 ? "Delete tour" : "Delete tours"}
              </Button>
            </ModalFooter>
          }
        >
          <p className="text-sm text-muted" data-attr="tours-delete-confirm-body">
            {deleteConfirm.length === 1
              ? `Delete ${deleteConfirmRow.guestName}'s tour on ${deleteConfirmRow.whenLabel}? It comes off Tours and the calendar. This cannot be undone.`
              : `Delete these ${deleteConfirm.length} tours? They come off Tours and the calendar. This cannot be undone.`}
          </p>
        </Modal>
      ) : null}
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
          <div className="max-h-[min(50vh,20rem)] space-y-4 overflow-y-auto">
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
          confirmLabel="Send message"
          confirmBusy={guestMessageBusy}
          confirmBusyLabel="Sending…"
          onConfirm={(_skip, channels, draft) => void submitGuestMessage(false, channels, draft)}
        />
      ) : null}
    </>
  );

  if (tourIdProp && detailRow) {
    const sections = recordSections("manager", "tour", { basePath, tourBucket: bucket });
    const activeTab = tourDetailTabProp ?? "overview";
    const onHeaderAction = (actionId: string) => {
      if (actionId === "confirm") {
        if (isPendingInquiry(detailRow)) {
          openApprovePreview([detailRow]);
          return;
        }
        if (isPendingProposal(detailRow)) {
          void decideTourProposals([detailRow], "approve");
          return;
        }
        showToast("Coming soon");
        return;
      }
      if (actionId === "reschedule") {
        if (isPendingInquiry(detailRow) || isUpcomingPlanned(detailRow)) {
          openReschedulePreview([detailRow]);
          return;
        }
        showToast("Coming soon");
        return;
      }
      if (actionId === "decline") {
        if (detailRow.bucket === "pending" && detailRow.source === "inquiry") {
          void quickDeclineFromHeader(detailRow);
          return;
        }
        if (isPendingProposal(detailRow)) {
          void decideTourProposals([detailRow], "discard");
          return;
        }
        showToast("Coming soon");
      }
    };
    const sourceLabel =
      detailRow.source === "inquiry" ? "Inquiry" : detailRow.source === "proposal" ? "Proposed" : "Planned";
    const needsConfirm = isPendingInquiry(detailRow) || isPendingProposal(detailRow);
    const ownContent =
      activeTab === "communication" ? (
        renderRecordSection("communication", {
          role: "manager",
          kind: "tour",
          kindLabel: "tour",
          recordId: detailRow.id,
          recordLabel: detailRow.guestName,
          propertyId: detailRow.propertyId,
          contactIds: detailRow.guestEmail ? [detailRow.guestEmail] : undefined,
        })
      ) : (
        <>
          {renderRecordSection("overview", {
            role: "manager",
            kind: "tour",
            kindLabel: "tour",
            recordId: detailRow.id,
            recordLabel: detailRow.guestName,
            overviewTiles: [
              { id: "when", label: "When", value: detailRow.whenLabel },
              { id: "status", label: "Status", value: detailRow.statusLabel, detail: needsConfirm ? "Needs confirm" : undefined, tone: needsConfirm ? "danger" : "default" },
              { id: "prospect", label: "Prospect", value: sourceLabel },
              { id: "room", label: "Room", value: detailRow.roomLabel || detailRow.propertyTitle },
            ],
            overviewNeeds: needsConfirm
              ? [{ id: "confirm", title: "Confirm the tour", detail: detailRow.whenLabel, onClick: () => onHeaderAction("confirm") }]
              : [],
            overviewCards: [
              {
                id: "prospect",
                title: "Prospect",
                rows: [
                  { label: "Name", value: detailRow.guestName },
                  { label: "Email", value: detailRow.guestEmail || "—" },
                  { label: "Phone", value: detailRow.guestPhone || "—" },
                  { label: "Source", value: sourceLabel },
                ],
              },
              {
                id: "listing",
                title: "Listing",
                rows: [
                  { label: "Property", value: detailRow.propertyTitle },
                  { label: "Room", value: detailRow.roomLabel || "—" },
                  { label: "Format", value: tourFormatLabel(detailRow.tourFormat) },
                ],
              },
            ],
          })}
          {renderDetailPanel(detailRow)}
          {detailActions ? (
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3 sm:px-4" data-attr="tour-overview-actions">
              {detailActions}
            </div>
          ) : null}
        </>
      );
    return (
      <>
        {modals}
        <PortalRecordDetailPage
          pageTitle="Tours"
          title={detailRow.guestName}
          subtitle={detailRow.whenLabel}
          avatarName={detailRow.guestName}
          backHref={listHrefForBucket(bucket)}
          backLabel="Back to tours"
          hideBackText
          bareHeader
          iconTitleActions
          dataAttrBack="tour-detail-back"
          pinScrollBody
        >
          <PortalRecordActions>
            <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onHeaderAction} />
          </PortalRecordActions>
          <PortalRecordSectionChrome
            sections={sections}
            recordId={detailRow.id}
            activeId={activeTab}
            title={detailRow.guestName}
            subtitle={detailRow.whenLabel}
            backHref={listHrefForBucket(bucket)}
            backLabel="All tours"
            ariaLabel="Tour sections"
            onHeaderAction={onHeaderAction}
          >
            {ownContent}
          </PortalRecordSectionChrome>
        </PortalRecordDetailPage>
      </>
    );
  }

  const listPageContent = (
    <>
      {modals}

      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={tabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: listHrefForBucket(tab.id),
          count: tab.count,
          alert: tab.alert,
          dataAttr: `tours-bucket-${tab.id}`,
        }))}
        activeDestinationId={bucket}
        destinationAriaLabel="Tour status"
        search={{ value: tourSearch, onChange: setTourSearch, placeholder: "Search tours", dataAttr: "tours-search" }}
        actions={
          <>
            {filterSheet}
            <FinancesExportMenu items={toursExportItems} />
            <PortalIconAction
              icon={CalendarPlus}
              label="Add availability"
              data-attr="tours-add-availability-open"
              onClick={() => setAvailabilityOpen(true)}
              // Not gated on `!authReady`: the sibling "Share tour link"
              // action beside it (below) never was, and pre-disabling on a
              // transient session check — rather than the real "no listed
              // property yet" reason — read as a permanently broken button
              // for that brief window (night UX sweep).
              disabled={scopedPropertyIds.length === 0}
            />
            <PortalIconAction
              icon={Settings}
              label={toursSettingsEntry.label}
              data-attr={toursSettingsEntry.dataAttr}
              onClick={() => setSettingsOpen(true)}
            />
            <PortalIconAction
              icon={Share2}
              label="Share tour link"
              disabled={scopedPropertyIds.length === 0}
              data-attr="tours-share-open"
              onClick={() => setShareTourOpen(true)}
            />
          </>
        }
        primary={
          <PortalPrimaryIconAction
            label="Add tour"
            disabled={scopedPropertyIds.length === 0}
            data-attr="tours-add-open"
            onClick={() => setAddTourOpen(true)}
          />
        }
        activeFilterChips={activeFilterChips}
      />

      <PortalRecordListSurface
        isEmpty={authReady && rowsForBucket.length === 0}
        emptyCard={
          tourSearch.trim()
            ? {
                title: portalEmptyNoMatchTitle("tours", tourSearch),
                section: "tours",
                tone: "muted",
                clear: { label: "Clear search", onClick: () => setTourSearch(""), dataAttr: "tours-empty-clear-search" },
              }
            : filterTouchCount > 0
            ? {
                title: portalEmptyNoMatchTitle("tours"),
                section: "tours",
                tone: "muted",
                clear: { label: "Clear filters", onClick: () => setPropertyFilters([]), dataAttr: "tours-empty-clear-filters" },
              }
            : {
                title: portalEmptyCopy(`tours.${bucket}` as PortalEmptyCopyKey).title,
                section: "tours",
                sibling: portalEmptySibling(
                  tabs.map((t) => ({ id: t.id, label: t.label, count: t.count, href: listHrefForBucket(t.id) })),
                  bucket,
                ),
                // Past tours are history; only the live tabs offer the pill.
                actions:
                  bucket === "past"
                    ? []
                    : [
                        {
                          label: "Schedule tour",
                          onClick: () => setAddTourOpen(true),
                          disabled: scopedPropertyIds.length === 0,
                          reason: scopedPropertyIds.length === 0 ? "List a property first — tours are booked against a listing." : undefined,
                          dataAttr: "tours-list-add",
                        },
                      ],
              }
        }
        onBulkClear={() => setSelectedIds(new Set())}
        bulkCount={selectedIds.size}
        bulkActions={listBulkActions}
      >
        {!authReady ? (
          <p className="text-sm text-muted">Loading tours…</p>
        ) : rowsForBucket.length > 0 ? (
          renderGroupedTours()
        ) : null}
      </PortalRecordListSurface>

      <ShareLeadLinkModal
        open={shareTourOpen}
        onClose={() => setShareTourOpen(false)}
        kind="tour"
        properties={
          scopedPropertyId
            ? propertyOptions.filter((option) => option.id === scopedPropertyId)
            : propertyOptions
        }
        preselectedPropertyId={scopedPropertyId}
      />
      {addTourOpen ? (
        <AddResidentWizard
          mode="tour"
          onClose={() => setAddTourOpen(false)}
          managerUserId={userId ?? null}
          propertyOptions={propertyOptions}
          propertyTick={propertyTick}
          executedLeaseKeys={EMPTY_LEASE_KEYS}
          defaultPropertyId={scopedPropertyId}
          onAdded={() => {
            void refresh();
            if (bucket !== "upcoming") {
              navigate(listHrefForBucket("upcoming"));
            }
          }}
        />
      ) : null}
      <ManagerTourAvailabilityModal
        open={availabilityOpen}
        onClose={() => setAvailabilityOpen(false)}
        managerUserId={userId}
        propertyId={scopedPropertyId}
        propertyLabel={scopedPropertyLabel}
        propertyOptions={propertyOptions}
        showToast={showToast}
      />
      <ManagerPortalSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialTab="tours"
        scopedTitle={settingsDialogTitlePrefix(toursSettingsEntry)}
      />
    </>
  );

  if (embedded) {
    return listPageContent;
  }

  return (
    <ManagerPortalPageShell
      title="Tours"

      hideTitleOnMobileNav
      titleInlineFilter={null}
      compactFilterRow
    >
      {listPageContent}
    </ManagerPortalPageShell>
  );
}
