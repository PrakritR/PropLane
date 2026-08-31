"use client";

import Image from "next/image";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { ClipboardList, Wrench } from "lucide-react";
import { PortalListAddRow, PORTAL_LIST_ADD_ROW_WRAP_CLASS } from "@/components/portal/portal-list-add-row";
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
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PortalDataTableColGroup,
  PORTAL_DETAIL_BTN,
  PORTAL_TABLE_DETAIL_CELL,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_TD,
  PortalMobileSummaryCard,
  PortalTableDetailActions,
  PortalTableInlineExpand,
  createPortalRowExpandClick,
  portalTableColumnPercents,
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
  upsertManagerWorkOrderToServer,
  writeManagerWorkOrderRows,
} from "@/lib/manager-work-orders-storage";
import { readManagerApplicationRows, syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";
import {
  PROPERTY_PIPELINE_EVENT,
  loadResidentPropertyFromServer,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import type { ManagerListingServiceOption } from "@/lib/manager-listing-submission";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { pickPrimaryFilingScope } from "@/lib/resident-filing-scope";
import { getPropertyById } from "@/lib/rental-application/data";
import { RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS } from "@/lib/resident-work-order-reminder-email";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { parseMoneyAmount } from "@/lib/household-charges";
import { workOrderCategoryForResidentLabel } from "@/lib/work-order-taxonomy";
import { ENTRY_PERMISSION_OPTIONS, entryPermissionLabel } from "@/lib/work-order-entry";
import { track } from "@/lib/analytics/track-client";
import {
  SERVICE_REQUESTS_EVENT,
  createServiceRequest,
  deleteServiceRequest,
  readServiceRequestsForResident,
  syncServiceRequestsFromServer,
  updateServiceRequest,
  hasDeposit,
  isServiceRequestFeePaid,
  CUSTOM_SERVICE_REQUEST_OFFER_ID,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import {
  buildUnifiedServiceRows,
  countServiceRowsByState,
  type ServiceRowState,
} from "@/lib/unified-service-rows";
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
 * One add affordance for the unified Services list — request an add-on or report an issue.
 */
function ResidentServicesAddActions({
  onRequest,
  onReport,
  disabled = false,
}: {
  onRequest: () => void;
  onReport: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={`${PORTAL_LIST_ADD_ROW_WRAP_CLASS} grid grid-cols-2 gap-2`}>
      <PortalListAddRow
        label="Request"
        ariaLabel="Request a service"
        icon={ClipboardList}
        onClick={onRequest}
        disabled={disabled}
        dataAttr="resident-services-request-add"
        inline
      />
      <PortalListAddRow
        label="Report"
        ariaLabel="Report a service issue"
        icon={Wrench}
        onClick={onReport}
        disabled={disabled}
        dataAttr="resident-services-maintenance-add"
        inline
      />
    </div>
  );
}

export function ResidentServicesPanel({
  basePath,
}: {
  basePath: string;
}) {
  const { showToast } = useAppUi();
  const session = usePortalSession();

  const openMaintenancePhotoPicker = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;width:0;height:0;";
    input.setAttribute("tabindex", "-1");
    input.setAttribute("aria-hidden", "true");
    const onChange = () => {
      void onPickPhotos(input.files);
      input.removeEventListener("change", onChange);
      input.remove();
    };
    input.addEventListener("change", onChange);
    document.body.appendChild(input);
    input.click();
  };

  const [serviceStateFilter, setServiceStateFilter] = useState<ServiceRowState>("open");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // modal state
  const [modalMode, setModalMode] = useState<"none" | "maintenance" | "service">("none");

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

  // maintenance form
  const [mTitle, setMTitle] = useState("");
  const [mDescription, setMDescription] = useState("");
  const [mCategory, setMCategory] = useState("Plumbing");
  const [mPriority, setMPriority] = useState("Medium");
  const [mArrivalPreset, setMArrivalPreset] = useState("Anytime");
  const [mArrivalCustom, setMArrivalCustom] = useState("");
  const [mEntryPermission, setMEntryPermission] = useState<DemoManagerWorkOrderRow["entryPermission"]>("call_first");
  const [mEntryNotes, setMEntryNotes] = useState("");
  const [mPhotos, setMPhotos] = useState<string[]>([]);

  // add-on service request form
  /** Catalog offer id, or CUSTOM_SERVICE_REQUEST_OFFER_ID for a free-form request. */
  const [requestTypeId, setRequestTypeId] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customPriceLimit, setCustomPriceLimit] = useState("");
  const [maintenanceSubmitting, setMaintenanceSubmitting] = useState(false);
  const [serviceSubmitting, setServiceSubmitting] = useState(false);

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
    if (serverCatalogOffers) {
      return serverCatalogOffers.filter(visibleToResident);
    }
    if (!residentApplication) return [];
    const propertyId =
      residentApplication.assignedPropertyId?.trim() ||
      residentApplication.propertyId?.trim() ||
      residentApplication.application?.propertyId?.trim() ||
      "";
    if (!propertyId) return [];
    const property = getPropertyById(propertyId);
    if (!property?.listingSubmission || property.listingSubmission.v !== 1) return [];
    const options = normalizeManagerListingSubmissionV1(property.listingSubmission).serviceRequestOptions ?? [];
    return options.filter(visibleToResident);
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
          createdAtIso: row.createdAtIso,
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

  if (!servicesUnlocked && modalMode !== "none") {
    setModalMode("none");
  }

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const onPickPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const remaining = 6 - mPhotos.length;
    if (remaining <= 0) { showToast("Up to 6 photos."); return; }
    const next = [...mPhotos];
    for (let i = 0; i < Math.min(files.length, remaining); i++) {
      const file = files[i];
      if (!file) continue;
      if (!file.type.startsWith("image/")) { showToast("Images only."); return; }
      next.push(await fileToDataUrl(file));
    }
    setMPhotos(next);
  };

  const resetMaintenance = () => {
    setMTitle("");
    setMDescription("");
    setMCategory("Plumbing");
    setMPriority("Medium");
    setMArrivalPreset("Anytime");
    setMArrivalCustom("");
    setMEntryPermission("call_first");
    setMEntryNotes("");
    setMPhotos([]);
  };
  const resetService = () => {
    setRequestTypeId(availableOffers.length > 0 ? "" : CUSTOM_SERVICE_REQUEST_OFFER_ID);
    setCustomTitle("");
    setCustomDescription("");
    setCustomPriceLimit("");
  };

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

  const submitMaintenance = async () => {
    if (maintenanceSubmitting) return;
    if (!servicesUnlocked) {
      showToast("Services unlock after your lease is fully signed.");
      return;
    }
    if (!mTitle.trim()) { showToast("Add a title first."); return; }
    if (!mDescription.trim()) { showToast("Describe the issue first."); return; }
    if (!residentEmail) { showToast("Sign in to submit."); return; }
    setMaintenanceSubmitting(true);
    try {
    const application = getApplication();
    const { propertyId, managerUserId } = resolveFilingIds();
    if (!propertyId || !managerUserId) {
      showToast("Could not find your property manager. Contact support.");
      return;
    }
    const propertyLabel =
      application?.property ||
      getPropertyById(propertyId)?.address.split(",")[0]?.trim() ||
      "Assigned house";
    const propertyAddress = getPropertyById(propertyId)?.address.trim() || undefined;
    const row: DemoManagerWorkOrderRow & { requestType: string } = {
      id: `REQ-${Date.now()}`,
      requestType: "maintenance",
      propertyName: propertyLabel,
      propertyId,
      propertyAddress,
      assignedPropertyId: application?.assignedPropertyId,
      assignedRoomChoice: application?.assignedRoomChoice || application?.application?.roomChoice1,
      managerUserId,
      unit: application?.assignedRoomChoice || application?.application?.roomChoice1 || "—",
      title: mTitle.trim(),
      priority: mPriority,
      status: "Submitted",
      bucket: "open",
      category: workOrderCategoryForResidentLabel(mCategory),
      description: mDescription.trim(),
      scheduled: "—",
      cost: "—",
      preferredArrival: formatPreferredArrival(mArrivalPreset, mArrivalCustom),
      entryPermission: mEntryPermission,
      entryNotes: mEntryNotes.trim() || undefined,
      residentName: application?.name,
      residentEmail,
      photoDataUrls: mPhotos,
    };
    writeManagerWorkOrderRows([row, ...readManagerWorkOrderRows()], { mirror: false });
    const mirrored = await upsertManagerWorkOrderToServer(row);
    if (!mirrored.ok) {
      deleteManagerWorkOrderRow(row.id);
      setAllRows(readManagerWorkOrderRows());
      showToast(mirrored.error || "Could not send work order to your manager. Try again.");
      return;
    }
    if (mirrored.row.id === row.id) {
      updateManagerWorkOrder(row.id, () => mirrored.row);
    }
    setAllRows(readManagerWorkOrderRows());
    setExpandedId(row.id);
    // Manager notification (inbox + email + SMS) fires server-side on the
    // mirror write — a second client-side send here would double-notify.
    showToast("Service request submitted.");
    track("work_order_submitted", {
      category: row.category,
      priority: mPriority,
      emergency: mPriority === "Emergency",
      photo_count: mPhotos.length,
      entry_permission: mEntryPermission,
    });
    resetMaintenance();
    setModalMode("none");
    await syncManagerWorkOrdersFromServer({ force: true });
    setAllRows(readManagerWorkOrderRows());
    } finally {
      setMaintenanceSubmitting(false);
    }
  };

  const submitService = async () => {
    if (serviceSubmitting) return;
    if (!servicesUnlocked) {
      showToast("Services unlock after your lease is fully signed.");
      return;
    }
    if (!residentEmail) { showToast("Sign in to submit."); return; }

    const isCustom =
      requestTypeId === CUSTOM_SERVICE_REQUEST_OFFER_ID || availableOffers.length === 0;
    if (isCustom) {
      if (!customTitle.trim()) { showToast("Add a title for your request."); return; }
      const limitAmount = parseMoneyAmount(customPriceLimit.trim());
      if (!Number.isFinite(limitAmount) || limitAmount <= 0) {
        showToast("Enter a valid price limit.");
        return;
      }
    } else {
      if (!requestTypeId || !availableOffers.some((o) => o.id === requestTypeId)) {
        showToast("Select a request type.");
        return;
      }
    }

    setServiceSubmitting(true);
    try {
    const application = getApplication();
    const { propertyId, managerUserId } = resolveFilingIds();
    if (!propertyId) {
      showToast("No property assignment found. Contact support.");
      return;
    }
    if (!managerUserId) { showToast("Could not find your property manager. Contact support."); return; }

    let offerId: string;
    let offerName: string;
    let offerDescription: string;
    let price: string;
    let priceLimit: string | undefined;
    let deposit: string;
    let notifyTitle: string;
    let notifyDetails: string[];

    if (isCustom) {
      const limitLabel = customPriceLimit.trim().startsWith("$")
        ? customPriceLimit.trim()
        : `$${parseMoneyAmount(customPriceLimit.trim())}`;
      offerId = CUSTOM_SERVICE_REQUEST_OFFER_ID;
      offerName = customTitle.trim();
      offerDescription = customDescription.trim();
      price = "";
      priceLimit = limitLabel;
      deposit = "";
      notifyTitle = offerName;
      notifyDetails = [
        "Custom request",
        `Price limit: ${limitLabel}`,
        offerDescription ? `Details: ${offerDescription}` : "",
      ];
    } else {
      const currentOffer = availableOffers.find((offer) => offer.id === requestTypeId) ?? null;
      if (!currentOffer) {
        showToast("That request option is no longer available. Please choose another.");
        setRequestTypeId("");
        return;
      }
      offerId = currentOffer.id;
      offerName = currentOffer.name;
      offerDescription = currentOffer.description;
      price = currentOffer.price;
      deposit = currentOffer.deposit;
      notifyTitle = currentOffer.name;
      notifyDetails = [
        `Offer: ${currentOffer.name}`,
        currentOffer.description ? `Offer details: ${currentOffer.description}` : "",
        currentOffer.price ? `Price: ${currentOffer.price}` : "",
        hasDeposit(currentOffer.deposit) ? `Deposit: ${currentOffer.deposit}` : "",
      ];
    }

    const { mirrored } = await createServiceRequest({
      offerId,
      offerName,
      offerDescription,
      price,
      priceLimit,
      deposit,
      residentEmail,
      residentName: application?.name || residentEmail,
      managerUserId,
      propertyId,
      returnByDate: "",
      notes: isCustom ? customDescription.trim() : "",
    });
    if (!mirrored.ok) {
      showToast(mirrored.error || "Could not send request to your manager. Try again.");
      return;
    }
    // Manager notification (inbox + email + SMS) fires server-side on the
    // mirror write — a second client-side send here would double-notify.
    void notifyDetails;
    showToast(`${notifyTitle} requested. Awaiting manager approval.`);
    resetService();
    setModalMode("none");
    await syncServiceRequestsFromServer({ force: true });
    reloadServiceRequests();
    } finally {
      setServiceSubmitting(false);
    }
  };

  const serviceRequestIsCustom =
    requestTypeId === CUSTOM_SERVICE_REQUEST_OFFER_ID || availableOffers.length === 0;
  const serviceRequestCatalogSelected =
    Boolean(requestTypeId) &&
    requestTypeId !== CUSTOM_SERVICE_REQUEST_OFFER_ID &&
    availableOffers.some((o) => o.id === requestTypeId);
  const serviceRequestSubmitDisabled =
    serviceSubmitting ||
    !requestTypeId ||
    (serviceRequestIsCustom ? !customTitle.trim() || !customPriceLimit.trim() : !serviceRequestCatalogSelected);

  const openRequestService = () => {
    if (!servicesUnlocked) {
      showToast("Services unlock after your lease is fully signed.");
      return;
    }
    setRequestTypeId(availableOffers.length > 0 ? "" : CUSTOM_SERVICE_REQUEST_OFFER_ID);
    setModalMode("service");
  };

  const openMaintenanceReport = () => {
    if (!servicesUnlocked) {
      showToast("Services unlock after your lease is fully signed.");
      return;
    }
    setModalMode("maintenance");
  };

  const lockedEmpty = !servicesUnlocked && unifiedServiceRows.length === 0;

  return (
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

      <div>
        <div className="mb-3">
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
            size="toolbar"
            className="w-full"
          />
        </div>
        {filteredUnifiedRows.length > 0 ? (
          <>
            <div className="space-y-2 lg:hidden">
              {filteredUnifiedRows.map((unified) => {
                if (unified.kind === "add-on") {
                  const req = serviceRequestById.get(unified.id);
                  if (!req) return null;
                  const rowId = `request-${req.id}`;
                  const expanded = expandedId === rowId;
                  return (
                    <PortalMobileSummaryCard
                      key={rowId}
                      title={req.offerName}
                      subtitle={unified.statusLabel}
                      trailing={<span className="text-xs text-muted">{displayServiceRequestCost(req)}</span>}
                      expanded={expanded}
                      onClick={() => setExpandedId((c) => (c === rowId ? null : rowId))}
                    >
                      {expanded ? (
                        <ServiceRequestCard
                          req={req}
                          onDelete={reloadServiceRequests}
                          onEdit={() => openRequestEdit(req)}
                          onSendReminder={() => void sendServiceRequestReminder(req)}
                          reminderSending={requestReminderSendingId === req.id}
                        />
                      ) : null}
                    </PortalMobileSummaryCard>
                  );
                }
                const row = workOrderById.get(unified.id);
                if (!row) return null;
                const expanded = expandedId === row.id;
                return (
                  <PortalMobileSummaryCard
                    key={row.id}
                    title={row.title}
                    subtitle={row.description ? row.description : unified.statusLabel}
                    badge={
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${priorityClass(row.priority)}`}>
                        {row.priority}
                      </span>
                    }
                    trailing={<span className="text-xs text-muted">{displayWorkOrderCost(row.cost)}</span>}
                    expanded={expanded}
                    onClick={() => setExpandedId((c) => (c === row.id ? null : row.id))}
                  >
                    {expanded ? (
                      <WorkOrderDetail
                        row={row}
                        onEdit={() => openWorkOrderEdit(row)}
                        onCancel={() => cancelWorkOrder(row.id)}
                        onSendReminder={() => void sendWorkOrderReminder(row)}
                        reminderSending={reminderSendingId === row.id}
                      />
                    ) : null}
                  </PortalMobileSummaryCard>
                );
              })}
            </div>
            <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
              <div className={PORTAL_DATA_TABLE_SCROLL}>
                <table className={PORTAL_DATA_TABLE}>
                  <PortalDataTableColGroup percents={portalTableColumnPercents(3)} />
                  <tbody>
                    {filteredUnifiedRows.map((unified) => {
                      if (unified.kind === "add-on") {
                        const req = serviceRequestById.get(unified.id);
                        if (!req) return null;
                        const rowId = `request-${req.id}`;
                        const isExpanded = expandedId === rowId;
                        return (
                          <Fragment key={rowId}>
                            <tr
                              className={PORTAL_TABLE_TR_EXPANDABLE}
                              onClick={createPortalRowExpandClick(() =>
                                setExpandedId((c) => (c === rowId ? null : rowId)),
                              )}
                              aria-expanded={isExpanded}
                            >
                              <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>
                                <PortalTableInlineExpand expanded={isExpanded}>{req.offerName}</PortalTableInlineExpand>
                              </td>
                              <td className={PORTAL_TABLE_TD}>{unified.statusLabel}</td>
                              <td className={PORTAL_TABLE_TD}>{displayServiceRequestCost(req)}</td>
                            </tr>
                            {isExpanded ? (
                              <tr className={PORTAL_TABLE_DETAIL_ROW}>
                                <td colSpan={3} className={PORTAL_TABLE_DETAIL_CELL}>
                                  <ServiceRequestCard
                                    req={req}
                                    onDelete={reloadServiceRequests}
                                    onEdit={() => openRequestEdit(req)}
                                    onSendReminder={() => void sendServiceRequestReminder(req)}
                                    reminderSending={requestReminderSendingId === req.id}
                                  />
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      }
                      const row = workOrderById.get(unified.id);
                      if (!row) return null;
                      const isExpanded = expandedId === row.id;
                      return (
                        <Fragment key={row.id}>
                          <tr
                            className={PORTAL_TABLE_TR_EXPANDABLE}
                            onClick={createPortalRowExpandClick(() =>
                              setExpandedId((c) => (c === row.id ? null : row.id)),
                            )}
                            aria-expanded={isExpanded}
                          >
                            <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>
                              <PortalTableInlineExpand expanded={isExpanded}>{row.title}</PortalTableInlineExpand>
                              <p className="mt-0.5 text-[11px] font-normal text-muted line-clamp-1">{row.description}</p>
                            </td>
                            <td className={PORTAL_TABLE_TD}>
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${priorityClass(row.priority)}`}>
                                {row.priority}
                              </span>
                            </td>
                            <td className={PORTAL_TABLE_TD}>{displayWorkOrderCost(row.cost)}</td>
                          </tr>
                          {isExpanded ? (
                            <tr className={PORTAL_TABLE_DETAIL_ROW}>
                              <td colSpan={3} className={`${PORTAL_TABLE_DETAIL_CELL} text-sm text-muted`}>
                                <WorkOrderDetail
                                  row={row}
                                  onEdit={() => openWorkOrderEdit(row)}
                                  onCancel={() => cancelWorkOrder(row.id)}
                                  onSendReminder={() => void sendWorkOrderReminder(row)}
                                  reminderSending={reminderSendingId === row.id}
                                />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : unifiedServiceRows.length > 0 ? (
          <p className="mb-2 px-1 text-center text-sm text-muted">No services in this status yet.</p>
        ) : null}
        <ResidentServicesAddActions
          onRequest={openRequestService}
          onReport={openMaintenanceReport}
          disabled={!servicesUnlocked}
        />
      </div>

      </div>

      {/* Service issue modal — mount only while open so no file input leaks to the list page */}
      {modalMode === "maintenance" ? (
      <Modal
        open
        title="Report service issue"
        onClose={() => { setModalMode("none"); resetMaintenance(); }}
        panelClassName="max-w-lg"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="resident-maintenance-submit"
              onClick={() => { return submitMaintenance(); }}
              disabled={maintenanceSubmitting}
            >
              {maintenanceSubmitting ? "Submitting…" : "Submit"}
            </Button>
          </ModalFooter>
        }
      >
        <p className="text-xs text-muted">Describe the issue. Your property manager will be notified.</p>
        <div className="mt-4 grid gap-3">
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Title</p>
            <Input value={mTitle} onChange={(e) => setMTitle(e.target.value)} placeholder="Short summary of the issue" className="bg-card" />
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Description</p>
            <Textarea
              value={mDescription}
              onChange={(e) => setMDescription(e.target.value)}
              placeholder="What's happening? Include any details that will help maintenance."
              rows={4}
              className="bg-card"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted">Category</p>
              <Select value={mCategory} onChange={(e) => setMCategory(e.target.value)} className="bg-card">
                <option>Plumbing</option>
                <option>Electrical</option>
                <option>HVAC</option>
                <option>Appliance</option>
                <option>Access / Locks</option>
                <option>General</option>
              </Select>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted">Priority</p>
              <Select value={mPriority} onChange={(e) => setMPriority(e.target.value)} className="bg-card">
                <option>Emergency</option>
                <option>Low</option>
                <option>Medium</option>
                <option>High</option>
              </Select>
              {mPriority === "Emergency" ? (
                <p className="mt-1 text-[11px] font-medium text-[var(--status-overdue-fg)]">
                  For fire, gas, or major flooding, call 911 first - then submit this.
                </p>
              ) : null}
            </div>
          </div>
          <PreferredArrivalField
            preset={mArrivalPreset}
            custom={mArrivalCustom}
            onPresetChange={setMArrivalPreset}
            onCustomChange={setMArrivalCustom}
          />
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Can the repair person enter if you&apos;re not home?</p>
            <Select
              value={mEntryPermission}
              onChange={(e) => setMEntryPermission(e.target.value as DemoManagerWorkOrderRow["entryPermission"])}
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
            <Input value={mEntryNotes} onChange={(e) => setMEntryNotes(e.target.value)} placeholder="Optional" className="bg-card" />
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Photos (up to 6)</p>
            <Button type="button" variant="outline" className="w-fit rounded-full text-xs" onClick={openMaintenancePhotoPicker}>
              Attach photos
            </Button>
          </div>
          {mPhotos.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {mPhotos.map((src, i) => (
                <div key={i} className="overflow-hidden rounded-xl border border-border bg-accent/30">
                  <Image src={src} alt={`Photo ${i + 1}`} width={240} height={180} className="h-24 w-full object-cover" unoptimized />
                  <div className="flex justify-start p-2">
                    <Button type="button" variant="outline" className="h-8 rounded-full px-3 text-[11px]" onClick={() => setMPhotos((p) => p.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Modal>
      ) : null}

      {/* Request modal */}
      <Modal
        open={modalMode === "service"}
        title="Add service"
        onClose={() => { setModalMode("none"); resetService(); }}
        panelClassName="max-w-lg"
        footer={
          modalMode === "service" ? (
            <ModalFooter>
              <Button
                type="button"
                variant="primary"
                className="rounded-full"
                onClick={() => { return submitService(); }}
                disabled={serviceRequestSubmitDisabled}
              >
                {serviceSubmitting ? "Sending…" : "Send request"}
              </Button>
            </ModalFooter>
          ) : undefined
        }
      >
        {(() => {
          const isCustom =
            requestTypeId === CUSTOM_SERVICE_REQUEST_OFFER_ID ||
            (availableOffers.length === 0 && Boolean(requestTypeId));
          const selectedCatalogOffer =
            requestTypeId &&
            requestTypeId !== CUSTOM_SERVICE_REQUEST_OFFER_ID
              ? availableOffers.find((o) => o.id === requestTypeId) ?? null
              : null;
          return (
            <>
              <p className="text-xs text-muted">
                {isCustom || availableOffers.length === 0
                  ? "Describe what you need and your max budget. Your manager will set the final price and approve the request."
                  : "Choose a request type your property offers, or Custom for something else."}
              </p>

              <div className="mt-4 space-y-3">
                <div>
                  <p className="mb-1 text-[11px] font-medium text-muted">
                    Service type <span className="text-rose-500">*</span>
                  </p>
                  <Select
                    value={
                      requestTypeId ||
                      (availableOffers.length === 0 ? CUSTOM_SERVICE_REQUEST_OFFER_ID : "")
                    }
                    onChange={(e) => {
                      const next = e.target.value;
                      setRequestTypeId(next);
                      if (next !== CUSTOM_SERVICE_REQUEST_OFFER_ID) {
                        setCustomTitle("");
                        setCustomDescription("");
                        setCustomPriceLimit("");
                      }
                    }}
                    className="bg-card"
                    disabled={serviceSubmitting}
                  >
                    {availableOffers.length > 0 ? (
                      <option value="">Select a service</option>
                    ) : null}
                    {availableOffers.map((offer) => (
                      <option key={offer.id} value={offer.id}>
                        {offer.name}
                        {offer.price ? ` · ${offer.price}` : ""}
                      </option>
                    ))}
                    <option value={CUSTOM_SERVICE_REQUEST_OFFER_ID}>Custom</option>
                  </Select>
                </div>

                {selectedCatalogOffer ? (
                  <div className="rounded-xl border border-border bg-accent/20 px-3 py-2.5 text-sm">
                    <p className="font-semibold text-foreground">{selectedCatalogOffer.name}</p>
                    {selectedCatalogOffer.description ? (
                      <p className="mt-1 text-xs text-muted">{selectedCatalogOffer.description}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted">
                      {[
                        selectedCatalogOffer.price ? `Price ${selectedCatalogOffer.price}` : null,
                        hasDeposit(selectedCatalogOffer.deposit)
                          ? `Deposit ${selectedCatalogOffer.deposit}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Manager-set pricing"}
                    </p>
                  </div>
                ) : null}

                {isCustom ||
                (availableOffers.length === 0 &&
                  (requestTypeId === CUSTOM_SERVICE_REQUEST_OFFER_ID || !requestTypeId)) ? (
                  <>
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-muted">
                        Request title <span className="text-rose-500">*</span>
                      </p>
                      <Input
                        value={customTitle}
                        onChange={(e) => setCustomTitle(e.target.value)}
                        placeholder="e.g. Extra storage bin"
                        className="bg-card"
                      />
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-muted">Details (optional)</p>
                      <Textarea
                        value={customDescription}
                        onChange={(e) => setCustomDescription(e.target.value)}
                        placeholder="Size, timing, or other details…"
                        className="min-h-[72px] bg-card"
                      />
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-muted">
                        Price limit <span className="text-rose-500">*</span>
                      </p>
                      <Input
                        value={customPriceLimit}
                        onChange={(e) => setCustomPriceLimit(e.target.value)}
                        placeholder="$50"
                        inputMode="decimal"
                        className="bg-card"
                      />
                      <p className="mt-1 text-[10px] text-muted">
                        Maximum you&apos;re willing to pay. Your manager confirms the final amount.
                      </p>
                    </div>
                  </>
                ) : null}
              </div>
            </>
          );
        })()}
      </Modal>

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
    </ManagerPortalPageShell>
  );
}
