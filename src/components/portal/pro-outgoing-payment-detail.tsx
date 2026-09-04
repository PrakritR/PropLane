"use client";

import { useMemo, useState } from "react";
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
import { generateWorkOrderPaymentReference } from "@/lib/payment-reference";
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
    () => defaultManagerVendorPayMethod(vendor) ?? "zelle",
  );
  const [payConfirmOpenInternal, setPayConfirmOpenInternal] = useState(false);
  const payConfirmOpen = payModalOpen ?? payConfirmOpenInternal;
  const setPayConfirmOpen = onPayModalOpenChange ?? setPayConfirmOpenInternal;
  const [manualSentConfirmed, setManualSentConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const canPayWithSelected = managerCanPayOutgoingRowWithMethod(row, paymentMethod);
  const paymentReference = workOrder
    ? workOrder.paymentReference?.trim() || generateWorkOrderPaymentReference(workOrder.id)
    : null;

  const submitPay = async () => {
    if (!workOrder) {
      showToast("Work order not found.");
      return;
    }
    if (!canPayWithSelected) {
      showToast(`This vendor cannot be paid with ${managerVendorPayMethodLabel(paymentMethod)}.`);
      return;
    }
    if (paymentMethod !== "ach" && !manualSentConfirmed) {
      showToast("Confirm that you sent the payment.");
      return;
    }

    if (isDemoModeActive()) {
      updateManagerWorkOrder(workOrder.id, (current) => ({
        ...current,
        automationStatus: "paid",
        paidAt: new Date().toISOString(),
        vendorPaymentChannel: paymentMethod,
        vendorZelleContactSnapshot: vendor?.zelleContact?.trim() || undefined,
        vendorVenmoContactSnapshot: vendor?.venmoContact?.trim() || undefined,
      }));
      showToast(`Marked paid via ${managerVendorPayMethodLabel(paymentMethod)} (demo).`);
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
        }),
      });
      const data = (await res.json()) as { workOrder?: DemoManagerWorkOrderRow; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not complete payment.");
      if (data.workOrder) updateManagerWorkOrder(workOrder.id, () => data.workOrder as DemoManagerWorkOrderRow);
      void syncManagerWorkOrdersFromServer();
      showToast(
        paymentMethod === "ach"
          ? "Approved and paid through PropLane."
          : `Marked paid · ${managerVendorPayMethodLabel(paymentMethod)}.`,
      );
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

      {row.zelleContactSnapshot ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-confirmed-fg)]">
          <p className="text-xs font-semibold">Pay with Zelle</p>
          <p className="mt-1 text-sm leading-relaxed">
            Send to <span className="font-mono font-medium">{row.zelleContactSnapshot}</span>.
            {paymentReference ? (
              <>
                {" "}
                Put <span className="font-mono font-medium">{paymentReference}</span> in the memo.
              </>
            ) : (
              <> Include the work order title in the memo.</>
            )}
          </p>
        </div>
      ) : null}

      {row.venmoContactSnapshot ? (
        <div className="glass-card mb-4 rounded-lg px-3 py-2.5 text-[var(--status-approved-fg)]">
          <p className="text-xs font-semibold">Pay with Venmo</p>
          <p className="mt-1 text-sm leading-relaxed">
            Send to <span className="font-mono font-medium">{row.venmoContactSnapshot}</span>.
            {paymentReference ? (
              <>
                {" "}
                Put <span className="font-mono font-medium">{paymentReference}</span> in the note.
              </>
            ) : (
              <> Include the property and work order in the note.</>
            )}
          </p>
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
              onClick={() => {
                setManualSentConfirmed(false);
                setPayConfirmOpen(true);
              }}
            >
              Pay {row.amountLabel}
            </Button>
          </div>
        </div>
      ) : payable ? (
        <p className="mb-4 text-sm text-muted">
          Ask the vendor to add Zelle, Venmo, or bank details under Vendor → Payments → Payment methods.
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
              disabled={busy || (paymentMethod !== "ach" && !manualSentConfirmed)}
              onClick={() => submitPay()}
            >
              {busy ? "Processing…" : paymentMethod === "ach" ? "Approve & pay" : "Mark as paid"}
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
          {paymentMethod === "zelle" && row.zelleContactSnapshot ? (
            <p className="text-muted">
              Send to <span className="font-mono text-foreground">{row.zelleContactSnapshot}</span>
            </p>
          ) : null}
          {paymentMethod === "venmo" && row.venmoContactSnapshot ? (
            <p className="text-muted">
              Send to <span className="font-mono text-foreground">{row.venmoContactSnapshot}</span>
            </p>
          ) : null}
          {paymentMethod === "ach" ? (
            <p className="text-muted">
              PropLane will attempt an ACH payout to the vendor&apos;s linked bank account and log this expense.
            </p>
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-border"
                checked={manualSentConfirmed}
                onChange={(e) => setManualSentConfirmed(e.target.checked)}
              />
              <span>I sent this payment outside PropLane.</span>
            </label>
          )}
        </div>
      </Modal>
    </>
  );
}
