"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CalendarDays, Clock, Landmark, Plus, Wallet } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { RecordFactCard, RecordFactRow, RecordRowsCard, type RecordRowItem } from "@/components/portal/portal-record-overview-kit";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PortalDialog, ConfirmRows } from "@/components/portal/portal-dialog";
import { ManagerAddOutgoingPaymentModal } from "@/components/portal/pro-add-outgoing-payment-modal";
import { VendorInvoiceManagerPaySheet } from "@/components/portal/vendor-invoice-manager-pay-sheet";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { buildPayeePaymentRows, MANAGER_OUTGOING_PAYMENTS_EVENT, type ManagerExpenseSnapshot, type PayeePaymentRow } from "@/lib/manager-outgoing-payments";
import { fetchPayeeBook } from "@/lib/manager-payees-client";
import { resolvePropertyLabelForId } from "@/lib/manager-portfolio-access";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { DateField } from "@/components/ui/date-field";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { FILTER_FIELD_LABEL_CLASS } from "@/components/portal/filter-field-lists";
import { portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { outgoingPaymentRecordHref, vendorDetailHref, workOrderDetailHref } from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";
import { readManagerVendorRows, syncManagerVendorsFromServer, type ManagerVendorRow } from "@/lib/manager-vendors-storage";
import type { OutgoingInvoice } from "@/lib/manager-outgoing-invoices";

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
};
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

type Payout = { id: string; vendorUserId: string; vendorName: string; workOrderId: string | null; amountCents: number; createdAt: string };
type Bucket = "to-pay" | "scheduled" | "paid";

/** Net 7 from the day the bill was approved: a vendor invoice carries no due date of its own. */
const dueIso = (row: OutgoingInvoice) => {
  const base = new Date(row.decidedAt ?? row.submittedAt);
  return Number.isFinite(base.getTime()) ? new Date(base.getTime() + 7 * 86_400_000).toISOString() : null;
};
const EMPTY_TITLE: Record<Bucket, string> = { "to-pay": "Nothing to pay", scheduled: "Nothing scheduled", paid: "No payments yet" };
const DATE_WORD: Record<Bucket, string> = { "to-pay": "Due", scheduled: "Pays", paid: "Paid" };

/** One real invoice list for Operations and the vendor record. No simulated settlement. */
export function ManagerOutgoingInvoicesPanel({
  tabId = "to-pay",
  vendorUserId,
  vendorId,
  vendorName,
  basePath = "/portal",
  paymentId,
  paymentTab = "overview",
}: {
  tabId?: string;
  /** The vendor record's linked login, when it has one: only then can a new bill be filed here. */
  vendorUserId?: string;
  /** A vendor record (roster row) id: lists every payment to that payee, with or without a linked login. */
  vendorId?: string;
  vendorName?: string;
  basePath?: string;
  /** Set on `outgoing/payment/<id>`: the one payment as a record page (Payment · Communication). */
  paymentId?: string;
  paymentTab?: string;
}) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const navigate = usePortalNavigate();
  const scoped = Boolean(vendorId);
  const [source, setSource] = useState("balance");
  const [checkout, setCheckout] = useState<OutgoingInvoice | null>(null);
  const [actionRow, setActionRow] = useState<OutgoingInvoice | null>(null);
  const [action, setAction] = useState<"schedule" | "offline">("schedule");
  const [actionDate, setActionDate] = useState("");
  const [offlineMethod, setOfflineMethod] = useState("Bank transfer");
  const [actionError, setActionError] = useState("");
  const [tab, setTab] = useState(tabId);
  const [rows, setRows] = useState<OutgoingInvoice[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [totals, setTotals] = useState({ owedCents: 0, paidThisYearCents: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<OutgoingInvoice | null>(null);
  const [pay, setPay] = useState<OutgoingInvoice | null>(null);
  const [picker, setPicker] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const [availableBalanceCents, setAvailableBalanceCents] = useState<number | null>(null);
  const [vendorRoster, setVendorRoster] = useState<ManagerVendorRow[]>([]);
  const { userId: managerUserId } = useManagerUserId();
  const [payeePayments, setPayeePayments] = useState<PayeePaymentRow[]>([]);
  useEffect(() => setTab(tabId), [tabId]);
  useEffect(() => {
    let active = true;
    fetch("/api/portal/payment-preferences").then(response => response.json()).then(data => { if (active) setSource(data.defaultPaymentSource === "bank" ? "bank" : "balance"); }).catch(() => {});
    return () => { active = false; };
  }, [vendorUserId]);
  useEffect(() => {
    const invoiceId = pay?.id;
    if (!invoiceId) return;
    let active = true;
    fetch(`/api/vendor/invoices/${encodeURIComponent(invoiceId)}/outgoing`).then(response => response.json()).then(data => { if (active) setDestination(data.destination ?? null); }).catch(() => {});
    return () => { active = false; };
  }, [pay?.id]);
  useEffect(() => {
    if (!pay) { setAvailableBalanceCents(null); return; }
    let active = true;
    fetch("/api/portal/proplane-balance").then(response => response.json()).then(data => {
      if (!active) return;
      const cents = data?.enabled ? Number(data.availableCents ?? 0) : 0;
      setAvailableBalanceCents(Number.isFinite(cents) ? cents : 0);
    }).catch(() => { if (active) setAvailableBalanceCents(0); });
    return () => { active = false; };
  }, [pay?.id]);
  useEffect(() => {
    if (!pay || availableBalanceCents === null) return;
    if (pay.totalCents > availableBalanceCents) setSource("bank");
  }, [pay?.id, pay?.totalCents, availableBalanceCents]);
  // The record page's Communication thread is the vendor's: it needs the roster row for the vendor's email and phone.
  useEffect(() => {
    if (!paymentId) return;
    let active = true;
    setVendorRoster(readManagerVendorRows());
    void syncManagerVendorsFromServer().then((next) => { if (active) setVendorRoster(next); }).catch(() => {});
    return () => { active = false; };
  }, [paymentId]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status: "approved,scheduled,paid", outgoing: "1" });
      if (vendorId) params.set("vendorId", vendorId);
      const response = await fetch(`/api/manager/vendor-invoices?${params}`, { credentials: "include" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load outgoing payments.");
      setRows(body.invoices); setPayouts(body.payouts ?? []); setTotals(body.totals);
      // Payments to a saved payee (mortgage, utility, teammate...) are expenses, already made: they list under Paid.
      if (!vendorId) {
        try {
          const [expenseRes, book] = await Promise.all([fetch("/api/expenses", { credentials: "include", cache: "no-store" }), fetchPayeeBook()]);
          const expenseBody = expenseRes.ok ? await expenseRes.json() as { expenses?: ManagerExpenseSnapshot[] } : { expenses: [] };
          setPayeePayments(buildPayeePaymentRows(expenseBody.expenses ?? [], new Map(book.payees.map(payee => [payee.id, payee]))));
        } catch { setPayeePayments([]); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load outgoing payments."); }
    finally { setLoading(false); }
  }, [vendorId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payInvoiceId = params.get("payInvoice")?.trim();
    if (!payInvoiceId || rows.length === 0) return;
    const match = rows.find((row) => row.id === payInvoiceId);
    if (!match) return;
    setTab("to-pay");
    setPay(match);
    params.delete("payInvoice");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
    window.history.replaceState(null, "", next);
  }, [rows]);
  const bucket = (row: OutgoingInvoice): Bucket => row.status === "paid" ? "paid" : row.status === "scheduled" && Boolean(row.scheduledFor && row.scheduledFor > pacificCalendarDateYmd()) ? "scheduled" : "to-pay";
  const passesFilters = (row: { vendorUserId: string; propertyName?: string }) => (!vendorFilter || row.vendorUserId === vendorFilter) && (!propertyFilter || row.propertyName === propertyFilter);
  const filtered = rows.filter(passesFilters);
  const shownPayeePayments = tab === "paid" && !vendorFilter && !propertyFilter ? payeePayments.filter(row => matchesPortalListSearch(search, row.name, row.typeLabel, row.memo)) : [];
  const tabs = (["to-pay", "scheduled", "paid"] as const).map(id => ({ id, label: id === "to-pay" ? "To pay" : id === "paid" ? "Paid" : "Scheduled", count: filtered.filter(row => bucket(row) === id).length + (id === "paid" ? payouts.filter(row => !vendorFilter || row.vendorUserId === vendorFilter).length + (vendorFilter ? 0 : payeePayments.length) : 0) }));
  const inBucket = filtered.filter(row => bucket(row) === tab);
  const shown = inBucket.filter(row => matchesPortalListSearch(search, row.vendorName, row.invoiceNumber, row.serviceTitle, row.propertyName, row.memo));
  const shownPayouts = tab === "paid" && !propertyFilter ? payouts.filter(row => (!vendorFilter || row.vendorUserId === vendorFilter) && matchesPortalListSearch(search, row.vendorName, row.workOrderId)) : [];
  const vendorOptions = [...new Map(rows.map(row => [row.vendorUserId, row.vendorName])).entries()].map(([id, name]) => ({ value: id, label: name }));
  const propertyOptions = [...new Set(rows.map(row => row.propertyName).filter((name): name is string => Boolean(name)))].map(name => ({ value: name, label: name }));
  const refresh = async () => { await load(); window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT)); };
  const mutate = async (row: OutgoingInvoice, action: string, date?: string, method?: string) => {
    setActionError("");
    const res = await fetch(`/api/vendor/invoices/${encodeURIComponent(row.id)}/outgoing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, date, method }) });
    const data = await res.json();
    if (!res.ok) { setActionError(data.error || "Could not update payment."); return false; }
    await refresh(); return true;
  };
  const recordHref = (id: string) => outgoingPaymentRecordHref(basePath, id);
  const plannedMethod = source === "bank" ? "Bank" : "PropLane balance";
  const methodOf = (row: OutgoingInvoice) => row.status === "paid"
    ? (row.paidFrom === "balance" ? "PropLane balance" : row.paidFrom === "stripe" ? "Bank" : row.offlineMethod || "Outside PropLane")
    : plannedMethod;
  const dateOf = (row: OutgoingInvoice) => row.status === "paid" ? row.paidAt : row.status === "scheduled" ? row.scheduledFor : dueIso(row);

  const openSchedule = (row: OutgoingInvoice) => { setAction("schedule"); setActionRow(row); setActionDate(row.scheduledFor || ""); setActionError(""); };
  const openMarkPaid = (row: OutgoingInvoice) => { setAction("offline"); setActionRow(row); setActionDate(pacificCalendarDateYmd()); setActionError(""); };
  const deleteBill = async (row: OutgoingInvoice): Promise<boolean> => {
    if (!(await confirm({ title: "Delete bill", description: `Delete the ${money(row.totalCents)} bill from ${row.vendorName}?`, confirmLabel: "Delete bill" }))) return false;
    if (!(await mutate(row, "delete"))) { showToast("Could not delete bill."); return false; }
    return true;
  };
  const messageVendor = (row: OutgoingInvoice) => navigate(outgoingPaymentRecordHref(basePath, row.id, "communication"));

  const dialogs = <>
    <PortalDialog primaryAction={view && view.status !== "paid" ? { label: "Pay now", onClick: () => { setPay(view); setView(null); } } : null} open={Boolean(view)} onClose={() => setView(null)} title="Invoice">
      {view ? <ConfirmRows rows={[
        { label: "Vendor", value: view.vendorName },
        ...(view.serviceTitle ? [{ label: "For", value: view.serviceTitle }] : []),
        ...(view.propertyName ? [{ label: "Property", value: view.propertyName }] : []),
        { label: "Status", value: view.status === "paid" ? "Paid" : view.status === "scheduled" ? "Scheduled" : "To pay" },
        ...(dateOf(view) ? [{ label: view.status === "paid" ? "Paid on" : view.status === "scheduled" ? "Pays on" : "Due", value: shortDate(dateOf(view)) }] : []),
        { label: view.status === "paid" ? "Paid with" : "Pays with", value: methodOf(view) },
        ...view.lineItems.map(line => ({ label: `${line.description} × ${line.quantity}`, value: money(line.amountCents) })),
        { label: "Total", value: <strong>{money(view.totalCents)}</strong> },
      ]} /> : null}
    </PortalDialog>
    <ManagerAddOutgoingPaymentModal open={picker} onClose={() => setPicker(false)} managerUserId={managerUserId} initialVendorId={vendorId} basePath={basePath} onPayVendorInvoice={invoiceId => { const match = rows.find(row => row.id === invoiceId); if (match) setPay(match); }} onSubmitted={() => void refresh()} />
    <PortalDialog open={Boolean(pay)} onClose={() => { setPay(null); setActionError(""); }} title="Pay vendor" primaryAction={{ label: pay ? `Pay ${money(pay.totalCents)}` : "Pay", disabled: Boolean(pay && source === "balance" && availableBalanceCents !== null && pay.totalCents > availableBalanceCents), onClick: async () => {
      if (!pay) return;
      if (source === "bank") { setCheckout(pay); setPay(null); return; }
      const res = await fetch(`/api/vendor/invoices/${encodeURIComponent(pay.id)}/pay-from-balance`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 422 && data.code === "insufficient_balance") { setSource("bank"); setCheckout(pay); setPay(null); return; }
        setActionError(data.error || "Could not pay invoice."); return;
      }
      setPay(null); showToast("Payment sent."); await refresh();
    } }}><div className="space-y-4"><div className="flex justify-between"><span>{pay?.vendorName}</span><strong>{money(pay?.totalCents ?? 0)}</strong></div>{destination ? <div className="flex justify-between"><span>Paid to</span><span>{destination}</span></div> : null}<FieldSingleSelect label="Pay from" value={source} onChange={setSource} options={[{ value: "balance", label: availableBalanceCents === null ? "PropLane balance" : `PropLane balance · ${money(availableBalanceCents)} available` }, { value: "bank", label: "Bank account" }]} />{pay && source === "balance" && availableBalanceCents !== null && pay.totalCents > availableBalanceCents ? <p role="status" className="text-sm text-muted">Short {money(pay.totalCents - availableBalanceCents)} — choose bank or reduce the amount.</p> : null}{actionError ? <p role="alert">{actionError}</p> : null}</div></PortalDialog>
    <PortalDialog open={Boolean(actionRow)} onClose={() => setActionRow(null)} title={action === "schedule" ? "Schedule payment" : "Mark paid outside PropLane"} primaryAction={{ label: action === "schedule" ? "Schedule" : "Record payment", onClick: async () => { if (actionRow && await mutate(actionRow, action, action === "offline" ? `${actionDate}T12:00:00-07:00` : actionDate, offlineMethod)) setActionRow(null); } }}>
      <div className="space-y-4">
        <div>
          <span className={FILTER_FIELD_LABEL_CLASS}>{action === "schedule" ? "Pay on" : "Paid on"}</span>
          <DateField value={actionDate} onChange={setActionDate} {...(action === "schedule" ? { min: pacificCalendarDateYmd() } : { max: pacificCalendarDateYmd() })} />
        </div>
        {action === "offline" ? <FieldSingleSelect label="Method" value={offlineMethod} onChange={setOfflineMethod} options={["Cash", "Check", "Bank transfer", "Other"].map(method => ({ value: method, label: method }))} /> : null}
        {actionRow ? <ConfirmRows rows={[
          { label: "To", value: actionRow.vendorName },
          { label: "Amount", value: money(actionRow.totalCents) },
          ...(action === "schedule" ? [{ label: "Pay from", value: plannedMethod }] : []),
        ]} /> : null}
        {actionError ? <p role="alert">{actionError}</p> : null}
      </div>
    </PortalDialog>
    <VendorInvoiceManagerPaySheet invoice={checkout} onClose={() => { setCheckout(null); void refresh(); }} />
  </>;

  /* ------------------------------------------------------------------ one payment: a record page */
  if (paymentId) {
    const invoice = rows.find(row => row.id === paymentId) ?? null;
    const payout = invoice ? null : payouts.find(row => row.id === paymentId) ?? null;
    if (loading) return <div data-attr="manager-outgoing-record"><PortalRecordListSurface loading isEmpty={false} /></div>;
    if (error) return <div data-attr="manager-outgoing-record"><PortalRecordListSurface loadError={error} onRetry={() => void load()} isEmpty={false} /></div>;
    if (!invoice && !payout) {
      return <div data-attr="manager-outgoing-record"><PortalListEmptyCard title="This payment is gone" section="payments" workspaceAware={false} actions={[{ label: "Outgoing payments", onClick: () => navigate(`${basePath}/outgoing/to-pay`) }]} /></div>;
    }
    const vendorName = (invoice ?? payout)!.vendorName;
    const paymentVendorUserId = (invoice ?? payout)!.vendorUserId;
    const rosterVendor = vendorRoster.find(v => (invoice && v.id === invoice.vendorId) || (v.vendorUserId && v.vendorUserId === paymentVendorUserId)) ?? null;
    const vendorRecordId = invoice?.vendorId || rosterVendor?.id || "";
    const state: Bucket | "approved" = invoice ? (invoice.status === "paid" ? "paid" : invoice.status === "scheduled" ? "scheduled" : "approved") : "paid";
    const amountCents = invoice ? invoice.totalCents : payout!.amountCents;
    const title = invoice ? (invoice.serviceTitle || invoice.invoiceNumber || "Invoice") : "Payment";
    const workOrderId = invoice ? invoice.workOrderId : payout!.workOrderId;
    const paidOn = invoice ? invoice.paidAt : payout!.createdAt;
    const backTab: Bucket = state === "paid" ? "paid" : state === "scheduled" ? "scheduled" : "to-pay";
    const backHref = `${basePath}/outgoing/${backTab}`;
    const sections = recordSections("manager", "vendor-bill", { basePath });
    const activeId = paymentTab === "communication" ? "communication" : "overview";
    const linkClass = "font-medium text-primary hover:underline";
    const detailRows: Array<{ label: string; value: ReactNode }> = [
      { label: "Vendor", value: vendorRecordId ? <Link href={vendorDetailHref(basePath, vendorRecordId)} className={linkClass}>{vendorName}</Link> : vendorName },
      ...(workOrderId ? [{ label: "Service", value: invoice?.serviceTitle ? <Link href={workOrderDetailHref(basePath, "open", workOrderId)} className={linkClass}>{invoice.serviceTitle}</Link> : <Link href={workOrderDetailHref(basePath, "completed", workOrderId)} className={linkClass}>Service</Link> }] : []),
      ...(invoice?.propertyName ? [{ label: "Property", value: invoice.propertyName }] : []),
      { label: "Status", value: state === "paid" ? "Paid" : state === "scheduled" ? "Scheduled" : "To pay" },
      { label: "Amount", value: money(amountCents) },
      { label: state === "paid" ? "Paid on" : state === "scheduled" ? "Pays on" : "Due", value: shortDate(invoice ? dateOf(invoice) : paidOn) || "No date" },
      ...(invoice ? [{ label: state === "paid" ? "Paid with" : "Pays with", value: methodOf(invoice) }] : []),
      ...(invoice?.invoiceNumber ? [{ label: "Invoice", value: invoice.invoiceNumber }] : []),
      ...(invoice ? [{ label: "Billed by", value: invoice.managerEntered ? "You (entered by hand)" : vendorName }] : []),
    ];
    const history: Array<RecordRowItem & { at: number }> = [];
    const at = (iso: string | null | undefined) => { const t = iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).getTime() : NaN; return Number.isFinite(t) ? t : 0; };
    if (invoice) {
      history.push({ id: "billed", at: at(invoice.submittedAt), title: invoice.managerEntered ? "Bill entered" : `Billed by ${vendorName}${invoice.invoiceNumber ? ` · ${invoice.invoiceNumber}` : ""}`, sub: shortDate(invoice.submittedAt), figure: money(invoice.totalCents) });
      if (invoice.decidedAt) history.push({ id: "approved", at: at(invoice.decidedAt), title: "Approved", sub: shortDate(invoice.decidedAt) });
      if (invoice.scheduledFor) history.push({ id: "scheduled", at: at(invoice.scheduledFor), title: "Scheduled to pay", sub: shortDate(invoice.scheduledFor) });
      if (invoice.paidAt) history.push({ id: "paid", at: at(invoice.paidAt), title: `Paid with ${methodOf(invoice)}`, sub: shortDate(invoice.paidAt), figure: money(invoice.totalCents) });
    } else if (payout) {
      history.push({ id: "payout", at: at(payout.createdAt), title: "Payment sent", sub: shortDate(payout.createdAt), figure: money(payout.amountCents) });
    }
    history.sort((a, b) => a.at - b.at);

    const available: Record<string, { run: () => void; show: boolean }> = {
      "view-invoice": { show: Boolean(invoice), run: () => setView(invoice) },
      schedule: { show: Boolean(invoice) && state !== "paid", run: () => invoice && openSchedule(invoice) },
      message: { show: true, run: () => navigate(outgoingPaymentRecordHref(basePath, paymentId, "communication")) },
      "mark-paid": { show: Boolean(invoice) && state !== "paid", run: () => invoice && openMarkPaid(invoice) },
      delete: { show: Boolean(invoice?.managerEntered) && state !== "paid", run: () => { if (invoice) void deleteBill(invoice).then((gone) => { if (gone) navigate(backHref); }); } },
      "pay-now": { show: Boolean(invoice) && state !== "paid", run: () => invoice && setPay(invoice) },
    };
    // Header order: View invoice · Schedule / Change date · Message vendor · Mark paid · red Delete bill · blue Pay now (right-most).
    const headerActions = ["view-invoice", "schedule", "message", "mark-paid", "delete", "pay-now"]
      .map((id) => sections.headerActions.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a) && available[a!.id]!.show)
      .map((a) => a.id === "schedule" && state === "scheduled" ? { ...a, label: "Change date" } : a);

    return <div data-attr="manager-outgoing-record">
      <PortalRecordDetailPage
        pageTitle="Outgoing payments"
        title={vendorName}
        subtitle={`${title} · ${money(amountCents)}`}
        avatarName={vendorName}
        backHref={backHref}
        backLabel="Back to outgoing payments"
        hideBackText
        bareHeader
        dataAttrBack="outgoing-payment-detail-back"
        iconTitleActions
        pinScrollBody
      >
        <PortalRecordActions>
          <PortalAdaptiveActionRow
            align="end"
            gapPx={6}
            actions={headerActions.map((a) => ({
              id: a.id,
              tone: a.tone,
              node: <PortalIconAction ring ringPrimary={a.tone === "primary"} tone={a.tone} icon={a.icon} label={a.label} data-attr={`record-header-action-${a.id}`} onClick={available[a.id]!.run} />,
              menuItem: <DropdownMenuItem className={a.tone === "danger" ? "text-red-600" : undefined} data-attr={`record-header-action-${a.id}`} onSelect={available[a.id]!.run}>{a.label}</DropdownMenuItem>,
            }))}
          />
        </PortalRecordActions>
        <PortalRecordSectionChrome
          sections={sections}
          recordId={paymentId}
          activeId={activeId}
          title={vendorName}
          subtitle={title}
          backHref={backHref}
          backLabel="All outgoing payments"
          ariaLabel="Payment sections"
        >
          {activeId === "communication" ? (
            vendorRecordId ? renderRecordSection("communication", {
              role: "manager",
              kind: "vendor",
              kindLabel: "vendor",
              recordId: vendorRecordId,
              recordLabel: vendorName,
              contactIds: rosterVendor?.email ? [rosterVendor.email] : undefined,
            }) : <PortalListEmptyCard title={`No messages with ${vendorName} yet`} section="communication" workspaceAware={false} />
          ) : (
            <div className="space-y-3" data-attr="outgoing-payment-record" data-out-state={state}>
              <RecordFactCard title="Payment" dataAttr="outgoing-payment-card">
                {detailRows.map((r) => <RecordFactRow key={r.label} label={r.label} value={r.value} />)}
              </RecordFactCard>
              {invoice ? (
                <RecordFactCard title="Invoice" dataAttr="outgoing-payment-invoice">
                  {invoice.lineItems.map((line, i) => <RecordFactRow key={i} label={`${line.description} × ${line.quantity}`} value={money(line.amountCents)} />)}
                  <RecordFactRow label="Total" value={<strong>{money(invoice.totalCents)}</strong>} />
                </RecordFactCard>
              ) : null}
              {history.length ? <RecordRowsCard title="History" rows={history} dataAttr="outgoing-payment-history" /> : null}
            </div>
          )}
        </PortalRecordSectionChrome>
      </PortalRecordDetailPage>
      {dialogs}
    </div>;
  }

  /* ------------------------------------------------------------------ the list */
  const currentTab: Bucket = tab === "paid" ? "paid" : tab === "scheduled" ? "scheduled" : "to-pay";
  const nothingToThisVendor = scoped && !loading && !error && rows.length === 0 && payouts.length === 0;
  const emptyCard = search.trim()
    ? { title: portalEmptyNoMatchTitle("payments", search), section: "payments", tone: "muted" as const, clear: { label: "Clear search", onClick: () => setSearch("") } }
    : { title: nothingToThisVendor ? `No payments to ${vendorName?.trim() || "this vendor"} yet` : EMPTY_TITLE[currentTab], section: "payments" };
  const filterCount = portalFilterActiveCount([vendorFilter, propertyFilter]);
  return <div data-attr="manager-outgoing-invoices">
    <PortalListControlStack variant="command" stickyDestinations={false}
      {...(scoped
        ? {
            destinationRow: (
              <LocalDestinationNav
                appearance="command"
                items={tabs.map((t) => ({
                  id: t.id,
                  label: t.label,
                  count: t.count,
                  dataAttr: `outgoing-tab-${t.id}`,
                }))}
                activeId={tab}
                onChange={setTab}
                ariaLabel="Outgoing payments"
              />
            ),
          }
        : { destinations: tabs.map((t) => ({ id: t.id, label: t.label, count: t.count, href: `${basePath}/outgoing/${t.id}`, dataAttr: `outgoing-tab-${t.id}` })), activeDestinationId: tab, destinationAriaLabel: "Outgoing payments" })}
      search={{ value: search, onChange: setSearch, placeholder: "Search outgoing payments" }}
      actions={scoped ? null : (
        <PortalFilterSortSheet
          activeCount={filterCount}
          compactPanel
          commandStripTrigger
          filterFieldCount={2}
          onReset={() => { setVendorFilter(""); setPropertyFilter(""); }}
          dataAttr="outgoing-filter"
        >
          <FieldSingleSelect label="Vendor" value={vendorFilter} onChange={setVendorFilter} options={[{ value: "", label: "All vendors" }, ...vendorOptions]} dataAttr="outgoing-filter-vendor" />
          <FieldSingleSelect label="Property" value={propertyFilter} onChange={setPropertyFilter} options={[{ value: "", label: "All properties" }, ...propertyOptions]} dataAttr="outgoing-filter-property" />
        </PortalFilterSortSheet>
      )}
      primary={scoped && !vendorUserId ? null : <PortalPrimaryIconAction label="Add payment" icon={Plus} onClick={() => { setActionError(""); setPicker(true); }} />} />
    <PortalRecordListSurface loading={loading} loadError={error} onRetry={() => void load()} isEmpty={!shown.length && !shownPayouts.length && !shownPayeePayments.length} emptyCard={emptyCard}>
      {shown.map(row => {
        const rowBucket = bucket(row);
        const planned = row.status !== "paid";
        return <RecordActionContext.Provider key={row.id} value={{ scope: row.id, clear: () => {}, actions: <>
          {planned ? <DropdownMenuItem onSelect={() => setPay(row)}>Pay now</DropdownMenuItem> : null}
          {planned ? <DropdownMenuItem onSelect={() => openSchedule(row)}>{row.status === "scheduled" ? "Change date" : "Schedule payment"}</DropdownMenuItem> : null}
          <DropdownMenuItem onSelect={() => setView(row)}>View invoice</DropdownMenuItem>
          {scoped && row.workOrderId ? <DropdownMenuItem onSelect={() => navigate(workOrderDetailHref(basePath, "open", row.workOrderId!))}>Open service</DropdownMenuItem> : null}
          <DropdownMenuItem onSelect={() => messageVendor(row)}>Message vendor</DropdownMenuItem>
          {planned ? <DropdownMenuItem onSelect={() => openMarkPaid(row)}>Mark paid</DropdownMenuItem> : null}
          {row.managerEntered && planned ? <DropdownMenuItem className="text-[var(--status-overdue-fg)] focus:text-[var(--status-overdue-fg)]" onSelect={() => void deleteBill(row)}>Delete bill</DropdownMenuItem> : null}
        </> }}><PortalApplicantRecordRow
          name={scoped ? (row.serviceTitle || row.invoiceNumber || "Invoice") : row.vendorName}
          tileLabel={row.vendorName}
          address={scoped ? (row.propertyName ?? "") : [row.serviceTitle || row.invoiceNumber || "Invoice", row.propertyName].filter(Boolean).join(" · ")}
          omitActionView
          facts={<>
            <PortalRowFact icon={rowBucket === "paid" ? CalendarDays : Clock}>{`${DATE_WORD[rowBucket]} ${shortDate(dateOf(row)) || "—"}`}</PortalRowFact>
            <PortalRowFact icon={methodOf(row) === "Bank" ? Landmark : Wallet}>{methodOf(row)}</PortalRowFact>
          </>}
          trailing={<strong>{money(row.totalCents)}</strong>} onOpen={() => navigate(recordHref(row.id))} dataAttr="outgoing-invoice-row" /></RecordActionContext.Provider>;
      })}
      {shownPayouts.map(row => <RecordActionContext.Provider key={`payout-${row.id}`} value={{ scope: row.id, clear: () => {}, actions: <>
        <DropdownMenuItem onSelect={() => navigate(recordHref(row.id))}>View payment</DropdownMenuItem>
        {row.workOrderId ? <DropdownMenuItem onSelect={() => navigate(workOrderDetailHref(basePath, "completed", row.workOrderId!))}>Open service</DropdownMenuItem> : null}
      </> }}><PortalApplicantRecordRow name={row.vendorName} address="Payment" omitActionView facts={<PortalRowFact icon={CalendarDays}>Paid {shortDate(row.createdAt)}</PortalRowFact>} trailing={<strong>{money(row.amountCents)}</strong>} onOpen={() => navigate(recordHref(row.id))} dataAttr="outgoing-payout-row" /></RecordActionContext.Provider>)}
      {shownPayeePayments.map(row => <RecordActionContext.Provider key={row.id} value={{ scope: row.id, clear: () => {}, actions: null }}><PortalApplicantRecordRow
        name={row.name}
        address={[row.typeLabel, (row.propertyId && resolvePropertyLabelForId(row.propertyId)) || "Portfolio"].filter(Boolean).join(" · ")}
        omitActionView
        facts={<PortalRowFact icon={CalendarDays}>{[row.referenceLabel, `paid ${shortDate(row.dateIso) || "—"}`].filter(Boolean).join(" · ")}</PortalRowFact>}
        trailing={<strong>{money(row.amountCents)}</strong>} onOpen={() => {}} dataAttr="outgoing-payee-payment-row" /></RecordActionContext.Provider>)}
    </PortalRecordListSurface>
    {dialogs}
  </div>;
}
