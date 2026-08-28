"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ManagerPortalPageShell,
  ManagerPortalStatusPills,
  PORTAL_HEADER_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import {
  PORTAL_DETAIL_BTN,
  PORTAL_DETAIL_BTN_PRIMARY,
  PORTAL_MOBILE_DETAIL_EXPAND,
  PortalDataTableEmpty,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { PortalPaymentsTable, type PortalPaymentTableRow } from "@/components/portal/portal-payments-table";
import { VendorPaymentMethodsModal } from "@/components/portal/vendor-payment-methods-modal";
import { GmailPaymentAutoTrackPanel } from "@/components/portal/gmail-payment-auto-track-panel";
import { formatGmailPaymentsConnectError } from "@/lib/gmail-payments/connect-errors";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readVendorWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import { safeFormatDateTime } from "@/lib/pacific-time";
import { fetchVendorPayoutsResult, type VendorPayout } from "@/lib/vendor-payouts";
import { VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS } from "@/lib/vendor-payment-methods";
import { managerVendorPayMethodLabel } from "@/lib/manager-vendor-payment-flow";
import { workOrderPaymentReference } from "@/lib/manual-payment-instructions";

type VendorPaymentBucket = "pending" | "paid";

type VendorPaymentLedgerRow = {
  id: string;
  propertyName: string;
  workOrderTitle: string;
  payeeLabel: string;
  amountLabel: string;
  dateLabel: string;
  bucket: VendorPaymentBucket;
  payoutStatus: string | null;
  payoutFailureReason: string | null;
};

const PAY_LABELS: { id: VendorPaymentBucket; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "paid", label: "Paid" },
];

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function workOrderAmountCents(row: DemoManagerWorkOrderRow): number {
  const labor = row.vendorCostCents ?? 0;
  const materials = row.materialsCostCents ?? 0;
  if (labor + materials > 0) return labor + materials;
  const parsed = parseFloat((row.cost ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
}

function vendorPaymentBucket(row: DemoManagerWorkOrderRow): VendorPaymentBucket | null {
  if (row.automationStatus === "paid") return "paid";
  if (row.bucket !== "completed" && row.automationStatus !== "vendor_marked_done") return null;
  return "pending";
}

function payoutStatusLabel(payout: VendorPayout | undefined): string | null {
  if (!payout) return null;
  if (payout.status === "paid") return "Payout sent";
  if (payout.status === "failed") return "Payout failed";
  if (payout.status === "skipped") return "Payout skipped";
  return null;
}

function managerPayeeLabel(_row: DemoManagerWorkOrderRow): string {
  return CANONICAL_DEMO_MANAGER_NAME;
}

function toLedgerRow(row: DemoManagerWorkOrderRow, payout: VendorPayout | undefined): VendorPaymentLedgerRow | null {
  const bucket = vendorPaymentBucket(row);
  if (!bucket) return null;

  const amountCents = workOrderAmountCents(row);
  const payoutLabel = payoutStatusLabel(payout);

  const dateIso =
    bucket === "paid"
      ? row.paidAt ?? payout?.createdAt ?? row.completedAt
      : row.vendorMarkedDoneAt ?? row.completedAt;
  const dateLabel = dateIso ? safeFormatDateTime(dateIso) : "—";

  return {
    id: row.id,
    propertyName: propertyLabel(row),
    workOrderTitle: row.title,
    payeeLabel: managerPayeeLabel(row),
    amountLabel: amountCents > 0 ? formatMoney(amountCents) : row.cost || "—",
    dateLabel,
    bucket,
    payoutStatus: payoutLabel,
    payoutFailureReason: payout?.failureReason ?? null,
  };
}

type VendorPaymentNotifyAction = "send_reminder" | "report_paid";

async function notifyVendorPayment(
  workOrderId: string,
  action: VendorPaymentNotifyAction,
  demo: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (demo) return { ok: true };
  try {
    const res = await fetch("/api/vendor/work-orders/payment-notify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workOrderId, action }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? "Could not send notification." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not send notification." };
  }
}

function VendorPaymentExpandedDetail({
  row,
  workOrder,
  vendorProfile,
  bucket,
}: {
  row: VendorPaymentLedgerRow;
  workOrder: DemoManagerWorkOrderRow;
  vendorProfile: ManagerVendorRow | null;
  bucket: VendorPaymentBucket;
}) {
  const paidChannel = workOrder.vendorPaymentChannel;
  const paymentRef = workOrderPaymentReference(workOrder);

  return (
    <div className={PORTAL_MOBILE_DETAIL_EXPAND}>
      {workOrder.paidViaGmailMessageId && bucket === "paid" ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-confirmed-fg)]">
          <p className="text-xs font-semibold">Payment confirmed automatically</p>
          <p className="mt-1 text-sm leading-relaxed">
            Your incoming Zelle or Venmo payment was matched and marked paid.
          </p>
        </div>
      ) : null}
      {paidChannel && bucket === "paid" ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-confirmed-fg)]">
          <p className="text-xs font-semibold">Paid via {managerVendorPayMethodLabel(paidChannel)}</p>
          {paidChannel === "zelle" && workOrder.vendorZelleContactSnapshot ? (
            <p className="mt-1 text-sm leading-relaxed">
              Sent to <span className="font-mono font-medium">{workOrder.vendorZelleContactSnapshot}</span>
            </p>
          ) : null}
          {paidChannel === "venmo" && workOrder.vendorVenmoContactSnapshot ? (
            <p className="mt-1 text-sm leading-relaxed">
              Sent to <span className="font-mono font-medium">{workOrder.vendorVenmoContactSnapshot}</span>
            </p>
          ) : null}
          {paidChannel === "ach" ? (
            <p className="mt-1 text-sm leading-relaxed">
              {row.payoutStatus ?? "ACH transfer through PropLane when your bank is linked."}
            </p>
          ) : null}
        </div>
      ) : null}

      {bucket === "pending" && vendorProfile?.zellePaymentsEnabled && vendorProfile.zelleContact?.trim() ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-confirmed-fg)]">
          <p className="text-xs font-semibold">{VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS.zelle}</p>
          <p className="mt-1 text-sm leading-relaxed">
            Your manager can send to{" "}
            <span className="font-mono font-medium">{vendorProfile.zelleContact.trim()}</span>. Include code{" "}
            <span className="font-mono font-medium">{paymentRef}</span> in the memo.
          </p>
        </div>
      ) : null}

      {bucket === "pending" && vendorProfile?.venmoPaymentsEnabled && vendorProfile.venmoContact?.trim() ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-approved-fg)]">
          <p className="text-xs font-semibold">{VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS.venmo}</p>
          <p className="mt-1 text-sm leading-relaxed">
            Your manager can send to{" "}
            <span className="font-mono font-medium">{vendorProfile.venmoContact.trim()}</span>. Include code{" "}
            <span className="font-mono font-medium">{paymentRef}</span> in the note.
          </p>
        </div>
      ) : null}

      {bucket === "pending" && vendorProfile?.achPaymentsEnabled ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-pending-fg)]">
          <p className="text-xs font-semibold">Pay through PropLane (ACH)</p>
          <p className="mt-1 text-sm leading-relaxed">
            When your bank is linked, your manager can approve &amp; pay to send an ACH transfer automatically.
          </p>
        </div>
      ) : null}

      {row.payoutFailureReason ? <p className="text-xs text-muted">{row.payoutFailureReason}</p> : null}
    </div>
  );
}

/** Vendor Payments — payout history from completed work orders + Stripe Connect bank linking. */
export function VendorPaymentsPanel() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();

  const [bucket, setBucket] = useState<VendorPaymentBucket>("pending");
  const [tick, setTick] = useState(0);
  const [payoutsByWorkOrderId, setPayoutsByWorkOrderId] = useState<Record<string, VendorPayout>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [vendorProfile, setVendorProfile] = useState<ManagerVendorRow | null>(null);
  const [paymentMethodsOpen, setPaymentMethodsOpen] = useState(false);

  const loadVendorProfile = useCallback(async () => {
    if (isDemoModeActive()) {
      setVendorProfile({
        id: "demo-vendor",
        managerUserId: null,
        name: "Demo Vendor",
        trade: "HVAC",
        phone: "",
        email: "",
        notes: "",
        active: true,
      });
      return;
    }
    const res = await fetch("/api/vendor/profile", { credentials: "include" });
    const data = (await res.json().catch(() => ({}))) as { profile?: ManagerVendorRow | null };
    setVendorProfile(data.profile ?? null);
  }, []);

  const loadPayouts = useCallback(async () => {
    const result = await fetchVendorPayoutsResult();
    if (!result.ok) return;
    setPayoutsByWorkOrderId(Object.fromEntries(result.payouts.map((p) => [p.workOrderId, p])));
  }, []);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    void syncManagerWorkOrdersFromServer().then(bump);
    void loadPayouts();
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
  }, [loadPayouts]);

  useEffect(() => {
    if (demo) return;
    void fetch("/api/vendor/profile", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { linked?: boolean; profile?: ManagerVendorRow | null }) => {
        setUnlinked(data.linked === false);
        setVendorProfile(data.profile ?? null);
      })
      .catch(() => undefined);
  }, [demo]);

  useEffect(() => {
    if (!paymentMethodsOpen) return;
    void loadVendorProfile();
  }, [paymentMethodsOpen, loadVendorProfile]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const connect = params.get("connect");
    const gmailPay = params.get("gmail-pay");
    if (connect === "done") {
      showToast("Bank account linked.");
    } else if (connect === "refresh") {
      showToast("Setup link expired. Open Payment methods and try again.");
    } else if (gmailPay === "connected") {
      showToast("Gmail linked for payment tracking.");
    } else if (gmailPay === "error") {
      const reason = params.get("reason");
      showToast(formatGmailPaymentsConnectError(reason));
    }
    if (connect || gmailPay) {
      const url = new URL(window.location.href);
      url.searchParams.delete("connect");
      url.searchParams.delete("gmail-pay");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, [showToast]);

  const workOrderById = useMemo(() => {
    void tick;
    const map = new Map<string, DemoManagerWorkOrderRow>();
    for (const row of readVendorWorkOrderRows()) map.set(row.id, row);
    return map;
  }, [tick]);

  const ledgerRows = useMemo(() => {
    void tick;
    return readVendorWorkOrderRows()
      .map((row) => toLedgerRow(row, payoutsByWorkOrderId[row.id]))
      .filter((row): row is VendorPaymentLedgerRow => row !== null);
  }, [tick, payoutsByWorkOrderId]);

  const ledgerById = useMemo(() => new Map(ledgerRows.map((row) => [row.id, row])), [ledgerRows]);

  const counts = useMemo(() => {
    const c: Record<VendorPaymentBucket, number> = { pending: 0, paid: 0 };
    for (const row of ledgerRows) c[row.bucket] += 1;
    return c;
  }, [ledgerRows]);

  const tabs = useMemo(
    () =>
      PAY_LABELS.map(({ id, label }) => ({
        id,
        label,
        count: counts[id],
      })),
    [counts],
  );

  const rowsForBucket = useMemo(
    () => ledgerRows.filter((row) => row.bucket === bucket),
    [ledgerRows, bucket],
  );

  const tableRows = useMemo<PortalPaymentTableRow[]>(
    () =>
      rowsForBucket.map((row) => ({
        id: row.id,
        charge: row.workOrderTitle,
        property: row.propertyName,
        payee: row.payeeLabel,
        dueDate: row.dateLabel,
        amount: row.amountLabel,
      })),
    [rowsForBucket],
  );

  const rowIdsKey = useMemo(() => rowsForBucket.map((row) => row.id).join(","), [rowsForBucket]);
  const showSelection = bucket === "pending" && rowsForBucket.length > 0;
  const allSelected = showSelection && rowsForBucket.every((row) => selectedIds.has(row.id));

  useEffect(() => {
    setSelectedIds(new Set());
    setExpandedId(null);
  }, [bucket, rowIdsKey]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const all = rowsForBucket.length > 0 && rowsForBucket.every((row) => prev.has(row.id));
      return all ? new Set() : new Set(rowsForBucket.map((row) => row.id));
    });
  }, [rowsForBucket]);

  const runNotify = useCallback(
    async (workOrderId: string, action: VendorPaymentNotifyAction) => {
      setRowBusyId(workOrderId);
      const result = await notifyVendorPayment(workOrderId, action, demo);
      setRowBusyId(null);
      if (!result.ok) {
        showToast(result.error ?? "Could not complete that action.");
        return false;
      }
      if (action === "report_paid") {
        showToast("Marked paid. Manager notified.");
      } else {
        showToast("Reminder sent.");
      }
      return true;
    },
    [demo, showToast],
  );

  const runBulkNotify = useCallback(
    async (action: VendorPaymentNotifyAction) => {
      const ids = [...selectedIds];
      if (ids.length === 0) return;
      setBulkBusy(true);
      let ok = 0;
      for (const workOrderId of ids) {
        const result = await notifyVendorPayment(workOrderId, action, demo);
        if (result.ok) ok += 1;
      }
      setBulkBusy(false);
      if (ok === 0) {
        showToast("Could not complete that action.");
        return;
      }
      setSelectedIds(new Set());
      if (action === "report_paid") {
        showToast(ok === 1 ? "Marked paid. Manager notified." : `Marked ${ok} payments paid. Manager notified.`);
      } else {
        showToast(ok === 1 ? "Reminder sent." : `Sent ${ok} reminders.`);
      }
    },
    [demo, selectedIds, showToast],
  );

  const renderExpandedActions = (tr: PortalPaymentTableRow) => {
    const row = ledgerById.get(tr.id)!;
    const busy = rowBusyId === row.id || bulkBusy;
    if (bucket === "paid") return null;
    return (
      <PortalTableDetailActions>
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN_PRIMARY}
          disabled={busy}
          data-attr="vendor-payments-mark-paid"
          onClick={(event) => {
            event.stopPropagation();
            void runNotify(row.id, "report_paid");
          }}
        >
          {busy ? "Updating…" : "Mark as paid"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          disabled={busy}
          data-attr="vendor-payments-send-reminder"
          onClick={(event) => {
            event.stopPropagation();
            void runNotify(row.id, "send_reminder");
          }}
        >
          {busy ? "Sending…" : "Send reminder"}
        </Button>
      </PortalTableDetailActions>
    );
  };

  const renderExpandedDetail = (tr: PortalPaymentTableRow) => {
    const row = ledgerById.get(tr.id)!;
    const workOrder = workOrderById.get(row.id);
    if (!workOrder) return null;
    return (
      <VendorPaymentExpandedDetail
        row={row}
        workOrder={workOrder}
        vendorProfile={vendorProfile}
        bucket={bucket}
      />
    );
  };

  return (
    <ManagerPortalPageShell
      title="Payments"
      hideTitleOnMobileNav
      titleAside={
        <Button
          type="button"
          variant="primary"
          className={PORTAL_HEADER_ACTION_BTN}
          onClick={() => setPaymentMethodsOpen(true)}
          data-attr="vendor-payments-add"
        >
          Payment methods
        </Button>
      }
    >
      <div className="mb-4">
        <ManagerPortalStatusPills tabs={tabs} activeId={bucket} onChange={(id) => setBucket(id as VendorPaymentBucket)} />
      </div>

      {unlinked ? (
        <p
          className="mb-4 rounded-xl border px-4 py-3 text-sm portal-banner-pending"
          data-attr="vendor-payments-unlinked-banner"
        >
          Waiting on a property manager to connect with you. Completed work will appear here once you&apos;re linked.
        </p>
      ) : (
        <div className="mb-4">
          <GmailPaymentAutoTrackPanel
            role="vendor"
            demo={demo}
            autoMarkEnabled
            onAutoMarkChange={() => undefined}
            showToast={showToast}
          />
        </div>
      )}

      {showSelection && selectedIds.size > 0 ? (
        <div className="mb-3">
          <PortalTableDetailActions>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN_PRIMARY}
              disabled={bulkBusy}
              data-attr="vendor-payments-mark-paid"
              onClick={() => runBulkNotify("report_paid")}
            >
              {bulkBusy ? "Updating…" : "Mark paid"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              disabled={bulkBusy}
              data-attr="vendor-payments-send-reminder"
              onClick={() => runBulkNotify("send_reminder")}
            >
              {bulkBusy ? "Sending…" : "Send reminder"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              disabled={bulkBusy}
              onClick={() => setSelectedIds(new Set())}
            >
              Clear selection
            </Button>
          </PortalTableDetailActions>
        </div>
      ) : null}

      {rowsForBucket.length === 0 ? (
        <PortalDataTableEmpty message="No payments in this bucket yet." icon="payment" />
      ) : (
        <PortalPaymentsTable
          rows={tableRows}
          expandedId={expandedId}
          onExpand={setExpandedId}
          expandOnRowClick
          selection={
            showSelection
              ? {
                  selectedIds,
                  allSelected,
                  onToggle: toggleSelected,
                  onToggleAll: toggleSelectAll,
                  selectLabel: (tr) => `Select ${tr.charge}`,
                }
              : undefined
          }
          renderExpandedActions={renderExpandedActions}
          renderExpandedDetail={renderExpandedDetail}
        />
      )}
      <VendorPaymentMethodsModal
        open={paymentMethodsOpen}
        onClose={() => setPaymentMethodsOpen(false)}
        profile={vendorProfile}
        onSaved={setVendorProfile}
      />
    </ManagerPortalPageShell>
  );
}
