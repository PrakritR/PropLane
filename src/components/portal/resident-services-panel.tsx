"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input, Textarea } from "@/components/ui/input";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListAddRow, PORTAL_LIST_ADD_ICONS, PORTAL_LIST_ADD_ROW_WRAP_CLASS } from "@/components/portal/portal-list-add-row";
import { ResidentAddServiceModal } from "@/components/portal/resident-add-service-modal";
import { formatPacificDate } from "@/lib/pacific-time";
import { Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ManagerPortalPageShell,
  PORTAL_INLINE_UNLOCK_NOTICE_CLASS,
  PORTAL_INLINE_UNLOCK_NOTICE_STACKED_CLASS,
} from "@/components/portal/portal-metrics";
import { ResidentPortalListBottomBar } from "@/components/portal/resident-portal-list-bottom-bar";
import {
  ResidentPortalGroupedDataList,
  RESIDENT_PORTAL_DEFAULT_GROUP_MODE,
  type ResidentPortalGroupableRow,
} from "@/components/portal/resident-portal-grouped-data-list";
import type { PortalListGroupMode } from "@/lib/portal-list-grouping";
import {
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { PreferredArrivalField } from "@/components/portal/preferred-arrival-field";
import { formatPreferredArrival, parsePreferredArrival } from "@/lib/preferred-arrival";
import type { DemoManagerWorkOrderRow, ResidentWorkBucket } from "@/data/demo-portal";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  MANAGER_WORK_ORDERS_EVENT,
  deleteManagerWorkOrderRow,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
  updateManagerWorkOrder,
} from "@/lib/manager-work-orders-storage";
import { readManagerApplicationRows, syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";
import {
  PROPERTY_PIPELINE_EVENT,
  loadResidentPropertyFromServer,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import type { ManagerListingServiceOption } from "@/lib/manager-listing-submission";
import { normalizeManagerListingSubmissionV1, mergeResidentServiceCatalogOffers } from "@/lib/manager-listing-submission";
import { pickPrimaryFilingScope } from "@/lib/resident-filing-scope";
import { getPropertyById } from "@/lib/rental-application/data";
import { RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS } from "@/lib/resident-work-order-reminder-email";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { ENTRY_PERMISSION_OPTIONS, entryPermissionLabel } from "@/lib/work-order-entry";
import {
  SERVICE_REQUESTS_EVENT,
  deleteServiceRequest,
  readServiceRequestsForResident,
  syncServiceRequestsFromServer,
  updateServiceRequest,
  hasDeposit,
  isServiceRequestFeePaid,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import {
  buildUnifiedServiceRows,
  countServiceRowsByState,
  type ServiceRowState,
  type UnifiedServiceRow,
} from "@/lib/unified-service-rows";
import type { PortalAdaptiveAction } from "@/components/portal/portal-adaptive-action-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import {
  LEASE_PIPELINE_EVENT,
  findLeaseForResidentEmail,
  hasBothLeaseSignatures,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";

const SERVICE_STATE_TABS: { id: ServiceRowState; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "scheduled", label: "Scheduled" },
  { id: "done", label: "Done" },
  { id: "declined", label: "Declined" },
];

function unifiedServiceRowKey(row: Pick<UnifiedServiceRow, "kind" | "id">): string {
  return `${row.kind}::${row.id}`;
}

function parseUnifiedServiceRowKey(key: string): { kind: UnifiedServiceRow["kind"]; id: string } | null {
  const splitAt = key.indexOf("::");
  if (splitAt <= 0) return null;
  const kind = key.slice(0, splitAt) as UnifiedServiceRow["kind"];
  if (kind !== "add-on" && kind !== "maintenance") return null;
  return { kind, id: key.slice(splitAt + 2) };
}

type ResidentServiceListRowData =
  | { unified: UnifiedServiceRow; req: ServiceRequest }
  | { unified: UnifiedServiceRow; row: DemoManagerWorkOrderRow };

export type WorkOrderFilterBucket = "pending" | "scheduled" | "completed";

export const WORK_ORDER_FILTER_TABS: { id: WorkOrderFilterBucket; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
];

export function workOrderFilterBucket(row: DemoManagerWorkOrderRow): WorkOrderFilterBucket {
  if (row.bucket === "completed") return "completed";
  if (row.bucket === "scheduled") return "scheduled";
  return "pending";
}

export type RequestStatusBucket = "pending" | "completed" | "denied";

export const REQUEST_STATUS_TABS: { id: RequestStatusBucket; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "completed", label: "Completed" },
  { id: "denied", label: "Denied" },
];

/** @deprecated Counts are no longer shown on status pills — returns the label only. */
export function pillLabelWithCount(label: string, _count: number): string {
  return label;
}

export type UnifiedItem =
  | { kind: "request"; req: ServiceRequest; sortKey: number }
  | { kind: "work-order"; row: DemoManagerWorkOrderRow; sortKey: number };

// Add-on service requests: pending while awaiting manager action; approved/returned → completed; denied → denied.
export function serviceRequestStatusBucket(req: ServiceRequest): RequestStatusBucket {
  if (req.status === "pending") return "pending";
  if (req.status === "denied") return "denied";
  return "completed";
}

export function unifiedItemStatusBucket(item: UnifiedItem): RequestStatusBucket {
  if (item.kind === "request") return serviceRequestStatusBucket(item.req);
  if (item.row.bucket === "completed") return "completed";
  return "pending";
}

// Restrict photo links to http(s) or inline image data URLs before they reach an
// <a href> / <Image src> sink — inlined as a guard clause at each call site so
// CodeQL's xss-through-dom barrier recognition sees the check (see commit 924bd45
// for the same fix pattern elsewhere).
const SAFE_PHOTO_HREF_RE = /^(?:data:image\/|https?:\/\/)/;

function priorityClass(p: string) {
  const x = p.toLowerCase();
  if (x === "emergency" || x === "high") return "portal-badge-danger ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  if (x === "medium") return "portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  return "bg-accent/30 text-muted ring-1 ring-border";
}

function isSetWorkOrderCost(cost: string | undefined): boolean {
  const trimmed = cost?.trim() ?? "";
  return trimmed !== "" && trimmed !== "—";
}

function displayWorkOrderCost(cost: string | undefined): string {
  return isSetWorkOrderCost(cost) ? (cost ?? "") : "—";
}

function displayServiceRequestCost(req: ServiceRequest): string {
  if (req.price?.trim()) return req.price.trim();
  if (req.priceLimit?.trim()) return req.priceLimit.trim();
  return "—";
}

export function formatDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatPacificDate(d, { month: "short", day: "numeric", year: "numeric" });
}

export function ServiceStatusBadge({
  status,
  neutral = false,
}: {
  status: ServiceRequest["status"];
  neutral?: boolean;
}) {
  if (status === "pending") return null;
  const label =
    status === "approved" ? "Approved" : status === "denied" ? "Denied" : status === "returned" ? "Return submitted" : null;
  if (!label) return null;
  if (neutral) {
    return <span className="text-xs font-medium text-muted">{label}</span>;
  }
  if (status === "approved")
    return (
      <span className="rounded-full portal-badge-info px-2.5 py-0.5 text-[10px] font-semibold">
        Approved
      </span>
    );
  if (status === "denied")
    return (
      <span className="rounded-full px-2.5 py-0.5 text-[10px] font-semibold portal-badge-danger ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]">
        Denied
      </span>
    );
  if (status === "returned")
    return (
      <span className="rounded-full px-2.5 py-0.5 text-[10px] font-semibold portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]">
        Return submitted
      </span>
    );
  return null;
}

const WORK_ORDER_BUCKET_LABEL: Record<ResidentWorkBucket, string> = {
  open: "Pending",
  scheduled: "Scheduled",
  completed: "Completed",
};

export function WorkOrderStatusBadge({ bucket, neutral = false }: { bucket: ResidentWorkBucket; neutral?: boolean }) {
  const label = WORK_ORDER_BUCKET_LABEL[bucket];
  if (neutral) {
    return <span className="text-xs font-medium text-muted">{label}</span>;
  }
  const cls =
    bucket === "completed"
      ? "portal-badge-success"
      : "portal-badge-info";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${cls} ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]`}>
      {WORK_ORDER_BUCKET_LABEL[bucket]}
    </span>
  );
}

/** Service fee summary for a request row (payments live on the Payments tab). */
export function requestChargesSummary(req: ServiceRequest): string {
  if (req.price?.trim()) {
    const paid = isServiceRequestFeePaid(req);
    if (req.status === "pending") return `Service fee ${req.price.trim()}`;
    return `Service fee ${req.price.trim()} · ${paid ? "Paid" : "Pending"}`;
  }
  if (req.priceLimit?.trim()) return `Price limit ${req.priceLimit.trim()}`;
  return "—";
}

export function ServiceRequestCard({
  req,
  onDelete,
  onEdit,
  onSendReminder,
  reminderSending = false,
}: {
  req: ServiceRequest;
  onDelete: () => void;
  onEdit: () => void;
  onSendReminder?: () => void;
  reminderSending?: boolean;
}) {
  const { showToast } = useAppUi();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const reminderCooldownMs =
    req.status === "pending" ? residentServiceRequestReminderCooldownMs(req) : 0;
  const reminderDisabled = reminderSending || reminderCooldownMs > 0;

  function removeRequest() {
    deleteServiceRequest(req.id);
    setDeleteOpen(false);
    onDelete();
    showToast("Request deleted.");
  }

  const feePaid = isServiceRequestFeePaid(req);

  return (
    <>
      {req.offerDescription ? (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Description</p>
          <p className="mt-1.5 text-sm whitespace-pre-wrap leading-relaxed">{req.offerDescription}</p>
        </>
      ) : null}
      {req.price ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Service fee</p>
          <p className="mt-1 text-sm font-medium text-foreground">{req.price}</p>
        </>
      ) : req.priceLimit?.trim() ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Price limit</p>
          <p className="mt-1 text-sm font-medium text-foreground">{req.priceLimit.trim()}</p>
          {req.status === "pending" ? (
            <p className="mt-1 text-xs text-muted">Your manager will confirm the final price before approving.</p>
          ) : null}
        </>
      ) : null}
      {hasDeposit(req.deposit) ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Deposit</p>
          <p className="mt-1 text-sm font-medium text-foreground">{req.deposit}</p>
        </>
      ) : null}
      {req.notes ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Notes</p>
          <p className="mt-1.5 text-sm whitespace-pre-wrap leading-relaxed">{req.notes}</p>
        </>
      ) : null}

      {req.status === "approved" && req.price?.trim() && !feePaid ? (
        <p className="mt-3 text-xs text-muted">
          Pay the service fee under <span className="font-medium text-foreground">Payments</span> when your manager approves the final amount.
        </p>
      ) : null}

      {req.status === "returned" && req.returnPhotoDataUrl ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Return photo</p>
          <a href={req.returnPhotoDataUrl} target="_blank" rel="noreferrer" className="mt-2 block w-32 overflow-hidden rounded-xl border border-border">
            <Image
              src={req.returnPhotoDataUrl}
              alt="Return photo"
              width={128}
              height={96}
              className="h-24 w-full object-cover"
              unoptimized
            />
          </a>
          <p className="mt-1.5 text-xs text-muted">
            {req.depositPaid
              ? "Deposit refunded. Return complete."
              : "Awaiting manager review to refund deposit."}
          </p>
        </>
      ) : null}

      {req.status === "denied" ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Manager note</p>
          <p className="mt-1.5 text-sm text-muted">
            {req.managerNote ?? "This request was not approved. Contact your property manager for details."}
          </p>
        </>
      ) : null}

      <PortalTableDetailActions>
        {req.status === "pending" && onSendReminder ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="resident-service-request-send-reminder"
            disabled={reminderDisabled}
            onClick={onSendReminder}
          >
            {reminderSending ? "Sending…" : reminderCooldownMs > 0 ? "Reminder sent" : "Send reminder"}
          </Button>
        ) : null}
        {req.status === "pending" ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="resident-service-request-edit"
            onClick={onEdit}
          >
            Edit service
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          onClick={() => setDeleteOpen(true)}
        >
          Delete request
        </Button>
      </PortalTableDetailActions>

      <ConfirmDeleteModal
        open={deleteOpen}
        title="Delete request"
        description={`Delete “${req.offerName}”?`}
        confirmLabel="Delete request"
        dataAttr="resident-service-request-delete-confirm"
        onClose={() => setDeleteOpen(false)}
        onConfirm={removeRequest}
      />
    </>
  );
}

function residentServiceRequestReminderCooldownMs(req: ServiceRequest, now = Date.now()): number {
  const sentAt = req.residentReminderSentAt?.trim();
  if (!sentAt) return 0;
  const ts = Date.parse(sentAt);
  if (!Number.isFinite(ts)) return 0;
  const elapsed = now - ts;
  if (elapsed >= RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS) return 0;
  return RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS - elapsed;
}

function residentWorkOrderReminderCooldownMs(row: DemoManagerWorkOrderRow, now = Date.now()): number {
  const sentAt = row.residentReminderSentAt?.trim();
  if (!sentAt) return 0;
  const ts = Date.parse(sentAt);
  if (!Number.isFinite(ts)) return 0;
  const elapsed = now - ts;
  if (elapsed >= RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS) return 0;
  return RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS - elapsed;
}

export function WorkOrderDetail({
  row,
  onEdit,
  onCancel,
  onSendReminder,
  reminderSending = false,
}: {
  row: DemoManagerWorkOrderRow;
  onEdit: () => void;
  onCancel: () => void;
  onSendReminder?: () => void;
  reminderSending?: boolean;
}) {
  const canModify = row.bucket === "open";
  const reminderCooldownMs = canModify ? residentWorkOrderReminderCooldownMs(row) : 0;
  const reminderDisabled = reminderSending || reminderCooldownMs > 0;
  const [cancelOpen, setCancelOpen] = useState(false);
  return (
    <>
      {row.reference ? (
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Work order</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">{row.reference}</p>
        </div>
      ) : null}
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Priority</p>
      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${priorityClass(row.priority)}`}>{row.priority}</span>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Preferred arrival</p>
      <p className="mt-1 text-sm font-medium text-foreground">{row.preferredArrival ?? "Anytime"}</p>
      {row.entryPermission || row.entryNotes ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Entry</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {entryPermissionLabel(row.entryPermission)}
            {row.entryNotes ? ` (${row.entryNotes})` : ""}
          </p>
        </>
      ) : null}
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Details</p>
      <p className="mt-1.5 text-sm whitespace-pre-wrap leading-relaxed">{row.description}</p>
      {row.scheduled && row.scheduled !== "—" ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Visit</p>
          <p className="mt-1 text-sm font-medium text-foreground">{row.scheduled}</p>
        </>
      ) : null}
      {row.cost && row.cost !== "—" ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Cost</p>
          <p className="mt-1 text-sm font-medium text-foreground">{row.cost}</p>
        </>
      ) : null}
      {row.photoDataUrls?.length ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Photos</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {row.photoDataUrls.map((src, i) => {
              const trimmed = src.trim();
              if (!SAFE_PHOTO_HREF_RE.test(trimmed)) return null;
              return (
                <a key={i} href={trimmed} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border bg-accent/30">
                  <Image src={trimmed} alt={`Photo ${i + 1}`} width={240} height={180} className="h-28 w-full object-cover" unoptimized />
                </a>
              );
            })}
          </div>
        </>
      ) : null}
      {canModify ? (
        <PortalTableDetailActions>
          {onSendReminder ? (
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              data-attr="resident-work-order-send-reminder"
              disabled={reminderDisabled}
              onClick={onSendReminder}
            >
              {reminderSending ? "Sending…" : reminderCooldownMs > 0 ? "Reminder sent" : "Send reminder"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="resident-work-order-edit"
            onClick={onEdit}
          >
            Edit service
          </Button>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            onClick={() => setCancelOpen(true)}
          >
            Cancel work order
          </Button>
        </PortalTableDetailActions>
      ) : null}

      <ConfirmDeleteModal
        open={cancelOpen}
        title="Cancel work order"
        description={`Cancel work order “${row.title || row.id}”?`}
        confirmLabel="Cancel work order"
        dataAttr="resident-work-order-cancel-confirm"
        onClose={() => setCancelOpen(false)}
        onConfirm={() => {
          setCancelOpen(false);
          onCancel();
        }}
      />
    </>
  );
}

/**
 * Unified Services list for residents.
 */
export function ResidentServicesPanel({
  basePath,
}: {
  basePath: string;
}) {
  const { showToast } = useAppUi();
  const session = usePortalSession();

  const [serviceStateFilter, setServiceStateFilter] = useState<ServiceRowState>("open");
  const groupMode: PortalListGroupMode = RESIDENT_PORTAL_DEFAULT_GROUP_MODE;
  const { selectedIds, toggleSelected, clearSelection, setSelectedIds } = usePortalRowSelection(serviceStateFilter);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addServiceOpen, setAddServiceOpen] = useState(false);

  // edit modals (resident edits their own items)
  const [editingRequest, setEditingRequest] = useState<ServiceRequest | null>(null);
  const [eNotes, setENotes] = useState("");
  const [editingWorkOrder, setEditingWorkOrder] = useState<DemoManagerWorkOrderRow | null>(null);
  const [wTitle, setWTitle] = useState("");
  const [wPriority, setWPriority] = useState("Medium");
  const [wArrivalPreset, setWArrivalPreset] = useState("Anytime");
  const [wArrivalCustom, setWArrivalCustom] = useState("");
  const [wEntryPermission, setWEntryPermission] = useState<DemoManagerWorkOrderRow["entryPermission"]>("call_first");
  const [wEntryNotes, setWEntryNotes] = useState("");
  const [wDetails, setWDetails] = useState("");
  const [reminderSendingId, setReminderSendingId] = useState<string | null>(null);
  const [requestReminderSendingId, setRequestReminderSendingId] = useState<string | null>(null);

  const [allRows, setAllRows] = useState<DemoManagerWorkOrderRow[]>([]);
  const [serviceRequests, setServiceRequests] = useState<ServiceRequest[]>([]);
  const [srTick, setSrTick] = useState(0);
  const [leaseTick, setLeaseTick] = useState(0);
  const [appTick, setAppTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  /** Catalog from `/api/portal/resident-property` — authoritative for resident offers. */
  const [serverCatalogOffers, setServerCatalogOffers] = useState<ManagerListingServiceOption[] | null>(null);
  /** Authoritative manager/property from the same hydrate (beats local app-row order). */
  const [serverFilingScope, setServerFilingScope] = useState<{
    managerUserId: string;
    propertyId: string;
  } | null>(null);

  const residentEmail = session.email?.trim().toLowerCase() ?? "";

  function reloadServiceRequests() {
    if (!residentEmail) {
      setServiceRequests([]);
      return;
    }
    setServiceRequests(readServiceRequestsForResident(residentEmail));
  }

  // Prefer approved + canonical demo portfolio over guided-tour mirrors when
  // the sandbox resident is approved under both managers.
  const residentApplication = useMemo(() => {
    void allRows;
    void appTick;
    if (!residentEmail) return null;
    const matches = readManagerApplicationRows().filter(
      (r) => r.email?.trim().toLowerCase() === residentEmail,
    );
    const candidates = matches.map((r) => ({
      managerUserId: String(r.managerUserId ?? "").trim(),
      propertyId:
        r.assignedPropertyId?.trim() ||
        r.propertyId?.trim() ||
        r.application?.propertyId?.trim() ||
        "",
      approved: r.bucket === "approved",
      row: r,
    }));
    const primary = pickPrimaryFilingScope(
      candidates.map(({ managerUserId, propertyId, approved }) => ({
        managerUserId,
        propertyId,
        approved,
      })),
      serverFilingScope
        ? {
            managerUserId: serverFilingScope.managerUserId,
            propertyId: serverFilingScope.propertyId,
          }
        : undefined,
    );
    if (primary) {
      return (
        candidates.find(
          (c) =>
            c.managerUserId === primary.managerUserId && c.propertyId === primary.propertyId,
        )?.row ??
        matches.find((r) => String(r.managerUserId ?? "").trim() === primary.managerUserId) ??
        null
      );
    }
    return matches.find((r) => r.bucket === "approved") ?? matches[0] ?? null;
  }, [residentEmail, allRows, appTick, serverFilingScope]);

  const visibleToResident = (o: { available: boolean; residentEmails?: string[] }) => {
    if (!o.available) return false;
    if (!o.residentEmails?.length) return true;
    return o.residentEmails.some((e) => e.trim().toLowerCase() === residentEmail);
  };

  // Prefer server catalog (includes unpublished properties); fall back to local
  // cached property lookup while the hydrate is in flight.
  const offersForResident = useMemo(() => {
    void propertyTick;
    let catalog: ManagerListingServiceOption[] = [];
    if (serverCatalogOffers) {
      catalog = serverCatalogOffers.filter(visibleToResident);
    } else if (residentApplication) {
      const propertyId =
        residentApplication.assignedPropertyId?.trim() ||
        residentApplication.propertyId?.trim() ||
        residentApplication.application?.propertyId?.trim() ||
        "";
      if (propertyId) {
        const property = getPropertyById(propertyId);
        if (property?.listingSubmission && property.listingSubmission.v === 1) {
          catalog = (normalizeManagerListingSubmissionV1(property.listingSubmission).serviceRequestOptions ?? [])
            .filter(visibleToResident);
        }
      }
    }
    return mergeResidentServiceCatalogOffers(catalog);
  }, [propertyTick, residentApplication, residentEmail, serverCatalogOffers]);

  const availableOffers = offersForResident;

  // Initial data sync — fire syncs sequentially to avoid overwhelming the server/browser
  useEffect(() => {
    const sync = () => setAllRows(readManagerWorkOrderRows());
    const onProperty = () => setPropertyTick((t) => t + 1);
    queueMicrotask(() => sync());
    void syncManagerWorkOrdersFromServer()
      .then(sync)
      .then(() => syncManagerApplicationsFromServer())
      .then(() => setAppTick((t) => t + 1))
      .then(() => syncPropertyPipelineFromServer())
      .then(() => setPropertyTick((t) => t + 1))
      .then(() => syncLeasePipelineFromServer())
      // The resident/admin-scoped sync above never returns a resident's own
      // property (it's scoped to properties the caller manages), so hydrate
      // it separately — needed for e.g. manager-offered add-on service requests.
      .then(() => loadResidentPropertyFromServer())
      .then((loaded) => {
        if (loaded) {
          setServerCatalogOffers(loaded.serviceRequestOptions);
          if (loaded.managerUserId && loaded.propertyId) {
            setServerFilingScope({
              managerUserId: loaded.managerUserId,
              propertyId: loaded.propertyId,
            });
          } else {
            setServerFilingScope(null);
          }
        } else {
          setServerCatalogOffers([]);
          setServerFilingScope(null);
        }
        setPropertyTick((t) => t + 1);
      });
    
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProperty);
    return () => {
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProperty);
    };
  }, []);

  useEffect(() => {
    queueMicrotask(() => reloadServiceRequests());
    void syncServiceRequestsFromServer();
    const onSr = () => setSrTick((t) => t + 1);
    window.addEventListener(SERVICE_REQUESTS_EVENT, onSr);
    return () => {
      window.removeEventListener(SERVICE_REQUESTS_EVENT, onSr);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [residentEmail]);

  useEffect(() => {
    const onLease = () => setLeaseTick((t) => t + 1);
    window.addEventListener(LEASE_PIPELINE_EVENT, onLease);
    return () => {
      window.removeEventListener(LEASE_PIPELINE_EVENT, onLease);
    };
  }, []);

  useEffect(() => {
    queueMicrotask(() => reloadServiceRequests());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srTick]);

  // Only show maintenance work orders (not old service type rows)
  const myRows = useMemo(() => {
    if (!residentEmail) return [];
    return allRows.filter(
      (r) =>
        r.residentEmail?.trim().toLowerCase() === residentEmail &&
        (r as DemoManagerWorkOrderRow & { requestType?: string }).requestType !== "service",
    );
  }, [allRows, residentEmail]);

  const sortedRequests = useMemo(
    () =>
      [...serviceRequests].sort((a, b) => {
        const ta = new Date(a.requestedAt).getTime();
        const tb = new Date(b.requestedAt).getTime();
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
      }),
    [serviceRequests],
  );

  const unifiedServiceRows = useMemo(
    () =>
      buildUnifiedServiceRows({
        addOns: sortedRequests,
        maintenance: myRows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          bucket: row.bucket,
          residentName: row.residentName,
          residentEmail: row.residentEmail,
          propertyId: row.propertyId,
          propertyName: row.propertyName,
          unit: row.unit,
          scheduledAtIso: row.scheduledAtIso,
        })),
        propertyLabelForRequest: (propertyId) =>
          getPropertyById(propertyId)?.buildingName?.trim() || null,
      }),
    [sortedRequests, myRows],
  );

  const serviceStateCounts = useMemo(
    () => countServiceRowsByState(unifiedServiceRows),
    [unifiedServiceRows],
  );

  const filteredUnifiedRows = useMemo(
    () => unifiedServiceRows.filter((row) => row.state === serviceStateFilter),
    [unifiedServiceRows, serviceStateFilter],
  );


  const serviceRequestById = useMemo(
    () => new Map(sortedRequests.map((req) => [req.id, req])),
    [sortedRequests],
  );

  const workOrderById = useMemo(() => new Map(myRows.map((row) => [row.id, row])), [myRows]);

  function openRequestEdit(req: ServiceRequest) {
    setEditingRequest(req);
    setENotes(req.notes);
  }

  function saveRequestEdit() {
    if (!editingRequest) return;
    updateServiceRequest(editingRequest.id, {
      notes: eNotes.trim(),
    });
    setEditingRequest(null);
    reloadServiceRequests();
    showToast("Request updated.");
  }

  function openWorkOrderEdit(row: DemoManagerWorkOrderRow) {
    setEditingWorkOrder(row);
    setWTitle(row.title);
    setWPriority(row.priority || "Medium");
    const parsed = parsePreferredArrival(row.preferredArrival);
    setWArrivalPreset(parsed.preset);
    setWArrivalCustom(parsed.custom);
    setWEntryPermission(row.entryPermission ?? "call_first");
    setWEntryNotes(row.entryNotes ?? "");
    setWDetails(row.description);
  }

  function saveWorkOrderEdit() {
    if (!editingWorkOrder) return;
    if (!wTitle.trim()) {
      showToast("Add a title first.");
      return;
    }
    updateManagerWorkOrder(editingWorkOrder.id, (r) => ({
      ...r,
      title: wTitle.trim(),
      priority: wPriority,
      preferredArrival: formatPreferredArrival(wArrivalPreset, wArrivalCustom),
      entryPermission: wEntryPermission,
      entryNotes: wEntryNotes.trim() || undefined,
      description: wDetails.trim() || r.description,
    }));
    setAllRows(readManagerWorkOrderRows());
    setEditingWorkOrder(null);
    showToast("Work order updated.");
  }

  function cancelWorkOrder(id: string) {
    deleteManagerWorkOrderRow(id);
    setAllRows(readManagerWorkOrderRows());
    setExpandedId(null);
    showToast("Work order removed.");
  }

  async function sendWorkOrderReminder(row: DemoManagerWorkOrderRow) {
    if (reminderSendingId) return;
    if (isDemoModeActive()) {
      showToast("Reminder sent (demo).");
      return;
    }
    setReminderSendingId(row.id);
    try {
      const res = await fetch("/api/portal/work-orders/send-reminder", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId: row.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not send reminder.");
        return;
      }
      await syncManagerWorkOrdersFromServer({ force: true });
      setAllRows(readManagerWorkOrderRows());
      showToast("Reminder sent to your property manager.");
    } catch {
      showToast("Could not send reminder.");
    } finally {
      setReminderSendingId(null);
    }
  }

  async function sendServiceRequestReminder(req: ServiceRequest) {
    if (requestReminderSendingId) return;
    if (isDemoModeActive()) {
      showToast("Reminder sent (demo).");
      return;
    }
    setRequestReminderSendingId(req.id);
    try {
      const res = await fetch("/api/portal/service-requests/send-reminder", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: req.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not send reminder.");
        return;
      }
      await syncServiceRequestsFromServer({ force: true });
      reloadServiceRequests();
      showToast("Reminder sent to your property manager.");
    } catch {
      showToast("Could not send reminder.");
    } finally {
      setRequestReminderSendingId(null);
    }
  }

  const residentLeaseRow = useMemo(() => {
    void leaseTick;
    if (!residentEmail) return null;
    return findLeaseForResidentEmail(residentEmail);
  }, [leaseTick, residentEmail]);

  const servicesUnlocked = Boolean(residentLeaseRow && hasBothLeaseSignatures(residentLeaseRow));

  if (!servicesUnlocked && addServiceOpen) {
    setAddServiceOpen(false);
  }

  function getApplication() {
    if (residentApplication) return residentApplication;
    const matches = readManagerApplicationRows().filter(
      (r) => r.email?.trim().toLowerCase() === residentEmail,
    );
    const primary = pickPrimaryFilingScope(
      matches.map((r) => ({
        managerUserId: String(r.managerUserId ?? "").trim(),
        propertyId:
          r.assignedPropertyId?.trim() ||
          r.propertyId?.trim() ||
          r.application?.propertyId?.trim() ||
          "",
        approved: r.bucket === "approved",
      })),
      serverFilingScope ?? undefined,
    );
    if (primary) {
      return (
        matches.find(
          (r) =>
            String(r.managerUserId ?? "").trim() === primary.managerUserId &&
            (r.assignedPropertyId?.trim() ||
              r.propertyId?.trim() ||
              r.application?.propertyId?.trim() ||
              "") === primary.propertyId,
        ) ??
        matches.find((r) => String(r.managerUserId ?? "").trim() === primary.managerUserId) ??
        matches[0]
      );
    }
    return matches.find((r) => r.bucket === "approved") ?? matches[0];
  }

  function resolveFilingIds(): { propertyId: string; managerUserId: string } {
    if (serverFilingScope?.propertyId && serverFilingScope.managerUserId) {
      return serverFilingScope;
    }
    const application = getApplication();
    const propertyId =
      application?.assignedPropertyId?.trim() ||
      application?.propertyId?.trim() ||
      application?.application?.propertyId?.trim() ||
      "";
    let managerUserId = application?.managerUserId?.trim() || "";
    if (!managerUserId && propertyId) {
      managerUserId = getPropertyById(propertyId)?.managerUserId?.trim() || "";
    }
    return { propertyId, managerUserId };
  }

  const openAddService = () => {
    if (!servicesUnlocked) {
      showToast("Services unlock after your lease is fully signed.");
      return;
    }
    setAddServiceOpen(true);
  };

  const serviceGroupedItems = useMemo((): ResidentPortalGroupableRow<ServiceRequest | DemoManagerWorkOrderRow>[] => {
    const showPropertyInMeta = groupMode !== "house";
    return filteredUnifiedRows.flatMap((unified): ResidentPortalGroupableRow<ServiceRequest | DemoManagerWorkOrderRow>[] => {
      const rowKey = unifiedServiceRowKey(unified);
      const propertyLabel = unified.propertyLabel?.trim() || unified.propertyId || "Property";
      if (unified.kind === "add-on") {
        const req = serviceRequestById.get(unified.id);
        if (!req) return [];
        const isExpanded = expandedId === rowKey;
        return [
          {
            id: rowKey,
            propertyId: unified.propertyId,
            propertyLabel,
            dataListRow: {
              id: rowKey,
              data: req,
              primary: req.offerName,
              meta: [
                showPropertyInMeta ? propertyLabel : null,
                unified.statusLabel,
                req.notes?.trim(),
              ]
                .filter(Boolean)
                .join(" · ") || unified.statusLabel,
              trailing: (
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {displayServiceRequestCost(req)}
                </span>
              ),
              expanded: isExpanded,
              onClick: () => setExpandedId((current) => (current === rowKey ? null : rowKey)),
              expandedContent: (
                <ServiceRequestCard
                  req={req}
                  onDelete={reloadServiceRequests}
                  onEdit={() => openRequestEdit(req)}
                  onSendReminder={() => void sendServiceRequestReminder(req)}
                  reminderSending={requestReminderSendingId === req.id}
                />
              ),
            },
          },
        ];
      }
      const row = workOrderById.get(unified.id);
      if (!row) return [];
      const isExpanded = expandedId === rowKey;
      return [
        {
          id: rowKey,
          propertyId: unified.propertyId,
          propertyLabel,
          dataListRow: {
            id: rowKey,
            data: row,
            primary: row.title,
            meta: [
              row.reference,
              showPropertyInMeta ? propertyLabel : null,
              unified.statusLabel,
              row.description?.trim(),
            ]
              .filter(Boolean)
              .join(" · ") || unified.statusLabel,
            trailing: (
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${priorityClass(row.priority)}`}
              >
                {row.priority}
              </span>
            ),
            expanded: isExpanded,
            onClick: () => setExpandedId((current) => (current === rowKey ? null : rowKey)),
            expandedContent: (
              <WorkOrderDetail
                row={row}
                onEdit={() => openWorkOrderEdit(row)}
                onCancel={() => cancelWorkOrder(row.id)}
                onSendReminder={() => void sendWorkOrderReminder(row)}
                reminderSending={reminderSendingId === row.id}
              />
            ),
          },
        },
      ];
    });
  }, [
    filteredUnifiedRows,
    serviceRequestById,
    workOrderById,
    expandedId,
    requestReminderSendingId,
    reminderSendingId,
  ]);

  const deleteSelectedServices = () => {
    for (const key of selectedIds) {
      const parsed = parseUnifiedServiceRowKey(key);
      if (!parsed) continue;
      if (parsed.kind === "add-on") {
        const req = serviceRequestById.get(parsed.id);
        if (req) deleteServiceRequest(req.id);
      } else {
        cancelWorkOrder(parsed.id);
      }
    }
    clearSelection();
    setBulkDeleteOpen(false);
    reloadServiceRequests();
    setAllRows(readManagerWorkOrderRows());
    showToast(selectedIds.size === 1 ? "Service removed." : "Services removed.");
  };

  const serviceSelectionActions = useMemo((): PortalAdaptiveAction[] => {
    if (selectedIds.size === 0) return [];
    const actions: PortalAdaptiveAction[] = [];
    if (selectedIds.size === 1) {
      const parsed = parseUnifiedServiceRowKey([...selectedIds][0]!);
      if (parsed?.kind === "add-on") {
        const req = serviceRequestById.get(parsed.id);
        if (req?.status === "pending") {
          actions.push({
            id: "reminder",
            keepPriority: 2,
            node: (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                disabled={requestReminderSendingId === req.id}
                data-attr="resident-service-request-send-reminder"
                onClick={() => void sendServiceRequestReminder(req)}
              >
                {requestReminderSendingId === req.id ? "Sending…" : "Send reminder"}
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem onSelect={() => void sendServiceRequestReminder(req)}>Send reminder</DropdownMenuItem>
            ),
          });
        }
      } else if (parsed?.kind === "maintenance") {
        const row = workOrderById.get(parsed.id);
        if (row && row.bucket !== "completed") {
          actions.push({
            id: "reminder",
            keepPriority: 2,
            node: (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                disabled={reminderSendingId === row.id}
                onClick={() => void sendWorkOrderReminder(row)}
              >
                {reminderSendingId === row.id ? "Sending…" : "Send reminder"}
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem onSelect={() => void sendWorkOrderReminder(row)}>Send reminder</DropdownMenuItem>
            ),
          });
        }
      }
    }
    actions.push({
      id: "delete",
      keepPriority: 0,
      node: (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="resident-services-bulk-delete"
          onClick={() => setBulkDeleteOpen(true)}
        >
          Delete
        </Button>
      ),
      menuItem: <DropdownMenuItem onSelect={() => setBulkDeleteOpen(true)}>Delete</DropdownMenuItem>,
    });
    return actions;
  }, [
    reminderSendingId,
    requestReminderSendingId,
    selectedIds,
    serviceRequestById,
    workOrderById,
  ]);

  const renderServiceAddRow = () =>
    servicesUnlocked ? (
      <PortalListAddRow
        label="Service"
        ariaLabel="Add service"
        icon={PORTAL_LIST_ADD_ICONS.service}
        onClick={openAddService}
        dataAttr="resident-services-apply"
      />
    ) : null;

  const lockedEmpty = !servicesUnlocked && unifiedServiceRows.length === 0;

  const serviceGroupedList =
    unifiedServiceRows.length > 0 ? (
      <ResidentPortalGroupedDataList
        items={serviceGroupedItems}
        groupMode={groupMode}
        selectable={servicesUnlocked}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
        dataAttr="resident-services-grouped-list"
        columns={[{ id: "service", header: "Service", cell: () => "—" }]}
        emptyState={
          filteredUnifiedRows.length === 0 && unifiedServiceRows.length > 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted">No services in this status yet.</p>
          ) : undefined
        }
      />
    ) : null;

  return (
    <>
    <ManagerPortalPageShell
      title="Services"
      hideTitleOnMobileNav
      compactFilterRow
    >
      <div
        className={lockedEmpty ? "space-y-0" : undefined}
        data-slot="resident-services-body"
      >
      {!servicesUnlocked ? (
        <p className={lockedEmpty ? PORTAL_INLINE_UNLOCK_NOTICE_STACKED_CLASS : PORTAL_INLINE_UNLOCK_NOTICE_CLASS}>
          <span className="font-semibold">Services unlock after your lease is fully signed.</span>{" "}
          Request add-ons and report issues once you and your manager have both signed.
        </p>
      ) : null}

      <PortalListControlStack
        className={lockedEmpty ? "mb-0" : "mb-2 max-lg:mb-1.5"}
        variant="command"
        stickyDestinations={false}
        destinationRow={
          <LocalDestinationNav
            items={SERVICE_STATE_TABS.map(({ id, label }) => ({
              id,
              label,
              count: serviceStateCounts[id],
              dataAttr: `resident-services-status-${id}`,
            }))}
            activeId={serviceStateFilter}
            onChange={(id) => setServiceStateFilter(id as ServiceRowState)}
            ariaLabel="Service status"
            appearance="command"
            className="w-full"
          />
        }
      />

      {servicesUnlocked ? (
        unifiedServiceRows.length === 0 ? (
          <div className={PORTAL_LIST_PAGE_BODY}>
            <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>{renderServiceAddRow()}</div>
          </div>
        ) : (
          <div className={PORTAL_LIST_PAGE_BODY}>
            {serviceGroupedList}
            <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>{renderServiceAddRow()}</div>
          </div>
        )
      ) : serviceGroupedList ? (
        <div className={PORTAL_LIST_PAGE_BODY}>{serviceGroupedList}</div>
      ) : null}


      <ResidentAddServiceModal
        open={addServiceOpen}
        onClose={() => setAddServiceOpen(false)}
        residentEmail={residentEmail}
        residentName={getApplication()?.name || residentEmail}
        availableOffers={availableOffers}
        servicesUnlocked={servicesUnlocked}
        resolveFilingIds={resolveFilingIds}
        getApplication={getApplication}
        onSubmitted={() => {
          setAllRows(readManagerWorkOrderRows());
          reloadServiceRequests();
          setAppTick((tick) => tick + 1);
        }}
      />

      {/* Edit add-on service request modal */}
      <Modal
        open={editingRequest !== null}
        title="Edit service"
        onClose={() => setEditingRequest(null)}
        panelClassName="max-w-lg"
        footer={
          editingRequest ? (
            <ModalFooter>
              <Button type="button" variant="primary" className="rounded-full" data-attr="resident-service-request-edit-save" onClick={saveRequestEdit}>
                Save changes
              </Button>
            </ModalFooter>
          ) : undefined
        }
      >
        {editingRequest ? (
          <>
            <p className="text-xs text-muted">
              Update the details of your <span className="font-semibold text-foreground">{editingRequest.offerName}</span> request.
              Pricing is set by your manager and can&apos;t be changed here.
            </p>
            <div className="mt-4 grid gap-3">
              <div>
                <p className="mb-1 text-[11px] font-medium text-muted">Notes</p>
                <Textarea
                  value={eNotes}
                  onChange={(e) => setENotes(e.target.value)}
                  placeholder="Preferred timing, special instructions…"
                  rows={3}
                  className="bg-card"
                />
              </div>
            </div>
          </>
        ) : null}
      </Modal>

      {/* Edit work order modal */}
      <Modal
        open={editingWorkOrder !== null}
        title="Edit work order"
        onClose={() => setEditingWorkOrder(null)}
        panelClassName="max-w-lg"
        footer={
          <ModalFooter>
            <Button type="button" variant="primary" className="rounded-full" data-attr="resident-work-order-edit-save" onClick={saveWorkOrderEdit}>
              Save changes
            </Button>
          </ModalFooter>
        }
      >
        <p className="text-xs text-muted">Update your maintenance request. Your property manager sees these changes.</p>
        <div className="mt-4 grid gap-3">
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Title</p>
            <Input value={wTitle} onChange={(e) => setWTitle(e.target.value)} placeholder="Short summary of the issue" className="bg-card" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted">Priority</p>
              <Select value={wPriority} onChange={(e) => setWPriority(e.target.value)} className="bg-card">
                <option>Emergency</option>
                <option>Low</option>
                <option>Medium</option>
                <option>High</option>
              </Select>
            </div>
            <PreferredArrivalField
              preset={wArrivalPreset}
              custom={wArrivalCustom}
              onPresetChange={setWArrivalPreset}
              onCustomChange={setWArrivalCustom}
            />
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Can the repair person enter if you&apos;re not home?</p>
            <Select
              value={wEntryPermission}
              onChange={(e) => setWEntryPermission(e.target.value as DemoManagerWorkOrderRow["entryPermission"])}
              className="bg-card"
            >
              {ENTRY_PERMISSION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Entry notes (gate code, pets, parking...)</p>
            <Input value={wEntryNotes} onChange={(e) => setWEntryNotes(e.target.value)} placeholder="Optional" className="bg-card" />
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Details</p>
            <Textarea
              value={wDetails}
              onChange={(e) => setWDetails(e.target.value)}
              placeholder="Describe the issue"
              rows={4}
              className="bg-card"
            />
          </div>
        </div>
      </Modal>
      </div>
    </ManagerPortalPageShell>
    <ResidentPortalListBottomBar
      selectionCount={selectedIds.size}
      selectionActions={serviceSelectionActions}
      selectionBarVariant="payments"
    />
    <ConfirmDeleteModal
      open={bulkDeleteOpen}
      title={selectedIds.size === 1 ? "Delete service" : "Delete services"}
      description={
        selectedIds.size === 1
          ? "Remove this service from your list?"
          : `Remove ${selectedIds.size} selected services from your list?`
      }
      confirmLabel="Delete"
      dataAttr="resident-services-bulk-delete-confirm"
      onClose={() => setBulkDeleteOpen(false)}
      onConfirm={deleteSelectedServices}
    />
    </>
  );
}
