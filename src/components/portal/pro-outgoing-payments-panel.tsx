"use client";

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import type { PortalAdaptiveAction } from "@/components/portal/portal-adaptive-action-row";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { ManagerOutgoingPaymentDetail } from "@/components/portal/pro-outgoing-payment-detail";
import {
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { PortalRecordRelatedPanel } from "@/components/portal/portal-record-related-panel";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { CalendarDays, Mail } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import type { DemoManagerOutgoingPaymentRow, DemoManagerWorkOrderRow, ManagerPaymentBucket } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  clusterManagerOutgoingPaymentRowsByMode,
  type ManagerOutgoingPayeeCluster,
  type ManagerOutgoingPropertyCluster,
} from "@/lib/manager-outgoing-payment-grouping";
import { deleteManagerOutgoingExpense } from "@/lib/manager-outgoing-payments";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { readManagerWorkOrderRows } from "@/lib/manager-work-orders-storage";
import { isPropertyClusterList, type PortalListGroupMode } from "@/lib/portal-list-grouping";
import { paymentDetailHref, paymentListHref, paymentRecordDetailHref, PAYMENT_RECORD_RAIL_GROUPS, PAYMENT_RECORD_TAB_DESCRIPTIONS, PAYMENT_RECORD_TAB_LABELS, PAYMENT_RECORD_TABS, parsePaymentRecordTab, vendorDetailHref, workOrderDetailHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";

/** The payee a payout is titled by — an em dash or blank means nobody is named yet. */
function outgoingPayeeLabel(row: DemoManagerOutgoingPaymentRow): string {
  const payee = row.payeeLabel?.trim() ?? "";
  return payee && payee !== "—" ? payee : "";
}

/**
 * The due fact on a payout row, in ONE format: a raw ISO day becomes the
 * display date, and a label that already says "Due" or "Before" is kept —
 * the same rule the incoming ledger applies to its charges.
 */
function formatOutgoingDue(due: string | undefined): string {
  const trimmed = due?.trim() ?? "";
  if (!trimmed) return "";
  const iso = /^(?:(due|before)\s+)?(\d{4})-(\d{2})-(\d{2})$/i.exec(trimmed);
  if (iso) {
    const d = new Date(Number(iso[2]), Number(iso[3]) - 1, Number(iso[4]), 12, 0, 0, 0);
    if (!Number.isNaN(d.getTime())) {
      const prefix = iso[1] ? iso[1][0]!.toUpperCase() + iso[1].slice(1).toLowerCase() : "Due";
      return `${prefix} ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    }
  }
  if (/^(due|before)\b/i.test(trimmed)) return trimmed;
  return `Due ${trimmed}`;
}

export function ManagerOutgoingPaymentsPanel({
  rows,
  activeBucket,
  vendorById,
  onRowsChanged,
  paymentId: paymentIdProp,
  paymentTab: paymentTabProp,
  listBasePath,
  onAddPayment,
  emptyCard,
  groupMode = "house",
}: {
  rows: DemoManagerOutgoingPaymentRow[];
  activeBucket: ManagerPaymentBucket;
  vendorById?: Map<string, ManagerVendorRow>;
  onRowsChanged?: () => void;
  paymentId?: string;
  paymentTab?: string;
  listBasePath?: string;
  onAddPayment?: () => void;
  /** The tab's empty card — the page owns the copy, tab counts and filter reset. */
  emptyCard?: ComponentProps<typeof PortalRecordListSurface>["emptyCard"];
  groupMode?: PortalListGroupMode;
}) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const navigate = usePortalNavigate();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [payModalRowId, setPayModalRowId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const showSelection = !paymentIdProp;
  const rowIdsKey = useMemo(() => rows.map((row) => row.id).join(","), [rows]);
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds],
  );

  useEffect(() => {
    setSelectedIds(new Set());
  }, [activeBucket, rowIdsKey]);

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

  const paymentClusters = useMemo(
    () => clusterManagerOutgoingPaymentRowsByMode(rows, groupMode),
    [rows, groupMode],
  );

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // The page hands the rows over already sorted; flattening the clusters in
  // that order keeps a payee's payouts adjacent, and in house mode a
  // property's rows sit together payee by payee. The grouping box is gone —
  // the card row says who and where.
  const orderedRows = useMemo(() => {
    if (isPropertyClusterList(groupMode, paymentClusters)) {
      return (paymentClusters as ManagerOutgoingPropertyCluster[]).flatMap((cluster) =>
        clusterManagerOutgoingPaymentRowsByMode(cluster.rows, "resident").flatMap((payee) => payee.rows),
      );
    }
    return (paymentClusters as ManagerOutgoingPayeeCluster[]).flatMap((cluster) => cluster.rows);
  }, [groupMode, paymentClusters]);

  /**
   * One white card per payout — the Properties row for a person. The payee is
   * the title and fills the tile; the payment, its category and the property
   * make the place line; the due date is a glyph fact; the amount sits bold on
   * the right, green once paid; the ⋯ the list surface draws carries the
   * row's actions. No grouping box, no pill: the tab says the bucket.
   */
  const renderGroupedList = () => (
    <div data-attr={groupMode === "house" ? "outgoing-payments-house-groups" : "outgoing-payments-payee-groups"}>
      {orderedRows.map((row) => {
        const payee = outgoingPayeeLabel(row);
        const place = [payee ? row.chargeTitle : "", row.categoryLabel, row.propertyName]
          .map((part) => part?.trim() ?? "")
          .filter(Boolean)
          .join(" · ");
        const due = formatOutgoingDue(row.dueDate);
        return (
          <PortalApplicantRecordRow
            key={row.id}
            name={payee || row.chargeTitle}
            tileLabel={payee || undefined}
            address={place}
            facts={due ? <PortalRowFact icon={CalendarDays}>{due}</PortalRowFact> : undefined}
            trailing={
              row.bucket === "paid" ? (
                <span className="tabular-nums text-[var(--status-confirmed-fg)]">{row.amountLabel}</span>
              ) : (
                <span className="tabular-nums">{row.amountLabel}</span>
              )
            }
            checked={showSelection && selectedIds.has(row.id)}
            onSelectedChange={showSelection ? () => toggleSelected(row.id) : undefined}
            onOpen={() => openPaymentDetail(row)}
            dataAttr="outgoing-payment-list-row"
          />
        );
      })}
    </div>
  );

  const deleteExpense = async (
    row: DemoManagerOutgoingPaymentRow,
    options?: { confirm?: boolean; navigateAfter?: boolean },
  ) => {
    if (!row.expenseEntryId) {
      showToast("This payment cannot be deleted.");
      return false;
    }
    if (row.fromAxisFee) return false;
    if (row.workOrderId && !row.fromExpense) {
      showToast("Work-order expenses are managed from Services.");
      return false;
    }
    if (options?.confirm !== false && !(await confirm({ description: `Delete "${row.chargeTitle}"?` }))) return false;

    if (isDemoModeActive()) {
      if (!deleteManagerOutgoingExpense(row.expenseEntryId)) {
        showToast("Could not delete expense.");
        return false;
      }
      if (options?.navigateAfter !== false) navigateToList();
      showToast("Expense removed.");
      onRowsChanged?.();
      return true;
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
      if (options?.navigateAfter !== false) navigateToList();
      showToast("Expense removed.");
      onRowsChanged?.();
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete expense.");
      return false;
    } finally {
      setDeletingId(null);
    }
  };

  const canDeleteExpense = (row: DemoManagerOutgoingPaymentRow) =>
    Boolean(row.fromExpense && row.expenseEntryId && !row.fromAxisFee);

  const isPayableWorkOrder = (row: DemoManagerOutgoingPaymentRow) =>
    Boolean(row.workOrderId && row.bucket !== "paid");

  const deleteSelectedExpenses = useCallback(async () => {
    const targets = selectedRows.filter(canDeleteExpense);
    if (targets.length === 0) return;
    const noun = targets.length === 1 ? "payment" : `${targets.length} payments`;
    if (!(await confirm({ description: `Delete ${noun}?` }))) return;
    let ok = 0;
    for (const row of targets) {
      if (await deleteExpense(row, { confirm: false, navigateAfter: false })) ok += 1;
    }
    setSelectedIds(new Set());
    if (ok > 0) {
      onRowsChanged?.();
      showToast(ok === 1 ? "Expense removed." : `Removed ${ok} expenses.`);
    }
  }, [onRowsChanged, selectedRows, showToast]);

  const bulkSelectionActions = useMemo(() => {
    if (!showSelection || selectedIds.size === 0) return null;

    const actions: PortalAdaptiveAction[] = [];
    const payableSelected = selectedRows.filter(isPayableWorkOrder);

    if (payableSelected.length === 1) {
      const row = payableSelected[0]!;
      const openPayModal = () => {
        setPayModalRowId(row.id);
        openPaymentDetail(row);
      };
      actions.push({
        id: "mark-paid",
        keepPriority: 5,
        node: (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_BULK_BAR_BTN}
            data-attr="outgoing-payments-mark-selected-paid"
            onClick={openPayModal}
          >
            Mark as paid
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="outgoing-payments-mark-selected-paid" onSelect={openPayModal}>
            Mark as paid
          </DropdownMenuItem>
        ),
      });
    }

    if (selectedRows.length > 0 && selectedRows.every(canDeleteExpense)) {
      actions.push({
        id: "delete",
        keepPriority: 3,
        node: (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_BULK_BAR_BTN}
            data-attr="outgoing-payments-delete-selected"
            onClick={() => void deleteSelectedExpenses()}
          >
            Delete
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="outgoing-payments-delete-selected"
            onSelect={() => void deleteSelectedExpenses()}
          >
            Delete
          </DropdownMenuItem>
        ),
      });
    }

    if (actions.length === 0) return null;

    return (
      <PortalAdaptiveActionRow
        actions={actions}
        moreAriaLabel="More bulk actions"
        moreDataAttr="outgoing-payments-bulk-more-actions"
        gapPx={4}
      />
    );
  }, [deleteSelectedExpenses, openPaymentDetail, selectedIds.size, selectedRows, showSelection]);

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
    return (
      <PortalRecordListSurface
        isEmpty
        add={
          onAddPayment
            ? {
                ariaLabel: "Add outgoing payment",
                icon: PORTAL_LIST_ADD_ICONS.payment,
                onClick: onAddPayment,
                dataAttr: "payments-list-add",
              }
            : undefined
        }
        emptyCard={emptyCard ?? (onAddPayment ? undefined : { title: "No payments out", section: "payments" })}
        className="pt-5 sm:pt-6"
        dataAttr="outgoing-payments-list-empty"
      />
    );
  }

  if (paymentIdProp && detailRow) {
    return (
      <PortalRecordDetailPage
        pageTitle="Payments"
        title={detailRow.chargeTitle}
        subtitle={detailRow.payeeLabel}
        avatarName={detailRow.payeeLabel}
        backHref={listBasePath ? paymentListHref(listBasePath, "outgoing", activeBucket) : "#"}
        backLabel="Back to payments"
        hideBackText
        bareHeader
        dataAttrBack="outgoing-payment-detail-back"
        iconTitleActions
        pinScrollBody
      >
        <PortalRecordActions>
          <PortalIconAction
            icon={Mail}
            label="Message"
            data-attr="outgoing-payment-detail-message"
            onClick={() => {
              if (listBasePath) navigate(`${listBasePath}/communication`);
            }}
          />
        </PortalRecordActions>
        {(() => {
          const recordTab = parsePaymentRecordTab(paymentTabProp);
          const navItems = PAYMENT_RECORD_TABS.map((tab) => ({
            id: tab,
            label: PAYMENT_RECORD_TAB_LABELS[tab],
            description: PAYMENT_RECORD_TAB_DESCRIPTIONS[tab],
            href: listBasePath
              ? paymentRecordDetailHref(listBasePath, "outgoing", activeBucket, detailRow.id, tab)
              : "#",
          }));
          return (
            <PortalRecordSectionChrome
              items={navItems}
              activeId={recordTab}
              groups={PAYMENT_RECORD_RAIL_GROUPS}
              title={detailRow.chargeTitle}
              backHref={listBasePath ? paymentListHref(listBasePath, "outgoing", activeBucket) : "#"}
              backLabel="All payments"
              ariaLabel="Payment sections"
              currentLabel={PAYMENT_RECORD_TAB_LABELS[recordTab]}
              defaultDisclosureOpen={recordTab === "overview"}
            >
              {recordTab === "overview" ? (
                renderDetailBody(detailRow)
              ) : recordTab === "communication" ? (
                <PortalRecordRelatedPanel
                  title="Communication"
                  href={listBasePath ? `${listBasePath}/communication` : undefined}
                  empty="No thread for this payment yet."
                />
              ) : recordTab === "service" ? (
                <PortalRecordRelatedPanel
                  title="Service"
                  value={detailRow.workOrderId ? detailRow.chargeTitle : undefined}
                  href={
                    listBasePath && detailRow.workOrderId
                      ? workOrderDetailHref(listBasePath, "open", detailRow.workOrderId)
                      : undefined
                  }
                  empty="No service on this payment."
                />
              ) : recordTab === "vendor" ? (
                <PortalRecordRelatedPanel
                  title="Vendor"
                  value={detailRow.payeeLabel}
                  href={
                    listBasePath && detailRow.vendorId
                      ? vendorDetailHref(listBasePath, detailRow.vendorId)
                      : undefined
                  }
                  empty="No vendor on this payment."
                />
              ) : (
                <PortalRecordRelatedPanel title="Resident" empty="This outgoing payment is not tied to a resident." />
              )}
            </PortalRecordSectionChrome>
          );
        })()}
      </PortalRecordDetailPage>
    );
  }

  return (
    <PortalRecordListSurface
      add={
        onAddPayment
          ? {
              ariaLabel: "Add outgoing payment",
              icon: PORTAL_LIST_ADD_ICONS.payment,
              onClick: onAddPayment,
              dataAttr: "payments-list-add",
            }
          : undefined
      }
      onBulkClear={() => setSelectedIds(new Set())}
      bulkCount={showSelection ? selectedIds.size : 0}
      bulkActions={bulkSelectionActions}
      dataAttr="outgoing-payments-list"
    >
      {renderGroupedList()}
    </PortalRecordListSurface>
  );
}
