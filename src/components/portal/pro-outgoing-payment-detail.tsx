"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalPaymentMethodPicker } from "@/components/portal/portal-payment-method-picker";
import {
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import type { DemoManagerOutgoingPaymentRow, DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  availableManagerVendorPayMethods,
  defaultManagerVendorPayMethod,
  managerCanPayOutgoingRowWithMethod,
  managerVendorPayMethodLabel,
  type ManagerVendorPayMethod,
} from "@/lib/manager-vendor-payment-flow";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import {
  syncManagerWorkOrdersFromServer,
  updateManagerWorkOrder,
} from "@/lib/manager-work-orders-storage";
import { parseMoneyAmount } from "@/lib/parse-money";
import {
  existingVendorPayoutWarning,
  VENDOR_DOUBLE_PAY_CONFLICT_CODE,
  type ExistingVendorPayoutSummary,
} from "@/lib/vendor-payout-guard";
import { parseWorkOrderCategoryFromDescription } from "@/lib/reports/formal-documents/spec";

function approvePayDefaults(row: DemoManagerWorkOrderRow) {
  return {
    category: row.category ?? parseWorkOrderCategoryFromDescription(row.description),
    vendorCostCents: row.vendorCostCents ?? Math.round(parseMoneyAmount(row.cost) * 100),
    materialsCostCents: row.materialsCostCents ?? 0,
    materialsMemo: row.materialsMemo ?? "",
    workDoneSummary: row.workDoneSummary || row.vendorMarkedDoneNote || row.title,
  };
}

export function ManagerOutgoingPaymentDetail({
  row,
  workOrder,
  vendor,
  onPaid,
  onDelete,
  deleteBusy = false,
  hideActionBar = false,
  payModalOpen,
  onPayModalOpenChange,
}: {
  row: DemoManagerOutgoingPaymentRow;
  workOrder?: DemoManagerWorkOrderRow;
  vendor?: ManagerVendorRow | null;
  onPaid?: () => void;
  onDelete?: () => void;
  deleteBusy?: boolean;
  hideActionBar?: boolean;
  payModalOpen?: boolean;
  onPayModalOpenChange?: (open: boolean) => void;
}) {
  const { showToast } = useAppUi();
  const payable = Boolean(row.workOrderId && row.bucket !== "paid");
  const methods = useMemo(() => availableManagerVendorPayMethods(vendor), [vendor]);
  const [paymentMethod, setPaymentMethod] = useState<ManagerVendorPayMethod>(
    () => defaultManagerVendorPayMethod(vendor) ?? "ach",
  );
  const [payConfirmOpenInternal, setPayConfirmOpenInternal] = useState(false);
  const payConfirmOpen = payModalOpen ?? payConfirmOpenInternal;
  const setPayConfirmOpen = onPayModalOpenChange ?? setPayConfirmOpenInternal;
  const [busy, setBusy] = useState(false);
  // Double-pay guard: a `pending` / `paid` vendor_payouts row already on this work
  // order. Pre-checked when the confirm step opens so the warning shows before the
  // first click; the server refuses with a 409 either way until acknowledged.
  const [existingPayout, setExistingPayout] = useState<ExistingVendorPayoutSummary | null>(null);
  const [doublePayAcknowledged, setDoublePayAcknowledged] = useState(false);

  const workOrderId = workOrder?.id ?? null;
  useEffect(() => {
    if (!payConfirmOpen) return;
    setDoublePayAcknowledged(false);
    if (!workOrderId || isDemoModeActive()) {
      setExistingPayout(null);
      return;
    }
    let cancelled = false;
    void fetch(`/api/portal/work-orders/approve-pay?workOrderId=${encodeURIComponent(workOrderId)}`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : { existingPayout: null }))
      .then((data: { existingPayout?: ExistingVendorPayoutSummary | null }) => {
        if (!cancelled) setExistingPayout(data.existingPayout ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [payConfirmOpen, workOrderId]);

  const needsDoublePayAck = Boolean(existingPayout) && !doublePayAcknowledged;

  const canPayWithSelected = managerCanPayOutgoingRowWithMethod(row, paymentMethod);

  const submitPay = async () => {
    if (!workOrder) {
      showToast("Service not found.");
      return;
    }
    if (!canPayWithSelected) {
      showToast(`This vendor cannot be paid with ${managerVendorPayMethodLabel(paymentMethod)}.`);
      return;
    }
    if (needsDoublePayAck) {
      showToast("Acknowledge the existing PropLane payout to continue.");
      return;
    }

    if (isDemoModeActive()) {
      updateManagerWorkOrder(workOrder.id, (current) => ({
        ...current,
        automationStatus: "paid",
        paidAt: new Date().toISOString(),
        vendorPaymentChannel: paymentMethod,
      }));
      showToast("Approved and paid through PropLane (demo).");
      setPayConfirmOpen(false);
      onPaid?.();
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/portal/work-orders/approve-pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          workOrder,
          ...approvePayDefaults(workOrder),
          paymentChannel: paymentMethod,
          acknowledgeExistingPayout: doublePayAcknowledged,
        }),
      });
      const data = (await res.json()) as {
        workOrder?: DemoManagerWorkOrderRow;
        error?: string;
        code?: string;
        existingPayout?: ExistingVendorPayoutSummary | null;
      };
      if (res.status === 409 && data.code === VENDOR_DOUBLE_PAY_CONFLICT_CODE && data.existingPayout) {
        // The pre-check missed it (or the payout landed since). Surface the server's
        // warning on the open confirm step and require the acknowledgement.
        setExistingPayout(data.existingPayout);
        setDoublePayAcknowledged(false);
        showToast("Acknowledge the existing PropLane payout to continue.");
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Could not complete payment.");
      if (data.workOrder) updateManagerWorkOrder(workOrder.id, () => data.workOrder as DemoManagerWorkOrderRow);
      void syncManagerWorkOrdersFromServer();
      showToast("Approved and paid through PropLane.");
      setPayConfirmOpen(false);
      onPaid?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not complete payment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        Due: <span className="font-semibold text-foreground">{row.dueDate}</span>
        {" · "}
        Payee: <span className="font-semibold text-foreground">{row.payeeLabel}</span>
      </p>

      {row.paidViaChannel && row.bucket === "paid" ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-confirmed-fg)]">
          <p className="text-xs font-semibold">Paid via {managerVendorPayMethodLabel(row.paidViaChannel)}</p>
          {row.paidAtLabel ? (
            <p className="mt-1 text-sm leading-relaxed">Marked paid {row.paidAtLabel}</p>
          ) : null}
        </div>
      ) : null}

      {row.achAvailable ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-pending-fg)]">
          <p className="text-xs font-semibold">Pay through PropLane (ACH)</p>
          <p className="mt-1 text-sm leading-relaxed">
            Approve &amp; pay to log the expense and send an ACH transfer when the vendor has linked their bank in the
            vendor portal.
          </p>
        </div>
      ) : null}

      {payable && methods.length > 0 ? (
        <div className="mb-4">
          <PortalPaymentMethodPicker
            options={methods}
            value={paymentMethod}
            onChange={setPaymentMethod}
            dataAttrPrefix="manager-outgoing-payment-method"
          />
          <div className="mt-3">
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="manager-outgoing-payment-pay"
              disabled={!canPayWithSelected || busy}
              onClick={() => setPayConfirmOpen(true)}
            >
              Pay {row.amountLabel}
            </Button>
          </div>
        </div>
      ) : payable ? (
        <p className="mb-4 text-sm text-muted">
          Ask the vendor to link their bank under Vendor → Payments → Payment methods.
        </p>
      ) : null}

      {row.fromExpense && !row.workOrderId && row.bucket === "paid" ? (
        <p className="text-xs text-muted">Logged expense. No vendor payout action required.</p>
      ) : null}

      {!hideActionBar ? (
      <PortalTableDetailActions>
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          onClick={(event) => {
            event.stopPropagation();
            void navigator.clipboard?.writeText(row.amountLabel);
            showToast("Amount copied.");
          }}
        >
          Copy amount
        </Button>
        {onDelete ? (
          <Button
            type="button"
            variant="outline"
            className={`${PORTAL_DETAIL_BTN} text-danger`}
            disabled={deleteBusy}
            data-attr="outgoing-payment-delete"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            {deleteBusy ? "Deleting…" : "Delete"}
          </Button>
        ) : null}
      </PortalTableDetailActions>
      ) : null}

      <Modal
        open={payConfirmOpen}
        onClose={() => setPayConfirmOpen(false)}
        title="Confirm vendor payment"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className={PORTAL_DETAIL_BTN}
              data-attr="manager-outgoing-payment-confirm-pay"
              disabled={busy || needsDoublePayAck}
              onClick={() => submitPay()}
            >
              {busy ? "Processing…" : "Approve & pay"}
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-4 text-sm">
          <p>
            Pay <span className="font-semibold text-foreground">{row.amountLabel}</span> to{" "}
            <span className="font-semibold text-foreground">{row.payeeLabel}</span> via{" "}
            <span className="font-semibold text-foreground">{managerVendorPayMethodLabel(paymentMethod)}</span>.
          </p>
          {existingPayout ? (
            <div
              role="alert"
              className="rounded-xl border px-4 py-3 text-sm portal-banner-danger"
              data-attr="manager-outgoing-payment-double-pay-warning"
            >
              <p className="font-semibold">This vendor may already be paid</p>
              <p className="mt-1 leading-relaxed">{existingVendorPayoutWarning(existingPayout)}</p>
              <label className="mt-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-border"
                  checked={doublePayAcknowledged}
                  onChange={(e) => setDoublePayAcknowledged(e.target.checked)}
                  data-attr="manager-outgoing-payment-double-pay-ack"
                />
                <span>I understand a PropLane payout already exists for this service and still want to mark it paid.</span>
              </label>
            </div>
          ) : null}
          <p className="text-muted">
            PropLane will attempt an ACH payout to the vendor&apos;s linked bank account and log this expense.
          </p>
        </div>
      </Modal>
    </>
  );
}
