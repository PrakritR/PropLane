"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Clock, Filter, Plus, Wallet } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";
import { VendorInvoiceManagerPaySheet } from "@/components/portal/vendor-invoice-manager-pay-sheet";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { vendorDetailHref, workOrderDetailHref } from "@/lib/portal-detail-routes";
import type { OutgoingInvoice } from "@/lib/manager-outgoing-invoices";

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
};
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** One real invoice list for Operations and the vendor record. No simulated settlement. */
export function ManagerOutgoingInvoicesPanel({ tabId = "to-pay", vendorUserId, basePath = "/portal" }: { tabId?: string; vendorUserId?: string; basePath?: string }) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const [source, setSource] = useState("balance");
  const [checkout, setCheckout] = useState<OutgoingInvoice | null>(null);
  const [actionRow, setActionRow] = useState<OutgoingInvoice | null>(null);
  const [action, setAction] = useState<"schedule" | "offline">("schedule");
  const [actionDate, setActionDate] = useState("");
  const [offlineMethod, setOfflineMethod] = useState("Bank transfer");
  const [actionError, setActionError] = useState("");
  const [tab, setTab] = useState(tabId);
  const [rows, setRows] = useState<OutgoingInvoice[]>([]);
  const [payouts, setPayouts] = useState<Array<{ id: string; vendorUserId: string; vendorName: string; workOrderId: string | null; amountCents: number; createdAt: string }>>([]);
  const [totals, setTotals] = useState({ owedCents: 0, paidThisYearCents: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [vendorFilter, setVendorFilter] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<OutgoingInvoice | null>(null);
  const [pay, setPay] = useState<OutgoingInvoice | null>(null);
  const [picker, setPicker] = useState(false);
  const [newBill, setNewBill] = useState(false);
  const [billId, setBillId] = useState("");
  const [billTitle, setBillTitle] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [services, setServices] = useState<Array<{ id: string; title: string; vendorUserId: string }>>([]);
  const [destination, setDestination] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  useEffect(() => setTab(tabId), [tabId]);
  useEffect(() => {
    let active = true;
    fetch("/api/portal/payment-preferences").then(response => response.json()).then(data => { if (active) setSource(data.defaultPaymentSource === "bank" ? "bank" : "balance"); }).catch(() => {});
    fetch("/api/manager/vendor-invoices?choices=1").then(response => response.json()).then(data => { if (active) setServices(data.services ?? []); }).catch(() => {});
    return () => { active = false; };
  }, [vendorUserId]);
  useEffect(() => {
    const invoiceId = pay?.id ?? (vendorUserId ? rows[0]?.id : null);
    if (!invoiceId) return;
    let active = true;
    fetch(`/api/vendor/invoices/${encodeURIComponent(invoiceId)}/outgoing`).then(response => response.json()).then(data => { if (active) setDestination(data.destination ?? null); }).catch(() => {});
    return () => { active = false; };
  }, [pay?.id, vendorUserId, rows]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status: "approved,scheduled,paid", outgoing: "1" });
      if (vendorUserId) params.set("vendorUserId", vendorUserId);
      const response = await fetch(`/api/manager/vendor-invoices?${params}`, { credentials: "include" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load outgoing payments.");
      setRows(body.invoices); setPayouts(body.payouts ?? []); setTotals(body.totals);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load outgoing payments."); }
    finally { setLoading(false); }
  }, [vendorUserId]);
  useEffect(() => { void load(); }, [load]);
  const bucket = (row: OutgoingInvoice) => row.status === "paid" ? "paid" : row.status === "scheduled" && Boolean(row.scheduledFor && row.scheduledFor > pacificCalendarDateYmd()) && !vendorUserId ? "scheduled" : "to-pay";
  const tabs = (vendorUserId ? ["to-pay", "paid"] : ["to-pay", "scheduled", "paid"]).map(id => ({ id, label: id === "to-pay" ? "To pay" : id === "paid" ? "Paid" : "Scheduled", count: rows.filter(row => bucket(row) === id).length + (id === "paid" ? payouts.length : 0) }));
  const shown = rows.filter(row => bucket(row) === tab && (!vendorFilter || row.vendorUserId === vendorFilter) && [row.vendorName, row.invoiceNumber, row.serviceTitle, row.propertyName, row.memo].join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  const shownPayouts = tab === "paid" ? payouts.filter(row => (!vendorFilter || row.vendorUserId === vendorFilter) && [row.vendorName, row.workOrderId].join(" ").toLowerCase().includes(search.trim().toLowerCase())) : [];
  const refresh = async () => { await load(); window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT)); };
  const mutate = async (row: OutgoingInvoice, action: string, date?: string, method?: string) => {
    setActionError("");
    const res = await fetch(`/api/vendor/invoices/${encodeURIComponent(row.id)}/outgoing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, date, method }) });
    const data = await res.json();
    if (!res.ok) { setActionError(data.error || "Could not update payment."); return false; }
    await refresh(); return true;
  };
  const unpaid = rows.filter(row => row.status !== "paid");
  return <div data-attr="manager-outgoing-invoices">
    {vendorUserId ? <dl className="mb-4 grid grid-cols-3 divide-x divide-border rounded-xl border border-border bg-card p-4"><div><dt>Paid this year</dt><dd className="text-xl font-semibold">{loading || error ? "—" : money(totals.paidThisYearCents)}</dd></div><div className="pl-4"><dt>Owed now</dt><dd className="text-xl font-semibold">{loading || error ? "—" : money(totals.owedCents)}</dd></div><div className="pl-4"><dt>Paid via</dt><dd>{destination ?? "—"}</dd></div></dl> : null}
    <PortalListControlStack variant="command" stickyDestinations={false}
      {...(vendorUserId
        ? { destinationRow: <ManagerPortalStatusPills tabs={tabs} activeId={tab} onChange={setTab} /> }
        : { destinations: tabs.map((t) => ({ id: t.id, label: t.label, count: t.count, href: `${basePath}/outgoing/${t.id}`, dataAttr: `outgoing-tab-${t.id}` })), activeDestinationId: tab, destinationAriaLabel: "Outgoing payments" })}
      search={{ value: search, onChange: setSearch, placeholder: "Search outgoing payments" }}
      actions={vendorUserId ? null : <PortalIconAction label="Filter" icon={Filter} active={Boolean(vendorFilter)} onClick={() => setFilterOpen(true)} data-attr="outgoing-filter" />}
      activeFilterChips={vendorFilter ? <PortalActiveFilterChips chips={[{ id: "vendor", label: `Vendor: ${rows.find((row) => row.vendorUserId === vendorFilter)?.vendorName ?? "Vendor"}`, onRemove: () => setVendorFilter("") }]} /> : null}
      primary={<PortalPrimaryIconAction label={vendorUserId ? "Pay vendor" : "Add payment"} icon={Plus} onClick={() => { setSelected(unpaid[0]?.id ?? ""); setNewBill(false); setBillId(crypto.randomUUID()); setActionError(""); setPicker(true); }} />} />
    <PortalDialog open={filterOpen} title="Filter outgoing payments" onClose={() => setFilterOpen(false)} primaryAction={{ label: "Apply", onClick: () => setFilterOpen(false) }}><FieldSingleSelect label="Vendor" value={vendorFilter} onChange={setVendorFilter} options={[{ value: "", label: "All vendors" }, ...[...new Map(rows.map(row => [row.vendorUserId, row.vendorName])).entries()].map(([id, name]) => ({ value: id, label: name }))]} /></PortalDialog>
    <PortalRecordListSurface loading={loading} loadError={error} onRetry={() => void load()} isEmpty={!shown.length && !shownPayouts.length} empty={<p className="py-8 text-center text-sm">{search ? "No matching payments." : "No outgoing payments."}</p>}>
      {shown.map(row => <RecordActionContext.Provider key={row.id} value={{ scope: row.id, clear: () => {}, actions: <>
        {row.status !== "paid" ? <DropdownMenuItem onSelect={() => setPay(row)}>Pay now</DropdownMenuItem> : null}
        {row.status !== "paid" ? <DropdownMenuItem onSelect={() => { setAction("schedule"); setActionRow(row); setActionDate(row.scheduledFor || ""); setActionError(""); }}>Schedule payment</DropdownMenuItem> : null}
        <DropdownMenuItem onSelect={() => setView(row)}>View invoice</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { window.location.href = vendorDetailHref(basePath, row.vendorId, "communication"); }}>Message vendor</DropdownMenuItem>
        {row.status !== "paid" ? <DropdownMenuItem onSelect={() => { setAction("offline"); setActionRow(row); setActionDate(pacificCalendarDateYmd()); setActionError(""); }}>Mark paid</DropdownMenuItem> : null}
        {row.managerEntered && row.status !== "paid" ? <DropdownMenuItem className="text-[var(--status-overdue-fg)] focus:text-[var(--status-overdue-fg)]" onSelect={async () => { if (await confirm({ title: "Delete bill", description: `Delete the ${money(row.totalCents)} bill from ${row.vendorName}?`, confirmLabel: "Delete bill" })) { if (!(await mutate(row, "delete"))) showToast("Could not delete bill."); } }}>Delete bill</DropdownMenuItem> : null}
      </> }}><PortalApplicantRecordRow name={row.vendorName} address={[row.serviceTitle || row.invoiceNumber || "Invoice", row.propertyName].filter(Boolean).join(" · ")}
        facts={<>
          <PortalRowFact icon={row.status === "paid" ? CalendarDays : Clock}>{row.status === "paid" ? `Paid ${shortDate(row.paidAt)}`.trim() : bucket(row) === "scheduled" ? `Scheduled for ${shortDate(row.scheduledFor)}` : `Approved ${shortDate(row.decidedAt ?? row.submittedAt)}`}</PortalRowFact>
          <PortalRowFact icon={Wallet}>{row.status === "paid" ? (row.paidFrom === "balance" ? "PropLane balance" : row.paidFrom === "stripe" ? "Bank account" : row.offlineMethod || "Paid outside PropLane") : source === "bank" ? "Bank account" : "PropLane balance"}</PortalRowFact>
        </>}
        trailing={<strong>{money(row.totalCents)}</strong>} onOpen={() => setView(row)} dataAttr="outgoing-invoice-row" /></RecordActionContext.Provider>)}
      {shownPayouts.map(row => <PortalApplicantRecordRow key={`payout-${row.id}`} name={row.vendorName} address="Payout" facts={<PortalRowFact icon={CalendarDays}>Paid {shortDate(row.createdAt)}</PortalRowFact>} trailing={<strong>{money(row.amountCents)}</strong>} onOpen={() => { if (row.workOrderId) window.location.href = workOrderDetailHref(basePath, "completed", row.workOrderId); }} />)}
    </PortalRecordListSurface>
    <PortalDialog primaryAction={null} open={Boolean(view)} onClose={() => setView(null)} title={view?.invoiceNumber || "Invoice"}><div className="space-y-3">{view?.lineItems.map((line, i) => <div key={i} className="flex justify-between gap-3"><span>{line.description} × {line.quantity}</span><span>{money(line.amountCents)}</span></div>)}<div className="flex justify-between"><span>Total</span><strong>{money(view?.totalCents ?? 0)}</strong></div>{view?.status !== "paid" ? <Button onClick={() => { setPay(view); setView(null); }}>Pay</Button> : null}</div></PortalDialog>
    <PortalDialog open={picker} onClose={() => setPicker(false)} title="Pay vendor" primaryAction={{ label: newBill ? "Create bill" : "Continue", disabled: newBill ? !serviceId || !billTitle || !/^\d+(?:\.\d{1,2})?$/.test(billAmount) : !selected, onClick: async () => {
      if (!newBill) { setPay(unpaid.find(row => row.id === selected) ?? null); setPicker(false); return; }
      const res = await fetch("/api/manager/vendor-invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: billId, workOrderId: serviceId, title: billTitle, amountCents: Math.round(Number(billAmount) * 100) }) });
      const data = await res.json(); if (!res.ok) { setActionError(data.error || "Could not create bill."); return; }
      setPicker(false); await refresh(); showToast("Bill created.");
    } }}><div className="space-y-4"><FieldSingleSelect label="Payment" value={newBill ? "new" : "invoice"} onChange={value => setNewBill(value === "new")} options={[{ value: "invoice", label: "Approved invoice" }, { value: "new", label: "New bill" }]} />{newBill ? <><FieldSingleSelect label="Service" value={serviceId} onChange={setServiceId} placeholder="Choose service" options={services.filter(service => !vendorUserId || service.vendorUserId === vendorUserId).map(service => ({ value: service.id, label: service.title }))} /><label>Description<Input value={billTitle} onChange={event => setBillTitle(event.target.value)} /></label><label>Amount<Input inputMode="decimal" value={billAmount} onChange={event => setBillAmount(event.target.value)} /></label></> : <FieldSingleSelect label="Invoice" value={selected} onChange={setSelected} placeholder="Choose an approved invoice" options={unpaid.map(row => ({ value: row.id, label: `${row.vendorName} · ${row.invoiceNumber || row.serviceTitle || "Invoice"} · ${money(row.totalCents)}` }))} />}{actionError ? <p role="alert">{actionError}</p> : null}</div></PortalDialog>
    <PortalDialog open={Boolean(pay)} onClose={() => { setPay(null); setActionError(""); }} title="Pay vendor" primaryAction={{ label: "Pay", onClick: async () => {
      if (!pay) return;
      if (source === "bank") { setCheckout(pay); setPay(null); return; }
      const res = await fetch(`/api/vendor/invoices/${encodeURIComponent(pay.id)}/pay-from-balance`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setActionError(data.error || "Could not pay invoice."); return; }
      setPay(null); showToast("Payment sent."); await refresh();
    } }}><div className="space-y-4"><div className="flex justify-between"><span>{pay?.vendorName}</span><strong>{money(pay?.totalCents ?? 0)}</strong></div>{destination ? <div className="flex justify-between"><span>Paid to</span><span>{destination}</span></div> : null}<FieldSingleSelect label="Pay from" value={source} onChange={setSource} options={[{ value: "balance", label: "PropLane balance" }, { value: "bank", label: "Bank account" }]} />{actionError ? <p role="alert">{actionError}</p> : null}</div></PortalDialog>
    <PortalDialog open={Boolean(actionRow)} onClose={() => setActionRow(null)} title={action === "schedule" ? "Schedule payment" : "Mark paid outside PropLane"} primaryAction={{ label: action === "schedule" ? "Schedule payment" : "Record payment", onClick: async () => { if (actionRow && await mutate(actionRow, action, action === "offline" ? `${actionDate}T12:00:00-07:00` : actionDate, offlineMethod)) setActionRow(null); } }}><div className="space-y-4"><label>Date<Input type="date" value={actionDate} onChange={event => setActionDate(event.target.value)} /></label>{action === "offline" ? <FieldSingleSelect label="Method" value={offlineMethod} onChange={setOfflineMethod} options={["Cash", "Check", "Bank transfer", "Other"].map(method => ({ value: method, label: method }))} /> : null}{actionError ? <p role="alert">{actionError}</p> : null}</div></PortalDialog>
    <VendorInvoiceManagerPaySheet invoice={checkout} onClose={() => { setCheckout(null); void refresh(); }} />

  </div>;
}
