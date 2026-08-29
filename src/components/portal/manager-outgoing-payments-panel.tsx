"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerOutgoingPaymentDetail } from "@/components/portal/manager-outgoing-payment-detail";
import {
  PORTAL_DETAIL_BTN,
  PortalDataTableEmpty,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import type { DemoManagerOutgoingPaymentRow, DemoManagerWorkOrderRow, ManagerPaymentBucket } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { deleteManagerOutgoingExpense } from "@/lib/manager-outgoing-payments";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { readManagerWorkOrderRows } from "@/lib/manager-work-orders-storage";
import { paymentDetailHref, paymentListHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";

export function ManagerOutgoingPaymentsPanel({
  rows,
  activeBucket,
  vendorById,
  onRowsChanged,
  paymentId: paymentIdProp,
  listBasePath,
  onAddPayment,
}: {
  rows: DemoManagerOutgoingPaymentRow[];
  activeBucket: ManagerPaymentBucket;
  vendorById?: Map<string, ManagerVendorRow>;
  onRowsChanged?: () => void;
  paymentId?: string;
  listBasePath?: string;
  onAddPayment?: () => void;
}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [payModalRowId, setPayModalRowId] = useState<string | null>(null);

  const workOrderById = useMemo(() => {
    const map = new Map<string, DemoManagerWorkOrderRow>();
    for (const row of readManagerWorkOrderRows()) map.set(row.id, row);
    return map;
  }, [rows]);

  const detailRow = useMemo(() => {
    if (!paymentIdProp) return null;
    const decoded = decodeURIComponent(paymentIdProp);
    return rows.find((row) => row.id === decoded) ?? null;
  }, [paymentIdProp, rows]);

  const navigateToList = useCallback(() => {
    if (!listBasePath) return;
    navigate(paymentListHref(listBasePath, "outgoing", activeBucket));
  }, [activeBucket, listBasePath, navigate]);

  const openPaymentDetail = useCallback(
    (row: DemoManagerOutgoingPaymentRow) => {
      if (listBasePath) {
        navigate(paymentDetailHref(listBasePath, "outgoing", activeBucket, row.id));
      }
    },
    [activeBucket, listBasePath, navigate],
  );

  const deleteExpense = async (row: DemoManagerOutgoingPaymentRow) => {
    if (!row.expenseEntryId) {
      showToast("This payment cannot be deleted.");
      return;
    }
    if (row.fromAxisFee) return;
    if (row.workOrderId && !row.fromExpense) {
      showToast("Work-order expenses are managed from Services.");
      return;
    }
    if (!window.confirm(`Delete "${row.chargeTitle}"?`)) return;

    if (isDemoModeActive()) {
      if (!deleteManagerOutgoingExpense(row.expenseEntryId)) {
        showToast("Could not delete expense.");
        return;
      }
      navigateToList();
      showToast("Expense removed.");
      onRowsChanged?.();
      return;
    }

    setDeletingId(row.id);
    try {
      const res = await fetch(`/api/expenses?id=${encodeURIComponent(row.expenseEntryId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not delete expense.");
      deleteManagerOutgoingExpense(row.expenseEntryId);
      navigateToList();
      showToast("Expense removed.");
      onRowsChanged?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete expense.");
    } finally {
      setDeletingId(null);
    }
  };

  const canDeleteExpense = (row: DemoManagerOutgoingPaymentRow) =>
    Boolean(row.fromExpense && row.expenseEntryId && !row.fromAxisFee);

  const isPayableWorkOrder = (row: DemoManagerOutgoingPaymentRow) =>
    Boolean(row.workOrderId && row.bucket !== "paid");

  const renderHeaderActions = (row: DemoManagerOutgoingPaymentRow) => {
    const payable = isPayableWorkOrder(row);
    return (
      <PortalTableDetailActions>
        {payable ? (
          <Button
            type="button"
            variant="primary"
            className={PORTAL_DETAIL_BTN}
            data-attr="manager-outgoing-payment-mark-paid"
            onClick={() => setPayModalRowId(row.id)}
          >
            Mark as paid
          </Button>
        ) : null}
        {canDeleteExpense(row) ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            disabled={deletingId === row.id}
            data-attr="outgoing-payment-delete"
            onClick={() => deleteExpense(row)}
          >
            {deletingId === row.id ? "Deleting…" : "Delete"}
          </Button>
        ) : null}
      </PortalTableDetailActions>
    );
  };

  const renderDetailBody = (row: DemoManagerOutgoingPaymentRow) => {
    const workOrder = row.workOrderId ? workOrderById.get(row.workOrderId) : undefined;
    const vendor = row.vendorId ? vendorById?.get(row.vendorId) : undefined;
    if (row.workOrderId) {
      return (
        <ManagerOutgoingPaymentDetail
          row={row}
          workOrder={workOrder}
          vendor={vendor}
          hideActionBar
          payModalOpen={payModalRowId === row.id}
          onPayModalOpenChange={(open) => {
            if (!open) setPayModalRowId(null);
          }}
          onPaid={() => {
            setPayModalRowId(null);
            navigateToList();
            onRowsChanged?.();
          }}
          onDelete={canDeleteExpense(row) ? () => void deleteExpense(row) : undefined}
          deleteBusy={deletingId === row.id}
        />
      );
    }
    return (
      <p className="text-sm text-muted">
        Due: <span className="font-semibold text-foreground">{row.dueDate}</span>
        {" · "}
        Payee: <span className="font-semibold text-foreground">{row.payeeLabel}</span>
      </p>
    );
  };

  if (rows.length === 0) {
    if (onAddPayment) {
      return (
        <div className={`${PORTAL_LIST_ADD_ROW_WRAP_CLASS} pt-5 sm:pt-6`}>
          <PortalListAddRow
            label="Add"
            icon={PORTAL_LIST_ADD_ICONS.payment}
            onClick={onAddPayment}
            dataAttr="payments-list-add"
          />
        </div>
      );
    }
    return <PortalDataTableEmpty message="No outgoing payments in this bucket yet." icon="payment" />;
  }

  if (paymentIdProp && detailRow) {
    return (
      <PortalRecordDetailPage
        pageTitle="Payments"
        title={detailRow.chargeTitle}
        subtitle={detailRow.payeeLabel}
        backHref={listBasePath ? paymentListHref(listBasePath, "outgoing", activeBucket) : "#"}
        backLabel="Back to payments"
        hideBackText
        bareHeader
        dataAttrBack="outgoing-payment-detail-back"
        inlineActions
        actions={renderHeaderActions(detailRow)}
      >
        {renderDetailBody(detailRow)}
      </PortalRecordDetailPage>
    );
  }

  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      {rows.map((row) => (
        <PortalPersonRecordRow
          key={row.id}
          name={row.chargeTitle}
          subtitle={row.propertyName}
          preview={row.payeeLabel}
          meta={row.amountLabel}
          onOpen={() => openPaymentDetail(row)}
          dataAttr="outgoing-payment-list-row"
        />
      ))}
      {onAddPayment ? (
        <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
          <PortalListAddRow
            label="Add"
            icon={PORTAL_LIST_ADD_ICONS.payment}
            onClick={onAddPayment}
            dataAttr="payments-list-add"
          />
        </div>
      ) : null}
    </div>
  );
}
