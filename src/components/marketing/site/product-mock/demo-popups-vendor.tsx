"use client";

/**
 * The vendor tabs' pop-ups, drawn for the home demo from fixture props (captain 2026-10-08: the pop-ups on the home
 * page must match the real portal). Two shells:
 *
 *  - `DemoWorkspacePopup` (the house workspace: step rail, centre, right-hand preview, Back / Next footer) for the
 *    `AddWorkspace` doors: Submit bid / Request payment (`VendorQuoteWizard`) and Upload document.
 *  - `DemoDialog` below, the `Modal` / `PortalDialog` frame: title and close at the top, an optional left record
 *    rail and right preview, the body, and one right-hand primary in the footer. Set availability, the visit
 *    quick-look, Reply to review, Withdraw, Add a bank account, Refund a payment, a month's statement, the W-9 and
 *    New message are all this frame.
 *
 * The real components fetch and mount the assistant, so they cannot render on the public page; each body here is
 * composed from the same exported pieces and carries the real labels, fields and footer words. Nothing is sent or
 * saved: a primary closes the pop-up and the panel shows a small "(sample)" toast. Loaded on demand
 * (`demo-popups-lazy-vendor.tsx`).
 */

import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, CreditCard, Download, ExternalLink, FileText, Landmark, Mail, Plus, X, Zap } from "lucide-react";
import { DemoAskPropLane, DemoWorkspacePopup } from "@/components/marketing/site/product-mock/demo-popup";
import { DemoPopupHostContext } from "@/components/marketing/site/product-mock/demo-popup-host";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { ConfirmRows } from "@/components/portal/portal-dialog";
import { PopupMessagePreview, PopupRecordPreview } from "@/components/portal/popup-live-preview";
import { PreviewPanel, ReviewCard, WizardSection, WizardSelect, WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import {
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageComposeRecipientSection,
  PortalMessageScheduleFields,
  PortalMessageSendViaDropdown,
  PortalMessageSubjectField,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
} from "@/components/portal/portal-message-compose-fields";
import { VendorReviewStarDisplay } from "@/components/portal/vendor-review-stars";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Select, Textarea } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS, MODAL_HEADER_CLOSE_CLASS } from "@/components/ui/modal";
import { FIELD_SELECT_MENU_DATA_ATTR } from "@/components/ui/field-select-portal-interaction";
import { VENDOR_REFUND_REASONS } from "@/components/portal/vendor-refund-modal";
import { VENDOR_DOCUMENT_KINDS, VENDOR_DOCUMENT_LABELS, type VendorDocumentKind } from "@/lib/vendor-documents";
import { starterVendorQuickReplies } from "@/lib/vendor-quick-replies";
import { VENDOR_INSTANT_WITHDRAW_FEE_LABEL, vendorInstantWithdrawFeeQuoteCents, PROPLANE_SERVICE_FEE_LABEL } from "@/lib/platform-fees";
import { refundFeeShareCents, refundNetDebitCents } from "@/lib/vendor-banking/refund-cap";
import { VENDOR_W9_ENTITY_TYPES, maskTin } from "@/lib/vendor-banking/tax";
import { statementMonthLabel } from "@/lib/vendor-banking/statement-events";
import { WEEKDAY_DISPLAY_ORDER, WEEKDAY_LABELS, formatMinuteOfDayLabel, minuteOfDayToTimeInputValue, timeInputValueToMinuteOfDay } from "@/lib/vendor-availability";
import { cn } from "@/lib/utils";
import {
  DEMO_AVAILABLE_CENTS,
  DEMO_BANK,
  DEMO_DATE_OVERRIDES,
  DEMO_INSTANT_AVAILABLE_CENTS,
  DEMO_REFUNDABLE,
  DEMO_STATEMENTS,
  DEMO_W9,
  DEMO_WEEKLY_WINDOWS,
  statementClosingCents,
  type DemoAvailabilityWindow,
} from "@/components/marketing/site/product-mock/fixtures-popups-vendor";

const usd = (cents: number) => `$${(Math.max(0, cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const parseDollars = (raw: string) => {
  const cleaned = raw.trim().replace(/[$,]/g, "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(cleaned)) return 0;
  return Math.round(Number.parseFloat(cleaned) * 100);
};

/* ───────────────────────────── the Modal / PortalDialog frame ───────────────────────────── */

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** The centred layer a `Modal` draws, inside the demo window (the real one is `fixed` to the browser). */
function DialogLayer({ label, size, children }: { label: string; size: "standard" | "compact"; children: ReactNode }) {
  const host = useContext(DemoPopupHostContext);
  const layer = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-demo-popup=""
      className="demo-popup-layer pointer-events-auto absolute inset-0 z-[40] flex min-h-0 min-w-0 bg-foreground/30 p-0 backdrop-blur-sm sm:p-4"
    >
      <div className="flex min-h-0 min-w-0 flex-1 items-stretch justify-center p-0 sm:items-center">
        <div className={cn("demo-popup-window w-full", size === "standard" ? "h-full max-w-[920px] sm:h-[min(640px,100%)]" : "max-h-full max-w-lg")}>{children}</div>
      </div>
    </div>
  );
  return host ? createPortal(layer, host) : layer;
}

export type DemoDialogPrimary = { label: string; onClick: () => void; disabled?: boolean; dataAttr?: string };

/**
 * `Modal` / `PortalDialog`: header (title, header icons, Ask PropLane, close), the body between an optional left
 * record rail and right preview, and a footer with one primary at the right. No primary = no footer (a browse dialog).
 */
export function DemoDialog({
  title,
  onClose,
  children,
  primary,
  headerAction,
  context,
  preview,
  previewLabel = "Preview",
  size = "standard",
  assistant = true,
  dataAttr,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  primary?: DemoDialogPrimary | null;
  headerAction?: ReactNode;
  context?: ReactNode;
  preview?: ReactNode;
  previewLabel?: string;
  size?: "standard" | "compact";
  assistant?: boolean;
  dataAttr?: string;
}) {
  useEscape(onClose);
  return (
    <DialogLayer label={title} size={size}>
      <div className={cn("flex w-full flex-col overflow-hidden rounded-[10px] bg-card shadow-[0_24px_60px_-12px_rgba(16,24,40,0.45)]", size === "standard" ? "h-full" : "max-h-full")} data-attr={dataAttr}>
        <div className="flex min-h-[56px] shrink-0 items-center gap-3 border-b border-border px-4 py-2 sm:px-5">
          <h3 className="min-w-0 flex-1 truncate text-[16px] font-[650] leading-tight tracking-tight text-foreground">{title}</h3>
          {headerAction}
          {assistant ? <DemoAskPropLane /> : null}
          <button type="button" onClick={onClose} aria-label="Close" className={MODAL_HEADER_CLOSE_CLASS}>
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {context ? <aside data-popup-context="" className="hidden w-[190px] shrink-0 overflow-y-auto border-r border-border bg-background px-3.5 py-[18px] lg:block">{context}</aside> : null}
          <div data-popup-form="" className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-[22px] sm:py-[18px]">
            {children}
          </div>
          {preview ? (
            <aside data-popup-preview="" className="hidden w-[260px] shrink-0 overflow-y-auto border-l border-border bg-[#fafbfc] p-4 lg:block [html[data-theme=dark]_&]:bg-black/20">
              <div className="mb-2.5 text-xs font-semibold text-muted">{previewLabel}</div>
              {preview}
            </aside>
          ) : null}
        </div>
        {primary ? (
          <div className="flex min-h-[56px] shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-4 py-2">
            <span aria-hidden />
            <button
              type="button"
              onClick={primary.onClick}
              disabled={primary.disabled}
              data-demo-target="sheet-primary"
              data-attr={primary.dataAttr ?? "demo-dialog-primary"}
              className="min-h-[44px] rounded-lg bg-primary px-4 text-[13.5px] font-semibold text-white disabled:opacity-50 lg:min-h-9"
            >
              {primary.label}
            </button>
          </div>
        ) : null}
      </div>
    </DialogLayer>
  );
}

const NATIVE_FIELD = "w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none";

/* ───────────────────────────── Communication: New message ───────────────────────────── */

const MANAGER_PERSON = { key: "id:mgr-seattle", label: "Manager · Seattle Homes" };

/** The vendor New message, drawn as the shared composer (`ManagerCommunicationComposeModal portal="vendor"`). */
export function DemoVendorComposeDialog({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [categories, setCategories] = useState<string[]>(["management"]);
  const [keys, setKeys] = useState<string[]>([MANAGER_PERSON.key]);
  const [subject, setSubject] = useState("Kitchen faucet drip");
  const [body, setBody] = useState("I can be there Thursday at 10 AM. The parts are on the truck.");
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [sendAt, setSendAt] = useState("2025-09-26T09:00");
  const viaSms = sendVia.includes("sms");
  const viaEmail = sendVia.includes("email");
  const sendLabel = scheduleLater ? "Schedule" : viaEmail && viaSms ? "Send message" : viaSms ? "Send SMS" : "Send email";
  const recipient = categories.includes("management") ? MANAGER_PERSON.label : "";
  return (
    <DemoDialog
      title="New message"
      onClose={onClose}
      context={<PopupRecordPreview rows={[{ label: "Recipients", value: keys.length ? recipient : "Not selected" }]} />}
      previewLabel="Message preview"
      preview={<PopupMessagePreview subject={subject} body={body} recipient={keys.length ? recipient : ""} channel={sendLabel} sendAt={scheduleLater ? sendAt : undefined} />}
      primary={{ label: sendLabel, onClick: onSent, dataAttr: "inbox-compose-send" }}
      dataAttr="vendor-new-message"
    >
      <PortalMessageComposeModalBody>
        <PortalMessageComposeRecipientSection
          sectionOptions={[{ value: "management", label: "Manager" }, { value: "admin", label: "PropLane admin" }]}
          selectedCategories={categories}
          onCategoriesChange={(next) => {
            setCategories(next);
            if (!next.includes("management")) setKeys([]);
          }}
          sectionDataAttr="inbox-compose-category"
          personGroups={[{ label: "Manager", options: [{ value: MANAGER_PERSON.key, label: MANAGER_PERSON.label }] }]}
          selectedKeys={keys}
          onPeopleChange={setKeys}
          peopleDisabled={categories.length === 0}
          peopleEmptyMenuText={categories.length === 0 ? "Pick a section first" : "No contacts in selected sections"}
        />
        <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
          <PortalMessageSubjectField value={subject} onChange={setSubject} />
          <PortalMessageSendViaDropdown selected={sendVia} onChange={setSendVia} emailAvailable smsAvailable={false} dataAttr="inbox-compose-send-via" />
        </div>
        <PortalMessageBodyField value={body} onChange={setBody} minHeightClass="min-h-[7rem]" />
        <PortalMessageScheduleFields scheduleLater={scheduleLater} onScheduleLaterChange={setScheduleLater} sendAt={sendAt} onSendAtChange={setSendAt} />
      </PortalMessageComposeModalBody>
    </DemoDialog>
  );
}

/* ───────────────────────────── Services: Submit bid / Request payment ───────────────────────────── */

export type DemoQuoteJob = { id: string; title: string; place: string };
type QuoteDoor = "quote" | "invoice";

const LINKED_MANAGERS = [
  { value: "mgr-seattle", label: "Seattle Homes" },
  { value: "mgr-alder", label: "Alder Property Co" },
];

/** `VendorQuoteWizard`: Submit bid (Service, House, When, Bid, Review) or Request payment (Service, Invoice, Review). */
export function DemoVendorQuoteWizard({
  door,
  jobs,
  initialJobId,
  onClose,
  onDone,
}: {
  door: QuoteDoor;
  jobs: DemoQuoteJob[];
  initialJobId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [jobId, setJobId] = useState(initialJobId ?? jobs[0]?.id ?? "");
  const [when, setWhen] = useState("2025-10-02T09:00");
  const [labor, setLabor] = useState(door === "invoice" ? "185.00" : "180.00");
  const [materials, setMaterials] = useState("40.00");
  const [note, setNote] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("INV-1017");
  const [managerId, setManagerId] = useState(LINKED_MANAGERS[0]!.value);
  const job = jobs.find((row) => row.id === jobId) ?? null;
  const steps = useMemo(
    () =>
      door === "invoice"
        ? [
            { id: "job", label: "Service", attention: job ? 0 : 1 },
            { id: "quote", label: "Invoice", attention: labor.trim() ? 0 : 1 },
            { id: "review", label: "Review" },
          ]
        : [
            { id: "job", label: "Service", attention: job ? 0 : 1 },
            { id: "house", label: "House", attention: job ? 0 : 1 },
            { id: "when", label: "When", attention: when.trim() ? 0 : 1 },
            { id: "quote", label: "Bid", attention: labor.trim() ? 0 : 1 },
            { id: "review", label: "Review" },
          ],
    [door, job, labor, when],
  );
  const whenLabel = when ? new Date(when).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not set";
  const title = door === "invoice" ? "Request payment" : "Submit bid";
  const jobOptions = jobs.map((row) => ({ value: row.id, label: `${row.title} · ${row.place}` }));

  return (
    <DemoWorkspacePopup
      title={title}
      steps={steps}
      step={step}
      onStep={setStep}
      saveState="Not saved yet"
      sidePanel={
        <PreviewPanel
          title="Service preview"
          name={job?.title ?? "No service yet"}
          sub={job ? job.place : door === "invoice" ? "No house" : "Pick a service"}
          facts={[
            { label: "House", value: job ? job.place : "Not set", warn: door !== "invoice" && !job },
            ...(door === "invoice" ? [] : [{ label: "When", value: whenLabel, warn: !when }]),
            { label: door === "invoice" ? "Invoice" : "Bid", value: labor.trim() ? `$${labor}` : "Not set", warn: !labor.trim() },
          ]}
          creates={[{ tone: job ? "yes" : "warn", text: door === "invoice" ? "An invoice for the manager" : "A bid the manager can approve" }]}
        />
      }
      footer={{ kind: "wizard", lastLabel: title, onFinish: onDone }}
      onClose={onClose}
      dataAttr={`vendor-quote-wizard-${door}`}
    >
      {(index) => {
        const id = steps[index]?.id;
        if (id === "job") {
          return (
            <WizardSection title="The service">
              <WizardSelect label="Service" value={jobId} onChange={setJobId} options={jobOptions} dataAttr="vendor-quote-job" />
            </WizardSection>
          );
        }
        if (id === "house") {
          return (
            <WizardSection title="House">
              <p className="text-sm font-semibold text-foreground">{job ? job.place : "Pick a service first"}</p>
            </WizardSection>
          );
        }
        if (id === "when") {
          return (
            <WizardSection title="When">
              <label className={WIZARD_LABEL_CLASS} htmlFor="vendor-quote-when">Date and time</label>
              <Input id="vendor-quote-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} data-attr="vendor-quote-when" />
            </WizardSection>
          );
        }
        if (id === "quote") {
          return (
            <WizardSection title={door === "invoice" ? "Invoice" : "Bid"}>
              {door === "invoice" ? (
                <>
                  <label className={WIZARD_LABEL_CLASS} htmlFor="vendor-invoice-number">Invoice number</label>
                  <Input id="vendor-invoice-number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} data-attr="vendor-invoice-number" />
                  <div className="mt-3">
                    <WizardSelect label="Bill to" value={managerId} onChange={setManagerId} options={LINKED_MANAGERS} dataAttr="vendor-invoice-manager" />
                  </div>
                </>
              ) : null}
              <label className={cn(WIZARD_LABEL_CLASS, door === "invoice" && "mt-3")} htmlFor="vendor-quote-labor">{door === "invoice" ? "Amount" : "Labor"}</label>
              <Input id="vendor-quote-labor" inputMode="decimal" value={labor} onChange={(e) => setLabor(e.target.value)} data-attr="vendor-quote-labor" />
              {door === "quote" ? (
                <>
                  <label className={cn(WIZARD_LABEL_CLASS, "mt-3")} htmlFor="vendor-quote-materials">Materials</label>
                  <Input id="vendor-quote-materials" inputMode="decimal" value={materials} onChange={(e) => setMaterials(e.target.value)} data-attr="vendor-quote-materials" />
                </>
              ) : null}
              <label className={cn(WIZARD_LABEL_CLASS, "mt-3")} htmlFor="vendor-quote-note">Note</label>
              <Textarea id="vendor-quote-note" value={note} onChange={(e) => setNote(e.target.value)} data-attr="vendor-quote-note" />
            </WizardSection>
          );
        }
        return (
          <div>
            <ReviewCard
              title="Service"
              status={job ? "complete" : "incomplete"}
              onEdit={() => setStep(0)}
              facts={[
                { label: "Title", value: job?.title ?? "Not set" },
                { label: "House", value: job ? job.place : "Not set" },
                ...(door === "invoice" ? [{ label: "Bill to", value: LINKED_MANAGERS.find((m) => m.value === managerId)?.label ?? "Not set" }] : []),
              ]}
            />
            {door === "quote" ? (
              <ReviewCard title="When" status={when ? "complete" : "incomplete"} onEdit={() => setStep(2)} facts={[{ label: "Visit", value: whenLabel }]} />
            ) : null}
            <ReviewCard
              title={door === "invoice" ? "Invoice" : "Bid"}
              status={labor.trim() ? "complete" : "incomplete"}
              onEdit={() => setStep(door === "invoice" ? 1 : 3)}
              facts={[
                { label: door === "invoice" ? "Amount" : "Labor", value: labor.trim() ? `$${labor}` : "Not set" },
                ...(door === "quote" ? [{ label: "Materials", value: materials.trim() ? `$${materials}` : "None" }] : []),
              ]}
            />
          </div>
        );
      }}
    </DemoWorkspacePopup>
  );
}

/* ───────────────────────────── Calendar ───────────────────────────── */

type WeeklyWindow = DemoAvailabilityWindow & { id: string };

function WindowChip({ window, onCommit, onRemove }: { window: WeeklyWindow; onCommit: (start: number, end: number) => void; onRemove: () => void }) {
  const [start, setStart] = useState(minuteOfDayToTimeInputValue(window.startMinute));
  const [end, setEnd] = useState(minuteOfDayToTimeInputValue(window.endMinute));
  const commit = () => {
    const s = timeInputValueToMinuteOfDay(start);
    const e = timeInputValueToMinuteOfDay(end);
    if (s === null || e === null || s >= e) {
      setStart(minuteOfDayToTimeInputValue(window.startMinute));
      setEnd(minuteOfDayToTimeInputValue(window.endMinute));
      return;
    }
    onCommit(s, e);
  };
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-1 py-0.5" data-attr="vendor-availability-window">
      <input type="time" value={start} onChange={(e) => setStart(e.target.value)} onBlur={commit} aria-label="Start" className="w-[96px] border-0 bg-transparent text-[13px] outline-none" />
      <span className="text-muted">{"–"}</span>
      <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={commit} aria-label="End" className="w-[96px] border-0 bg-transparent text-[13px] outline-none" />
      <button type="button" aria-label={`Remove ${formatMinuteOfDayLabel(window.startMinute)}–${formatMinuteOfDayLabel(window.endMinute)}`} title="Remove window" onClick={onRemove} className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:text-danger">
        <X className="size-3.5" strokeWidth={2} aria-hidden />
      </button>
    </span>
  );
}

/** `VendorAvailabilityEditor dialog`: Weekly hours (per-day switch, Flexible, time windows) and Date overrides, footer Save. */
export function DemoVendorAvailabilityDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [windows, setWindows] = useState<WeeklyWindow[]>(() => DEMO_WEEKLY_WINDOWS.map((w, i) => ({ ...w, id: `w-${i}` })));
  const [flexible, setFlexible] = useState<number[]>([]);
  const [overrides, setOverrides] = useState(DEMO_DATE_OVERRIDES);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ date: "2025-10-04", type: "open", allDay: true, start: "09:00", end: "17:00", note: "" });
  const [counter, setCounter] = useState(100);
  const dayWindows = (weekday: number) => windows.filter((w) => w.weekday === weekday).sort((a, b) => a.startMinute - b.startMinute);
  const nextId = () => {
    setCounter((c) => c + 1);
    return `w-${counter}`;
  };
  const toggleDay = (weekday: number) => {
    const enabled = flexible.includes(weekday) || dayWindows(weekday).length > 0;
    if (enabled) {
      setWindows((cur) => cur.filter((w) => w.weekday !== weekday));
      setFlexible((cur) => cur.filter((d) => d !== weekday));
    } else {
      setWindows((cur) => [...cur, { id: nextId(), weekday, startMinute: 9 * 60, endMinute: 10 * 60 }]);
    }
  };
  const addWindow = (weekday: number) => {
    const existing = dayWindows(weekday);
    const start = existing.length ? Math.min(22 * 60, existing[existing.length - 1]!.endMinute) : 9 * 60;
    setWindows((cur) => [...cur, { id: nextId(), weekday, startMinute: start, endMinute: Math.min(24 * 60, start + 60) }]);
  };
  const copyToEveryDay = (weekday: number) => {
    const source = dayWindows(weekday);
    setFlexible([]);
    setWindows(WEEKDAY_DISPLAY_ORDER.flatMap((day) => source.map((w, i) => ({ id: `copy-${day}-${i}`, weekday: day, startMinute: w.startMinute, endMinute: w.endMinute }))));
  };

  return (
    <DemoDialog title="Set availability" onClose={onClose} size="standard" primary={adding ? null : { label: "Save", onClick: onSaved, dataAttr: "vendor-availability-save" }} dataAttr="vendor-calendar-availability-dialog">
      <div className="mx-auto max-w-2xl space-y-4" data-attr="vw-avail">
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="border-b border-border bg-accent/20 px-3.5 py-2.5">
            <span className="text-[13px] font-bold">Weekly hours</span>
          </div>
          {WEEKDAY_DISPLAY_ORDER.map((weekday) => {
            const list = dayWindows(weekday);
            const isFlexible = flexible.includes(weekday);
            const enabled = isFlexible || list.length > 0;
            const label = WEEKDAY_LABELS[weekday]!;
            return (
              <div key={weekday} className="grid grid-cols-[86px_1fr_auto] items-center gap-2.5 border-t border-border/60 px-3 py-2.5 first:border-t-0 max-sm:grid-cols-1 max-sm:items-start">
                <div className="flex items-center gap-2.5">
                  <button type="button" role="switch" aria-checked={enabled} aria-label={`${label} availability`} onClick={() => toggleDay(weekday)} className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition ${enabled ? "bg-primary" : "bg-accent"}`}>
                    <span className={`inline-block size-4.5 transform rounded-full bg-card shadow transition ${enabled ? "translate-x-5" : "translate-x-1"}`} />
                  </button>
                  <span className="w-8 text-[12.5px] font-bold uppercase tracking-wide text-foreground">{label}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (isFlexible) setFlexible((cur) => cur.filter((d) => d !== weekday));
                      else {
                        setWindows((cur) => cur.filter((w) => w.weekday !== weekday));
                        setFlexible((cur) => [...cur, weekday]);
                      }
                    }}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 transition ${isFlexible ? "bg-primary/10 text-primary ring-primary/30" : "bg-accent/30 text-muted ring-border hover:text-foreground"}`}
                  >
                    Flexible
                  </button>
                  {isFlexible ? (
                    <span className="text-xs font-medium text-primary">Any time</span>
                  ) : !enabled ? (
                    <span className="text-xs text-muted">Unavailable</span>
                  ) : (
                    <>
                      {list.map((w) => (
                        <WindowChip key={w.id} window={w} onCommit={(s, e) => setWindows((cur) => cur.map((x) => (x.id === w.id ? { ...x, startMinute: s, endMinute: e } : x)))} onRemove={() => setWindows((cur) => cur.filter((x) => x.id !== w.id))} />
                      ))}
                      <button type="button" onClick={() => addWindow(weekday)} className="inline-flex items-center gap-1 rounded-lg border border-dashed border-border px-2 py-1 text-[12px] font-semibold text-primary hover:bg-primary/5">
                        <Plus className="size-3.5" strokeWidth={2} aria-hidden />
                        Add window
                      </button>
                    </>
                  )}
                </div>
                {enabled && !isFlexible ? (
                  <button type="button" title="Copy to every day" aria-label={`Copy ${label} to every day`} onClick={() => copyToEveryDay(weekday)} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-accent/40 hover:text-foreground">
                    <Copy className="size-4" strokeWidth={1.8} aria-hidden />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border bg-accent/20 px-3.5 py-2.5">
            <span className="text-[13px] font-bold">Date overrides</span>
            <button type="button" onClick={() => setAdding((v) => !v)} className="h-8 rounded-full border border-[var(--input)] bg-card px-3 text-xs font-semibold text-foreground">
              {adding ? "Cancel" : "+ Add date"}
            </button>
          </div>
          {adding ? (
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-border/60 p-3.5">
              <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                Date
                <Input type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} className="h-9 w-[160px] rounded-md text-sm" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                Type
                <Select value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))} className="h-9 min-w-[150px] rounded-md text-sm">
                  <option value="open">Open extra time</option>
                  <option value="block">Block time off</option>
                </Select>
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-xs font-medium text-muted">
                <input type="checkbox" checked={draft.allDay} onChange={(e) => setDraft((d) => ({ ...d, allDay: e.target.checked }))} className="h-4 w-4 rounded border-border" />
                All day
              </label>
              {!draft.allDay ? (
                <>
                  <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                    Start
                    <Input type="time" value={draft.start} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} className="h-9 w-[120px] rounded-md text-sm" />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                    End
                    <Input type="time" value={draft.end} onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} className="h-9 w-[120px] rounded-md text-sm" />
                  </label>
                </>
              ) : null}
              <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-[11px] font-medium text-muted">
                Note (optional)
                <Input type="text" placeholder="e.g. Saturday availability" value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} className="h-9 rounded-md text-sm" />
              </label>
              <button
                type="button"
                onClick={() => {
                  const s = timeInputValueToMinuteOfDay(draft.start) ?? 0;
                  const e = timeInputValueToMinuteOfDay(draft.end) ?? 1440;
                  setOverrides((cur) => [...cur, { id: `ovr-${cur.length + 1}`, date: draft.date, allDay: draft.allDay, startMinute: draft.allDay ? 0 : s, endMinute: draft.allDay ? 1440 : e, kind: draft.type === "block" ? "block" : "open", note: draft.note }]);
                  setAdding(false);
                }}
                className="h-9 rounded-full bg-primary px-4 text-sm font-semibold text-white"
              >
                Save
              </button>
            </div>
          ) : null}
          {overrides.length === 0 ? (
            <p className="px-3.5 py-4 text-center text-xs text-muted">No specific dates added</p>
          ) : (
            overrides
              .slice()
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-2 border-t border-border/60 px-3.5 py-2.5 first:border-t-0" data-attr="vendor-availability-override-row">
                  <div>
                    <p className="text-[13.5px] font-semibold text-foreground">
                      {new Date(`${o.date}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      {" · "}
                      {o.startMinute === 0 && o.endMinute === 1440 ? "All day" : `${formatMinuteOfDayLabel(o.startMinute)}–${formatMinuteOfDayLabel(o.endMinute)}`}
                      {" · "}
                      <span className={o.kind === "block" ? "text-danger" : "text-primary"}>{o.kind === "block" ? "Blocked" : "Open"}</span>
                    </p>
                    {o.note ? <p className="mt-0.5 text-xs text-muted">{o.note}</p> : null}
                  </div>
                  <button type="button" aria-label={`Remove ${o.date}`} title="Remove" onClick={() => setOverrides((cur) => cur.filter((x) => x.id !== o.id))} className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger">
                    <X className="size-4" strokeWidth={1.8} aria-hidden />
                  </button>
                </div>
              ))
          )}
        </div>
      </div>
    </DemoDialog>
  );
}

/** The calendar's quick-look `PortalDialog`: title = the visit, an Open link and a message icon, fact rows, no footer. */
export function DemoVendorVisitDialog({ title, rows, onClose, onOpen, onMessage }: { title: string; rows: { label: string; value: string }[]; onClose: () => void; onOpen: () => void; onMessage: () => void }) {
  return (
    <DemoDialog
      title={title}
      onClose={onClose}
      size="compact"
      headerAction={
        <>
          <PortalIconAction icon={ExternalLink} label="Open" data-attr="calendar-event-open-record" onClick={onOpen} />
          <PortalIconAction icon={Mail} label="Message the manager" data-attr="tour-open-message-thread" onClick={onMessage} />
        </>
      }
      dataAttr="calendar-event-detail-modal"
    >
      <ConfirmRows rows={rows} />
    </DemoDialog>
  );
}

/* ───────────────────────────── Reviews ───────────────────────────── */

/** `ReviewReplyDialog`: the review for context, "Your reply" with a Quick replies toggle, footer Save reply. */
export function DemoVendorReplyDialog({ stars, body, reply, openQuickReplies, onClose, onSaved }: { stars: number; body: string; reply?: string; openQuickReplies: boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const editing = Boolean(reply);
  const [text, setText] = useState(reply ?? "");
  const [showReplies, setShowReplies] = useState(openQuickReplies);
  const quick = useMemo(() => starterVendorQuickReplies(), []);
  return (
    <DemoDialog title={editing ? "Edit reply" : "Reply to review"} onClose={onClose} primary={{ label: "Save reply", onClick: () => onSaved(text), disabled: !text.trim(), dataAttr: "vendor-review-reply-save" }} dataAttr="vendor-review-reply-dialog">
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-muted/10 px-3.5 py-3" data-attr="vendor-review-reply-context">
          <VendorReviewStarDisplay stars={stars} size="md" />
          {body ? <p className="mt-1.5 text-sm text-foreground">{body}</p> : null}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="vendor-review-reply-input" className={MODAL_FIELD_LABEL_CLASS}>Your reply</label>
            <PortalIconAction icon={Zap} label="Quick replies" active={showReplies} data-attr="vendor-review-quick-replies" onClick={() => setShowReplies((v) => !v)} />
          </div>
          {showReplies ? (
            <div className="overflow-hidden rounded-xl border border-border bg-card" data-attr="vendor-review-quick-replies-list">
              <ul>
                {quick.map((r) => (
                  <li key={r.id} className="border-b border-border last:border-0">
                    <button
                      type="button"
                      onClick={() => {
                        setText((draft) => (draft.trim() ? `${draft.replace(/\s+$/, "")}\n${r.text}` : r.text));
                        setShowReplies(false);
                      }}
                      className="block min-h-11 w-full px-3 py-2.5 text-left text-[13.5px] font-medium transition hover:bg-accent/60"
                    >
                      {r.text}
                    </button>
                  </li>
                ))}
              </ul>
              <span className="block min-h-11 border-t border-border px-3 py-2.5 text-[13.5px] font-semibold text-primary">Manage quick replies</span>
            </div>
          ) : null}
          <Textarea id="vendor-review-reply-input" rows={4} value={text} onChange={(e) => setText(e.target.value.slice(0, 1000))} data-attr="vendor-review-reply-input" />
        </div>
      </div>
    </DemoDialog>
  );
}

/* ───────────────────────────── Finances ───────────────────────────── */

/** `PayoutWithdrawSheet` for a vendor: Amount, Available (max), To, Standard · free / Instant, footer "Withdraw $X". */
export function DemoVendorWithdrawDialog({ initialAmountCents, onClose, onDone }: { initialAmountCents?: number; onClose: () => void; onDone: () => void }) {
  const [amountInput, setAmountInput] = useState(((initialAmountCents ?? DEMO_AVAILABLE_CENTS) / 100).toFixed(2));
  const [method, setMethod] = useState<"standard" | "instant">("standard");
  const accountLabel = `${DEMO_BANK.label} ····${DEMO_BANK.last4}`;
  const amountCents = parseDollars(amountInput);
  const feeCents = method === "instant" ? vendorInstantWithdrawFeeQuoteCents(amountCents) : 0;
  const netCents = Math.max(amountCents - feeCents, 0);
  const overBalance = amountCents > DEMO_AVAILABLE_CENTS;
  const belowMinimum = amountCents > 0 && amountCents < 100;
  const instantBlocked = method === "instant" && amountCents > DEMO_INSTANT_AVAILABLE_CENTS;
  const disabled = amountCents <= 0 || overBalance || belowMinimum || instantBlocked;
  return (
    <DemoDialog
      title="Withdraw"
      onClose={onClose}
      context={<PopupRecordPreview rows={[{ label: "Available", value: usd(DEMO_AVAILABLE_CENTS) }, { label: "To", value: accountLabel }]} />}
      previewLabel="Withdrawal preview"
      preview={
        <PreviewPanel
          title="Withdrawal"
          name={usd(amountCents)}
          sub={accountLabel}
          facts={[
            { label: "Amount", value: amountCents > 0 ? usd(amountCents) : "Not set" },
            { label: "Speed", value: method === "instant" ? "Instant" : "Standard" },
            { label: "Arrives", value: method === "instant" ? "Within 30 minutes" : "1–2 business days" },
            { label: method === "instant" ? "Bank receives" : "Fee", value: method === "instant" ? usd(netCents) : "Free" },
          ]}
          creates={[{ tone: overBalance || belowMinimum ? "warn" : "yes", text: overBalance ? "Amount is more than is available" : belowMinimum ? "Withdrawals start at $1.00" : "Sent to your payout account" }]}
        />
      }
      primary={{ label: `Withdraw ${usd(amountCents)}`, onClick: onDone, disabled, dataAttr: "withdraw-confirm" }}
      dataAttr="vendor-withdraw-dialog"
    >
      <div className="space-y-4">
        <label className="block text-sm font-medium">
          Amount
          <Input inputMode="decimal" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} aria-label="Amount" data-attr="withdraw-amount-input" className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2" />
        </label>
        <div className="flex justify-between text-sm">
          <span>Available</span>
          <button type="button" onClick={() => setAmountInput((DEMO_AVAILABLE_CENTS / 100).toFixed(2))} aria-label="Max" data-attr="withdraw-max" className="text-primary">{usd(DEMO_AVAILABLE_CENTS)}</button>
        </div>
        <FieldSingleSelect label="To" value={DEMO_BANK.id} onChange={() => undefined} options={[{ value: DEMO_BANK.id, label: accountLabel }]} />
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="withdraw-speed" checked={method === "standard"} onChange={() => setMethod("standard")} />
          Standard {"·"} free
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="withdraw-speed" checked={method === "instant"} onChange={() => setMethod("instant")} />
          Instant {"·"} {VENDOR_INSTANT_WITHDRAW_FEE_LABEL}
        </label>
        <div className="flex justify-between text-sm"><span>Arrives</span><span>{method === "instant" ? "Within 30 minutes" : "1–2 business days"}</span></div>
        {method === "instant" ? (
          <>
            <div className="flex justify-between text-sm"><span>Fee</span><span>{usd(feeCents)}</span></div>
            <div className="flex justify-between text-sm"><span>Bank receives</span><span>{usd(netCents)}</span></div>
          </>
        ) : null}
        {overBalance ? <p role="alert" className="text-sm text-danger">Amount exceeds available balance.</p> : null}
        {belowMinimum ? <p role="alert" className="text-sm text-danger">Enter at least $1.00.</p> : null}
      </div>
    </DemoDialog>
  );
}

function BankModeRow({ id, active, onSelect, title, icon }: { id: "manual" | "card"; active: boolean; onSelect: (id: "manual" | "card") => void; title: string; icon: ReactNode }) {
  return (
    <button type="button" onClick={() => onSelect(id)} aria-pressed={active} data-attr={`bank-mode-${id}`} className={cn("flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm font-medium", active ? "border-primary bg-primary/[0.06] text-foreground" : "border-border bg-card text-foreground")}>
      {icon}
      {title}
    </button>
  );
}

/** `AddBankFlow` > `PayoutBankSheet`: "Add a bank account", routing and account number or a debit card, footer "Add account". */
export function DemoVendorAddBankDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"manual" | "card">("manual");
  const [holder, setHolder] = useState("Pacific Plumbing LLC");
  const [routing, setRouting] = useState("110000000");
  const [account, setAccount] = useState("000123456789");
  const [type, setType] = useState("checking");
  return (
    <DemoDialog title="Add a bank account" size="compact" assistant={false} onClose={onClose} primary={{ label: "Add account", onClick: onDone, dataAttr: "bank-sheet-submit" }} dataAttr="add-bank-flow">
      <div className="space-y-2">
        <BankModeRow id="manual" active={mode === "manual"} onSelect={setMode} title="Enter routing and account number" icon={<Landmark className="size-4" aria-hidden />} />
        <BankModeRow id="card" active={mode === "card"} onSelect={setMode} title="Debit card for instant payouts" icon={<CreditCard className="size-4" aria-hidden />} />
      </div>
      {mode === "manual" ? (
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted" htmlFor="bank-holder-name">Account holder</label>
            <input id="bank-holder-name" value={holder} onChange={(e) => setHolder(e.target.value)} className={NATIVE_FIELD} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted" htmlFor="bank-routing">Routing number</label>
            <input id="bank-routing" inputMode="numeric" value={routing} onChange={(e) => setRouting(e.target.value.replace(/[^0-9]/g, ""))} className={NATIVE_FIELD} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted" htmlFor="bank-account-number">Account number</label>
            <input id="bank-account-number" inputMode="numeric" value={account} onChange={(e) => setAccount(e.target.value.replace(/[^0-9]/g, ""))} className={NATIVE_FIELD} />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">Type</p>
            <FieldSingleSelect label="Account type" hideLabel value={type} onChange={setType} options={[{ value: "checking", label: "Checking" }, { value: "savings", label: "Savings" }]} dataAttr="bank-account-type" />
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted">Debit card</label>
          <div className="rounded-xl border border-border bg-card px-3 py-3 text-sm text-muted" data-attr="bank-card-element">Card number {"·"} MM / YY {"·"} CVC</div>
        </div>
      )}
    </DemoDialog>
  );
}

/** `VendorRefundModal`: Payment, Amount, Reason, the breakdown, footer "Refund $X". */
export function DemoVendorRefundDialog({ initialPaymentId, onClose, onDone }: { initialPaymentId?: string; onClose: () => void; onDone: () => void }) {
  const [paymentId, setPaymentId] = useState(initialPaymentId ?? DEMO_REFUNDABLE[0]!.id);
  const payment = DEMO_REFUNDABLE.find((p) => p.id === paymentId) ?? DEMO_REFUNDABLE[0]!;
  const maxGross = payment.amountCents - payment.refundedGrossCents;
  const [amountInput, setAmountInput] = useState((maxGross / 100).toFixed(2));
  const [reason, setReason] = useState<string>(VENDOR_REFUND_REASONS[0]);
  const requested = Math.round((Number(amountInput) || 0) * 100);
  const gross = Math.max(0, Math.min(requested, maxGross));
  const over = requested > maxGross;
  const feeShare = refundFeeShareCents(payment, gross);
  const netDebit = refundNetDebitCents(payment, gross);
  return (
    <DemoDialog
      title="Refund a payment"
      onClose={onClose}
      primary={{ label: gross > 0 ? `Refund ${usd(gross)}` : "Refund", onClick: onDone, disabled: gross <= 0 || over, dataAttr: "vendor-refund-submit" }}
      dataAttr="vendor-refund-modal"
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Payment</span>
          {initialPaymentId ? (
            <span className="text-sm text-foreground" data-attr="vendor-refund-payment">{payment.label}</span>
          ) : (
            <Select value={paymentId} onChange={(e) => { const next = DEMO_REFUNDABLE.find((p) => p.id === e.target.value); setPaymentId(e.target.value); if (next) setAmountInput(((next.amountCents - next.refundedGrossCents) / 100).toFixed(2)); }} data-attr="vendor-refund-payment-select">
              {DEMO_REFUNDABLE.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </Select>
          )}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Amount</span>
          <Input type="number" min={0} step="0.01" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} data-attr="vendor-refund-amount" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Reason</span>
          <Select value={reason} onChange={(e) => setReason(e.target.value)} data-attr="vendor-refund-reason">
            {VENDOR_REFUND_REASONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </Select>
        </label>
        {gross > 0 ? (
          <div className="rounded-lg border border-border bg-accent/30 p-3 text-sm" data-attr="vendor-refund-preview">
            <div className="flex justify-between py-0.5"><span className="text-muted">Manager gets back</span><span className="font-medium text-foreground">{usd(gross)}</span></div>
            {feeShare > 0 ? <div className="flex justify-between py-0.5"><span className="text-muted">{PROPLANE_SERVICE_FEE_LABEL} returned to you</span><span className="font-medium text-foreground">{usd(feeShare)}</span></div> : null}
            <div className="flex justify-between py-0.5"><span className="text-muted">From your balance</span><span className="font-semibold text-foreground">{usd(netDebit)}</span></div>
          </div>
        ) : null}
        {over ? <p className="text-sm text-[var(--status-overdue-fg)]" role="alert">Amount is more than can be refunded.</p> : null}
      </div>
    </DemoDialog>
  );
}

/** `VendorStatementModal`: a browse dialog titled with the month, opening and closing balance, PDF and CSV icons, the ledger table. */
export function DemoVendorStatementDialog({ month, onClose }: { month: string; onClose: () => void }) {
  const statement = DEMO_STATEMENTS.find((s) => s.month === month) ?? DEMO_STATEMENTS[0]!;
  const lines = statement.lines.reduce<{ line: (typeof statement.lines)[number]; balance: number }[]>((acc, line) => {
    const previous = acc.length ? acc[acc.length - 1]!.balance : statement.openingCents;
    return [...acc, { line, balance: previous + line.amountCents }];
  }, []);
  return (
    <DemoDialog title={statementMonthLabel(statement.month)} onClose={onClose} primary={null} dataAttr="vendor-statement-modal">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-6 text-sm">
          <span>Opening <b data-attr="vendor-statement-opening">{signedUsd(statement.openingCents)}</b></span>
          <span>Closing <b data-attr="vendor-statement-closing">{signedUsd(statementClosingCents(statement))}</b></span>
        </div>
        <div className="flex items-center gap-3">
          <PortalIconAction icon={FileText} label="Download PDF" data-attr="vendor-statement-pdf" />
          <PortalIconAction icon={Download} label="Export CSV" data-attr="vendor-statement-export" />
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-[0.06em] text-muted">
              <th className="py-2 pr-3">Date</th>
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Description</th>
              <th className="py-2 pr-3 text-right">Amount</th>
              <th className="py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {lines
              .slice()
              .reverse()
              .map(({ line, balance }) => (
                <tr key={line.id} className="border-b border-border/60" data-attr="vendor-statement-row">
                  <td className="py-2 pr-3 text-muted">{line.date}</td>
                  <td className="py-2 pr-3 text-foreground">{line.type}</td>
                  <td className="py-2 pr-3 text-foreground">{line.description}</td>
                  <td className={`py-2 pr-3 text-right font-medium ${line.amountCents < 0 ? "text-muted" : "text-foreground"}`}>{signedUsd(line.amountCents)}</td>
                  <td className="py-2 text-right font-semibold text-foreground">{signedUsd(balance)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </DemoDialog>
  );
}

type W9Draft = Omit<typeof DEMO_W9, "tinType"> & { tinType: "ein" | "ssn"; tin: string; attested: boolean };

/** `W9Dialog`: legal name, entity type, tax id (only ever masked), address, certification, footer "Submit W-9". */
export function DemoVendorW9Dialog({ hasW9, onClose, onDone }: { hasW9: boolean; onClose: () => void; onDone: () => void }) {
  const [draft, setDraft] = useState<W9Draft>({ ...DEMO_W9, tin: "", attested: false });
  const set = (patch: Partial<W9Draft>) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <DemoDialog title="W-9" onClose={onClose} primary={{ label: "Submit W-9", onClick: onDone, disabled: !draft.attested, dataAttr: "vendor-tax-submit" }} dataAttr="vendor-tax-dialog">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Legal name
          <Input value={draft.legalName} onChange={(e) => set({ legalName: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Business name (optional)
          <Input value={draft.businessName} onChange={(e) => set({ businessName: e.target.value })} />
        </label>
        <FieldSingleSelect label="Entity type" value={draft.entityType} onChange={(entityType) => set({ entityType })} options={VENDOR_W9_ENTITY_TYPES.map((entry) => ({ value: entry.value, label: entry.label }))} />
        <FieldSingleSelect label="Tax ID type" value={draft.tinType} onChange={(tinType) => set({ tinType: tinType === "ssn" ? "ssn" : "ein" })} options={[{ value: "ein", label: "EIN" }, { value: "ssn", label: "SSN" }]} />
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          {draft.tinType === "ein" ? "EIN" : "SSN"}
          <Input value={draft.tin} onChange={(e) => set({ tin: e.target.value })} inputMode="numeric" autoComplete="off" placeholder={hasW9 ? maskTin(draft.tinType, DEMO_W9.tinLast4) : undefined} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Address line 1
          <Input value={draft.addressLine1} onChange={(e) => set({ addressLine1: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Address line 2
          <Input value={draft.addressLine2} onChange={(e) => set({ addressLine2: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          City
          <Input value={draft.city} onChange={(e) => set({ city: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          State
          <Input value={draft.state} onChange={(e) => set({ state: e.target.value })} maxLength={2} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          ZIP
          <Input value={draft.zip} onChange={(e) => set({ zip: e.target.value })} />
        </label>
        <label className="flex items-start gap-2 text-sm text-foreground sm:col-span-2">
          <input type="checkbox" checked={draft.attested} onChange={(e) => set({ attested: e.target.checked })} data-attr="vendor-tax-attest" />
          Under penalties of perjury, I certify that the tax ID shown is correct and that I am a U.S. person.
        </label>
      </div>
    </DemoDialog>
  );
}

/* ───────────────────────────── Documents: Upload document ───────────────────────────── */

/** `VendorUploadDocumentWorkspace`: Type, File, Review; the last step says "Upload". */
export function DemoVendorUploadDocumentPopup({ initialKind, onClose, onDone }: { initialKind?: VendorDocumentKind; onClose: () => void; onDone: (kind: VendorDocumentKind) => void }) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<VendorDocumentKind>(initialKind ?? "insurance");
  const [fileName, setFileName] = useState("certificate-of-insurance.pdf");
  const steps = [
    { id: "kind", label: "Type" },
    { id: "file", label: "File" },
    { id: "review", label: "Review" },
  ];
  return (
    <DemoWorkspacePopup
      title="Upload document"
      steps={steps}
      step={step}
      onStep={setStep}
      saveState="Not saved yet"
      sidePanel={
        <PreviewPanel
          title="Document"
          name={VENDOR_DOCUMENT_LABELS[kind]}
          sub={fileName || "Pick a PDF"}
          facts={[
            { label: "Type", value: VENDOR_DOCUMENT_LABELS[kind] },
            { label: "File", value: fileName || "Not set", warn: !fileName },
          ]}
          creates={[{ tone: fileName ? "yes" : "warn", text: "A compliance file managers can review" }]}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Upload", onFinish: () => onDone(kind) }}
      onClose={onClose}
      dataAttr="vendor-upload-document"
    >
      {(index) =>
        index === 0 ? (
          <WizardSection title="Type">
            <WizardSelect label="Document" value={kind} onChange={(value) => setKind(value as VendorDocumentKind)} options={VENDOR_DOCUMENT_KINDS.map((id) => ({ value: id, label: VENDOR_DOCUMENT_LABELS[id] }))} dataAttr="vendor-upload-document-kind" />
          </WizardSection>
        ) : index === 1 ? (
          <WizardSection title="File">
            <label className={WIZARD_LABEL_CLASS} htmlFor="vendor-upload-document-file">PDF</label>
            <Input id="vendor-upload-document-file" type="file" accept="application/pdf" onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")} data-attr="vendor-upload-document-file" />
            <p className="mt-3 text-sm font-semibold text-foreground">{fileName || "No file"}</p>
          </WizardSection>
        ) : (
          <WizardSection title="Review">
            <p className="text-sm font-semibold text-foreground">{VENDOR_DOCUMENT_LABELS[kind]}</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{fileName || "No file"}</p>
          </WizardSection>
        )
      }
    </DemoWorkspacePopup>
  );
}
