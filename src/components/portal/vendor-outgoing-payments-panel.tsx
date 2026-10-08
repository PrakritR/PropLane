"use client";

/**
 * Outgoing payments (vendor-portal-ia-1007): the vendor's own expense log. Private to the vendor.
 * Tabs This month · Last month · Earlier (a routed segment), search, a Filter popover, Download
 * and the round + that opens Add expense. Rows are the shared anatomy: tile · title · service
 * place line · glyph facts (category, date, receipt) · amount · ⋯ (Edit · View/Add receipt ·
 * Delete). No pills.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Download, Paperclip, Receipt, Tag } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { RecordBandFilter, RecordTabBand } from "@/components/portal/record-list-band";
import { VendorRowMenu, type VendorRowMenuItem } from "@/components/portal/vendor-row-menu";
import {
  VendorAddExpenseModal,
  todayLocalIso,
  type VendorExpenseServiceOption,
} from "@/components/portal/vendor-add-expense-modal";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { MANAGER_WORK_ORDERS_EVENT, readVendorWorkOrderRows, syncManagerWorkOrdersFromServer } from "@/lib/manager-work-orders-storage";
import { readVendorDocumentDataUrl } from "@/lib/vendor-documents";
import {
  VENDOR_EXPENSE_CATEGORIES,
  VENDOR_EXPENSE_RECEIPT_MAX_BYTES,
  vendorExpenseCategoryLabel,
  vendorExpenseSegment,
  vendorExpenseSegmentCounts,
  vendorExpensesCsv,
  type VendorExpense,
} from "@/lib/vendor-expenses";
import { VENDOR_OUTGOING_SEGMENTS, vendorOutgoingHref, type VendorOutgoingSegment } from "@/lib/vendor-money-routes";

const SEGMENT_LABELS: Record<VendorOutgoingSegment, string> = {
  "this-month": "This month",
  "last-month": "Last month",
  earlier: "Earlier",
};

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function VendorOutgoingPaymentsPanel({
  basePath = "/vendor",
  segment,
}: {
  basePath?: string;
  segment: VendorOutgoingSegment;
}) {
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const [expenses, setExpenses] = useState<VendorExpense[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [editing, setEditing] = useState<VendorExpense | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const receiptTarget = useRef<VendorExpense | null>(null);
  const receiptInput = useRef<HTMLInputElement | null>(null);

  const today = useMemo(() => todayLocalIso(), []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/vendor/expenses", { credentials: "include" });
      const body = (await res.json().catch(() => null)) as { expenses?: VendorExpense[] } | null;
      if (!res.ok || !body || !Array.isArray(body.expenses)) {
        setState("error");
        return;
      }
      setExpenses(body.expenses);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    void syncManagerWorkOrdersFromServer().then(bump);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
  }, []);

  // The vendor's own services, for the Service dropdown and filter.
  const services = useMemo<VendorExpenseServiceOption[]>(() => {
    void tick;
    return readVendorWorkOrderRows().map((job) => {
      const unit = job.unit?.trim();
      const place = job.propertyName ? (unit && unit !== "—" ? `${job.propertyName} · ${unit}` : job.propertyName) : "";
      return { id: job.id, label: [job.title?.trim() || "Service", place].filter(Boolean).join(" · ") };
    });
  }, [tick]);

  const counts = useMemo(() => vendorExpenseSegmentCounts(expenses, today), [expenses, today]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return expenses.filter((expense) => {
      if (vendorExpenseSegment(expense.expenseDate, today) !== segment) return false;
      if (categoryFilter && expense.category !== categoryFilter) return false;
      if (serviceFilter && expense.workOrderId !== serviceFilter) return false;
      if (!needle) return true;
      const haystack = `${expense.memo ?? ""} ${vendorExpenseCategoryLabel(expense.category)} ${expense.workOrderTitle ?? ""} ${expense.propertyLabel ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [expenses, segment, categoryFilter, serviceFilter, search, today]);

  function openAdd() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(expense: VendorExpense) {
    setEditing(expense);
    setModalOpen(true);
  }

  async function viewReceipt(expense: VendorExpense) {
    try {
      const res = await fetch(`/api/vendor/expenses/${encodeURIComponent(expense.id)}/receipt`, { credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? "Could not open the receipt.");
      window.open(body.url, "_blank", "noopener");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not open the receipt.");
    }
  }

  async function attachReceipt(expense: VendorExpense, file: File) {
    if (file.size > VENDOR_EXPENSE_RECEIPT_MAX_BYTES) {
      showToast("The receipt must be 5 MB or smaller.");
      return;
    }
    try {
      const dataUrl = await readVendorDocumentDataUrl(file);
      const res = await fetch(`/api/vendor/expenses/${encodeURIComponent(expense.id)}/receipt`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save the receipt.");
      setExpenses((current) => current.map((item) => (item.id === expense.id ? { ...item, hasReceipt: true } : item)));
      showToast("Receipt added.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save the receipt.");
    }
  }

  async function deleteExpense(expense: VendorExpense) {
    if (
      !(await confirm({
        title: "Delete expense",
        description: `Delete ${formatUsd(expense.amountCents)}${expense.memo ? ` · ${expense.memo}` : ""}?`,
        confirmLabel: "Delete",
      }))
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/vendor/expenses/${encodeURIComponent(expense.id)}`, { method: "DELETE", credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not delete the expense.");
      setExpenses((current) => current.filter((item) => item.id !== expense.id));
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete the expense.");
    }
  }

  function downloadCsv() {
    const blob = new Blob([vendorExpensesCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `expenses-${segment}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const serviceFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const expense of expenses) {
      if (expense.workOrderId && !seen.has(expense.workOrderId)) {
        seen.set(expense.workOrderId, expense.workOrderTitle ?? "Linked service");
      }
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [expenses]);

  const filtered = Boolean(search.trim() || categoryFilter || serviceFilter);

  return (
    <ManagerPortalPageShell title="Outgoing payments" hideTitleOnMobileNav compactFilterRow>
      <div className="mb-2 max-lg:mb-1.5">
        <RecordTabBand
          dataAttr="vendor-outgoing-band"
          ariaLabel="Expense period"
          tabs={VENDOR_OUTGOING_SEGMENTS.map((id) => ({
            id,
            label: SEGMENT_LABELS[id],
            count: state === "ready" ? counts[id] : undefined,
          }))}
          activeId={segment}
          onChange={(id) => navigate(vendorOutgoingHref(basePath, id as VendorOutgoingSegment))}
          search={{ value: search, onChange: setSearch, placeholder: "Search expenses" }}
          actions={
            <>
              <RecordBandFilter
                dataAttr="vendor-outgoing-band"
                fields={[
                  {
                    id: "category",
                    label: "Category",
                    anyLabel: "Any category",
                    value: categoryFilter,
                    options: VENDOR_EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: c.label })),
                    onChange: setCategoryFilter,
                  },
                  ...(serviceFilterOptions.length > 0
                    ? [
                        {
                          id: "service",
                          label: "Service",
                          anyLabel: "Any service",
                          value: serviceFilter,
                          options: serviceFilterOptions,
                          onChange: setServiceFilter,
                        },
                      ]
                    : []),
                ]}
              />
              <PortalIconAction
                icon={Download}
                label="Download expenses"
                data-attr="vendor-outgoing-download"
                disabled={rows.length === 0}
                onClick={downloadCsv}
              />
            </>
          }
          plus={{ label: "Add expense", onClick: openAdd, dataAttr: "vendor-outgoing-add" }}
        />
      </div>
      <PortalRecordListSurface
        loading={state === "loading"}
        loadError={state === "error" ? "Could not load your expenses." : undefined}
        onRetry={() => {
          setState("loading");
          void load();
        }}
        isEmpty={state === "ready" && rows.length === 0}
        emptyCard={{
          title: filtered ? "No expenses match" : "No expenses yet",
          section: "financials",
          tone: filtered ? "muted" : "default",
        }}
        dataAttr="vendor-outgoing-list"
      >
        {rows.map((expense) => {
          const items: VendorRowMenuItem[] = [
            { id: "edit", label: "Edit", onSelect: () => openEdit(expense) },
            expense.hasReceipt
              ? { id: "receipt", label: "View receipt", onSelect: () => void viewReceipt(expense) }
              : {
                  id: "receipt",
                  label: "Add receipt",
                  onSelect: () => {
                    receiptTarget.current = expense;
                    receiptInput.current?.click();
                  },
                },
            { id: "delete", label: "Delete", destructive: true, onSelect: () => void deleteExpense(expense) },
          ];
          const place = [expense.workOrderTitle, expense.propertyLabel].filter(Boolean).join(" · ");
          return (
            <PortalPropertyRecordRow
              key={expense.id}
              title={expense.memo || vendorExpenseCategoryLabel(expense.category)}
              address={place || undefined}
              leading={<PortalRowIconTile icon={Receipt} />}
              leadingShape="square"
              facts={
                <>
                  <PortalRowFact icon={Tag} srLabel="Category">
                    {vendorExpenseCategoryLabel(expense.category)}
                  </PortalRowFact>
                  <PortalRowFact icon={CalendarDays} srLabel="Date">
                    {formatDay(expense.expenseDate)}
                  </PortalRowFact>
                  {expense.hasReceipt ? (
                    <PortalRowFact icon={Paperclip} srLabel="Receipt">
                      Receipt
                    </PortalRowFact>
                  ) : null}
                </>
              }
              amount={formatUsd(expense.amountCents)}
              actions={<VendorRowMenu label={expense.memo || vendorExpenseCategoryLabel(expense.category)} items={items} dataAttr="vendor-expense-row-menu" />}
              onOpen={() => openEdit(expense)}
              dataAttr="vendor-expense-row"
            />
          );
        })}
      </PortalRecordListSurface>
      <input
        ref={receiptInput}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        className="hidden"
        data-attr="vendor-expense-row-receipt-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const target = receiptTarget.current;
          e.target.value = "";
          if (file && target) void attachReceipt(target, file);
        }}
      />
      <VendorAddExpenseModal
        open={modalOpen}
        expense={editing}
        services={services}
        onClose={() => setModalOpen(false)}
        onSaved={(saved, note) => {
          setModalOpen(false);
          setExpenses((current) => {
            const without = current.filter((item) => item.id !== saved.id);
            return [saved, ...without].sort((a, b) =>
              a.expenseDate === b.expenseDate ? (a.createdAt < b.createdAt ? 1 : -1) : a.expenseDate < b.expenseDate ? 1 : -1,
            );
          });
          if (note) showToast(note);
          // Land on the tab the expense belongs to so the vendor sees it.
          const target = vendorExpenseSegment(saved.expenseDate, today);
          if (target !== segment) navigate(vendorOutgoingHref(basePath, target));
        }}
      />
    </ManagerPortalPageShell>
  );
}
