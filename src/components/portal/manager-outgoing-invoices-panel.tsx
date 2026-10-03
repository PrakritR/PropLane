"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Plus, SlidersHorizontal } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { vendorDetailHref, workOrderDetailHref } from "@/lib/portal-detail-routes";
import type { OutgoingInvoice } from "@/lib/manager-outgoing-invoices";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** One real invoice list for Operations and the vendor record. No simulated settlement. */
export function ManagerOutgoingInvoicesPanel({ tabId = "to-pay", vendorUserId, basePath = "/portal" }: { tabId?: string; vendorUserId?: string; basePath?: string }) {
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
  const [selected, setSelected] = useState("");
  useEffect(() => setTab(tabId), [tabId]);
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
  const bucket = (row: OutgoingInvoice) => row.status === "paid" ? "paid" : row.status === "scheduled" && !vendorUserId ? "scheduled" : "to-pay";
  const tabs = (vendorUserId ? ["to-pay", "paid"] : ["to-pay", "scheduled", "paid"]).map(id => ({ id, label: id === "to-pay" ? "To pay" : id === "paid" ? "Paid" : "Scheduled", count: rows.filter(row => bucket(row) === id).length + (id === "paid" ? payouts.length : 0) }));
  const shown = rows.filter(row => bucket(row) === tab && (!vendorFilter || row.vendorUserId === vendorFilter) && [row.vendorName, row.invoiceNumber, row.serviceTitle, row.propertyName, row.memo].join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  const shownPayouts = tab === "paid" ? payouts.filter(row => (!vendorFilter || row.vendorUserId === vendorFilter) && [row.vendorName, row.workOrderId].join(" ").toLowerCase().includes(search.trim().toLowerCase())) : [];
  const unpaid = rows.filter(row => row.status !== "paid");
  return <div data-attr="manager-outgoing-invoices">
    {vendorUserId ? <dl className="mb-4 grid grid-cols-2 divide-x divide-border rounded-xl border border-border bg-card p-4"><div><dt>Paid this year</dt><dd className="text-xl font-semibold">{loading || error ? "—" : money(totals.paidThisYearCents)}</dd></div><div className="pl-4"><dt>Owed now</dt><dd className="text-xl font-semibold">{loading || error ? "—" : money(totals.owedCents)}</dd></div></dl> : null}
    <PortalListControlStack variant="command" stickyDestinations={false}
      destinationRow={<ManagerPortalStatusPills tabs={tabs} activeId={tab} onChange={setTab} />}
      search={{ value: search, onChange: setSearch, placeholder: "Search outgoing payments" }}
      actions={<PortalIconAction label="Filter" icon={SlidersHorizontal} active={Boolean(vendorFilter)} onClick={() => setFilterOpen(true)} />}
      primary={<PortalPrimaryIconAction label="Add payment" icon={Plus} onClick={() => { setSelected(unpaid[0]?.id ?? ""); setPicker(true); }} />} />
    {search || vendorFilter ? <div className="flex items-center gap-2 py-2 text-sm"><span>Showing filtered payments</span><button type="button" className="underline" onClick={() => { setSearch(""); setVendorFilter(""); }}>Clear</button></div> : null}
    <PortalDialog open={filterOpen} title="Filter outgoing payments" onClose={() => setFilterOpen(false)} primaryAction={{ label: "Apply", onClick: () => setFilterOpen(false) }}><label>Vendor<Select value={vendorFilter} onChange={event => setVendorFilter(event.target.value)}><option value="">All vendors</option>{[...new Map(rows.map(row => [row.vendorUserId, row.vendorName])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></label></PortalDialog>
    <PortalRecordListSurface loading={loading} loadError={error} onRetry={() => void load()} isEmpty={!shown.length && !shownPayouts.length} empty={<p className="py-8 text-center text-sm">{search ? "No matching payments." : "No outgoing payments."}</p>}>
      {shown.map(row => <RecordActionContext.Provider key={row.id} value={{ scope: row.id, clear: () => {}, actions: <>
        {row.status !== "paid" ? <DropdownMenuItem onSelect={() => setPay(row)}>Pay now</DropdownMenuItem> : null}
        <DropdownMenuItem onSelect={() => setView(row)}>View invoice</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { window.location.href = vendorDetailHref(basePath, row.vendorId, "communication"); }}>Message vendor</DropdownMenuItem>
      </> }}><PortalApplicantRecordRow name={row.vendorName} address={[row.serviceTitle || row.invoiceNumber || "Invoice", row.propertyName].filter(Boolean).join(" · ")}
        facts={<PortalRowFact icon={CalendarDays}>{row.paidAt ? `Paid ${row.paidAt.slice(0, 10)}` : `Approved ${(row.decidedAt || row.submittedAt).slice(0, 10)}`}{row.paidFrom ? ` · ${row.paidFrom === "balance" ? "PropLane balance" : "Bank"}` : ""}</PortalRowFact>}
        trailing={<strong>{money(row.totalCents)}</strong>} onOpen={() => setView(row)} dataAttr="outgoing-invoice-row" /></RecordActionContext.Provider>)}
      {shownPayouts.map(row => <PortalApplicantRecordRow key={`payout-${row.id}`} name={row.vendorName} address="Payout" facts={<PortalRowFact icon={CalendarDays}>Paid {row.createdAt.slice(0, 10)}</PortalRowFact>} trailing={<strong>{money(row.amountCents)}</strong>} onOpen={() => { if (row.workOrderId) window.location.href = workOrderDetailHref(basePath, "completed", row.workOrderId); }} />)}
    </PortalRecordListSurface>
    <PortalDialog primaryAction={null} open={Boolean(view)} onClose={() => setView(null)} title={view?.invoiceNumber || "Invoice"}><div className="space-y-3">{view?.lineItems.map((line, i) => <div key={i} className="flex justify-between gap-3"><span>{line.description} × {line.quantity}</span><span>{money(line.amountCents)}</span></div>)}<div className="flex justify-between"><span>Total</span><strong>{money(view?.totalCents ?? 0)}</strong></div>{view?.status !== "paid" ? <Button onClick={() => { setPay(view); setView(null); }}>Pay</Button> : null}</div></PortalDialog>
    <PortalDialog primaryAction={null} open={picker} onClose={() => setPicker(false)} title="Pay vendor"><div className="space-y-4"><label>Invoice<Select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose an approved invoice</option>{unpaid.map(row => <option key={row.id} value={row.id}>{row.vendorName} · {row.invoiceNumber || row.serviceTitle || "Invoice"} · {money(row.totalCents)}</option>)}</Select></label><Button disabled={!selected} onClick={() => { setPay(unpaid.find(row => row.id === selected) ?? null); setPicker(false); }}>Continue</Button></div></PortalDialog>
    <PortalDialog primaryAction={null} open={Boolean(pay)} onClose={() => setPay(null)} title="Pay vendor"><div className="space-y-4"><div className="flex justify-between"><span>{pay?.vendorName}</span><strong>{money(pay?.totalCents ?? 0)}</strong></div><p role="alert">Invoice payments are unavailable until payment settlement safeguards are enabled. No money has moved.</p></div></PortalDialog>
  </div>;
}
