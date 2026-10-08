"use client";

/**
 * The record pages the vendor tabs open when a row is clicked, drawn for the home demo from fixture props:
 *
 *  - a service (`vendor-work-orders-panel.tsx`): rail Job (Overview, Estimate & bid, Schedule), Money (Invoice,
 *    Payments), Records (Communication, Documents), header "Message the manager", the one round primary labelled with
 *    the next step, and a ⋯ "More"
 *  - an invoice (`VendorInvoiceDetailPage`): rail Invoice (Overview, Lines, Payout), header Edit, Withdraw, Download, Submit
 *  - a payment (`VendorPayoutRecordPage`): rail Payout (Overview, Included invoices), header Receipt, Refund
 *  - a withdrawal (`VendorWithdrawalDetail`): no rail, the Payout rows and a Receipt icon
 *  - the inline document viewer under a Documents row.
 *
 * The real pages fetch their record, so these draw the same header, rail and cards from the same exported pieces
 * (`recordSections`, `PortalDetailHeader`, `PortalRecordSectionChrome`, `RecordFactCard`). Section names come from
 * the registry. Nothing saves; popups opened from a record (Request payment, Submit bid) are the demo pop-ups.
 * Loaded on demand (`demo-popups-lazy-vendor.tsx`).
 */

import { useMemo, useState, type ReactNode } from "react";
import { Check, CalendarDays, Download, MessageSquare, Navigation, Send, X, type LucideIcon } from "lucide-react";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalTitleActionsProvider } from "@/components/portal/portal-title-actions-slot";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { ManagerResidentSectionToolbar } from "@/components/portal/manager-resident-section-toolbar";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { ServiceStageStepper } from "@/components/portal/service-details-section";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { recordSections, type RecordSections } from "@/lib/portals/record-sections";
import { vendorBidTabs, vendorServiceStageItems } from "@/lib/vendor-work-order-tabs";
import { PROPLANE_SERVICE_FEE_LABEL } from "@/lib/platform-fees";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import type { VendorReplyChoice } from "@/lib/work-order-bid-cycle";
import type { ServiceStage } from "@/lib/service-lifecycle";
import { DemoRecordThread } from "@/components/marketing/site/product-mock/demo-record";
import { demoVendorServiceActions, jobDetailFor, type VendorJobDetail, type VendorServiceActionId } from "@/components/marketing/site/product-mock/fixtures-popups-vendor";

const SECTION_BODY = "space-y-3 px-3 pb-4 sm:px-4";
const LABEL_CLASS = "mb-1 block text-xs font-medium uppercase tracking-wide text-muted";

type Message = { id: string; author: string; body: string; at: string; direction: "inbound" | "outbound" };

/* ───────────────────────────── the frame ───────────────────────────── */

/** The registry's rail and the header's icon slot, with the back chevron. `sections` omitted = a page with no rail. */
function VendorRecordFrame({
  title,
  subtitle,
  backLabel,
  onBack,
  actions,
  sections,
  recordId,
  activeId,
  onActive,
  ariaLabel,
  children,
}: {
  title: string;
  subtitle?: string;
  backLabel: string;
  onBack: () => void;
  actions: ReactNode;
  sections?: RecordSections;
  recordId: string;
  activeId?: string;
  onActive?: (id: string) => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  // The registry's hrefs are real routes; in the demo a rail row only switches section.
  const inert = useMemo<RecordSections | undefined>(
    () =>
      sections
        ? { ...sections, groups: sections.groups.map((group) => ({ ...group, items: group.items.map((item) => ({ ...item, href: () => "#" })) })) }
        : undefined,
    [sections],
  );
  const labelToId = useMemo(() => new Map((sections?.groups ?? []).flatMap((g) => g.items.map((i) => [i.label, i.id] as const))), [sections]);
  return (
    <PortalTitleActionsProvider>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-attr="demo-record-page"
        onClickCapture={(event) => {
          const anchor = (event.target as Element | null)?.closest?.("nav a");
          if (!anchor) return;
          event.preventDefault();
          const id = labelToId.get(anchor.textContent?.trim() ?? "");
          if (id) onActive?.(id);
        }}
      >
        <div className="shrink-0">
          <PortalDetailHeader
            title={title}
            subtitle={subtitle}
            avatarName={title}
            onBack={onBack}
            backLabel={backLabel}
            hideBackText
            bare
            iconTitleActions
            dataAttrBack="record-detail-back"
            actions={
              <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5" data-attr="record-header-icons">
                {actions}
              </div>
            }
          />
        </div>
        {inert && activeId ? (
          <PortalRecordSectionChrome sections={inert} recordId={recordId} activeId={activeId} title={title} subtitle={subtitle} backHref="#" backLabel="Back" ariaLabel={ariaLabel}>
            {children}
          </PortalRecordSectionChrome>
        ) : (
          <div className="min-h-0 flex-1">{children}</div>
        )}
      </div>
    </PortalTitleActionsProvider>
  );
}

/** A registry's header icons: the first is the filled primary, a danger one is red, every one a ringed icon. */
function RegistryIcons({ sections, onAction, hide = [] }: { sections: RecordSections; onAction: (id: string) => void; hide?: string[] }) {
  const actions = sections.headerActions.filter((a) => !hide.includes(a.id));
  return (
    <>
      {actions.map((action, index) => {
        const primary = index === 0 && action.tone !== "danger";
        return (
          <PortalIconAction
            key={action.id}
            ring
            ringPrimary={primary}
            tone={primary ? "primary" : action.tone}
            icon={action.icon}
            label={action.label}
            data-attr={`record-header-action-${action.id}`}
            onClick={() => onAction(action.id)}
          />
        );
      })}
    </>
  );
}

/** The section's single-tab header card (`renderSectionHeader`). */
function SectionHeader({ id, label, extra }: { id: string; label: string; extra?: ReactNode }) {
  return (
    <ManagerResidentSectionToolbar
      actions={[]}
      onAction={() => undefined}
      className="rs40 plp-header-card"
      destinationRow={<LocalDestinationNav items={[{ id, label, dataAttr: `vendor-job-section-${id}` }]} activeId={id} onChange={() => undefined} ariaLabel={label} appearance="command" className="w-full" />}
      extraActions={extra}
    />
  );
}

function EmptyCard({ title, dataAttr }: { title: string; dataAttr: string }) {
  return <PortalListEmptyCard title={title} workspaceAware={false} dataAttr={dataAttr} />;
}

/* ───────────────────────────── a service ───────────────────────────── */

export type DemoVendorJob = {
  id: string;
  title: string;
  /** "property · room" once hired; the general area before. */
  placeLine: string;
  hired: boolean;
  stage: ServiceStage;
  /** The row's fact ("Thu, Oct 2 · 9am", "Invoice sent"). */
  fact: string;
  figure?: string;
  manager: string;
};

const ACTION_ICON: Record<VendorServiceActionId, LucideIcon> = {
  submit_bid: Send,
  book_visit: CalendarDays,
  visit_done: Check,
  decline: X,
  schedule: CalendarDays,
  reschedule: CalendarDays,
  mark_done: Check,
  send_invoice: Send,
  message: MessageSquare,
};

const BID_STUB = { amountCents: 18_000, estimateCents: null, consultationVisitAt: null, estimateVisitDoneAt: null } as unknown as WorkOrderBid;
const VISIT_STUB = { amountCents: null, estimateCents: null, consultationVisitAt: "2025-10-02T16:00:00.000Z", estimateVisitDoneAt: null } as unknown as WorkOrderBid;
const OFFER_STUB = { status: "sent" } as unknown as WorkOrderVendorOffer;

export function DemoVendorJobRecord({
  job,
  detail: baseDetail,
  messages,
  initialSection = "service",
  initialBidChoice,
  onBack,
  onToast,
  onRequestInvoice,
  onCompleted,
  invoiceSent,
}: {
  job: DemoVendorJob;
  detail?: VendorJobDetail;
  messages: Message[];
  initialSection?: string;
  initialBidChoice?: VendorReplyChoice;
  onBack: () => void;
  onToast: (text: string) => void;
  /** Opens the Request payment pop-up on this service (Send invoice). */
  onRequestInvoice: () => void;
  /** The service was marked Complete here, so the list moves it to Completed. */
  onCompleted?: () => void;
  invoiceSent: boolean;
}) {
  const [stage, setStage] = useState<ServiceStage>(job.stage);
  const [detail, setDetail] = useState<VendorJobDetail>(baseDetail ?? jobDetailFor(job.id));
  const [section, setSection] = useState(initialSection);
  const [choice, setChoice] = useState<VendorReplyChoice | null>(initialBidChoice ?? null);
  const offered = !job.hired;
  const invoice = invoiceSent ? "sent" : detail.invoice;
  const sections = useMemo(() => recordSections("vendor", "job", { basePath: "/vendor" }), []);
  const actions = demoVendorServiceActions(stage, detail, offered, invoice === "owed");
  const primary = actions.find((a) => a.id !== "decline" && a.id !== "message") ?? null;
  const more = actions.filter((a) => a !== primary);

  const bidForTabs = detail.bid === "visit" ? VISIT_STUB : detail.bid === "sent" ? BID_STUB : undefined;
  const tabs = vendorBidTabs(bidForTabs, offered || detail.bid === "none" ? OFFER_STUB : undefined);
  const defaultChoice: VendorReplyChoice = detail.bid === "visit" ? "complete_estimate_visit" : "submit_bid";
  const activeChoice = tabs.find((t) => t.value === (choice ?? defaultChoice))?.value ?? tabs[0]?.value ?? "submit_bid";
  const activeTab = tabs.find((t) => t.value === activeChoice);

  const [labor, setLabor] = useState("180");
  const [materials, setMaterials] = useState("40");
  const [when, setWhen] = useState("2025-10-02T09:00");
  const [estimate, setEstimate] = useState("200");
  const [visitAt, setVisitAt] = useState("2025-10-01T16:00");
  const [visitFee, setVisitFee] = useState("0");
  const [note, setNote] = useState("");

  const go = (next: string, bidChoice?: VendorReplyChoice) => {
    setSection(next);
    if (bidChoice) setChoice(bidChoice);
  };
  const run = (id: VendorServiceActionId) => {
    if (id === "submit_bid") {
      if (section === "bid" && activeChoice === "submit_bid") {
        setDetail((d) => ({ ...d, bid: "sent" }));
        onToast("Bid submitted (sample)");
      } else go("bid", "submit_bid");
    } else if (id === "book_visit") go("bid", "book_estimate_visit");
    else if (id === "visit_done") go("bid", "complete_estimate_visit");
    else if (id === "decline") go("bid", offered ? "decline" : "cant_do_it");
    else if (id === "schedule" || id === "reschedule") go("schedule");
    else if (id === "message") go("communication");
    else if (id === "mark_done") {
      setStage("completed");
      onCompleted?.();
      onToast("Marked complete (sample)");
    } else if (id === "send_invoice") onRequestInvoice();
  };
  const PrimaryIcon = primary ? ACTION_ICON[primary.id] : Send;

  const submitBid = () => {
    if (!activeTab) return;
    if (activeChoice === "submit_bid") setDetail((d) => ({ ...d, bid: "sent" }));
    if (activeChoice === "book_estimate_visit") setDetail((d) => ({ ...d, bid: "visit" }));
    if (activeChoice === "decline" || activeChoice === "cant_do_it") {
      onToast("Declined (sample)");
      onBack();
      return;
    }
    onToast(`${activeTab.submitLabel} (sample)`);
  };

  const factRows: { label: string; value: ReactNode }[] = [
    { label: "Service", value: job.title },
    { label: "Trade", value: detail.trade },
    { label: "Where", value: job.placeLine },
    { label: "Status", value: job.fact },
    ...(detail.visit ? [{ label: "Visit", value: detail.visit }] : []),
    { label: "Manager", value: job.manager },
    ...(job.figure ? [{ label: "Your price", value: job.figure }] : detail.budget ? [{ label: "Budget", value: detail.budget }] : []),
    ...(detail.description ? [{ label: "Details", value: detail.description }] : []),
  ];

  let body: ReactNode;
  if (section === "bid") {
    body = (
      <div className={SECTION_BODY} data-attr="vendor-estimate-bid">
        <ManagerResidentSectionToolbar
          actions={[]}
          onAction={() => undefined}
          className="rs40 plp-header-card"
          destinationRow={
            <LocalDestinationNav
              items={tabs.map((tab) => ({ id: tab.value, label: tab.label, dataAttr: `vendor-reply-choice-${tab.value}` }))}
              activeId={activeChoice}
              onChange={(id) => setChoice(id as VendorReplyChoice)}
              ariaLabel="Your answer"
              appearance="command"
              className="w-full"
            />
          }
        />
        <div className="rounded-2xl border border-border bg-card" data-attr="vendor-bid-answer">
          <div className="space-y-3 p-4">
            {activeChoice === "give_estimate" ? (
              <div>
                <label className={LABEL_CLASS} htmlFor="vendor-reply-estimate">Estimate</label>
                <Input id="vendor-reply-estimate" inputMode="decimal" placeholder="$0" value={estimate} onChange={(e) => setEstimate(e.target.value)} />
              </div>
            ) : null}
            {activeChoice === "book_estimate_visit" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-visit-at">Visit</label>
                  <Input id="vendor-reply-visit-at" type="datetime-local" value={visitAt} onChange={(e) => setVisitAt(e.target.value)} />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-visit-fee">Visit fee</label>
                  <Input id="vendor-reply-visit-fee" inputMode="decimal" placeholder="$0" value={visitFee} onChange={(e) => setVisitFee(e.target.value)} />
                </div>
              </div>
            ) : null}
            {activeChoice === "submit_bid" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-labor">Labor</label>
                  <Input id="vendor-reply-labor" inputMode="decimal" placeholder="$0" value={labor} onChange={(e) => setLabor(e.target.value)} />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-materials">Materials</label>
                  <Input id="vendor-reply-materials" inputMode="decimal" placeholder="$0" value={materials} onChange={(e) => setMaterials(e.target.value)} />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-when">Can start</label>
                  <Input id="vendor-reply-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                </div>
                <div>
                  <span className={LABEL_CLASS}>Total</span>
                  <p className="flex h-10 items-center text-sm font-bold text-foreground">${((Number(labor) || 0) + (Number(materials) || 0)).toLocaleString("en-US")}</p>
                </div>
              </div>
            ) : null}
            {activeChoice === "give_estimate" || activeChoice === "submit_bid" ? (
              <div>
                <label className={LABEL_CLASS} htmlFor="vendor-reply-note">Note</label>
                <Textarea id="vendor-reply-note" placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            ) : null}
            {activeChoice === "decline" || activeChoice === "cant_do_it" ? (
              <div>
                <label className={LABEL_CLASS} htmlFor="vendor-reply-reason">Reason</label>
                <Textarea id="vendor-reply-reason" placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            ) : null}
          </div>
          <div className="flex justify-end border-t border-border/70 px-4 py-3" data-attr="vendor-bid-footer">
            <Button type="button" variant="primary" data-attr="vendor-reply-submit" onClick={() => submitBid()}>
              {activeTab?.submitLabel ?? "Submit bid"}
            </Button>
          </div>
        </div>
      </div>
    );
  } else if (section === "schedule") {
    body = (
      <div className={SECTION_BODY} data-attr="vendor-job-schedule">
        <SectionHeader
          id="visit"
          label="Visit"
          extra={stage === "scheduled" ? <PortalIconAction icon={Check} label="Complete" tone="primary" data-attr="vendor-mark-done" onClick={() => run("mark_done")} /> : null}
        />
        {detail.visit || stage === "scheduled" || stage === "completed" ? (
          <p className="text-sm text-foreground">
            Visit <span className="font-medium">{detail.visit ?? job.fact}</span>
          </p>
        ) : (
          <EmptyCard title="Not yet scheduled" dataAttr="vendor-job-schedule-empty" />
        )}
      </div>
    );
  } else if (section === "invoice") {
    body = (
      <div className={SECTION_BODY} data-attr="vendor-job-bid-invoice">
        <SectionHeader
          id="invoice"
          label="Invoice"
          extra={stage === "completed" && invoice === "owed" ? <PortalIconAction icon={Send} label="Send invoice" tone="primary" data-attr="vendor-send-invoice" onClick={onRequestInvoice} /> : null}
        />
        {stage === "completed" ? (
          <>
            <RecordFactCard title="Invoice">
              <RecordFactRow label="Amount" value={job.figure ?? "—"} />
              <RecordFactRow label="Status" value={invoice === "paid" ? "Paid" : invoice === "sent" ? "Invoice sent" : "Not sent yet"} />
            </RecordFactCard>
          </>
        ) : (
          <EmptyCard title="No invoice yet" dataAttr="vendor-job-invoice-empty" />
        )}
      </div>
    );
  } else if (section === "payments") {
    body = (
      <div className={SECTION_BODY} data-attr="vendor-job-payments">
        <SectionHeader id="payments" label="Payout" />
        {stage === "completed" && invoice === "paid" ? (
          <RecordFactCard title="Payout">
            <RecordFactRow label="Amount" value={job.figure ?? "—"} />
            <RecordFactRow label="Status" value="Paid" tone="ok" />
          </RecordFactCard>
        ) : (
          <EmptyCard title="No payments yet" dataAttr="vendor-job-payments-empty" />
        )}
      </div>
    );
  } else if (section === "communication") {
    body = (
      <div className={SECTION_BODY}>
        <DemoRecordThread name={job.manager} subtitle={job.title} messages={messages} selfName="Pacific Plumbing" onSent={() => onToast("Message sent (sample)")} />
      </div>
    );
  } else if (section === "documents") {
    body = (
      <div className={SECTION_BODY} data-attr="vendor-job-photos">
        <SectionHeader id="photos" label="Photos" />
        <EmptyCard title="No documents yet" dataAttr="vendor-job-documents-empty" />
      </div>
    );
  } else {
    body = (
      <>
        <div className="space-y-3 px-3 pb-3 pt-1 sm:px-4">
          <ServiceStageStepper stages={vendorServiceStageItems(stage)} />
          <RecordFactCard title="Service">
            {factRows.map((row) => (
              <RecordFactRow key={row.label} label={row.label} value={row.value} />
            ))}
          </RecordFactCard>
        </div>
        <div className="flex justify-end px-3 pb-3 pt-1 sm:px-4">
          <PortalIconAction icon={Navigation} label="Directions" data-attr="vendor-job-directions" onClick={() => onToast("Directions (sample)")} />
        </div>
      </>
    );
  }

  return (
    <VendorRecordFrame
      title={job.title}
      subtitle={job.placeLine}
      backLabel="Back to services"
      onBack={onBack}
      sections={sections}
      recordId={job.id}
      activeId={section}
      onActive={(id) => setSection(id)}
      ariaLabel="Service sections"
      actions={
        <>
          <PortalIconAction icon={MessageSquare} label="Message the manager" data-attr="vendor-job-message" onClick={() => go("communication")} />
          {primary ? <PortalPrimaryIconAction icon={PrimaryIcon} label={primary.label} data-attr="vendor-job-primary" onClick={() => run(primary.id)} /> : null}
          {more.length > 0 ? <RowActionsMenu label="More" items={more.map((a) => ({ id: a.id, label: a.label, danger: a.id === "decline", onSelect: () => run(a.id) }))} /> : null}
        </>
      }
    >
      {body}
    </VendorRecordFrame>
  );
}

/* ───────────────────────────── an invoice ───────────────────────────── */

export type DemoVendorInvoice = { id: string; number: string; place: string; date: string; status: string; amount: string; manager: string; service: string };

export function DemoVendorInvoiceRecord({ invoice, messages, initialSection = "overview", onBack, onToast, onEdit }: { invoice: DemoVendorInvoice; messages: Message[]; initialSection?: string; onBack: () => void; onToast: (text: string) => void; onEdit: () => void }) {
  const [section, setSection] = useState(initialSection);
  const sections = useMemo(() => recordSections("vendor", "invoice", { basePath: "/vendor" }), []);
  const paid = invoice.status === "Paid";
  const onAction = (id: string) => {
    if (id === "edit" || id === "submit") onEdit();
    else if (id === "withdraw") {
      onToast("Invoice retracted (sample)");
      onBack();
    } else onToast("Download (sample)");
  };
  let body: ReactNode;
  if (section === "lines") {
    body = (
      <ul className="mx-3 divide-y divide-border rounded-xl border border-border bg-card px-3 sm:mx-4 sm:px-4" data-attr="vendor-invoice-lines">
        <li className="flex items-center justify-between gap-3 py-3 text-sm">
          <span className="truncate">{invoice.service}</span>
          <span className="shrink-0 font-medium tabular-nums">{invoice.amount}</span>
        </li>
      </ul>
    );
  } else if (section === "payout") {
    body = <div className={SECTION_BODY}>{paid ? <p className="text-sm text-foreground">Paid {"—"} see the Payouts tab for transfer details.</p> : <EmptyCard title="Not paid out yet" dataAttr="vendor-invoice-payout-empty" />}</div>;
  } else if (section === "communication") {
    body = (
      <div className={SECTION_BODY}>
        <DemoRecordThread name={invoice.manager} subtitle={invoice.number} messages={messages} selfName="Pacific Plumbing" onSent={() => onToast("Message sent (sample)")} />
      </div>
    );
  } else if (section === "documents") {
    body = (
      <div className={SECTION_BODY}>
        <EmptyCard title="No documents yet" dataAttr="vendor-invoice-documents-empty" />
      </div>
    );
  } else {
    body = (
      <div className={SECTION_BODY} data-attr="vendor-invoice-overview">
        <RecordFactCard title="Invoice">
          <RecordFactRow label="Invoice" value={invoice.number} />
          <RecordFactRow label="Amount" value={invoice.amount} />
          <RecordFactRow label="Status" value={invoice.status} tone={paid ? "ok" : undefined} />
          <RecordFactRow label="Submitted" value={invoice.date} />
          <RecordFactRow label="Bill to" value={invoice.manager} />
          <RecordFactRow label="Service" value={invoice.service} />
        </RecordFactCard>
      </div>
    );
  }
  return (
    <VendorRecordFrame
      title={invoice.number}
      subtitle={invoice.date}
      backLabel="Back to invoices"
      onBack={onBack}
      sections={sections}
      recordId={invoice.id}
      activeId={section}
      onActive={setSection}
      ariaLabel="Invoice sections"
      actions={<RegistryIcons sections={sections} onAction={onAction} />}
    >
      {body}
    </VendorRecordFrame>
  );
}

/* ───────────────────────────── a payment (payout) ───────────────────────────── */

export type DemoVendorPayment = { id: string; title: string; place: string; date: string; amountCents: number; feeCents: number; manager: string };

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function DemoVendorPaymentRecord({ payment, messages, initialSection = "overview", onBack, onToast, onRefund }: { payment: DemoVendorPayment; messages: Message[]; initialSection?: string; onBack: () => void; onToast: (text: string) => void; onRefund: () => void }) {
  const [section, setSection] = useState(initialSection);
  const sections = useMemo(() => recordSections("vendor", "payout", { basePath: "/vendor" }), []);
  let body: ReactNode;
  if (section === "included-invoices") {
    body = (
      <div className={SECTION_BODY} data-attr="vendor-payout-included">
        <p className="text-sm text-foreground">{payment.title}</p>
      </div>
    );
  } else if (section === "communication") {
    body = (
      <div className={SECTION_BODY}>
        <DemoRecordThread name={payment.manager} subtitle={payment.title} messages={messages} selfName="Pacific Plumbing" onSent={() => onToast("Message sent (sample)")} />
      </div>
    );
  } else {
    body = (
      <div className={SECTION_BODY} data-attr="vendor-payout-overview">
        <RecordFactCard title="Payment">
          <RecordFactRow label="Gross" value={money(payment.amountCents)} />
          <RecordFactRow label={PROPLANE_SERVICE_FEE_LABEL} value={`−${money(payment.feeCents)}`} />
          <RecordFactRow label="Net to you" value={money(payment.amountCents - payment.feeCents)} />
          <RecordFactRow label="Status" value="Paid" tone="ok" />
          <RecordFactRow label="Paid" value={payment.date} />
          <RecordFactRow label="Property" value={payment.place} />
        </RecordFactCard>
      </div>
    );
  }
  return (
    <VendorRecordFrame
      title={payment.title}
      subtitle="Payout"
      backLabel="Back to payouts"
      onBack={onBack}
      sections={sections}
      recordId={payment.id}
      activeId={section}
      onActive={setSection}
      ariaLabel="Payout sections"
      actions={<RegistryIcons sections={sections} onAction={(id) => (id === "refund" ? onRefund() : onToast("Receipt (sample)"))} />}
    >
      {body}
    </VendorRecordFrame>
  );
}

/* ───────────────────────────── a withdrawal ───────────────────────────── */

export type DemoVendorWithdrawal = { id: string; title: string; amountCents: number; feeCents: number; bank: string; sent: string; arrived: string; status: string };

export function DemoVendorWithdrawalRecord({ withdrawal, onBack, onToast }: { withdrawal: DemoVendorWithdrawal; onBack: () => void; onToast: (text: string) => void }) {
  const title = `${withdrawal.title} · ${money(withdrawal.amountCents)}`;
  return (
    <VendorRecordFrame
      title={title}
      subtitle="Payout"
      backLabel="Back to balance"
      onBack={onBack}
      recordId={withdrawal.id}
      ariaLabel="Payout"
      actions={<PortalIconAction icon={Download} label="Receipt" ring data-attr="vendor-withdrawal-receipt" onClick={() => onToast("Receipt (sample)")} />}
    >
      <div className="px-3 pb-4 sm:px-4" data-attr="vendor-withdrawal-detail">
        <PortalSettingsSection title="Payout">
          <PortalSettingsGroup>
            <PortalSettingsRow label="Amount">{money(withdrawal.amountCents)}</PortalSettingsRow>
            {withdrawal.feeCents > 0 ? <PortalSettingsRow label="Instant payout fee">{`−${money(withdrawal.feeCents)}`}</PortalSettingsRow> : null}
            <PortalSettingsRow label="Sent to your bank">{money(withdrawal.amountCents - withdrawal.feeCents)}</PortalSettingsRow>
            <PortalSettingsRow label="To">{withdrawal.bank}</PortalSettingsRow>
            <PortalSettingsRow label="Sent">{withdrawal.sent}</PortalSettingsRow>
            <PortalSettingsRow label={withdrawal.status === "Paid" ? "Arrived" : "Arrives"}>{withdrawal.arrived}</PortalSettingsRow>
            <PortalSettingsRow label="Status">{withdrawal.status}</PortalSettingsRow>
          </PortalSettingsGroup>
        </PortalSettingsSection>
      </div>
    </VendorRecordFrame>
  );
}

/* ───────────────────────────── the inline document viewer ───────────────────────────── */

/** `DocumentInlineViewer` under a Documents row: the rendered document in a frame with a Download strip. The demo draws a blank sample page. */
export function DemoVendorDocumentViewer({ title, downloadLabel = "Download PDF", onDownload }: { title: string; downloadLabel?: string; onDownload: () => void }) {
  return (
    <section className="mt-3" data-attr="vendor-document-inline-viewer">
      <div data-portal-detail-actions="" className="mb-3 flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" className="rounded-full" data-attr="vendor-documents-inline-download" onClick={onDownload}>
          {downloadLabel}
        </Button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
        <div role="img" aria-label={`${title} preview`} className="mx-auto flex h-64 max-w-md flex-col gap-3 p-6">
          <span className="h-3 w-2/5 rounded bg-neutral-200" />
          <span className="h-2 w-full rounded bg-neutral-100" />
          <span className="h-2 w-11/12 rounded bg-neutral-100" />
          <span className="h-2 w-4/5 rounded bg-neutral-100" />
          <span className="h-2 w-full rounded bg-neutral-100" />
          <span className="h-2 w-3/5 rounded bg-neutral-100" />
        </div>
      </div>
    </section>
  );
}
