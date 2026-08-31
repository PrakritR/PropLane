"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PortalDataTableEmpty,
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import type { DemoManagerWorkOrderRow, ManagerWorkOrderBucket } from "@/data/demo-portal";
import {
  findWorkOrderCharge,
  HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE,
  HOUSEHOLD_CHARGES_EVENT,
  parseMoneyAmount,
  recordWorkOrderResidentCharge,
  updateHouseholdChargeAmount,
} from "@/lib/household-charges";
import { deleteManagerWorkOrderRow, updateManagerWorkOrder } from "@/lib/manager-work-orders-storage";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import {
  MANAGER_VENDORS_EVENT,
  readActiveManagerVendorRows,
  syncManagerVendorsFromServer,
} from "@/lib/manager-vendors-storage";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { parseWorkOrderCategoryFromDescription } from "@/lib/reports/formal-documents/spec";
import type { WorkOrderCategory } from "@/lib/reports/categories";
import { syncManagerWorkOrdersFromServer } from "@/lib/manager-work-orders-storage";
import { fetchWorkOrderBids, type WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderRowWithDispatch } from "@/lib/work-order-dispatch";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { acceptDemoWorkOrderBid, approveDemoWorkOrderPay } from "@/lib/demo/demo-work-order-actions";
import { isWorkOrderCostLockedByVendor } from "@/lib/work-order-cost-lock";
import { entryPermissionLabel } from "@/lib/work-order-entry";
import { notifyResidentOfWorkOrderUpdate } from "@/lib/work-order-resident-notifications";
import { buildWorkOrderCompletedNotice } from "@/lib/resident-service-notices";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { track } from "@/lib/analytics/track-client";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { workOrderDetailHref, workOrderListHref } from "@/lib/portal-detail-routes";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { INBOX_LIST_SCROLL } from "@/components/portal/portal-inbox-ui";
import { usePortalNavigate } from "@/lib/portal-nav-client";

function priorityClass(p: string) {
  const x = p.toLowerCase();
  if (x === "high" || x === "emergency")
    return "portal-badge-danger ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  if (x === "medium") return "portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  return "bg-accent/30 text-muted ring-1 ring-border";
}

type BillDraft = { cost: string; paymentStatus: "pending" | "paid" };

function isSetWorkOrderCost(cost: string | undefined): boolean {
  const trimmed = cost?.trim() ?? "";
  return trimmed !== "" && trimmed !== "—";
}

function displayWorkOrderCost(cost: string | undefined): string {
  return isSetWorkOrderCost(cost) ? (cost ?? "") : "—";
}

function defaultBillDraft(row: DemoManagerWorkOrderRow): BillDraft {
  const cost = isSetWorkOrderCost(row.cost) ? (row.cost ?? "") : "";
  return { cost, paymentStatus: "pending" };
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toDatetimeLocalValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromDatetimeLocalValue(s: string): string | null {
  if (!s.trim()) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatScheduledLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Restrict photo links to http(s) or inline image data URLs before they reach an
// <a href> / <Image src> sink — inlined as a guard clause at each call site (rather
// than routed through a helper's return value) so CodeQL's xss-through-dom barrier
// recognition sees the check (see commit 924bd45 for the same fix elsewhere).
const SAFE_PHOTO_HREF_RE = /^(?:data:image\/|https?:\/\/)/;

/** $500+ triggers a confirm-preview before Approve + Pay; below it, one tap completes
 * and pays immediately. Bump this single constant to change the cutoff. */
const APPROVE_PAY_CONFIRM_THRESHOLD_CENTS = 50_000;

function approvePayDefaults(row: DemoManagerWorkOrderRow) {
  return {
    category: row.category ?? parseWorkOrderCategoryFromDescription(row.description),
    vendorCostCents: row.vendorCostCents ?? Math.round(parseMoneyAmount(row.cost) * 100),
    materialsCostCents: row.materialsCostCents ?? 0,
    materialsMemo: row.materialsMemo ?? "",
    workDoneSummary: row.workDoneSummary || row.vendorMarkedDoneNote || row.title,
  };
}

export function ManagerWorkOrdersPanel({
  allRows,
  bucket,
  onAfterSchedule,
  workOrderId: workOrderIdProp,
  listBasePath,
  listAddAction,
}: {
  allRows: DemoManagerWorkOrderRow[];
  bucket: ManagerWorkOrderBucket;
  /** After moving a row from Open → Scheduled, switch the parent tab so the row is still visible. */
  onAfterSchedule?: () => void;
  workOrderId?: string;
  listBasePath?: string;
  listAddAction?: {
    label?: string;
    hint?: string;
    icon?: LucideIcon;
    onClick: () => void;
    dataAttr: string;
  };
}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const { userId: managerUserId, ready: authReady } = useManagerUserId();
  const [billDraftById, setBillDraftById] = useState<Record<string, BillDraft>>({});
  const [visitAtById, setVisitAtById] = useState<Record<string, string>>({});
  const [hcTick, setHcTick] = useState(0);
  const [vendorTick, setVendorTick] = useState(0);
  const [completeRow, setCompleteRow] = useState<DemoManagerWorkOrderRow | null>(null);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeDraft, setCompleteDraft] = useState({
    category: "general" as WorkOrderCategory,
    vendorCost: "",
    materialsCost: "",
    materialsMemo: "",
    workDoneSummary: "",
    notifyResident: true,
    residentSubject: "",
    residentBody: "",
    viaEmail: true,
    viaSms: true,
  });
  const [bidsByWorkOrderId, setBidsByWorkOrderId] = useState<Record<string, WorkOrderBid[]>>({});
  const [acceptingBidId, setAcceptingBidId] = useState<string | null>(null);
  const [dispatchBusyId, setDispatchBusyId] = useState<string | null>(null);
  const [autoSchedulingId, setAutoSchedulingId] = useState<string | null>(null);
  const [approvePayRow, setApprovePayRow] = useState<DemoManagerWorkOrderRow | null>(null);
  const [approvePayBusy, setApprovePayBusy] = useState(false);
  const [deleteRow, setDeleteRow] = useState<DemoManagerWorkOrderRow | null>(null);

  useEffect(() => {
    void syncManagerVendorsFromServer();
    const onVendors = () => setVendorTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
  }, []);

  const activeVendors = useMemo(() => {
    void vendorTick;
    return readActiveManagerVendorRows();
  }, [vendorTick]);

  const rows = useMemo(() => allRows.filter((r) => r.bucket === bucket), [allRows, bucket]);

  useEffect(() => {
    const on = () => setHcTick((n) => n + 1);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, on);
    return () => window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, on);
  }, []);

  const loadBids = useCallback(async (workOrderId: string) => {
    const bids = await fetchWorkOrderBids(workOrderId);
    setBidsByWorkOrderId((prev) => ({ ...prev, [workOrderId]: bids }));
  }, []);

  const openExpand = useCallback(
    (row: DemoManagerWorkOrderRow) => {
      setVisitAtById((prev) => ({
        ...prev,
        [row.id]: row.scheduledAtIso ? toDatetimeLocalValue(row.scheduledAtIso) : prev[row.id] ?? "",
      }));
      setBillDraftById((prev) => ({
        ...prev,
        [row.id]: prev[row.id] ?? defaultBillDraft(row),
      }));
      if (!row.selfAssigned && (row.vendorId || row.biddingOpen || row.biddingResolvedAt)) void loadBids(row.id);
    },
    [loadBids],
  );

  const routeWorkOrderId = workOrderIdProp ? decodeURIComponent(workOrderIdProp) : null;
  const routeWorkOrder = useMemo(() => {
    if (!routeWorkOrderId) return null;
    return rows.find((r) => r.id === routeWorkOrderId) ?? allRows.find((r) => r.id === routeWorkOrderId) ?? null;
  }, [routeWorkOrderId, rows, allRows]);

  useEffect(() => {
    if (routeWorkOrder) openExpand(routeWorkOrder);
  }, [routeWorkOrder, openExpand]);

  const openWorkOrderDetail = useCallback(
    (row: DemoManagerWorkOrderRow) => {
      if (listBasePath) navigate(workOrderDetailHref(listBasePath, bucket, row.id));
    },
    [bucket, listBasePath, navigate],
  );

  const navigateToList = useCallback(() => {
    if (listBasePath) navigate(workOrderListHref(listBasePath, bucket));
  }, [bucket, listBasePath, navigate]);

  const effectiveManagerId = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;

  const tryAutoChargeScheduled = useCallback(() => {
    if (!authReady) return;
    for (const row of allRows) {
      if (row.bucket !== "scheduled") continue;
      if (findWorkOrderCharge(row.id)) continue;
      const draft = billDraftById[row.id] ?? defaultBillDraft(row);
      const amountInput = draft.cost.trim() ? draft.cost : isSetWorkOrderCost(row.cost) ? (row.cost ?? "") : "";
      const amt = parseMoneyAmount(amountInput);
      const email = (row.residentEmail ?? "").trim().toLowerCase();
      if (amt <= 0 || !email.includes("@")) continue;
      const created = recordWorkOrderResidentCharge({
        managerUserId: effectiveManagerId,
        workOrderId: row.id,
        propertyId: row.propertyId || row.assignedPropertyId,
        propertyLabel: row.propertyName,
        unit: row.unit,
        workOrderTitle: row.title,
        amountInput,
        residentEmail: row.residentEmail ?? "",
        residentName: row.residentName ?? "",
        initialStatus: draft.paymentStatus,
      });
      if (created) {
        setHcTick((n) => n + 1);
      }
    }
  }, [allRows, authReady, billDraftById, effectiveManagerId]);

  useEffect(() => {
    const t = window.setTimeout(() => tryAutoChargeScheduled(), 400);
    return () => window.clearTimeout(t);
  }, [tryAutoChargeScheduled, hcTick]);

  const chargeByWoId = useMemo(() => {
    void hcTick;
    const m = new Map<string, ReturnType<typeof findWorkOrderCharge>>();
    for (const r of rows) {
      const c = findWorkOrderCharge(r.id);
      if (c) m.set(r.id, c);
    }
    return m;
  }, [rows, hcTick]);

  /** Email the assigned vendor the visit details. Returns true if a send was attempted and accepted. */
  const sendVendorVisitEmail = useCallback(
    async (row: DemoManagerWorkOrderRow, iso: string): Promise<boolean> => {
      if (row.selfAssigned || !row.vendorId) return false;
      const vendor = activeVendors.find((v) => v.id === row.vendorId);
      const vendorEmail = vendor?.email?.trim() ?? "";
      if (!vendor || !vendorEmail.includes("@")) return false;
      // /demo never sends real mail or hits authed routes — the sandbox is read-only.
      if (isDemoModeActive()) return false;
      try {
        const res = await fetch("/api/portal/send-vendor-visit-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            workOrderId: row.id,
            vendorId: vendor.id,
            vendorEmail,
            vendorName: vendor.name,
            workOrderTitle: row.title,
            propertyLabel: row.propertyName,
            unit: row.unit,
            visitLabel: formatScheduledLabel(iso),
            description: row.description,
            preferredArrival: row.preferredArrival,
          }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    [activeVendors],
  );

  /** Commit a resolved visit time (manual or auto-scheduled) — bucket/status transition,
   * best-effort billing charge, and the vendor email + inbox notification, all shared so
   * auto-schedule reuses exactly the same write + notify path as picking a time by hand. */
  const commitScheduledVisit = useCallback(
    async (row: DemoManagerWorkOrderRow, iso: string) => {
      const draft = billDraftById[row.id] ?? defaultBillDraft(row);
      const costTrimmed = draft.cost.trim();
      const amt = costTrimmed ? parseMoneyAmount(costTrimmed) : 0;
      const residentEmail = (row.residentEmail ?? "").trim();
      const scheduledLabel = formatScheduledLabel(iso);

      updateManagerWorkOrder(row.id, (r) => ({
        ...r,
        bucket: "scheduled",
        status: "Scheduled",
        scheduledAtIso: iso,
        scheduled: scheduledLabel,
        ...(costTrimmed && Number.isFinite(amt) && amt >= 0 ? { cost: `$${amt.toFixed(2)}` } : {}),
      }));

      let created = null;
      if (residentEmail.includes("@") && Number.isFinite(amt) && amt > 0) {
        created = recordWorkOrderResidentCharge({
          managerUserId: effectiveManagerId,
          workOrderId: row.id,
          propertyId: row.propertyId || row.assignedPropertyId,
          propertyLabel: row.propertyName,
          unit: row.unit,
          workOrderTitle: row.title,
          amountInput: draft.cost,
          residentEmail,
          residentName: row.residentName ?? "",
          initialStatus: draft.paymentStatus,
        });
      }
      if (created) setHcTick((n) => n + 1);
      const vendorEmailed = await sendVendorVisitEmail(row, iso);
      if (!isDemoModeActive() && iso !== row.scheduledAtIso) {
        void notifyResidentOfWorkOrderUpdate("visit_scheduled", row, { scheduledLabel }).then((notify) => {
          if (notify.ok) track("work_order_resident_notified", { stage: "visit_scheduled", work_order_id: row.id });
        });
      }
      const billingPart = created
        ? created.status === "paid"
          ? " Payment recorded as paid."
          : " Pending payment created."
        : "";
      showToast(`Work order scheduled.${billingPart}${vendorEmailed ? " Vendor emailed with the visit details." : ""}`);
      if (workOrderIdProp) navigateToList();
      onAfterSchedule?.();
    },
    [billDraftById, effectiveManagerId, onAfterSchedule, sendVendorVisitEmail, showToast],
  );

  /** Schedule the visit (date required). Billing is optional — a charge is only created when a cost is set and a resident is linked. */
  const saveScheduleFromOpen = async (row: DemoManagerWorkOrderRow) => {
    const visitAt = visitAtById[row.id] ?? "";
    const iso = fromDatetimeLocalValue(visitAt);
    if (!iso) {
      showToast("Choose a visit date and time to schedule.");
      return;
    }
    await commitScheduledVisit(row, iso);
  };

  /** Resolve the assigned vendor's next open slot from their set availability (weekly
   * windows minus blocked dates minus their other scheduled visits) and book it — same
   * commit path as scheduling by hand, so the vendor gets the same email + inbox notice. */
  const autoScheduleVisit = async (row: DemoManagerWorkOrderRow) => {
    if (row.selfAssigned || !row.vendorId) {
      showToast("Assign a vendor before auto-scheduling.");
      return;
    }
    setAutoSchedulingId(row.id);
    try {
      // /demo: book a synthetic next-day slot locally instead of the authed route.
      if (isDemoModeActive()) {
        const slot = new Date();
        slot.setDate(slot.getDate() + 1);
        slot.setHours(10, 0, 0, 0);
        const iso = slot.toISOString();
        setVisitAtById((prev) => ({ ...prev, [row.id]: toDatetimeLocalValue(iso) }));
        await commitScheduledVisit(row, iso);
        return;
      }
      const res = await fetch("/api/portal-work-orders/auto-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ workOrderId: row.id, vendorId: row.vendorId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not auto-schedule.");
      if (!data.iso) {
        showToast(
          data.reason === "no_availability"
            ? "This vendor hasn't set their availability yet."
            : "No open slot found in the vendor's availability.",
        );
        return;
      }
      setVisitAtById((prev) => ({ ...prev, [row.id]: toDatetimeLocalValue(data.iso) }));
      await commitScheduledVisit(row, data.iso);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not auto-schedule.");
    } finally {
      setAutoSchedulingId(null);
    }
  };

  const rescheduleVisit = async (row: DemoManagerWorkOrderRow) => {
    const visitAt = visitAtById[row.id] ?? "";
    const iso = fromDatetimeLocalValue(visitAt);
    if (!iso) {
      showToast("Choose a new visit date and time.");
      return;
    }
    updateManagerWorkOrder(row.id, (r) => ({
      ...r,
      scheduledAtIso: iso,
      scheduled: formatScheduledLabel(iso),
    }));
    const vendorEmailed = await sendVendorVisitEmail(row, iso);
    showToast(vendorEmailed ? "Visit time updated. Vendor emailed with the new time." : "Visit time updated.");
  };

  const openCompleteModal = (row: DemoManagerWorkOrderRow) => {
    if (row.bucket !== "scheduled") return;
    const summary = row.workDoneSummary ?? row.title;
    const notice = buildWorkOrderCompletedNotice({
      residentName: row.residentName ?? "",
      title: row.title,
      propertyLabel: row.propertyName,
      unit: row.unit,
      workDoneSummary: summary,
    });
    setCompleteRow(row);
    setCompleteDraft({
      category: row.category ?? parseWorkOrderCategoryFromDescription(row.description),
      vendorCost: row.vendorCostCents ? String(row.vendorCostCents / 100) : "",
      materialsCost: row.materialsCostCents ? String(row.materialsCostCents / 100) : "",
      materialsMemo: row.materialsMemo ?? "",
      workDoneSummary: summary,
      notifyResident: Boolean(row.residentEmail?.includes("@")),
      residentSubject: notice.subject,
      residentBody: notice.body,
      viaEmail: true,
      viaSms: true,
    });
  };

  const submitComplete = async () => {
    if (!completeRow) return;
    if (
      completeDraft.notifyResident &&
      completeRow.residentEmail?.includes("@") &&
      (!completeDraft.residentSubject.trim() || !completeDraft.residentBody.trim())
    ) {
      showToast("Add a subject and message for the resident, or uncheck notify.");
      return;
    }
    if (
      completeDraft.notifyResident &&
      completeRow.residentEmail?.includes("@") &&
      !completeDraft.viaEmail &&
      !completeDraft.viaSms
    ) {
      showToast("Choose Email and/or Messages, or uncheck notify.");
      return;
    }
    setCompleteBusy(true);
    try {
      const vendorCostCents = completeDraft.vendorCost.trim()
        ? Math.round(Number.parseFloat(completeDraft.vendorCost.replace(/[^0-9.]/g, "")) * 100)
        : 0;
      const materialsCostCents = completeDraft.materialsCost.trim()
        ? Math.round(Number.parseFloat(completeDraft.materialsCost.replace(/[^0-9.]/g, "")) * 100)
        : 0;
      // /demo: complete locally — the sandbox never writes to real work-order rows.
      if (isDemoModeActive()) {
        const now = new Date().toISOString();
        updateManagerWorkOrder(completeRow.id, (r) => ({
          ...r,
          bucket: "completed",
          status: "Completed",
          category: completeDraft.category,
          vendorCostCents: vendorCostCents > 0 ? vendorCostCents : r.vendorCostCents,
          materialsCostCents: materialsCostCents > 0 ? materialsCostCents : r.materialsCostCents,
          materialsMemo: completeDraft.materialsMemo,
          workDoneSummary: completeDraft.workDoneSummary,
          completedAt: now,
        }));
        showToast("Work order marked complete.");
        setCompleteRow(null);
        if (workOrderIdProp) navigateToList();
        return;
      }
      const res = await fetch("/api/portal/work-orders/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          workOrder: completeRow,
          category: completeDraft.category,
          vendorCostCents: vendorCostCents > 0 ? vendorCostCents : undefined,
          materialsCostCents: materialsCostCents > 0 ? materialsCostCents : undefined,
          materialsMemo: completeDraft.materialsMemo,
          workDoneSummary: completeDraft.workDoneSummary,
          skipResidentNotify: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not complete work order.");
      updateManagerWorkOrder(completeRow.id, () => data.workOrder as DemoManagerWorkOrderRow);
      void syncManagerWorkOrdersFromServer();

      const residentEmail = completeRow.residentEmail?.trim() ?? "";
      if (completeDraft.notifyResident && residentEmail.includes("@")) {
        const notify = await deliverPortalInboxMessage({
          eventCategory: "maintenance",
          fromName: "Property Manager",
          toEmails: [residentEmail],
          subject: completeDraft.residentSubject.trim(),
          text: completeDraft.residentBody.trim(),
          deliverViaEmail: completeDraft.viaEmail,
          deliverViaSms: completeDraft.viaSms,
        });
        if (notify.ok) {
          track("work_order_resident_notified", { stage: "completed", work_order_id: completeRow.id });
        }
        showToast(
          notify.ok
            ? data.expenseEntryIds?.length
              ? "Completed, expenses logged, and resident notified."
              : "Work order completed and resident notified."
            : data.expenseEntryIds?.length
              ? "Completed and expenses logged, but resident message failed."
              : "Work order completed, but resident message failed.",
        );
      } else {
        showToast(
          data.expenseEntryIds?.length
            ? "Work order completed and expenses logged."
            : "Work order marked complete.",
        );
      }
      setCompleteRow(null);
      if (workOrderIdProp) navigateToList();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not complete work order.");
    } finally {
      setCompleteBusy(false);
    }
  };

  const markComplete = (row: DemoManagerWorkOrderRow) => {
    openCompleteModal(row);
  };

  /** Runs the same completion + expense-logging as "Mark complete", then marks the vendor
   * paid (bookkeeping status only — see APPROVE_PAY_CONFIRM_THRESHOLD_CENTS for the
   * one-tap vs confirm-preview gate). */
  const submitApprovePay = async (row: DemoManagerWorkOrderRow) => {
    setApprovePayBusy(true);
    try {
      // /demo: mark paid locally — never hits the real payout/bookkeeping route.
      if (isDemoModeActive()) {
        approveDemoWorkOrderPay(row.id);
        showToast("Approved and paid.");
        setApprovePayRow(null);
        if (workOrderIdProp) navigateToList();
        return;
      }
      const res = await fetch("/api/portal/work-orders/approve-pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ workOrder: row, ...approvePayDefaults(row) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not approve payment.");
      updateManagerWorkOrder(row.id, () => data.workOrder as DemoManagerWorkOrderRow);
      void syncManagerWorkOrdersFromServer();
      showToast("Approved and paid.");
      setApprovePayRow(null);
      if (workOrderIdProp) navigateToList();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not approve payment.");
    } finally {
      setApprovePayBusy(false);
    }
  };

  const approvePay = (row: DemoManagerWorkOrderRow) => {
    const { vendorCostCents, materialsCostCents } = approvePayDefaults(row);
    if (vendorCostCents + materialsCostCents < APPROVE_PAY_CONFIRM_THRESHOLD_CENTS) {
      void submitApprovePay(row);
    } else {
      setApprovePayRow(row);
    }
  };

  /** Auto-save the Cost field and, once a resident is linked and the amount warrants it,
   * auto-create or update the payment line. Locked only when a vendor fixed the price
   * (set-vendor-price or accepted bid). */
  const commitBilling = useCallback(
    (row: DemoManagerWorkOrderRow, overrides?: Partial<BillDraft>) => {
      if (isWorkOrderCostLockedByVendor(row)) return;
      const draft = { ...(billDraftById[row.id] ?? defaultBillDraft(row)), ...overrides };
      const trimmed = draft.cost.trim();
      if (!trimmed) {
        if (isSetWorkOrderCost(row.cost)) updateManagerWorkOrder(row.id, (r) => ({ ...r, cost: "—" }));
        return;
      }
      const amt = parseMoneyAmount(trimmed);
      if (!Number.isFinite(amt) || amt < 0) return;
      const residentEmail = (row.residentEmail ?? "").trim();
      const existing = findWorkOrderCharge(row.id);
      if (existing) {
        if (updateHouseholdChargeAmount(existing.id, amt, effectiveManagerId)) {
          updateManagerWorkOrder(row.id, (r) => ({ ...r, cost: `$${amt.toFixed(2)}` }));
          setHcTick((n) => n + 1);
        }
        return;
      }
      if (amt > 0 && residentEmail.includes("@")) {
        const created = recordWorkOrderResidentCharge({
          managerUserId: effectiveManagerId,
          workOrderId: row.id,
          propertyId: row.propertyId || row.assignedPropertyId,
          propertyLabel: row.propertyName,
          unit: row.unit,
          workOrderTitle: row.title,
          amountInput: draft.cost,
          residentEmail,
          residentName: row.residentName ?? "",
          initialStatus: draft.paymentStatus,
        });
        if (created) {
          updateManagerWorkOrder(row.id, (r) => ({ ...r, cost: `$${amt.toFixed(2)}` }));
          setHcTick((n) => n + 1);
          showToast(created.status === "paid" ? "Payment recorded as paid." : "Pending payment line created.");
        }
      } else {
        updateManagerWorkOrder(row.id, (r) => ({ ...r, cost: `$${amt.toFixed(2)}` }));
      }
    },
    [billDraftById, effectiveManagerId, showToast],
  );

  const onDeleteWorkOrder = (row: DemoManagerWorkOrderRow) => {
    setDeleteRow(row);
  };

  const confirmDeleteWorkOrder = () => {
    const row = deleteRow;
    if (!row) return;
    if (deleteManagerWorkOrderRow(row.id)) {
      showToast("Work order removed.");
      if (workOrderIdProp) navigateToList();
      setHcTick((n) => n + 1);
    } else showToast("Could not delete work order.");
    setDeleteRow(null);
  };

  const assignVendor = (row: DemoManagerWorkOrderRow, choice: string) => {
    if (choice === "self") {
      updateManagerWorkOrder(row.id, (r) => ({
        ...r,
        vendorId: undefined,
        vendorName: undefined,
        vendorAssignedAt: undefined,
        selfAssigned: true,
      }));
      showToast("You're handling this yourself. No vendor email will be sent.");
      return;
    }
    if (!choice) {
      updateManagerWorkOrder(row.id, (r) => ({
        ...r,
        vendorId: undefined,
        vendorName: undefined,
        vendorAssignedAt: undefined,
        vendorPriceSetAt: undefined,
        selfAssigned: false,
      }));
      showToast("Vendor unassigned.");
      return;
    }
    const vendor = activeVendors.find((v) => v.id === choice);
    if (!vendor) {
      showToast("Vendor not found.");
      return;
    }
    const assignedAt = new Date().toISOString();
    updateManagerWorkOrder(row.id, (r) => ({
      ...r,
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorAssignedAt: assignedAt,
      selfAssigned: false,
    }));
    showToast(`Assigned ${vendor.name}.`);
    // ponytail: client fire-and-forget; move into a server assign route if/when one exists
    if (!isDemoModeActive() && row.residentEmail && choice !== row.vendorId) {
      void notifyResidentOfWorkOrderUpdate("vendor_assigned", {
        ...row,
        vendorId: vendor.id,
        vendorName: vendor.name,
        vendorAssignedAt: assignedAt,
        selfAssigned: false,
      }).then((notify) => {
        if (notify.ok) track("work_order_resident_notified", { stage: "vendor_assigned", work_order_id: row.id });
      });
    }
  };

  const acceptBidHandler = async (bid: WorkOrderBid) => {
    setAcceptingBidId(bid.id);
    try {
      // /demo: accept the bid in the local sandbox stores only.
      if (isDemoModeActive()) {
        if (!acceptDemoWorkOrderBid(bid.workOrderId)) throw new Error("Could not accept bid.");
        await loadBids(bid.workOrderId);
        showToast("Bid accepted. Vendor assigned at the agreed cost.");
        return;
      }
      const res = await fetch("/api/portal/work-order-bids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "accept", bidId: bid.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not accept bid.");
      await syncManagerWorkOrdersFromServer({ force: true });
      await loadBids(bid.workOrderId);
      showToast("Bid accepted. Vendor assigned at the agreed cost.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not accept bid.");
    } finally {
      setAcceptingBidId(null);
    }
  };

  const handleDispatchDecision = async (row: DemoManagerWorkOrderRow, action: "approve" | "decline") => {
    // /demo: never fetch the authed dispatch route from the sandbox.
    if (isDemoModeActive()) {
      showToast("Demo mode: dispatch actions are disabled.");
      return;
    }
    setDispatchBusyId(row.id);
    try {
      const res = await fetch("/api/portal/dispatch-proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ workOrderId: row.id, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not update dispatch.");
      if (action === "approve") {
        showToast(
          data.scheduledIso
            ? `Dispatched ${data.vendorName}. Visit booked for ${formatScheduledLabel(data.scheduledIso)}.`
            : `Dispatched ${data.vendorName}. Pick a visit time below.`,
        );
      } else {
        showToast("Dispatch proposal declined.");
      }
      await syncManagerWorkOrdersFromServer({ force: true });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not update dispatch.");
    } finally {
      setDispatchBusyId(null);
    }
  };

  const renderRowDetail = (row: DemoManagerWorkOrderRow) => {
    const draft = billDraftById[row.id] ?? defaultBillDraft(row);
    const linkedCharge = chargeByWoId.get(row.id);
    const visitAt = visitAtById[row.id] ?? "";
    const assignedVendor =
      !row.selfAssigned && row.vendorId
        ? activeVendors.find((v) => v.id === row.vendorId) ?? null
        : null;
    const assignedVendorEmail = assignedVendor?.email?.trim() ?? "";
    const dispatch = (row as WorkOrderRowWithDispatch).dispatch;

    return (
      <>
                        <p className="text-sm leading-relaxed text-muted">{row.description}</p>
                        <p className="mt-1.5 text-xs text-muted">
                          Resident preferred arrival:{" "}
                          <span className="font-medium text-muted">{row.preferredArrival?.trim() || "Anytime"}</span>
                        </p>
                        {row.entryPermission || row.entryNotes ? (
                          <p className="mt-1.5 text-xs text-muted">
                            Entry: <span className="font-medium text-muted">{entryPermissionLabel(row.entryPermission)}</span>
                            {row.entryNotes ? <span className="font-medium text-muted"> ({row.entryNotes})</span> : null}
                          </p>
                        ) : null}
                        {row.bucket !== "open" && row.scheduled && row.scheduled !== "—" ? (
                          <p className="mt-1.5 text-xs text-muted">
                            Visit scheduled for <span className="font-medium text-foreground">{row.scheduled}</span>
                          </p>
                        ) : null}
                        {row.automationStatus === "vendor_marked_done" ? (
                          <p className="mt-1.5 text-xs font-medium text-muted">
                            Vendor marked this done{row.vendorMarkedDoneNote ? `: "${row.vendorMarkedDoneNote}"` : ""}. Awaiting your approval.
                          </p>
                        ) : row.automationStatus === "paid" ? (
                          <p className="mt-1.5 text-xs font-medium text-muted">Approved and paid.</p>
                        ) : null}
                        {row.photoDataUrls?.length ? (
                          <div className="mt-4">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted">Photos</p>
                            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                              {row.photoDataUrls.map((src, index) => {
                                const trimmed = src.trim();
                                if (!SAFE_PHOTO_HREF_RE.test(trimmed)) return null;
                                return (
                                <a
                                  key={`${row.id}-photo-${index}`}
                                  href={trimmed}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block overflow-hidden rounded-xl border border-border bg-accent/30"
                                >
                                  <Image
                                    src={trimmed}
                                    alt={`Work order photo ${index + 1}`}
                                    width={240}
                                    height={180}
                                    className="h-28 w-full object-cover"
                                    unoptimized
                                  />
                                </a>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}

                        {row.bucket === "open" && dispatch ? (
                          dispatch.status === "proposed" ? (
                            <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-3">
                              <p className="text-sm font-semibold text-foreground">PropLane suggests {dispatch.vendorName}</p>
                              <p className="mt-1 text-xs text-muted">{dispatch.reasoning}</p>
                              {dispatch.candidates.slice(0, 2).map((c) => (
                                <p key={c.vendorId} className="mt-0.5 text-[11px] text-muted">
                                  {c.vendorName} · {c.reason}
                                </p>
                              ))}
                              <div className="mt-2.5 flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  variant="primary"
                                  data-attr="dispatch-approve"
                                  className="h-7 rounded-full px-3 text-xs"
                                  disabled={dispatchBusyId === row.id}
                                  onClick={() => handleDispatchDecision(row, "approve")}
                                >
                                  {dispatchBusyId === row.id ? "Dispatching…" : "Approve & dispatch"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  data-attr="dispatch-decline"
                                  className="h-7 rounded-full px-3 text-xs"
                                  disabled={dispatchBusyId === row.id}
                                  onClick={() => handleDispatchDecision(row, "decline")}
                                >
                                  Decline
                                </Button>
                              </div>
                            </div>
                          ) : dispatch.status === "approved" || dispatch.status === "auto_dispatched" ? (
                            <p className="mt-4 text-xs text-muted">
                              Dispatched by PropLane to <span className="font-medium text-foreground">{dispatch.vendorName}</span>
                              {dispatch.decidedAtIso ? ` · ${formatScheduledLabel(dispatch.decidedAtIso)}` : ""}
                            </p>
                          ) : null
                        ) : null}

                        <div className="mt-4 flex flex-wrap items-end gap-x-3 gap-y-2">
                          <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                            Cost
                            <Input
                              type="text"
                              inputMode="decimal"
                              placeholder="$0"
                              value={draft.cost}
                              disabled={isWorkOrderCostLockedByVendor(row)}
                              data-attr="work-order-cost-input"
                              onChange={(e) =>
                                setBillDraftById((prev) => ({
                                  ...prev,
                                  [row.id]: { ...(prev[row.id] ?? defaultBillDraft(row)), cost: e.target.value },
                                }))
                              }
                              onBlur={() => commitBilling(row)}
                              className="h-8 w-24 rounded-md text-sm"
                            />
                          </label>
                          {!linkedCharge ? (
                            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                              Payment
                              <Select
                                className="h-8 rounded-md text-xs"
                                value={draft.paymentStatus}
                                data-attr="work-order-payment-status-select"
                                onChange={(e) => {
                                  const paymentStatus = e.target.value as "pending" | "paid";
                                  setBillDraftById((prev) => ({
                                    ...prev,
                                    [row.id]: {
                                      ...(prev[row.id] ?? defaultBillDraft(row)),
                                      paymentStatus,
                                    },
                                  }));
                                  commitBilling(row, { paymentStatus });
                                }}
                              >
                                <option value="pending">Pending</option>
                                <option value="paid">Paid</option>
                              </Select>
                            </label>
                          ) : null}
                          {row.bucket !== "completed" ? (
                            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                              Visit date
                              <Input
                                type="datetime-local"
                                value={visitAt}
                                onChange={(e) =>
                                  setVisitAtById((prev) => ({ ...prev, [row.id]: e.target.value }))
                                }
                                className="h-8 rounded-md text-sm"
                              />
                            </label>
                          ) : null}
                          {row.bucket !== "completed" ? (
                            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                              Vendor
                              <Select
                                className="h-8 min-w-[150px] rounded-md text-xs"
                                value={row.selfAssigned ? "self" : row.vendorId ?? ""}
                                onChange={(e) => assignVendor(row, e.target.value)}
                              >
                                <option value="">None</option>
                                <option value="self">Self</option>
                                {activeVendors.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.name}
                                  </option>
                                ))}
                              </Select>
                            </label>
                          ) : row.vendorName ? (
                            <span className="pb-1.5 text-xs text-muted">
                              Vendor: <span className="font-medium text-foreground">{row.vendorName}</span>
                            </span>
                          ) : row.selfAssigned ? (
                            <span className="pb-1.5 text-xs text-muted">Self-handled</span>
                          ) : null}
                          {assignedVendor?.phone ? (
                            <a href={`tel:${assignedVendor.phone}`} className="pb-1.5 text-xs font-medium text-primary hover:underline">
                              Call
                            </a>
                          ) : null}
                          {assignedVendorEmail ? (
                            <a href={`mailto:${assignedVendorEmail}`} className="pb-1.5 text-xs font-medium text-primary hover:underline">
                              Email
                            </a>
                          ) : null}
                        </div>

                        {(bidsByWorkOrderId[row.id] ?? []).length > 0 ? (
                          <div className="mt-3 border-t border-border pt-3">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted">Bids</p>
                            <div className="mt-2 space-y-1.5">
                                {(bidsByWorkOrderId[row.id] ?? []).map((bid) => {
                                  const pricingPending = bid.amountCents == null;
                                  const totalCents = (bid.amountCents ?? 0) + bid.materialsCents;
                                  return (
                                  <div
                                    key={bid.id}
                                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs"
                                  >
                                    <div>
                                      <span className="font-medium text-foreground">{bid.vendorName || "Vendor"}</span>{" "}
                                      <span className="inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]">
                                        {bid.quoteMode === "after_consultation" ? "After consultation" : "Upfront"}
                                      </span>
                                      {pricingPending ? (
                                        <span className="ml-1 text-muted">
                                          · Consultation{" "}
                                          {bid.consultationVisitAt
                                            ? `scheduled for ${new Date(bid.consultationVisitAt).toLocaleString(undefined, {
                                                month: "short",
                                                day: "numeric",
                                                hour: "numeric",
                                                minute: "2-digit",
                                              })}`
                                            : "pending"}{" "}
                                          , pricing pending
                                        </span>
                                      ) : (
                                        <span className="text-muted">
                                          {" "}
                                          · ${(totalCents / 100).toFixed(2)} (labor ${((bid.amountCents ?? 0) / 100).toFixed(2)} + materials $
                                          {(bid.materialsCents / 100).toFixed(2)}) ·{" "}
                                          {bid.proposedTime
                                            ? new Date(bid.proposedTime).toLocaleString(undefined, {
                                                month: "short",
                                                day: "numeric",
                                                hour: "numeric",
                                                minute: "2-digit",
                                              })
                                            : "—"}
                                        </span>
                                      )}
                                      {bid.note ? <p className="mt-0.5 text-muted">{bid.note}</p> : null}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span
                                        className={
                                          bid.status === "accepted"
                                            ? "inline-flex rounded-full bg-accent/40 px-2 py-0.5 text-[10px] font-semibold text-foreground ring-1 ring-border"
                                            : bid.status === "declined"
                                              ? "inline-flex rounded-full bg-accent/30 px-2 py-0.5 text-[10px] font-semibold text-muted ring-1 ring-border"
                                              : "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]"
                                        }
                                      >
                                        {bid.status}
                                      </span>
                                      {bid.status === "submitted" && !pricingPending ? (
                                        <Button
                                          type="button"
                                          variant="primary"
                                          data-attr="work-order-accept-bid"
                                          className="h-7 rounded-full px-3 text-xs"
                                          disabled={acceptingBidId === bid.id}
                                          onClick={() => acceptBidHandler(bid)}
                                        >
                                          Accept
                                        </Button>
                                      ) : null}
                                    </div>
                                  </div>
                                  );
                                })}
                            </div>
                          </div>
                        ) : null}

                        <PortalTableDetailActions>
                          {row.bucket === "open" ? (
                            <>
                              <Button
                                type="button"
                                variant="primary"
                                className={`${PORTAL_DETAIL_BTN} rounded-full`}
                                onClick={() => saveScheduleFromOpen(row)}
                              >
                                Schedule visit
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                className={`${PORTAL_DETAIL_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`}
                                onClick={() => onDeleteWorkOrder(row)}
                              >
                                Delete
                              </Button>
                            </>
                          ) : row.bucket === "scheduled" ? (
                            <Button type="button" variant="outline" className={PORTAL_DETAIL_BTN} onClick={() => rescheduleVisit(row)}>
                              Save new time
                            </Button>
                          ) : null}
                          {!row.selfAssigned && row.vendorId && row.bucket !== "completed" ? (
                            <Button
                              type="button"
                              variant="outline"
                              data-attr="work-order-auto-schedule"
                              className={PORTAL_DETAIL_BTN}
                              disabled={autoSchedulingId === row.id}
                              onClick={() => autoScheduleVisit(row)}
                            >
                              {autoSchedulingId === row.id ? "Finding a slot…" : "Auto-schedule"}
                            </Button>
                          ) : null}
                          {row.bucket === "scheduled" && row.automationStatus === "vendor_marked_done" ? (
                            <Button
                              type="button"
                              variant="primary"
                              data-attr="work-order-approve-pay"
                              className={`${PORTAL_DETAIL_BTN} rounded-full`}
                              disabled={approvePayBusy}
                              onClick={() => approvePay(row)}
                            >
                              Approve &amp; pay
                            </Button>
                          ) : row.bucket === "scheduled" ? (
                            <Button type="button" variant="outline" className={PORTAL_DETAIL_BTN} onClick={() => markComplete(row)}>
                              Mark complete
                            </Button>
                          ) : null}
                          {row.bucket !== "open" ? (
                            <Button
                              type="button"
                              variant="outline"
                              className={`${PORTAL_DETAIL_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`}
                              onClick={() => onDeleteWorkOrder(row)}
                            >
                              Delete
                            </Button>
                          ) : null}
                        </PortalTableDetailActions>
      </>
    );
  };

  if (routeWorkOrderId) {
    if (!routeWorkOrder) {
      return <PortalDataTableEmpty icon="work-order" message="Work order not found." />;
    }
    return (
      <PortalRecordDetailPage
        pageTitle="Work orders"
        title={routeWorkOrder.title}
        subtitle={[routeWorkOrder.propertyName, routeWorkOrder.unit].filter(Boolean).join(" · ") || undefined}
        backHref={listBasePath ? workOrderListHref(listBasePath, bucket) : "#"}
        backLabel="Back to work orders"
        dataAttrBack="work-order-detail-back"
      >
        {renderRowDetail(routeWorkOrder)}
      </PortalRecordDetailPage>
    );
  }

  if (rows.length === 0) {
    if (listAddAction) {
      return (
        <PortalRecordListSurface
          isEmpty
          add={{
            label: listAddAction.label ?? "Add",
            ariaLabel: "Add work order",
            icon: listAddAction.icon ?? Wrench,
            onClick: listAddAction.onClick,
            dataAttr: listAddAction.dataAttr,
          }}
        />
      );
    }
    return (
      <PortalDataTableEmpty
        icon="work-order"
        message={allRows.length === 0 ? "No work orders yet." : "No work orders in this bucket yet."}
      />
    );
  }

  return (
    <div>
      <PortalRecordListSurface
        className={INBOX_LIST_SCROLL}
        add={
          listAddAction
            ? {
                label: listAddAction.label ?? "Add",
                ariaLabel: "Add work order",
                icon: listAddAction.icon ?? Wrench,
                onClick: listAddAction.onClick,
                dataAttr: listAddAction.dataAttr,
              }
            : undefined
        }
      >
        {rows.map((row) => {
          const subtitle = [row.propertyName, row.unit].filter(Boolean).join(" · ");
          return (
            <PortalServiceRecordRow
              key={row.id}
              title={row.title}
              subtitle={subtitle || undefined}
              onOpen={() => openWorkOrderDetail(row)}
              dataAttr="work-order-list-row"
            />
          );
        })}
      </PortalRecordListSurface>

      <Modal
        open={Boolean(completeRow)}
        onClose={() => setCompleteRow(null)}
        title="Complete work order"
        description={
          completeRow ? `${completeRow.propertyName} · ${completeRow.title}` : undefined
        }
        footer={
          completeRow ? (
            <ModalFooter>
              <Button type="button" variant="primary" onClick={() => submitComplete()} disabled={completeBusy}>
                {completeBusy
                  ? "Completing…"
                  : completeDraft.notifyResident && completeRow.residentEmail?.includes("@")
                    ? "Complete & notify"
                    : "Complete & log expenses"}
              </Button>
            </ModalFooter>
          ) : undefined
        }
      >
        {completeRow ? (
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Category
              <Select
               
                value={completeDraft.category}
                onChange={(e) => setCompleteDraft({ ...completeDraft, category: e.target.value as WorkOrderCategory })}
                disabled={completeBusy}
              >
                <option value="cleaning">Cleaning</option>
                <option value="plumbing">Plumbing</option>
                <option value="mold">Mold remediation</option>
                <option value="electrical">Electrical</option>
                <option value="hvac">HVAC</option>
                <option value="appliance">Appliance</option>
                <option value="access">Access / Locks</option>
                <option value="general">General maintenance</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Vendor / labor cost (USD)
              <Input
                value={completeDraft.vendorCost}
                onChange={(e) => setCompleteDraft({ ...completeDraft, vendorCost: e.target.value })}
                disabled={completeBusy}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Materials / equipment cost (USD)
              <Input
                value={completeDraft.materialsCost}
                onChange={(e) => setCompleteDraft({ ...completeDraft, materialsCost: e.target.value })}
                disabled={completeBusy}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Materials notes
              <Input
                value={completeDraft.materialsMemo}
                onChange={(e) => setCompleteDraft({ ...completeDraft, materialsMemo: e.target.value })}
                disabled={completeBusy}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Work done summary
              <Input
                value={completeDraft.workDoneSummary}
                onChange={(e) => setCompleteDraft({ ...completeDraft, workDoneSummary: e.target.value })}
                disabled={completeBusy}
              />
            </label>
            {completeRow.residentEmail?.includes("@") ? (
              <div className="space-y-2 rounded-xl border border-border bg-accent/20 p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-border text-primary"
                    checked={completeDraft.notifyResident}
                    disabled={completeBusy}
                    data-attr="work-order-complete-notify"
                    onChange={(e) => setCompleteDraft({ ...completeDraft, notifyResident: e.target.checked })}
                  />
                  <span className="font-medium text-foreground">Message resident (email + SMS)</span>
                </label>
                {completeDraft.notifyResident ? (
                  <>
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                      Subject
                      <Input
                        value={completeDraft.residentSubject}
                        onChange={(e) => setCompleteDraft({ ...completeDraft, residentSubject: e.target.value })}
                        disabled={completeBusy}
                        data-attr="work-order-complete-resident-subject"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                      Message
                      <Textarea
                        className="min-h-[120px]"
                        value={completeDraft.residentBody}
                        onChange={(e) => setCompleteDraft({ ...completeDraft, residentBody: e.target.value })}
                        disabled={completeBusy}
                        data-attr="work-order-complete-resident-body"
                      />
                    </label>
                    <div className="flex flex-wrap gap-4 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border text-primary"
                          checked={completeDraft.viaEmail}
                          disabled={completeBusy}
                          onChange={(e) => setCompleteDraft({ ...completeDraft, viaEmail: e.target.checked })}
                          data-attr="work-order-complete-via-email"
                        />
                        Email
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border text-primary"
                          checked={completeDraft.viaSms}
                          disabled={completeBusy}
                          onChange={(e) => setCompleteDraft({ ...completeDraft, viaSms: e.target.checked })}
                          data-attr="work-order-complete-via-sms"
                        />
                        Messages (SMS)
                      </label>
                    </div>
                    <p className="text-xs text-muted">Always saved to PropLane inbox. SMS uses your work number.</p>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(approvePayRow)}
        onClose={() => setApprovePayRow(null)}
        title="Approve & pay"
        description={
          approvePayRow ? `${approvePayRow.propertyName} · ${approvePayRow.title}` : undefined
        }
        footer={
          approvePayRow ? (
            <ModalFooter>
              <Button
                type="button"
                variant="primary"
                data-attr="work-order-approve-pay-confirm"
                onClick={() => submitApprovePay(approvePayRow)}
                disabled={approvePayBusy}
              >
                {approvePayBusy ? "Approving…" : "Approve & pay"}
              </Button>
            </ModalFooter>
          ) : undefined
        }
      >
        {approvePayRow ? (
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              Pay{" "}
              <span className="font-semibold">
                $
                {(
                  (approvePayDefaults(approvePayRow).vendorCostCents + approvePayDefaults(approvePayRow).materialsCostCents) /
                  100
                ).toFixed(2)}
              </span>
              {approvePayRow.vendorName ? (
                <>
                  {" "}
                  to <span className="font-semibold">{approvePayRow.vendorName}</span>
                </>
              ) : null}
            </p>
            {approvePayRow.vendorMarkedDoneNote ? (
              <p className="text-xs text-muted">Vendor note: &ldquo;{approvePayRow.vendorMarkedDoneNote}&rdquo;</p>
            ) : null}
            <p className="text-xs text-muted">
              This logs the expense, marks the work order completed, and records the vendor as paid (bookkeeping
              only; no funds are transferred).
            </p>
          </div>
        ) : null}
      </Modal>

      <ConfirmDeleteModal
        open={deleteRow !== null}
        title="Delete work order"
        description={
          deleteRow
            ? `Delete work order ${deleteRow.id}${deleteRow.title ? ` (“${deleteRow.title}”)` : ""}?`
            : null
        }
        confirmLabel="Delete work order"
        dataAttr="work-order-delete-confirm"
        onClose={() => setDeleteRow(null)}
        onConfirm={confirmDeleteWorkOrder}
      />
    </div>
  );
}
