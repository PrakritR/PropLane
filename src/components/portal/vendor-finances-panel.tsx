"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TabNav } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import {
  ManagerPortalFilterRow,
  ManagerPortalPageShell,
  ManagerPortalStatusPills,
  MANAGER_TABLE_TH,
} from "@/components/portal/portal-metrics";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,
  PortalDataTableEmpty,
} from "@/components/portal/portal-data-table";
import { ReportFilterBar, type ReportFilterState } from "@/components/portal/reports/report-filter-bar";
import { MANAGER_WORK_ORDERS_EVENT, readVendorWorkOrderRows, syncManagerWorkOrdersFromServer } from "@/lib/manager-work-orders-storage";
import {
  buildVendorIncomeRows,
  buildVendorPropertyFilterOptions,
  filterVendorIncomeRows,
  formatVendorIncomeMoney,
  vendorIncomeTotals,
  type VendorIncomeRow,
} from "@/lib/vendor-income";
import { fetchVendorPayoutsResult, type VendorPayout } from "@/lib/vendor-payouts";
import {
  formatInvoiceMoney,
  normalizeLineItems,
  sumLineItemsCents,
  vendorInvoiceBadgeTone,
  vendorInvoiceStatusLabel,
  type VendorInvoice,
  type VendorInvoiceStatus,
} from "@/lib/vendor-invoices";

const VENDOR_FINANCE_TABS = [
  { id: "income", label: "Income" },
  { id: "invoices", label: "Invoices" },
] as const;

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

function payoutStatusTone(status: VendorIncomeRow["payoutStatus"]): string {
  if (status === "paid") {
    return "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  }
  if (status === "failed") {
    return "portal-badge-danger ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  }
  if (status === "pending") {
    return "portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  }
  return "bg-accent/30 text-foreground ring-1 ring-border";
}

function compareIncomeRows(a: VendorIncomeRow, b: VendorIncomeRow, key: string, dir: "asc" | "desc"): number {
  let cmp = 0;
  if (key === "date") {
    cmp = (a.dateIso || "").localeCompare(b.dateIso || "");
  } else if (key === "workOrder") {
    cmp = a.workOrderTitle.localeCompare(b.workOrderTitle, undefined, { sensitivity: "base" });
  } else if (key === "property") {
    cmp = a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" });
  } else if (key === "labor") {
    cmp = a.laborCents - b.laborCents;
  } else if (key === "materials") {
    cmp = a.materialsCents - b.materialsCents;
  } else if (key === "total") {
    cmp = a.totalCents - b.totalCents;
  } else if (key === "payoutStatus") {
    cmp = a.payoutStatusLabel.localeCompare(b.payoutStatusLabel, undefined, { sensitivity: "base" });
  }
  return dir === "asc" ? cmp : -cmp;
}

function VendorIncomeTable({
  rows,
  sortKey,
  sortDir,
  onHeaderSort,
}: {
  rows: VendorIncomeRow[];
  sortKey: string;
  sortDir: "asc" | "desc";
  onHeaderSort: (key: string) => void;
}) {
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareIncomeRows(a, b, sortKey, sortDir)),
    [rows, sortKey, sortDir],
  );
  const totals = useMemo(() => vendorIncomeTotals(rows), [rows]);

  if (rows.length === 0) {
    return <PortalDataTableEmpty message="No income entries yet." icon="finance" />;
  }

  const columns = [
    { key: "date", label: "Date", align: "left" as const },
    { key: "workOrder", label: "Work order", align: "left" as const },
    { key: "property", label: "Property", align: "left" as const },
    { key: "labor", label: "Labor", align: "right" as const },
    { key: "materials", label: "Materials", align: "right" as const },
    { key: "total", label: "Total", align: "right" as const },
    { key: "payoutStatus", label: "Payout status", align: "left" as const },
  ];

  return (
    <>
      <div className="space-y-2 lg:hidden">
        {sortedRows.map((row) => (
          <div key={row.id} className={PORTAL_MOBILE_CARD_CLASS}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <div className="min-w-0 col-span-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Work order</p>
                <p className="truncate text-sm font-medium text-foreground">{row.workOrderTitle}</p>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Date</p>
                <p className="truncate text-sm text-foreground">{formatIncomeDate(row.dateIso)}</p>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Total</p>
                <p className="truncate text-sm font-medium tabular-nums text-foreground">
                  {formatVendorIncomeMoney(row.totalCents)}
                </p>
              </div>
              <div className="min-w-0 col-span-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Property</p>
                <p className="truncate text-sm text-foreground">{row.propertyLabel}</p>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Labor</p>
                <p className="truncate text-sm tabular-nums text-foreground">{formatVendorIncomeMoney(row.laborCents)}</p>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Materials</p>
                <p className="truncate text-sm tabular-nums text-foreground">
                  {formatVendorIncomeMoney(row.materialsCents)}
                </p>
              </div>
              <div className="min-w-0 col-span-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Payout status</p>
                <span
                  className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${payoutStatusTone(row.payoutStatus)}`}
                >
                  {row.payoutStatusLabel}
                </span>
              </div>
            </div>
          </div>
        ))}
        <div className={`${PORTAL_MOBILE_CARD_CLASS} bg-accent/10`}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div className="min-w-0 col-span-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Total income</p>
              <p className="truncate text-sm font-semibold tabular-nums text-foreground">
                {formatVendorIncomeMoney(totals.totalCents)}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
        <div className={PORTAL_DATA_TABLE_SCROLL}>
          <table className={PORTAL_DATA_TABLE}>
            <thead>
              <tr className={PORTAL_TABLE_HEAD_ROW}>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`${MANAGER_TABLE_TH} ${col.align === "right" ? "text-right" : "text-left"} cursor-pointer select-none hover:bg-accent/30 transition`}
                    onClick={() => onHeaderSort(col.key)}
                    data-attr={`vendor-finances-sort-${col.key}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      <span className="text-[10px] text-muted/60">
                        {sortKey === col.key ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <tr key={row.id} className={PORTAL_TABLE_TR}>
                  <td className={`${PORTAL_TABLE_TD} text-muted`}>{formatIncomeDate(row.dateIso)}</td>
                  <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>{row.workOrderTitle}</td>
                  <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>{row.propertyLabel}</td>
                  <td className={`${PORTAL_TABLE_TD} text-right tabular-nums`}>{formatVendorIncomeMoney(row.laborCents)}</td>
                  <td className={`${PORTAL_TABLE_TD} text-right tabular-nums`}>
                    {formatVendorIncomeMoney(row.materialsCents)}
                  </td>
                  <td className={`${PORTAL_TABLE_TD} text-right tabular-nums font-medium text-foreground`}>
                    {formatVendorIncomeMoney(row.totalCents)}
                  </td>
                  <td className={PORTAL_TABLE_TD}>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${payoutStatusTone(row.payoutStatus)}`}
                    >
                      {row.payoutStatusLabel}
                    </span>
                    {row.payoutFailureReason ? (
                      <p className="mt-1 text-xs text-muted">{row.payoutFailureReason}</p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-accent/10 font-semibold text-sm">
                <td className={PORTAL_TABLE_TD}>Total income</td>
                <td className={PORTAL_TABLE_TD} />
                <td className={PORTAL_TABLE_TD} />
                <td className={`${PORTAL_TABLE_TD} text-right tabular-nums`}>
                  {formatVendorIncomeMoney(totals.laborCents)}
                </td>
                <td className={`${PORTAL_TABLE_TD} text-right tabular-nums`}>
                  {formatVendorIncomeMoney(totals.materialsCents)}
                </td>
                <td className={`${PORTAL_TABLE_TD} text-right tabular-nums`}>
                  {formatVendorIncomeMoney(totals.totalCents)}
                </td>
                <td className={PORTAL_TABLE_TD} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </>
  );
}

const INVOICE_STATUS_FILTERS: { id: "all" | VendorInvoiceStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "submitted", label: "Submitted" },
  { id: "approved", label: "Approved" },
  { id: "scheduled", label: "Scheduled" },
  { id: "paid", label: "Paid" },
  { id: "rejected", label: "Rejected" },
];

type InvoiceFormLine = { description: string; quantity: string; unitAmount: string };

function emptyLine(): InvoiceFormLine {
  return { description: "", quantity: "1", unitAmount: "" };
}

const INVOICE_FORM_INPUT =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

function SubmitInvoiceModal({
  open,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [workOrderId, setWorkOrderId] = useState("");
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

  function reset() {
    setInvoiceNumber("");
    setWorkOrderId("");
    setMemo("");
    setLines([emptyLine()]);
    setError(null);
  }

  async function handleSubmit() {
    if (previewLines.length === 0) {
      setError("Add at least one line item with an amount.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/vendor/invoices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: invoiceNumber.trim() || undefined,
          workOrderId: workOrderId.trim() || undefined,
          memo: memo.trim() || undefined,
          lineItems: lines.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity) || 0,
            unitAmountCents: Math.round((Number(l.unitAmount) || 0) * 100),
          })),
        }),
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
    <Modal
      open={open}
      title="Submit invoice"
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={saving || totalCents === 0}
            data-attr="vendor-invoice-submit"
          >
            {saving ? "Submitting…" : `Submit ${formatInvoiceMoney(totalCents)}`}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
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
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Work order (optional)</span>
            <input
              className={INVOICE_FORM_INPUT}
              value={workOrderId}
              onChange={(e) => setWorkOrderId(e.target.value)}
              placeholder="Service id"
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
    </Modal>
  );
}

function formatInvoiceDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function VendorInvoicesView({ tabItems, tabId }: { tabItems: { id: string; label: string; href: string }[]; tabId: string }) {
  const [invoices, setInvoices] = useState<VendorInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | VendorInvoiceStatus>("all");
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/vendor/invoices");
      if (!res.ok) {
        setInvoices([]);
        return;
      }
      const body = (await res.json()) as { invoices?: VendorInvoice[] };
      setInvoices(body.invoices ?? []);
    } catch {
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: invoices.length };
    for (const inv of invoices) map[inv.status] = (map[inv.status] ?? 0) + 1;
    return map;
  }, [invoices]);

  const filtered = useMemo(
    () => (statusFilter === "all" ? invoices : invoices.filter((inv) => inv.status === statusFilter)),
    [invoices, statusFilter],
  );

  return (
    <ManagerPortalPageShell
      title="Finances"
      hideTitleOnMobileNav
      titleAside={
        <Button variant="primary" onClick={() => setModalOpen(true)} data-attr="vendor-invoice-new">
          Submit invoice
        </Button>
      }
      filterRow={
        <ManagerPortalFilterRow>
          <TabNav activeId={tabId} items={tabItems} />
          <ManagerPortalStatusPills
            tabs={INVOICE_STATUS_FILTERS.map((f) => ({ id: f.id, label: f.label, count: counts[f.id] ?? 0 }))}
            activeId={statusFilter}
            onChange={(id) => setStatusFilter(id as "all" | VendorInvoiceStatus)}
          />
        </ManagerPortalFilterRow>
      }
    >
      {loading ? (
        <PortalDataTableEmpty message="Loading invoices…" icon="finance" />
      ) : filtered.length === 0 ? (
        <PortalDataTableEmpty
          message={invoices.length === 0 ? "No invoices yet. Submit one to bill your manager." : "No invoices match this filter."}
          icon="finance"
        />
      ) : (
        <>
          <div className="space-y-2 lg:hidden">
            {filtered.map((inv) => (
              <div key={inv.id} className={PORTAL_MOBILE_CARD_CLASS}>
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium text-foreground">{inv.invoiceNumber || "Invoice"}</p>
                  <Badge tone={vendorInvoiceBadgeTone(inv.status)}>{vendorInvoiceStatusLabel(inv.status)}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Submitted</p>
                    <p className="truncate text-sm text-foreground">{formatInvoiceDate(inv.submittedAt)}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">Total</p>
                    <p className="truncate text-sm font-medium tabular-nums text-foreground">
                      {formatInvoiceMoney(inv.totalCents, inv.currency)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
            <div className={PORTAL_DATA_TABLE_SCROLL}>
              <table className={PORTAL_DATA_TABLE}>
                <thead>
                  <tr className={PORTAL_TABLE_HEAD_ROW}>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Invoice #</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Submitted</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Work order</th>
                    <th className={`${MANAGER_TABLE_TH} text-right`}>Items</th>
                    <th className={`${MANAGER_TABLE_TH} text-right`}>Total</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inv) => (
                    <tr key={inv.id} className={PORTAL_TABLE_TR}>
                      <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>{inv.invoiceNumber || "—"}</td>
                      <td className={`${PORTAL_TABLE_TD} text-muted`}>{formatInvoiceDate(inv.submittedAt)}</td>
                      <td className={`${PORTAL_TABLE_TD} text-muted`}>{inv.workOrderId || "—"}</td>
                      <td className={`${PORTAL_TABLE_TD} text-right tabular-nums`}>{inv.lineItems.length}</td>
                      <td className={`${PORTAL_TABLE_TD} text-right tabular-nums font-medium text-foreground`}>
                        {formatInvoiceMoney(inv.totalCents, inv.currency)}
                      </td>
                      <td className={PORTAL_TABLE_TD}>
                        <Badge tone={vendorInvoiceBadgeTone(inv.status)}>{vendorInvoiceStatusLabel(inv.status)}</Badge>
                        {inv.decisionNote ? <p className="mt-1 text-xs text-muted">{inv.decisionNote}</p> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <SubmitInvoiceModal open={modalOpen} onClose={() => setModalOpen(false)} onSubmitted={load} />
    </ManagerPortalPageShell>
  );
}

/** Vendor Finances — income earned from completed work orders and payouts. */
export function VendorFinancesPanel({
  tabId,
  basePath = "/vendor",
}: {
  tabId: string;
  basePath?: string;
}) {
  const [filters, setFilters] = useState(defaultFilters);
  const [tick, setTick] = useState(0);
  const [payoutsByWorkOrderId, setPayoutsByWorkOrderId] = useState<Record<string, VendorPayout>>({});
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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

  const allRows = useMemo(() => {
    void tick;
    return buildVendorIncomeRows(readVendorWorkOrderRows(), payoutsByWorkOrderId);
  }, [tick, payoutsByWorkOrderId]);

  const propertyOptions = useMemo(() => buildVendorPropertyFilterOptions(allRows), [allRows]);

  const filteredRows = useMemo(
    () =>
      filterVendorIncomeRows(allRows, {
        from: filters.from,
        to: filters.to,
        propertyId: filters.propertyId,
      }),
    [allRows, filters.from, filters.to, filters.propertyId],
  );

  const financeTabItems = useMemo(
    () => VENDOR_FINANCE_TABS.map((tab) => ({ ...tab, href: `${basePath}/financials/${tab.id}` })),
    [basePath],
  );

  function onHeaderSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "date" || key === "total" || key === "labor" || key === "materials" ? "desc" : "asc");
    }
  }

  if (tabId === "invoices") {
    return <VendorInvoicesView tabItems={financeTabItems} tabId={tabId} />;
  }

  if (tabId !== "income") {
    return (
      <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav>
        <PortalDataTableEmpty message="This finances view is not available." icon="finance" />
      </ManagerPortalPageShell>
    );
  }

  return (
    <ManagerPortalPageShell
      title="Finances"
      hideTitleOnMobileNav
      filterRow={
        <ManagerPortalFilterRow>
          <TabNav activeId={tabId} items={financeTabItems} />
        </ManagerPortalFilterRow>
      }
    >
      <div className="space-y-5">
        <ReportFilterBar
          showProperty
          showDateRange
          showDaysAhead={false}
          showTaxYear={false}
          propertyOptions={propertyOptions}
          filters={filters}
          onChange={(next) => setFilters((f) => ({ ...f, ...next }))}
          onRun={() => undefined}
          showRunButton={false}
        />

        {filteredRows.length === 0 && allRows.length > 0 ? (
          <PortalDataTableEmpty message="No income entries match these filters yet." icon="finance" />
        ) : (
          <VendorIncomeTable
            rows={filteredRows}
            sortKey={sortKey}
            sortDir={sortDir}
            onHeaderSort={onHeaderSort}
          />
        )}
      </div>
    </ManagerPortalPageShell>
  );
}
