"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpFromLine, Download, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Input, Select } from "@/components/ui/input";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  vendorInvoiceDetailHref,
  vendorPayoutDetailHref,
  type VendorInvoiceDetailTabId,
  type VendorPayoutDetailTabId,
} from "@/lib/portal-detail-routes";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import {
  FilterCheckboxList,
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  filterMultiSelectSummary,
} from "@/components/portal/filter-field-lists";
import { VendorPaymentsPanel, type VendorPaymentsPanelHandle } from "@/components/portal/vendor-payments-panel";
import { VendorQuoteWizard } from "@/components/portal/vendor-quote-wizard";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";
import type { ReportFilterState } from "@/components/portal/reports/report-filter-bar";
import { MANAGER_WORK_ORDERS_EVENT, readVendorWorkOrderRows, syncManagerWorkOrdersFromServer } from "@/lib/manager-work-orders-storage";
import { buildVendorIncomeRows } from "@/lib/vendor-income";
import { fetchVendorPayoutsResult, type VendorPayout } from "@/lib/vendor-payouts";
import {
  buildVendorPaymentPropertyFilterOptions,
  buildVendorPaymentRows,
  filterVendorPaymentRows,
  formatVendorPaymentMoney,
  vendorPaymentStatusOptions,
  type VendorPaymentRow,
} from "@/lib/vendor-payments";
import { VendorPaymentRowMenu } from "@/components/portal/vendor-payment-row-menu";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import {
  bankToWithdrawAccounts,
  formatMoney,
  type PortalPayoutBalance,
} from "@/components/portal/portal-payouts-panel";
import { PayoutWithdrawSheet, type PayoutWithdrawAccount } from "@/components/portal/payout-withdraw-sheet";
import { withdrawableCentsFromSnapshot } from "@/lib/stripe-platform-hold";
import { track } from "@/lib/analytics/track-client";
import {
  formatInvoiceMoney,
  normalizeLineItems,
  sumLineItemsCents,
  vendorInvoiceStatusLabel,
  vendorInvoiceTimeline,
  type VendorInvoice,
} from "@/lib/vendor-invoices";
import { VendorInvoiceTimeline } from "@/components/portal/vendor-invoice-timeline";

type VendorLinkedManagerOption = {
  managerUserId: string;
  label: string;
};

/**
 * VD11 — Income and Invoices are no longer two routed tabs: they merge into
 * one flat Payments list at the `income` tabId, which is now the page's only
 * visible destination. `invoices`/`payouts` stay valid tab ids purely so a
 * record URL (`/financials/invoices|payouts/<id>`) still resolves — see the
 * `kind === "vendor" && section === "financials"` block in
 * `render-portal-section.tsx`, which redirects the bare list routes into
 * `income` before either ever mounts here.
 */
function VendorFinancesChrome({
  actions,
  primary,
  filterRow,
  search,
  activeFilterChips,
  children,
}: {
  actions?: ReactNode;
  primary?: ReactNode;
  filterRow?: ReactNode;
  search?: { value: string; onChange: (value: string) => void; placeholder: string; dataAttr?: string };
  activeFilterChips?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ManagerPortalPageShell title="Payments" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        filterRow={filterRow}
        search={search}
        activeFilterChips={activeFilterChips}
        actions={actions}
        primary={primary}
      />
      {children}
    </ManagerPortalPageShell>
  );
}

function defaultFilters(): ReportFilterState {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  return {
    propertyId: "",
    from: yearStart.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
    daysAhead: "90",
    taxYear: String(now.getFullYear() - 1),
  };
}

function formatIncomeDate(dateIso: string): string {
  if (!dateIso) return "—";
  const day = dateIso.slice(0, 10);
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * C160 — Income becomes a Money-in view: the Available balance + Withdraw
 * affordance that used to live only on Settings → Payouts is now surfaced
 * directly on the Income tab too, so a vendor reads "money in" and can move
 * it without a detour through Settings. Reuses the same read route
 * (`GET /api/vendor/payouts/balance`) and the same `PayoutWithdrawSheet` /
 * `POST /api/vendor/payouts/create` write path the Settings page already
 * uses — no new money route, no bypass of server-side amount/ownership
 * checks. Settings → Payouts is unchanged and still works on its own.
 */
function VendorIncomeBalanceCard() {
  const [balance, setBalance] = useState<PortalPayoutBalance | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const loadBalance = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/vendor/payouts/balance", { credentials: "include" });
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as Partial<PortalPayoutBalance> | null;
      if (!body || typeof body.availableCents !== "number" || !body.setup) {
        setLoadError(true);
        return;
      }
      setBalance(body as PortalPayoutBalance);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  // Access-denied / not-yet-linked reads the same as "nothing to show yet" —
  // the empty Income list below already explains that state, so this card
  // simply omits itself rather than duplicating an error banner.
  if (loadError || !balance) return null;

  const withdrawAccounts: PayoutWithdrawAccount[] = bankToWithdrawAccounts(balance.bank);
  const withdrawableCents = withdrawableCentsFromSnapshot(balance);
  const ready = balance.setup.ready;

  return (
    <div
      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm"
      data-attr="vendor-income-balance-card"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Available balance</p>
        <p className="mt-1 text-2xl font-extrabold leading-none tracking-tight text-foreground" data-attr="vendor-income-balance-available">
          {formatMoney(balance.availableCents, balance.currency)}
        </p>
      </div>
      {/* VD12/VD45 — Withdraw is a top-right icon action on the balance card,
          matching the pattern already landed on Settings → Payouts and the
          Dashboard balance card; same withdraw sheet, no new money path. */}
      <PortalIconAction
        icon={ArrowUpFromLine}
        label="Withdraw"
        data-attr="vendor-income-balance-withdraw"
        disabled={!ready || withdrawableCents <= 0}
        onClick={() => {
          track("payout_withdraw_started", { portal: "vendor", source: "income_tab" });
          setWithdrawOpen(true);
        }}
      />
      <PayoutWithdrawSheet
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        apiBase="/api/vendor"
        currency={balance.currency}
        availableCents={balance.availableCents}
        instantAvailableCents={balance.instantAvailableCents}
        accounts={withdrawAccounts}
        onSuccess={() => {
          setWithdrawOpen(false);
          void loadBalance();
        }}
      />
    </div>
  );
}

/**
 * VD11 — the merged Payments list: every income row (a completed job's
 * payout) and every invoice row (a submitted bill) in one newest-first
 * surface. VD14's row menu carries View/Edit/Withdraw/Download, contextual
 * on the row's kind and status.
 */
function VendorPaymentsTable({
  rows,
  basePath,
  onOpenEditInvoice,
  onWithdrawInvoice,
  withdrawingInvoiceId,
  onDownload,
}: {
  rows: VendorPaymentRow[];
  basePath: string;
  onOpenEditInvoice: (invoice: VendorInvoice) => void;
  onWithdrawInvoice: (invoice: VendorInvoice) => void;
  withdrawingInvoiceId: string | null;
  onDownload: (row: VendorPaymentRow) => void;
}) {
  const navigate = usePortalNavigate();

  if (rows.length === 0) {
    const empty = portalEmptyCopy("finances.income");
    return <PortalListEmptyCard title={empty.title} section={empty.section} />;
  }

  return (
    <PortalRecordListSurface isEmpty={false} dataAttr="vendor-payments-list">
      {rows.map((row) => {
        const viewHref =
          row.kind === "invoice"
            ? vendorInvoiceDetailHref(basePath, row.invoice!.id)
            : row.payoutId
              ? vendorPayoutDetailHref(basePath, row.payoutId)
              : null;
        const submittedInvoice = row.kind === "invoice" && row.invoice!.status === "submitted" ? row.invoice : null;
        const downloadable = row.statusId === "invoice:paid" || row.statusId === "invoice:approved" || row.statusId === "income:paid";
        const rowMenu = (
          <VendorPaymentRowMenu
            label={row.title}
            onView={viewHref ? () => navigate(viewHref) : undefined}
            onEdit={submittedInvoice ? () => onOpenEditInvoice(submittedInvoice) : undefined}
            onWithdraw={submittedInvoice ? () => onWithdrawInvoice(submittedInvoice) : undefined}
            withdrawing={submittedInvoice ? withdrawingInvoiceId === submittedInvoice.id : false}
            onDownload={downloadable ? () => onDownload(row) : undefined}
          />
        );
        return (
          // A relative wrapper, not `trailing`, carries the ⋯: the row's own
          // title button (`onOpen`) would otherwise nest a real `<button>`
          // (the DropdownMenu trigger) inside a `<button>`, which is invalid
          // markup. The menu sits as an absolutely-positioned sibling instead.
          <div key={row.id} className="relative">
            <PortalPropertyRecordRow
              title={row.title}
              address={row.propertyLabel ?? undefined}
              facts={[formatIncomeDate(row.dateIso), row.statusLabel].filter(Boolean).join(" · ")}
              trailing={formatVendorPaymentMoney(row)}
              onOpen={viewHref ? () => navigate(viewHref) : undefined}
              dataAttr={row.kind === "invoice" ? "vendor-invoice-row" : "vendor-income-row"}
            />
            <div className="pointer-events-none absolute right-2 top-2">
              <div className="pointer-events-auto">{rowMenu}</div>
            </div>
          </div>
        );
      })}
    </PortalRecordListSurface>
  );
}

type InvoiceFormLine = { description: string; quantity: string; unitAmount: string };

function emptyLine(): InvoiceFormLine {
  return { description: "", quantity: "1", unitAmount: "" };
}

const INVOICE_FORM_INPUT =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

function vendorExportUrl(dataset: "invoices" | "payouts", from?: string, to?: string): string {
  const params = new URLSearchParams({ dataset });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return `/api/vendor/export?${params.toString()}`;
}

function invoiceToFormLines(invoice: VendorInvoice): InvoiceFormLine[] {
  return invoice.lineItems.map((item) => ({
    description: item.description,
    quantity: String(item.quantity),
    unitAmount: (item.unitAmountCents / 100).toFixed(2),
  }));
}

function SubmitInvoiceModal({
  open,
  onClose,
  onSubmitted,
  linkedManagers,
  editingInvoice = null,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  /** Managers this vendor is linked to. Serving several clients is the normal case. */
  linkedManagers: VendorLinkedManagerOption[];
  editingInvoice?: VendorInvoice | null;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [workOrderId, setWorkOrderId] = useState("");
  const [managerUserId, setManagerUserId] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<InvoiceFormLine[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewLines = useMemo(
    () =>
      normalizeLineItems(
        lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity),
          unitAmountCents: Math.round((Number(l.unitAmount) || 0) * 100),
        })),
      ),
    [lines],
  );
  const totalCents = useMemo(() => sumLineItemsCents(previewLines), [previewLines]);
  const showManagerPicker = linkedManagers.length > 1;

  useEffect(() => {
    if (!open) return;
    if (editingInvoice) {
      setInvoiceNumber(editingInvoice.invoiceNumber ?? "");
      setWorkOrderId(editingInvoice.workOrderId ?? "");
      setMemo(editingInvoice.memo ?? "");
      setLines(invoiceToFormLines(editingInvoice).length > 0 ? invoiceToFormLines(editingInvoice) : [emptyLine()]);
      return;
    }
    if (linkedManagers.length === 1) {
      setManagerUserId(linkedManagers[0]!.managerUserId);
    }
  }, [open, linkedManagers, editingInvoice]);

  useEffect(() => {
    const trimmed = workOrderId.trim();
    if (!trimmed) return;
    const workOrder = readVendorWorkOrderRows().find((row) => row.id === trimmed);
    const ownerId = workOrder?.managerUserId?.trim();
    if (ownerId && linkedManagers.some((m) => m.managerUserId === ownerId)) {
      setManagerUserId(ownerId);
    }
  }, [workOrderId, linkedManagers]);

  function reset() {
    setInvoiceNumber("");
    setWorkOrderId("");
    setManagerUserId(linkedManagers.length === 1 ? linkedManagers[0]!.managerUserId : "");
    setMemo("");
    setLines([emptyLine()]);
    setError(null);
  }

  async function handleSubmit() {
    if (previewLines.length === 0) {
      setError("Add at least one line item with an amount.");
      return;
    }
    if (!editingInvoice && showManagerPicker && !managerUserId.trim()) {
      setError("Choose which manager to bill.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const lineItemsPayload = lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity) || 0,
        unitAmountCents: Math.round((Number(l.unitAmount) || 0) * 100),
      }));
      const res = await fetch(editingInvoice ? `/api/vendor/invoices/${editingInvoice.id}` : "/api/vendor/invoices", {
        method: editingInvoice ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          editingInvoice
            ? {
                invoiceNumber: invoiceNumber.trim() || undefined,
                memo: memo.trim() || undefined,
                lineItems: lineItemsPayload,
              }
            : {
                invoiceNumber: invoiceNumber.trim() || undefined,
                workOrderId: workOrderId.trim() || undefined,
                managerUserId: managerUserId.trim() || undefined,
                memo: memo.trim() || undefined,
                lineItems: lineItemsPayload,
              },
        ),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Failed to submit invoice.");
        return;
      }
      // `vendor_invoice_submitted` fires server-side on confirmed insert (the
      // action can fail validation), so we don't double-fire it here — the
      // button's data-attr already captures client intent via autocapture.
      reset();
      onSubmitted();
      onClose();
    } catch {
      setError("Failed to submit invoice.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PortalDialog
      open={open}
      title={editingInvoice ? "Edit invoice" : "Submit invoice"}
      onClose={() => {
        if (!saving) onClose();
      }}
      dismissBlocked={saving}
      primaryAction={{
        label: saving ? "Submitting…" : editingInvoice ? `Save ${formatInvoiceMoney(totalCents)}` : `Submit ${formatInvoiceMoney(totalCents)}`,
        onClick: handleSubmit,
        disabled: saving || totalCents === 0,
        loading: saving,
        dataAttr: "vendor-invoice-submit",
      }}
    >
      <div className="space-y-4">
        {showManagerPicker && !editingInvoice ? (
          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Bill to</span>
            <Select
              aria-label="Bill to"
              value={managerUserId}
              onChange={(e) => setManagerUserId(e.target.value)}
              data-attr="vendor-invoice-manager"
            >
              <option value="">Choose a manager…</option>
              {linkedManagers.map((manager) => (
                <option key={manager.managerUserId} value={manager.managerUserId}>
                  {manager.label}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Invoice # (optional)</span>
            <input
              className={INVOICE_FORM_INPUT}
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="INV-001"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">
              Service {editingInvoice ? "" : "(optional)"}
            </span>
            <input
              className={INVOICE_FORM_INPUT}
              value={workOrderId}
              onChange={(e) => setWorkOrderId(e.target.value)}
              placeholder="Service id"
              readOnly={Boolean(editingInvoice)}
              disabled={Boolean(editingInvoice)}
            />
          </label>
        </div>

        <div className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Line items</span>
          {lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2">
              <input
                className={`${INVOICE_FORM_INPUT} col-span-6`}
                value={line.description}
                onChange={(e) =>
                  setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, description: e.target.value } : l)))
                }
                placeholder="Description"
              />
              <input
                className={`${INVOICE_FORM_INPUT} col-span-2 text-right tabular-nums`}
                value={line.quantity}
                inputMode="numeric"
                onChange={(e) =>
                  setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, quantity: e.target.value } : l)))
                }
                placeholder="Qty"
                aria-label="Quantity"
              />
              <input
                className={`${INVOICE_FORM_INPUT} col-span-3 text-right tabular-nums`}
                value={line.unitAmount}
                inputMode="decimal"
                onChange={(e) =>
                  setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, unitAmount: e.target.value } : l)))
                }
                placeholder="Unit $"
                aria-label="Unit amount in dollars"
              />
              <button
                type="button"
                className="col-span-1 rounded-lg text-muted hover:text-danger disabled:opacity-40"
                onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))}
                disabled={lines.length <= 1}
                aria-label="Remove line item"
              >
                ✕
              </button>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() => setLines((prev) => [...prev, emptyLine()])}
            data-attr="vendor-invoice-add-line"
          >
            Add line item
          </Button>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Memo (optional)</span>
          <textarea
            className={`${INVOICE_FORM_INPUT} min-h-16`}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Notes for the manager"
          />
        </label>

        <div className="flex items-center justify-between rounded-lg bg-accent/20 px-3 py-2 text-sm font-semibold text-foreground">
          <span>Total</span>
          <span className="tabular-nums">{formatInvoiceMoney(totalCents)}</span>
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </PortalDialog>
  );
}

function formatInvoiceDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The vendor invoice record page. VD11 folded the bare Invoices LIST into
 * the merged Payments list (`VendorPaymentsTable`, at the `income` tabId) —
 * this component now only renders a single invoice's own detail page
 * (`/financials/invoices/<id>/<tab>`); its fetch/edit/withdraw state lives
 * in the parent `VendorFinancesPanel` so the merged list and this detail
 * page share one source of truth instead of two.
 */
function VendorInvoiceDetailPage({
  basePath = "/vendor",
  recordId,
  recordDetailTab,
  invoices,
  loading,
  linkedManagers,
  modalOpen,
  editingInvoice,
  openEdit,
  closeModal,
  withdrawInvoice,
  load,
}: {
  basePath?: string;
  recordId: string;
  recordDetailTab?: VendorInvoiceDetailTabId;
  invoices: VendorInvoice[];
  loading: boolean;
  linkedManagers: VendorLinkedManagerOption[];
  modalOpen: boolean;
  editingInvoice: VendorInvoice | null;
  openEdit: (invoice: VendorInvoice) => void;
  closeModal: () => void;
  withdrawInvoice: (invoice: VendorInvoice) => Promise<void>;
  load: () => Promise<void>;
}) {
  const navigate = usePortalNavigate();
  const invoice = invoices.find((inv) => inv.id === recordId) ?? null;
  if (!invoice) {
    return loading ? (
      <PortalDataTableEmpty icon="default" message="Loading…" />
    ) : (
      <PortalDataTableEmpty icon="default" message="Invoice not found." />
    );
  }
  const activeTab: VendorInvoiceDetailTabId = recordDetailTab ?? "overview";
  const backHref = `${basePath}/financials/invoices`;
  const sections = recordSections("vendor", "invoice", { basePath });
  const onHeaderAction = (actionId: string) => {
    if (actionId === "edit" || actionId === "submit") {
      openEdit(invoice);
      return;
    }
    if (actionId === "withdraw") {
      void withdrawInvoice(invoice).then(() => navigate(backHref));
      return;
    }
    if (actionId === "download") {
      window.open(vendorExportUrl("invoices"), "_blank", "noopener");
    }
  };
  const ownContent =
    activeTab === "lines" ? (
      <ul className="divide-y divide-border rounded-xl border border-border bg-card px-3 sm:px-4" data-attr="vendor-invoice-lines">
        {invoice.lineItems.map((line, i) => (
          <li key={i} className="flex items-center justify-between gap-3 py-3 text-sm">
            <span className="truncate">{line.description}</span>
            <span className="shrink-0 font-medium tabular-nums">{formatInvoiceMoney(line.amountCents, invoice.currency)}</span>
          </li>
        ))}
      </ul>
    ) : activeTab === "payout" ? (
      <div className="px-3 pb-4 sm:px-4">
        {invoice.status === "paid" ? (
          <p className="text-sm text-foreground">Paid — see the Payouts tab for transfer details.</p>
        ) : (
          <PortalListEmptyCard title="Not paid out yet" workspaceAware={false} dataAttr="vendor-invoice-payout-empty" />
        )}
      </div>
    ) : activeTab === "communication" || activeTab === "documents" ? (
      renderRecordSection(activeTab, {
        role: "vendor",
        kind: "invoice",
        kindLabel: "invoice",
        recordId: invoice.id,
        recordLabel: invoice.invoiceNumber || "Invoice",
      })
    ) : (
      <div className="space-y-3 px-3 pb-4 sm:px-4" data-attr="vendor-invoice-overview">
        <p className="text-sm text-foreground">
          {formatInvoiceMoney(invoice.totalCents, invoice.currency)} · {vendorInvoiceStatusLabel(invoice.status)}
        </p>
        {invoice.memo ? <p className="text-sm whitespace-pre-wrap text-muted">{invoice.memo}</p> : null}
        <VendorInvoiceTimeline steps={vendorInvoiceTimeline(invoice)} />
      </div>
    );
  return (
    <>
      <PortalRecordDetailPage
        pageTitle="Payments"
        title={invoice.invoiceNumber || "Invoice"}
        subtitle={formatInvoiceDate(invoice.submittedAt)}
        avatarName={invoice.invoiceNumber || "Invoice"}
        backHref={backHref}
        backLabel="Back to invoices"
        hideBackText
        bareHeader
        iconTitleActions
        pinScrollBody
      >
        <PortalRecordActions>
          <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onHeaderAction} />
        </PortalRecordActions>
        <PortalRecordSectionChrome
          sections={sections}
          recordId={invoice.id}
          activeId={activeTab}
          title={invoice.invoiceNumber || "Invoice"}
          subtitle={formatInvoiceDate(invoice.submittedAt)}
          backHref={backHref}
          backLabel="All invoices"
          ariaLabel="Invoice sections"
          onHeaderAction={onHeaderAction}
        >
          {ownContent}
        </PortalRecordSectionChrome>
      </PortalRecordDetailPage>
      <SubmitInvoiceModal
        open={modalOpen}
        onClose={closeModal}
        onSubmitted={load}
        linkedManagers={linkedManagers}
        editingInvoice={editingInvoice}
      />
    </>
  );
}

/**
 * A single vendor payout's record page. `vendor_payouts` is one row per work
 * order (not a Stripe-style batch of several invoices), so "Included
 * invoices" shows the one job that produced this payout rather than a real
 * invoice list — the closest honest mapping onto this data model.
 */
function VendorPayoutRecordPage({
  payoutId,
  detailTab,
  basePath,
}: {
  payoutId: string;
  detailTab: VendorPayoutDetailTabId;
  basePath: string;
}) {
  const { showToast } = useAppUi();
  const [payout, setPayout] = useState<VendorPayout | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void fetchVendorPayoutsResult().then((result) => {
      if (!active) return;
      setPayout(result.ok ? (result.payouts.find((p) => p.id === payoutId) ?? null) : null);
    });
    return () => {
      active = false;
    };
  }, [payoutId]);

  if (payout === undefined) {
    return <PortalDataTableEmpty icon="default" message="Loading…" />;
  }
  if (!payout) {
    return <PortalDataTableEmpty icon="default" message="Payout not found." />;
  }

  const job = readVendorWorkOrderRows().find((row) => row.id === payout.workOrderId) ?? null;
  const backHref = `${basePath}/financials/payouts`;
  const sections = recordSections("vendor", "payout", { basePath });
  const title = job?.title || "Payout";

  const ownContent =
    detailTab === "included-invoices" ? (
      <div className="px-3 pb-4 sm:px-4" data-attr="vendor-payout-included">
        {job ? (
          <p className="text-sm text-foreground">{[job.title, job.reference].filter(Boolean).join(" · ")}</p>
        ) : (
          <PortalListEmptyCard title="No linked job found" workspaceAware={false} dataAttr="vendor-payout-included-empty" />
        )}
      </div>
    ) : detailTab === "communication" ? (
      renderRecordSection("communication", {
        role: "vendor",
        kind: "payout",
        kindLabel: "payout",
        recordId: payout.id,
        recordLabel: title,
      })
    ) : (
      <div className="px-3 pb-4 sm:px-4" data-attr="vendor-payout-overview">
        <p className="text-sm text-foreground">
          {formatInvoiceMoney(payout.amountCents)} · {payout.status}
        </p>
        <p className="mt-1 text-xs text-muted">Created {formatIncomeDate(payout.createdAt)}</p>
        {payout.failureReason ? <p className="mt-2 text-sm text-muted">{payout.failureReason}</p> : null}
      </div>
    );

  return (
    <PortalRecordDetailPage
      pageTitle="Finances"
      title={title}
      subtitle="Payout"
      avatarName={title}
      backHref={backHref}
      backLabel="Back to payouts"
      hideBackText
      bareHeader
      iconTitleActions
      pinScrollBody
    >
      <PortalRecordActions>
        <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={() => showToast("Coming soon")} />
      </PortalRecordActions>
      <PortalRecordSectionChrome
        sections={sections}
        recordId={payout.id}
        activeId={detailTab}
        title={title}
        subtitle="Payout"
        backHref={backHref}
        backLabel="All payouts"
        ariaLabel="Payout sections"
        onHeaderAction={() => showToast("Coming soon")}
      >
        {ownContent}
      </PortalRecordSectionChrome>
    </PortalRecordDetailPage>
  );
}

/** Vendor Finances — income earned from completed work orders and payouts. */
export function VendorFinancesPanel({
  tabId,
  basePath = "/vendor",
  recordId,
  recordDetailTab,
}: {
  tabId: string;
  basePath?: string;
  /** An invoice or payout RECORD id (docs/agents/record-page.md); set only when routed to /financials/invoices|payouts/<id>/<tab>. */
  recordId?: string;
  recordDetailTab?: VendorInvoiceDetailTabId | VendorPayoutDetailTabId;
}) {
  const [filters, setFilters] = useState(defaultFilters);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [statusIds, setStatusIds] = useState<string[]>([]);
  const [listSearch, setListSearch] = useState("");
  const [tick, setTick] = useState(0);
  const [payoutsByWorkOrderId, setPayoutsByWorkOrderId] = useState<Record<string, VendorPayout>>({});
  const [requestOpen, setRequestOpen] = useState(false);

  // VD11 — invoice fetch/edit/withdraw state used to live inside the now-
  // removed standalone Invoices list view; it lives here so the merged
  // Payments list and the invoice detail page (still routed at
  // /financials/invoices/<id>) share one source of truth.
  const [invoices, setInvoices] = useState<VendorInvoice[]>([]);
  const [linkedManagers, setLinkedManagers] = useState<VendorLinkedManagerOption[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<VendorInvoice | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const confirm = useConfirm();

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      const res = await fetch("/api/vendor/invoices");
      if (!res.ok) {
        setInvoices([]);
        setLinkedManagers([]);
        return;
      }
      const body = (await res.json()) as {
        invoices?: VendorInvoice[];
        managers?: { managerUserId: string; name: string }[];
        linkedManagers?: VendorLinkedManagerOption[];
      };
      setInvoices(body.invoices ?? []);
      setLinkedManagers(
        body.linkedManagers ??
          (body.managers ?? []).map((manager) => ({
            managerUserId: manager.managerUserId,
            label: manager.name,
          })),
      );
    } catch {
      setInvoices([]);
      setLinkedManagers([]);
    } finally {
      setInvoicesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  async function withdrawInvoice(invoice: VendorInvoice) {
    if (!(await confirm({ title: "Withdraw invoice", description: "Withdraw this invoice?", confirmLabel: "Withdraw", note: "You can submit a corrected one afterward." }))) return;
    setWithdrawingId(invoice.id);
    try {
      const res = await fetch(`/api/vendor/invoices/${invoice.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Could not withdraw invoice.");
      }
      await loadInvoices();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not withdraw invoice.");
    } finally {
      setWithdrawingId(null);
    }
  }

  function openEdit(invoice: VendorInvoice) {
    setEditingInvoice(invoice);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingInvoice(null);
  }

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

  const jobs = useMemo(() => {
    void tick;
    return readVendorWorkOrderRows();
  }, [tick]);

  const jobsById = useMemo(() => Object.fromEntries(jobs.map((job) => [job.id, job])), [jobs]);

  const incomeRows = useMemo(
    () => buildVendorIncomeRows(jobs, payoutsByWorkOrderId),
    [jobs, payoutsByWorkOrderId],
  );

  // VD11 — Income and Invoices merge into one flat, newest-first list here.
  const allRows = useMemo(
    () => buildVendorPaymentRows(incomeRows, invoices, jobsById, payoutsByWorkOrderId),
    [incomeRows, invoices, jobsById, payoutsByWorkOrderId],
  );

  const propertyOptions = useMemo(() => buildVendorPaymentPropertyFilterOptions(allRows), [allRows]);
  const statusOptions = useMemo(() => vendorPaymentStatusOptions(allRows), [allRows]);

  const filteredRows = useMemo(
    () =>
      filterVendorPaymentRows(allRows, {
        from: filters.from,
        to: filters.to,
        propertyIds,
        statusIds,
        query: listSearch,
      }),
    [allRows, filters.from, filters.to, propertyIds, statusIds, listSearch],
  );

  const payoutsRef = useRef<VendorPaymentsPanelHandle>(null);
  const defaults = defaultFilters();
  const filterTouchCount =
    propertyIds.length +
    statusIds.length +
    (filters.from !== defaults.from ? 1 : 0) +
    (filters.to !== defaults.to ? 1 : 0);

  const filterSheet = (
    <PortalFilterSortSheet
      activeCount={filterTouchCount}
      compactPanel
      filterFieldCount={4}
      commandStripTrigger
      onReset={() => {
        setPropertyIds([]);
        setStatusIds([]);
        setFilters(defaultFilters());
      }}
      dataAttr="vendor-finances-filter-sheet-open"
    >
      <VendorFinanceFilterFields
        statusOptions={statusOptions}
        statusIds={statusIds}
        onStatusIdsChange={setStatusIds}
        propertyOptions={propertyOptions}
        propertyIds={propertyIds}
        onPropertyIdsChange={setPropertyIds}
        from={filters.from}
        to={filters.to}
        onRangeChange={(next) => setFilters((current) => ({ ...current, ...next }))}
      />
    </PortalFilterSortSheet>
  );

  const filterChips: PortalActiveFilterChip[] = [
    ...statusIds.map((id) => ({
      id: `status-${id}`,
      label: statusOptions.find((option) => option.id === id)?.label ?? id,
      onRemove: () => setStatusIds((current) => current.filter((item) => item !== id)),
    })),
    ...propertyIds.map((id) => ({
      id: `property-${id}`,
      label: propertyOptions.find((option) => option.id === id)?.label ?? id,
      onRemove: () => setPropertyIds((current) => current.filter((item) => item !== id)),
    })),
  ];

  const requestPayment = (
    <PortalPrimaryIconAction
      label={portalListAddPrimaryLabel("payment")}
      data-attr="vendor-finances-request-payment"
      onClick={() => setRequestOpen(true)}
    />
  );

  const requestWizard = (
    <VendorQuoteWizard
      open={requestOpen}
      door="invoice"
      jobs={jobs}
      onClose={() => setRequestOpen(false)}
      onSubmitted={() => {
        setRequestOpen(false);
        setTick((n) => n + 1);
        void loadInvoices();
      }}
    />
  );

  // Bare `/financials/invoices` (no recordId) never reaches this component —
  // `render-portal-section.tsx` redirects it into the merged `income` list
  // (VD11); only an invoice RECORD (`/financials/invoices/<id>/<tab>`) renders
  // here.
  if (tabId === "invoices" && recordId) {
    return (
      <VendorInvoiceDetailPage
        basePath={basePath}
        recordId={recordId}
        recordDetailTab={recordDetailTab as VendorInvoiceDetailTabId}
        invoices={invoices}
        loading={invoicesLoading}
        linkedManagers={linkedManagers}
        modalOpen={modalOpen}
        editingInvoice={editingInvoice}
        openEdit={openEdit}
        closeModal={closeModal}
        withdrawInvoice={withdrawInvoice}
        load={loadInvoices}
      />
    );
  }

  // The bare "payouts" tab never reaches this component — `render-portal-section.tsx`
  // redirects it straight to Settings → Payouts (PLAN-0920-1500) before
  // `VendorFinancesPanel` is mounted with that tabId. Only a payout *record*
  // (/financials/payouts/<id>/<tab>, PLAN-0920-1058) renders here.
  if (tabId === "payouts" && recordId) {
    return (
      <VendorPayoutRecordPage
        payoutId={recordId}
        detailTab={(recordDetailTab as VendorPayoutDetailTabId) ?? "overview"}
        basePath={basePath}
      />
    );
  }

  const incomeEmpty = portalEmptyCopy("finances.income");
  const filtersHideRows = allRows.length > 0 && filteredRows.length === 0;

  function downloadPaymentRow(row: VendorPaymentRow) {
    const day = row.dateIso ? row.dateIso.slice(0, 10) : undefined;
    window.open(vendorExportUrl(row.kind === "invoice" ? "invoices" : "payouts", day, day), "_blank", "noopener");
  }

  return (
    <VendorFinancesChrome
      filterRow={filterSheet}
      search={{
        value: listSearch,
        onChange: setListSearch,
        placeholder: "Search payments",
        dataAttr: "vendor-income-search",
      }}
      activeFilterChips={<PortalActiveFilterChips chips={filterChips} />}
      actions={
        <>
          <PortalIconAction
            icon={Download}
            label="Export invoices CSV"
            data-attr="vendor-export-invoices-csv"
            onClick={() => {
              window.location.assign(vendorExportUrl("invoices", filters.from, filters.to));
            }}
          />
          <PortalIconAction icon={Wrench} label="Payout setup" data-attr="vendor-finances-payout-setup" onClick={() => payoutsRef.current?.openPaymentMethods()} />
        </>
      }
      primary={requestPayment}
    >
      <VendorIncomeBalanceCard />
      {invoicesLoading ? (
        <div data-attr="vendor-payments-loading">
          <ListSkeleton rows={4} showLeading={false} />
        </div>
      ) : filteredRows.length === 0 ? (
        <PortalListEmptyCard
          title={filtersHideRows ? "No payments match these filters" : incomeEmpty.title}
          section={incomeEmpty.section}
          tone={filtersHideRows ? "muted" : "default"}
          actions={
            filtersHideRows
              ? []
              : [{ label: portalListAddPrimaryLabel("payment"), onClick: () => setRequestOpen(true), dataAttr: "vendor-income-empty-add" }]
          }
          clear={
            filtersHideRows
              ? {
                  label: "Clear filters",
                  onClick: () => {
                    setPropertyIds([]);
                    setStatusIds([]);
                    setFilters(defaultFilters());
                    setListSearch("");
                  },
                  dataAttr: "vendor-income-empty-clear-filters",
                }
              : undefined
          }
        />
      ) : (
        <VendorPaymentsTable
          rows={filteredRows}
          basePath={basePath}
          onOpenEditInvoice={openEdit}
          onWithdrawInvoice={(invoice) => void withdrawInvoice(invoice)}
          withdrawingInvoiceId={withdrawingId}
          onDownload={downloadPaymentRow}
        />
      )}
      {requestWizard}
      <SubmitInvoiceModal
        open={modalOpen}
        onClose={closeModal}
        onSubmitted={loadInvoices}
        linkedManagers={linkedManagers}
        editingInvoice={editingInvoice}
      />
      <VendorPaymentsPanel ref={payoutsRef} setupOnly />
    </VendorFinancesChrome>
  );
}

function VendorFinanceFilterFields({
  statusOptions,
  statusIds,
  onStatusIdsChange,
  propertyOptions,
  propertyIds,
  onPropertyIdsChange,
  from,
  to,
  onRangeChange,
}: {
  statusOptions: { id: string; label: string }[];
  statusIds: string[];
  onStatusIdsChange: (next: string[]) => void;
  propertyOptions: { id: string; label: string }[];
  propertyIds: string[];
  onPropertyIdsChange: (next: string[]) => void;
  from: string;
  to: string;
  onRangeChange: (next: Partial<ReportFilterState>) => void;
}) {
  const [draftStatusIds, setDraftStatusIds] = usePortalFilterDraft(statusIds, onStatusIdsChange, []);
  const [draftPropertyIds, setDraftPropertyIds] = usePortalFilterDraft(propertyIds, onPropertyIdsChange, []);
  const [draftFrom, setDraftFrom] = usePortalFilterDraft(from, (next) => onRangeChange({ from: next }), from);
  const [draftTo, setDraftTo] = usePortalFilterDraft(to, (next) => onRangeChange({ to: next }), to);
  const statusListOptions = statusOptions.map((option) => ({ value: option.id, label: option.label }));
  const propertyListOptions = propertyOptions.map((option) => ({ value: option.id, label: option.label }));

  return (
    <FilterFieldsAccordion>
      {/* VD13 — status replaces the old Invoices-only underline tabs: the
          merged list filters by status across BOTH income and invoice rows. */}
      <FilterCollapsibleSection
        sectionId="status"
        label="Status"
        summary={filterMultiSelectSummary(draftStatusIds, statusListOptions)}
        empty={draftStatusIds.length === 0}
        menuOptionCount={Math.max(1, statusListOptions.length)}
      >
        <FilterCheckboxList
          options={statusListOptions}
          selected={draftStatusIds}
          onChange={setDraftStatusIds}
          dataAttr="vendor-finances-filter-status"
        />
      </FilterCollapsibleSection>
      <FilterCollapsibleSection
        sectionId="property"
        label="Property"
        summary={filterMultiSelectSummary(draftPropertyIds, propertyListOptions)}
        empty={draftPropertyIds.length === 0}
        menuOptionCount={Math.max(1, propertyListOptions.length)}
      >
        <FilterCheckboxList
          options={propertyListOptions}
          selected={draftPropertyIds}
          onChange={setDraftPropertyIds}
          dataAttr="vendor-finances-filter-property"
        />
      </FilterCollapsibleSection>
      <FilterCollapsibleSection
        sectionId="from"
        label="From"
        summary={draftFrom || "Any"}
        empty={!draftFrom}
        menuOptionCount={1}
      >
        <Input
          type="date"
          value={draftFrom}
          onChange={(event) => setDraftFrom(event.target.value)}
          data-attr="vendor-finances-filter-from"
        />
      </FilterCollapsibleSection>
      <FilterCollapsibleSection
        sectionId="to"
        label="To"
        summary={draftTo || "Any"}
        empty={!draftTo}
        menuOptionCount={1}
      >
        <Input
          type="date"
          value={draftTo}
          onChange={(event) => setDraftTo(event.target.value)}
          data-attr="vendor-finances-filter-to"
        />
      </FilterCollapsibleSection>
    </FilterFieldsAccordion>
  );
}
