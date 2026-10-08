"use client";

/**
 * The pop-ups and record pages the manager Residents and Vendors tabs open, drawn for the home demo from fixture props.
 *
 *  RESIDENTS
 *  - Add resident / Edit resident (the round +, Edit): the REAL step components of `resident-wizard/`
 *    (`ContactStep`, `HomeStep`, `ApplicationStep`, `LeaseStep`, `PaymentsStep`, `DocumentsStep`, `ReviewStep`,
 *    `ResidentSidePanel`) fed a hand-built `derived`, inside the demo's workspace shell. The real
 *    `AddResidentWizard` reads the property store, drafts and the assistant, so it cannot mount.
 *  - A resident's record (row click): the real rail (`recordSections("manager","resident")`) and header icons per
 *    section, `ResidentOverviewPanel` on Overview, fact cards elsewhere.
 *  - Approve, Send setup, Remind to finish, Add charge, Add service, Add tour, Add document, Delete: small pop-ups
 *    that copy the real titles, steps, field labels and footer words.
 *
 *  VENDORS
 *  - Add vendor / Invite vendor / Edit vendor: the real step names, fields and footer words of `ManagerVendorFormModal`
 *    (its `TypicalPriceFields` and `ManagerVendorFormFields` are the real pieces).
 *  - A vendor's record and a PropLane vendor's record: the real rails and header icons.
 *
 * Nothing is sent or saved: every primary only closes and the panel toasts "(sample)". Loaded on demand.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import {
  DemoPopupLayer,
  DemoWorkspacePopup,
} from "@/components/marketing/site/product-mock/demo-popup";
import {
  DemoRecordPage,
  DemoRecordThread,
  RecordFactCard,
  RecordFactRow,
  type DemoRecordAction,
} from "@/components/marketing/site/product-mock/demo-record";
import { recordSections, type RecordSections } from "@/lib/portals/record-sections";
import { PanelSection, type StepRailItem } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  PreviewPanel,
  WizardField,
  WizardLockedField,
  WizardSelect,
  WizardSection,
  WizardRow,
} from "@/components/portal/add-workspace/parts";
import { WorkspaceFileCard, WorkspaceHeaderUploadPresent } from "@/components/portal/add-workspace/upload-action";
import { ContactStep, RESIDENT_FILE_ACCEPT, RESIDENT_STEP_FILE_CHIPS } from "@/components/portal/resident-wizard/step-contact";
import { HomeStep } from "@/components/portal/resident-wizard/step-home";
import { ApplicationStep } from "@/components/portal/resident-wizard/step-application";
import { LeaseStep } from "@/components/portal/resident-wizard/step-lease";
import { PaymentsStep } from "@/components/portal/resident-wizard/step-payments";
import { DocumentsStep } from "@/components/portal/resident-wizard/step-documents";
import { ReviewStep } from "@/components/portal/resident-wizard/step-review";
import { ResidentSidePanel } from "@/components/portal/resident-wizard/side-panel";
import type { ResidentWizardDerived } from "@/components/portal/resident-wizard/derived";
import {
  alsoCreates,
  currentResidentStepOffPath,
  emptyAddPersonForm,
  formatMoney,
  thingsToFinish,
  type AddPersonForm,
} from "@/components/portal/resident-wizard/state";
import {
  RESIDENT_LEASE_TERM_AIRBNB,
  RESIDENT_LEASE_TERM_CUSTOM,
  RESIDENT_LEASE_TERM_LONG,
  RESIDENT_LEASE_TERM_SHORT,
} from "@/lib/resident-manual-lease-terms";
import { ResidentOverviewPanel } from "@/components/portal/pro-resident-overview-panel";
import { PopupMessagePreview, PopupSubjectCard } from "@/components/portal/popup-live-preview";
import {
  PortalMessageBodyField,
  PortalMessageSendViaDropdown,
  PortalMessageSubjectField,
} from "@/components/portal/portal-message-compose-fields";
import { ManagerVendorFormFields, TypicalPriceFields, type ManagerVendorFormDraft } from "@/components/portal/pro-vendor-form-modal";
import { PortalInvitePaths, type PortalInvitePath } from "@/components/portal/portal-invite-paths";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import type { AddWorkspaceStep } from "@/components/portal/add-workspace";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import { AXIS_ID_LABEL } from "@/lib/pro-relationships";
import type { CatalogVendorFixture, ResidentFixtureRow } from "@/components/marketing/site/product-mock/fixtures";
import {
  DEMO_CHARGE_TYPES,
  DEMO_DOCUMENT_KINDS,
  DEMO_NEW_RESIDENT,
  DEMO_SERVICE_CATEGORIES,
  DEMO_WIZARD_PROPERTIES,
  demoCatalogContact,
  demoCatalogVendorRecord,
  demoResidentRecord,
  demoVendorRecord,
  demoWizardPricing,
  demoWizardRooms,
  type DemoFactCardData,
  type DemoVendor,
} from "@/components/marketing/site/product-mock/fixtures-popups-people";

const noop = () => undefined;
const cancelButtonClass = "min-h-[44px] rounded-full px-6 text-[13.5px] font-semibold text-muted hover:bg-foreground/5";

function CancelButton({ onClick, dataAttr }: { onClick: () => void; dataAttr: string }) {
  return (
    <button type="button" onClick={onClick} className={cancelButtonClass} data-attr={dataAttr}>
      Cancel
    </button>
  );
}

/* ─────────────────────────── A small centred dialog (the real Modal) ─────────────────────────── */

export function DemoDialogPopup({
  title,
  children,
  confirmLabel,
  tone = "default",
  onClose,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "default" | "danger";
  onClose: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <DemoPopupLayer label={title}>
      <div className="flex h-full w-full items-center justify-center p-3">
        <div className="w-full max-w-[440px] overflow-hidden rounded-2xl border border-border bg-card shadow-[0_30px_80px_-30px_rgba(15,23,42,0.5)]" data-attr="demo-dialog-popup">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <h2 className="text-[16px] font-bold tracking-tight text-foreground">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-muted hover:bg-foreground/5">
              <span aria-hidden>×</span>
            </button>
          </div>
          <div className="px-5 py-4 text-[14px] leading-relaxed text-foreground">{children}</div>
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <CancelButton onClick={onClose} dataAttr="demo-dialog-cancel" />
            <button
              type="button"
              onClick={onConfirm}
              data-demo-target="sheet-primary"
              data-attr="demo-dialog-confirm"
              className={
                tone === "danger"
                  ? "min-h-[44px] rounded-full bg-[var(--status-overdue-fg)] px-6 text-[13.5px] font-bold text-white lg:min-h-9"
                  : "min-h-[44px] rounded-full bg-primary px-6 text-[13.5px] font-bold text-white lg:min-h-9"
              }
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </DemoPopupLayer>
  );
}

/* ─────────────────────────── The message preview (Send setup, Remind, Invite, Remove) ─────────────────────────── */

export function DemoMessagePreviewPopup({
  title,
  recipient,
  phone,
  subject: initialSubject,
  body: initialBody,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  recipient: string;
  phone?: string;
  subject: string;
  body: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [via, setVia] = useState<string[]>(["email"]);
  const channel = [via.includes("email") && "Email", via.includes("sms") && "SMS"].filter(Boolean).join(" · ");
  return (
    <DemoWorkspacePopup
      title={title}
      steps={[{ id: "message", label: title }]}
      stepHeading=""
      saveState={null}
      sidePanel={
        <PanelSection title="Message preview">
          <PopupMessagePreview subject={subject} body={body} recipient={recipient} channel={channel} />
        </PanelSection>
      }
      footer={{ kind: "done", label: confirmLabel, onDone: onConfirm, left: <CancelButton onClick={onClose} dataAttr="demo-message-cancel" /> }}
      onClose={onClose}
      dataAttr="demo-message-preview-popup"
    >
      {() => (
        <div className="max-w-[560px] space-y-3">
          <WizardLockedField label="To" value={recipient} lockTip="The recipient is fixed" />
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <PortalMessageSubjectField value={subject} onChange={setSubject} dataAttr="portal-notification-subject" />
            <PortalMessageSendViaDropdown selected={via} onChange={setVia} emailAvailable smsAvailable={Boolean(phone)} dataAttr="portal-notification-send-via" />
          </div>
          <PortalMessageBodyField value={body} onChange={setBody} minHeightClass="min-h-[7rem]" dataAttr="portal-notification-body" />
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────── Approve application ─────────────────────────── */

export function DemoApproveResidentPopup({ row, onClose, onApproved }: { row: ResidentFixtureRow; onClose: () => void; onApproved: () => void }) {
  const record = useMemo(() => demoResidentRecord(row), [row]);
  const first = row.name.split(" ")[0] ?? row.name;
  return (
    <DemoWorkspacePopup
      title="Approve application"
      steps={[{ id: "approve", label: "Approve application" }]}
      stepHeading=""
      saveState={null}
      sidePanel={
        <PreviewPanel
          title="Applicant sees"
          name="Approved"
          sub={record.property}
          facts={[
            { label: "Room", value: record.unit || "Not assigned" },
            { label: "Rent", value: record.rent ? `${formatMoney(record.rent)} / month` : "Not set" },
            { label: "Message", value: "Email" },
          ]}
          creates={[
            { tone: "yes", text: "The applicant is told and a lease can be sent" },
            { tone: "no", text: "Nothing is charged yet" },
          ]}
        />
      }
      footer={{ kind: "done", label: "Approve", onDone: onApproved, left: <CancelButton onClick={onClose} dataAttr="approve-application-cancel" /> }}
      onClose={onClose}
      dataAttr="approve-application-dialog"
    >
      {() => (
        <div className="max-w-[560px] space-y-3">
          <PopupSubjectCard title={row.name} lines={[row.email, row.place]} />
          <dl className="divide-y divide-border rounded-xl border border-border bg-card px-4 text-sm">
            <ApproveLine label="Room">{record.unit || "Not assigned"}</ApproveLine>
            <ApproveLine label="Rent">{record.rent ? `${formatMoney(record.rent)} / month` : "Not set"}</ApproveLine>
            <ApproveLine label={`Email to ${first}`}>Welcome to {record.property}</ApproveLine>
          </dl>
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

function ApproveLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="font-bold text-foreground">{children}</dd>
    </div>
  );
}

/* ─────────────────────────── Small action pop-ups (Add charge, Add service, Add tour, Add document) ─────────────────────────── */

function ReviewList({ facts }: { facts: [string, string][] }) {
  return (
    <dl className="divide-y divide-border rounded-2xl border border-border bg-card px-5">
      {facts.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 py-4 text-sm">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 break-words text-right font-semibold">{value || "Not set"}</dd>
        </div>
      ))}
    </dl>
  );
}

export type DemoActionKind = "add-charge" | "add-service" | "add-tour" | "add-document";

export function DemoResidentActionPopup({ kind, row, onClose, onDone }: { kind: DemoActionKind; row: ResidentFixtureRow; onClose: () => void; onDone: () => void }) {
  const record = useMemo(() => demoResidentRecord(row), [row]);
  const [step, setStep] = useState(0);
  const [chargeType, setChargeType] = useState<string>(DEMO_CHARGE_TYPES[0]);
  const [chargeTitle, setChargeTitle] = useState("October rent");
  const [amount, setAmount] = useState(record.rent ? String(record.rent) : "");
  const [due, setDue] = useState("2025-10-01");
  const [status, setStatus] = useState("pending");
  const [serviceTitle, setServiceTitle] = useState("Kitchen faucet drip");
  const [category, setCategory] = useState<string>(DEMO_SERVICE_CATEGORIES[0]);
  const [priority, setPriority] = useState("normal");
  const [tourDate, setTourDate] = useState("2025-09-27");
  const [tourStart, setTourStart] = useState("14:00");
  const [tourFormat, setTourFormat] = useState("in_person");
  const [visitor, setVisitor] = useState(row.name);
  const [docKind, setDocKind] = useState<string>(DEMO_DOCUMENT_KINDS[0]);
  const [fileName, setFileName] = useState<string | null>(null);

  const finish = (title: string, lastLabel: string, steps: StepRailItem[], preview: ReactNode, body: (index: number) => ReactNode) => (
    <DemoWorkspacePopup
      title={title}
      subtitle={record.place}
      saveState="Not saved yet"
      steps={steps}
      stepHeading=""
      step={step}
      onStep={setStep}
      sidePanel={preview}
      footer={{ kind: "wizard", lastLabel, onFinish: onDone }}
      onClose={onClose}
      dataAttr={`demo-${kind}-popup`}
    >
      {body}
    </DemoWorkspacePopup>
  );

  if (kind === "add-charge") {
    const amountLabel = amount ? formatMoney(Number(amount) || 0) : "";
    return finish(
      "Add charge",
      "Add charge",
      [
        { id: "who", label: "Who", summary: `${row.name} · ${record.property}` },
        { id: "amount", label: "Amount", summary: amountLabel ? `${chargeType} · ${amountLabel}` : "Amount" },
        { id: "review", label: "Review", summary: "Ready" },
      ],
      <PreviewPanel
        title="Charge"
        name={chargeTitle || "New charge"}
        sub={row.name}
        facts={[
          { label: "Resident", value: row.name },
          { label: "Type", value: chargeType },
          { label: "Amount", value: amountLabel || "Not set", warn: !amountLabel },
        ]}
        creates={[
          { tone: "yes", text: "A charge on their Payments tab" },
          { tone: "warn", text: "Notice previewed before it sends" },
        ]}
      />,
      (index) => (
        <div className="max-w-[560px] space-y-4">
          {index === 0 ? (
            <>
              <WizardLockedField label="Property" value={record.property} lockTip="From the resident's record" />
              <WizardLockedField label="Resident" value={row.name} lockTip="From the resident's record" />
            </>
          ) : null}
          {index === 1 ? (
            <>
              <WizardSelect label="Type" value={chargeType} onChange={setChargeType} options={DEMO_CHARGE_TYPES.map((t) => ({ value: t, label: t }))} dataAttr="add-charge-type" />
              <WizardField label="Charge title" required>
                <Input value={chargeTitle} onChange={(e) => setChargeTitle(e.target.value)} data-attr="add-charge-title" />
              </WizardField>
              <WizardRow cols={2}>
                <WizardField label="Amount" required>
                  <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-attr="add-charge-amount" />
                </WizardField>
                <WizardField label="Due">
                  <Input type="date" className="portal-modal-date-input" value={due} onChange={(e) => setDue(e.target.value)} data-attr="add-charge-due" />
                </WizardField>
              </WizardRow>
              <WizardSelect
                label="Status"
                value={status}
                onChange={setStatus}
                options={[
                  { value: "pending", label: "Pending" },
                  { value: "overdue", label: "Overdue" },
                  { value: "paid", label: "Paid" },
                ]}
                dataAttr="add-charge-status"
              />
            </>
          ) : null}
          {index === 2 ? (
            <ReviewList
              facts={[
                ["Resident", row.name],
                ["Type", chargeType],
                ["Charge title", chargeTitle],
                ["Amount", amountLabel],
                ["Due", due],
              ]}
            />
          ) : null}
        </div>
      ),
    );
  }

  if (kind === "add-service") {
    return finish(
      "Add service",
      "Add service",
      [
        { id: "where", label: "Where", summary: record.place },
        { id: "service", label: "Service", summary: serviceTitle || "What needs doing" },
        { id: "review", label: "Review", summary: "Ready" },
      ],
      <PreviewPanel
        title="Service"
        name={serviceTitle || "New service"}
        sub={record.property}
        facts={[
          { label: "Property", value: record.property },
          { label: "Room", value: record.unit || "None" },
          { label: "Resident", value: row.name },
          { label: "Priority", value: priority },
        ]}
        creates={[{ tone: "yes", text: "An open service on their Services tab" }]}
      />,
      (index) => (
        <div className="max-w-[560px] space-y-4">
          {index === 0 ? (
            <>
              <WizardLockedField label="Property" value={record.property} lockTip="From the resident's record" />
              <WizardLockedField label="Room" value={record.unit || "None"} lockTip="From the resident's record" />
              <WizardLockedField label="Resident" value={row.name} lockTip="From the resident's record" />
            </>
          ) : null}
          {index === 1 ? (
            <>
              <WizardField label="Title" required>
                <Input value={serviceTitle} onChange={(e) => setServiceTitle(e.target.value)} data-attr="add-service-title" />
              </WizardField>
              <WizardSelect label="Category" value={category} onChange={setCategory} options={DEMO_SERVICE_CATEGORIES.map((c) => ({ value: c, label: c }))} dataAttr="add-service-category" />
              <WizardSelect
                label="Priority"
                value={priority}
                onChange={setPriority}
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "urgent", label: "Urgent" },
                ]}
                dataAttr="add-service-priority"
              />
            </>
          ) : null}
          {index === 2 ? (
            <ReviewList
              facts={[
                ["Property", record.property],
                ["Room", record.unit],
                ["Resident", row.name],
                ["Priority", priority],
              ]}
            />
          ) : null}
        </div>
      ),
    );
  }

  if (kind === "add-tour") {
    return finish(
      "Add tour",
      "Add tour",
      [
        { id: "home", label: "Home", summary: record.property },
        { id: "when", label: "Date & time", summary: `${tourDate} · ${tourStart}` },
        { id: "visitor", label: "Visitor", summary: visitor },
        { id: "review", label: "Review", summary: "Ready" },
      ],
      <PreviewPanel
        title="Tour"
        name={visitor || "Visitor"}
        sub={record.property}
        facts={[
          { label: "Format", value: tourFormat === "virtual" ? "Virtual" : "In person" },
          { label: "When", value: `${tourDate} · ${tourStart}` },
        ]}
        creates={[
          { tone: "yes", text: "A tour on Tours and your calendar" },
          { tone: "warn", text: "Confirmation previewed before it sends" },
        ]}
      />,
      (index) => (
        <div className="max-w-[560px] space-y-4">
          {index === 0 ? (
            <WizardSection title="Property">
              <WizardRow cols={2}>
                <WizardLockedField label="Property" value={record.property} lockTip="From the resident's record" />
                <WizardLockedField label="Room" value={record.unit || "Any room"} lockTip="From the resident's record" />
              </WizardRow>
              <div className="mt-3">
                <WizardSelect
                  label="Format"
                  value={tourFormat}
                  onChange={setTourFormat}
                  options={[
                    { value: "in_person", label: "In person" },
                    { value: "virtual", label: "Virtual" },
                  ]}
                  dataAttr="add-tour-format"
                />
              </div>
            </WizardSection>
          ) : null}
          {index === 1 ? (
            <WizardSection title="Date & time">
              <WizardRow cols={2}>
                <WizardField label="Date" required>
                  <Input type="date" className="portal-modal-date-input" value={tourDate} onChange={(e) => setTourDate(e.target.value)} data-attr="add-tour-date" />
                </WizardField>
                <WizardField label="Start" required>
                  <Input type="time" value={tourStart} onChange={(e) => setTourStart(e.target.value)} data-attr="add-tour-start" />
                </WizardField>
              </WizardRow>
            </WizardSection>
          ) : null}
          {index === 2 ? (
            <WizardSection title="Visitor">
              <WizardRow cols={2}>
                <WizardField label="Name" required>
                  <Input value={visitor} onChange={(e) => setVisitor(e.target.value)} data-attr="add-tour-name" />
                </WizardField>
                <WizardField label="Email">
                  <Input type="email" defaultValue={row.email} data-attr="add-tour-email" />
                </WizardField>
              </WizardRow>
            </WizardSection>
          ) : null}
          {index === 3 ? (
            <ReviewList
              facts={[
                ["Property", record.property],
                ["Format", tourFormat === "virtual" ? "Virtual" : "In person"],
                ["Date & time", `${tourDate} · ${tourStart} Pacific`],
                ["Visitor", visitor],
              ]}
            />
          ) : null}
        </div>
      ),
    );
  }

  return (
    <DemoWorkspacePopup
      title="Add document"
      subtitle={record.place}
      saveState="Not saved yet"
      steps={[{ id: "document", label: "Add document" }]}
      stepHeading=""
      sidePanel={
        <PanelSection title="Goes on their file">
          <p className="text-[13.5px] font-semibold text-foreground">{fileName ?? "No file chosen"}</p>
          <p className="text-[12.5px] text-muted">{docKind} · {row.name}</p>
        </PanelSection>
      }
      footer={{ kind: "done", label: "Add document", onDone, left: <CancelButton onClick={onClose} dataAttr="add-document-cancel" /> }}
      onClose={onClose}
      dataAttr="demo-add-document-popup"
    >
      {() => (
        <div className="max-w-[560px] space-y-4">
          <WorkspaceFileCard
            accept={RESIDENT_FILE_ACCEPT}
            chips={RESIDENT_STEP_FILE_CHIPS}
            fileName={fileName}
            onPick={(file) => setFileName(file.name)}
            dataAttr="add-document-upload"
          />
          <WizardSelect label="What is it" value={docKind} onChange={setDocKind} options={DEMO_DOCUMENT_KINDS.map((k) => ({ value: k, label: k }))} dataAttr="add-document-kind" />
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────── Add resident / Edit resident ─────────────────────────── */

const STEP_IDS = ["contact", "home", "application", "lease", "payments", "documents", "review"] as const;

function propertyIdFor(title: string): string {
  return DEMO_WIZARD_PROPERTIES.find((p) => p.label === title)?.id ?? "";
}

function initialForm(mode: "add" | "edit", row?: ResidentFixtureRow): AddPersonForm {
  const blank = emptyAddPersonForm("resident");
  if (mode === "add" || !row) {
    const propertyId = DEMO_NEW_RESIDENT.propertyId;
    return {
      ...blank,
      name: DEMO_NEW_RESIDENT.name,
      email: DEMO_NEW_RESIDENT.email,
      phone: DEMO_NEW_RESIDENT.phone,
      propertyId,
      roomId: DEMO_NEW_RESIDENT.roomId,
      leaseTerm: RESIDENT_LEASE_TERM_LONG,
      moveInDate: DEMO_NEW_RESIDENT.moveInDate,
      moveOutDate: DEMO_NEW_RESIDENT.moveOutDate,
      ...demoWizardPricing(propertyId, DEMO_NEW_RESIDENT.roomId),
    };
  }
  const record = demoResidentRecord(row);
  const propertyId = propertyIdFor(record.property);
  const room = demoWizardRooms(propertyId).find((r) => r.name === record.unit);
  return {
    ...blank,
    name: row.name,
    email: row.email,
    phone: record.phone,
    propertyId,
    roomId: room?.id ?? "",
    leaseTerm: RESIDENT_LEASE_TERM_LONG,
    moveInDate: record.moveInIso,
    moveOutDate: record.moveOutIso,
    ...demoWizardPricing(propertyId, room?.id ?? ""),
  };
}

function useDemoDerived(form: AddPersonForm): ResidentWizardDerived {
  return useMemo<ResidentWizardDerived>(() => {
    const rooms = demoWizardRooms(form.propertyId);
    const rentedByRoom = rooms.length > 0;
    const entireHome = Boolean(form.propertyId) && !rentedByRoom;
    const room = rooms.find((r) => r.id === form.roomId);
    const isShortTerm = form.leaseTerm === RESIDENT_LEASE_TERM_SHORT;
    const isAirbnb = form.leaseTerm === RESIDENT_LEASE_TERM_AIRBNB;
    const leaseTermOptions = [
      { value: RESIDENT_LEASE_TERM_SHORT, label: "Short-term" },
      { value: RESIDENT_LEASE_TERM_AIRBNB, label: "Airbnb" },
      { value: RESIDENT_LEASE_TERM_LONG, label: "Long term" },
      { value: RESIDENT_LEASE_TERM_CUSTOM, label: "Custom" },
    ];
    return {
      roomOptions: rooms.map((r) => ({ id: r.id, name: r.name, monthlyRent: r.monthlyRent })),
      bundleOptions: [],
      leaseTermOptions,
      leaseTermPresetValues: leaseTermOptions.map((o) => o.value),
      customLeaseTermHidden: false,
      rentedByRoom,
      entireHome,
      showBundleSelect: false,
      showRoomSelect: rentedByRoom && !form.bundleId.trim(),
      rentalType: isAirbnb ? "airbnb" : isShortTerm ? "short_term" : "standard",
      isShortTerm,
      isAirbnb,
      isMonthToMonth: false,
      applicationConfig: null,
      customQuestions: [],
      fieldEnabled: () => true,
      listingSays: room ? `${room.name} · $${room.monthlyRent}/mo listed` : null,
    };
  }, [form.propertyId, form.roomId, form.bundleId, form.leaseTerm]);
}

export function DemoResidentWizardPopup({
  mode,
  row,
  onClose,
  onDone,
}: {
  mode: "add" | "edit";
  row?: ResidentFixtureRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<AddPersonForm>(() => initialForm(mode, row));
  const [step, setStep] = useState(0);
  const patch = useCallback((next: Partial<AddPersonForm>) => setForm((prev) => ({ ...prev, ...next })), []);
  const derived = useDemoDerived(form);
  const editing = mode === "edit";

  // A new placement re-prices from the listing; the first pass over a saved resident keeps what they pay.
  const placementKey = `${form.propertyId}|${form.roomId}`;
  const lastPlacement = useRef(placementKey);
  useEffect(() => {
    if (lastPlacement.current === placementKey) return;
    lastPlacement.current = placementKey;
    patch(demoWizardPricing(form.propertyId, form.roomId));
  }, [placementKey, form.propertyId, form.roomId, patch]);

  const propertyLabel = DEMO_WIZARD_PROPERTIES.find((p) => p.id === form.propertyId)?.label ?? null;
  const todo = useMemo(() => thingsToFinish(form, "person"), [form]);
  const missing = (id: string) => todo.some((t) => t.step === id);
  const rent = Number(form.rent.replace(/[^\d.]/g, "")) || 0;
  const appFilled = [form.application.employer ? "Employment" : null, form.application.currentStreet ? "address" : null, form.application.ref1Name ? "1 reference" : null].filter(Boolean).join(" · ");
  const homeSummary = propertyLabel ? `${propertyLabel}${derived.listingSays ? ` · ${derived.listingSays.split(" · ")[0]}` : ""}` : "No property yet";
  const leaseSummary = rent && form.moveInDate ? `${formatMoney(rent)}/${derived.isShortTerm ? "night" : "mo"} · ${form.moveInDate}${form.moveOutDate ? ` → ${form.moveOutDate}` : ""}` : "Rent not set";
  const contactSummary = form.name.trim() ? [form.name.trim(), form.email.trim()].filter(Boolean).join(" · ") : "Who they are";

  const steps: AddWorkspaceStep[] = useMemo(() => {
    const off = "Off this add";
    return editing
      ? [
          { id: "contact", label: "Resident", incomplete: missing("contact"), summary: contactSummary },
          { id: "home", label: "Home", incomplete: missing("home"), summary: homeSummary },
          { id: "application", label: "Application", summary: appFilled || "On file" },
          { id: "lease", label: "Lease", incomplete: missing("lease"), summary: leaseSummary },
          { id: "payments", label: "Payments", summary: "2 paid · 0 unpaid" },
          { id: "documents", label: "Documents", summary: "2 attached" },
          { id: "review", label: "Review", summary: "Nothing changed" },
        ]
      : [
          { id: "contact", label: "Resident", summary: contactSummary },
          { id: "home", label: "Home", summary: homeSummary },
          { id: "application", label: "Application", offPath: currentResidentStepOffPath("application", form), summary: appFilled || (alsoCreates(form, "application") ? "Nothing yet" : off) },
          { id: "lease", label: "Lease", offPath: currentResidentStepOffPath("lease", form), summary: alsoCreates(form, "lease") ? leaseSummary : off },
          { id: "payments", label: "Payments", offPath: currentResidentStepOffPath("payments", form), summary: derived.isAirbnb ? "Nothing billed" : alsoCreates(form, "payments") ? "From move-in" : off },
          { id: "documents", label: "Documents", offPath: currentResidentStepOffPath("documents", form), summary: form.documents.length ? `${form.documents.length} attached` : alsoCreates(form, "documents") ? "None attached" : off },
          { id: "review", label: "Review", incomplete: todo.length > 0, summary: todo.length ? `${todo.length} to finish` : "Ready to add" },
        ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, todo, derived.isAirbnb, derived.isShortTerm, editing, propertyLabel]);

  const goTo = (id: string) => setStep(Math.max(0, STEP_IDS.indexOf(id as (typeof STEP_IDS)[number])));
  const title = editing ? "Edit resident" : "Add resident";

  return (
    <DemoWorkspacePopup
      title={title}
      subtitle={propertyLabel ?? undefined}
      saveState={editing ? "Saved" : "Not saved yet"}
      steps={steps}
      step={step}
      onStep={setStep}
      stepHeading=""
      railHeader={
        <button
          type="button"
          onClick={() => goTo("documents")}
          data-attr="residents-wizard-rail-documents"
          className="mb-3 grid w-full place-items-center rounded-xl border border-dashed border-border bg-white px-3 py-5 text-[12.5px] font-semibold text-muted transition hover:border-primary/50 hover:text-primary [html[data-theme=dark]_&]:bg-card"
        >
          <span className="flex flex-col items-center gap-1.5">
            <FolderOpen className="h-5 w-5" strokeWidth={1.7} aria-hidden />
            {form.documents.length ? `${form.documents.length} ${form.documents.length === 1 ? "document" : "documents"}` : "Add documents"}
          </span>
        </button>
      }
      sidePanel={<ResidentSidePanel form={form} derived={derived} propertyLabel={propertyLabel} mode="person" />}
      footer={{ kind: "wizard", lastLabel: editing ? "Save resident" : "Add resident", onFinish: onDone }}
      onClose={onClose}
      dataAttr={editing ? "residents-edit-wizard" : "residents-wizard"}
    >
      {(index) => {
        const id = STEP_IDS[index];
        return (
          <WorkspaceHeaderUploadPresent.Provider value={!editing}>
            {index === 0 && !editing ? (
              <WorkspaceFileCard accept={RESIDENT_FILE_ACCEPT} chips={RESIDENT_STEP_FILE_CHIPS} onPick={noop} dataAttr="residents-wizard-header-upload" label="Upload a file" />
            ) : null}
            {id === "contact" ? <ContactStep form={form} patch={patch} strip={{ kind: "blank" }} onPickFile={noop} onUndoFill={noop} busy={false} mode="person" /> : null}
            {id === "home" ? <HomeStep form={form} patch={patch} derived={derived} propertyOptions={DEMO_WIZARD_PROPERTIES} /> : null}
            {id === "application" ? <ApplicationStep form={form} patch={patch} derived={derived} propertyLabel={propertyLabel} onPickApplicationFile={editing ? undefined : noop} uploadBusy={false} /> : null}
            {id === "lease" ? <LeaseStep form={form} patch={patch} derived={derived} onPickLeasePdf={noop} busy={false} /> : null}
            {id === "payments" ? <PaymentsStep form={form} patch={patch} derived={derived} /> : null}
            {id === "documents" ? <DocumentsStep form={form} patch={patch} onPickFile={noop} busy={false} /> : null}
            {id === "review" ? <ReviewStep form={form} patch={patch} derived={derived} propertyLabel={propertyLabel} goTo={goTo} mode="person" /> : null}
          </WorkspaceHeaderUploadPresent.Provider>
        );
      }}
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────── A resident's record page ─────────────────────────── */

function FactCards({ cards }: { cards: DemoFactCardData[] }) {
  return (
    <div className="flex flex-col gap-4 pb-6" data-attr="demo-record-cards">
      {cards.map((card) => (
        <RecordFactCard key={card.title} title={card.title}>
          {card.rows.map((r) => (
            <RecordFactRow key={r.label} label={r.label} value={r.value} tone={r.tone} />
          ))}
        </RecordFactCard>
      ))}
    </div>
  );
}

function ListCard({ title, count, rows, empty }: { title: string; count?: number; rows: { id: string; label: string; value: ReactNode; tone?: "ok" | "bad" }[]; empty: string }) {
  return (
    <div className="flex flex-col gap-4 pb-6">
      <RecordFactCard title={title} count={count}>
        {rows.length === 0 ? <RecordFactRow label="None" value={empty} /> : rows.map((r) => <RecordFactRow key={r.id} label={r.label} value={r.value} tone={r.tone} />)}
      </RecordFactCard>
    </div>
  );
}

function registryActions(sections: RecordSections, onAction: (id: string) => void, relabel?: Record<string, string>): DemoRecordAction[] {
  return sections.headerActions.map((action) => ({
    id: action.id,
    label: relabel?.[action.id] ?? action.label,
    icon: action.icon,
    tone: action.tone,
    onClick: () => onAction(action.id),
  }));
}

export function DemoResidentRecord({
  row,
  onBack,
  onAction,
}: {
  row: ResidentFixtureRow;
  onBack: () => void;
  /** A header icon: edit, delete, approve, decline, download, run-check, remind-payment, add-charge, add-service, add-tour, upload. */
  onAction: (id: string) => void;
}) {
  const record = useMemo(() => demoResidentRecord(row), [row]);
  const [active, setActive] = useState("overview");
  const ctx = { residentsTab: row.tab, hiddenSections: row.tab === "potential" ? ["services"] : [] };
  const sections = recordSections("manager", "resident", ctx, active);
  const actions = registryActions(sections, onAction);
  const first = row.name.split(" ")[0] ?? row.name;

  let body: ReactNode;
  switch (active) {
    case "overview":
      body = (
        <ResidentOverviewPanel
          resident={{
            name: record.name,
            email: record.email,
            phone: record.phone,
            propertyLabel: record.property,
            roomLabel: record.unit,
            signedMonthlyRent: record.stage === "potential" ? null : record.rent,
            leaseStart: record.moveInIso,
            leaseEnd: record.moveOutIso,
            stage: record.stage,
            statusLabel: record.statusLabel,
            axisId: record.axisId,
          }}
          ledgerRows={[]}
          leaseRows={[]}
          links={{}}
          onNavigate={noop}
          onInlineAction={noop}
          onNextAction={noop}
          onCopyField={noop}
        />
      );
      break;
    case "tours":
      body = <FactCards cards={record.tours} />;
      break;
    case "application":
      body = <FactCards cards={record.application} />;
      break;
    case "background-check":
      body = <FactCards cards={record.backgroundCheck} />;
      break;
    case "lease":
      body = <FactCards cards={record.lease} />;
      break;
    case "forms":
      body = <ListCard title="Forms" count={record.forms.length} rows={record.forms.map((f) => ({ id: f.id, label: f.title, value: f.fact }))} empty="No forms sent yet" />;
      break;
    case "move-in":
      body = <FactCards cards={record.moveIn} />;
      break;
    case "payments":
      body = (
        <ListCard
          title="Charges"
          count={record.charges.length}
          rows={record.charges.map((c) => ({ id: c.id, label: c.title, value: `${c.amount} · ${c.paid ? "Paid" : c.due}`, tone: c.paid ? ("ok" as const) : undefined }))}
          empty="No charges yet"
        />
      );
      break;
    case "services":
      body = <ListCard title="Services" count={record.services.length} rows={record.services.map((s) => ({ id: s.id, label: s.title, value: s.fact }))} empty="No services" />;
      break;
    case "documents":
      body = <ListCard title="Documents" count={record.documents.length} rows={record.documents.map((d) => ({ id: d.id, label: d.kind, value: d.name }))} empty="No documents" />;
      break;
    default:
      body = <DemoRecordThread name={row.name} subtitle={row.place} messages={record.messages} selfName="You" />;
  }

  return (
    <DemoRecordPage
      title={row.name}
      subtitle={`${row.place} · ${record.statusLabel}`}
      avatarName={row.name}
      backLabel="Back to residents"
      onBack={onBack}
      actions={actions}
      sections={sections}
      recordId={row.id}
      activeId={active}
      onActive={setActive}
      ariaLabel={`${first}'s sections`}
    >
      {body}
    </DemoRecordPage>
  );
}

/* ─────────────────────────── Add vendor / Invite vendor / Edit vendor ─────────────────────────── */

const PROPERTY_OPTIONS = DEMO_WIZARD_PROPERTIES;

export function DemoVendorFormPopup({
  mode,
  vendor,
  catalog,
  onClose,
  onFinish,
  onDelete,
}: {
  mode: "add" | "edit";
  vendor?: DemoVendor;
  /** A PropLane vendor the add is seeded from: the "Invite vendor" pop-up with the one Properties step. */
  catalog?: CatalogVendorFixture;
  onClose: () => void;
  onFinish: (result: { name: string; email: string; phone: string }) => void;
  onDelete?: () => void;
}) {
  const seeded = mode === "add" && Boolean(catalog);
  const contact = catalog ? demoCatalogContact(catalog) : null;
  const [step, setStep] = useState(0);
  const [invitePath, setInvitePath] = useState<PortalInvitePath>("link");
  const [axisInput, setAxisInput] = useState("");
  const [draft, setDraft] = useState<ManagerVendorFormDraft>(() => ({
    name: vendor?.name ?? catalog?.name ?? "",
    trade: vendor?.trade ?? contact?.trade ?? VENDOR_TRADE_OPTIONS[0],
    trades: vendor ? [vendor.trade] : contact ? [contact.trade] : [VENDOR_TRADE_OPTIONS[0]],
    phone: vendor?.phone ?? contact?.phone ?? "",
    email: vendor?.email ?? contact?.email ?? "",
    notes: "",
    active: vendor?.rank !== "Inactive",
    sharedWithManagers: false,
    shareOnProplane: false,
    vendorPriority: vendor?.rank === "Primary" ? "primary" : vendor?.rank === "Secondary" ? "secondary" : "",
    propertyIds: [],
    catalogId: catalog?.id,
    typicalRates: [],
  }));
  const patch = (next: Partial<ManagerVendorFormDraft>) => setDraft((prev) => ({ ...prev, ...next }));

  const title = mode === "edit" ? "Edit vendor" : seeded ? "Invite vendor" : "Add vendor";
  const housesSummary = draft.propertyIds.length ? `${draft.propertyIds.length} houses` : "Every property";
  const steps: AddWorkspaceStep[] =
    mode === "edit"
      ? [
          { id: "vendor", label: "Vendor", summary: draft.name.trim() || "Who they are" },
          { id: "properties", label: "Properties", summary: housesSummary },
          { id: "trades", label: "Who can handle", summary: draft.trades.join(", ") || "No trades yet" },
          { id: "rates", label: "Typical price", summary: draft.typicalRates.length ? "Per house" : "Set rates" },
          { id: "review", label: "Review", summary: "Save changes" },
        ]
      : seeded
        ? [{ id: "properties", label: "Properties", summary: housesSummary }]
        : [
            { id: "invite", label: "Invite by", summary: invitePath === "link" ? "Link" : invitePath === "message" ? "Message" : "PropLane code" },
            { id: "contact", label: "Contact", summary: draft.name.trim() || "Name and phone" },
            { id: "properties", label: "Properties", summary: housesSummary },
            { id: "trades", label: "What they do", summary: draft.trades.join(", ") || "No trades yet" },
            { id: "rates", label: "Typical price", summary: draft.typicalRates.length ? "Per house" : "Set rates" },
            { id: "review", label: "Review", summary: "Invite vendor" },
          ];
  const current = Math.min(step, steps.length - 1);
  const stepId = steps[current]!.id;
  const rateHouses = draft.propertyIds.length ? PROPERTY_OPTIONS.filter((p) => draft.propertyIds.includes(p.id)) : PROPERTY_OPTIONS;

  return (
    <DemoWorkspacePopup
      title={title}
      saveState={mode === "edit" ? "Saved" : "Not saved yet"}
      steps={steps}
      step={current}
      onStep={setStep}
      stepHeading=""
      footer={{
        kind: "wizard",
        lastLabel: mode === "edit" ? "Save vendor" : seeded ? "Invite" : "Invite vendor",
        onFinish: () => onFinish({ name: draft.name, email: draft.email, phone: draft.phone }),
        onDelete: mode === "edit" ? onDelete : undefined,
      }}
      onClose={onClose}
      dataAttr="vendor-form"
    >
      {() => (
        <>
          {stepId === "invite" ? (
            <div className="space-y-4" data-attr="vendor-form-invite-by">
              <PortalInvitePaths value={invitePath} onChange={setInvitePath} />
              {invitePath === "code" ? (
                <label className="block space-y-1">
                  <span className="text-sm font-semibold">{AXIS_ID_LABEL}</span>
                  <Input value={axisInput} onChange={(e) => setAxisInput(e.target.value)} className="font-mono" data-attr="vendor-proplane-id-input" />
                </label>
              ) : null}
            </div>
          ) : null}
          {stepId === "vendor" ? (
            <div className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Vendor name</span>
                <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} required data-attr="vendor-essential-name" />
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Email</span>
                <Input type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="email" data-attr="vendor-essential-email" />
              </label>
              <div className="space-y-1">
                <label htmlFor="vendor-invite-phone" className="text-sm font-semibold">Phone</label>
                <PhoneNumberField id="vendor-invite-phone" value={draft.phone} onChange={(phone) => patch({ phone })} dataAttr="vendor-optional-phone" />
              </div>
            </div>
          ) : null}
          {stepId === "contact" ? (
            <div className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Invite by first name</span>
                <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} required data-attr="vendor-essential-name" />
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Email</span>
                <Input type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="email" data-attr="vendor-essential-email" />
              </label>
              <div className="space-y-1">
                <label htmlFor="vendor-invite-phone" className="text-sm font-semibold">Phone</label>
                <PhoneNumberField id="vendor-invite-phone" value={draft.phone} onChange={(phone) => patch({ phone })} dataAttr="vendor-optional-phone" />
              </div>
            </div>
          ) : null}
          {stepId === "properties" ? (
            <div className="space-y-4">
              {seeded && catalog && contact ? (
                <div className="rounded-2xl border border-border bg-card px-4 py-3 text-[13.5px]" data-attr="vendor-catalog-invite-facts">
                  <p className="font-semibold">{catalog.name}</p>
                  <p className="mt-1">{[contact.trade, contact.phone, contact.email].filter(Boolean).join(" · ")}</p>
                </div>
              ) : null}
              <CheckboxMultiSelect
                label="Properties"
                dataAttr="vendor-form-properties"
                emptyLabel="Every property"
                selectionTriggerLabel={draft.propertyIds.length === 0 ? "Every property" : undefined}
                options={[{ value: "__all__", label: "Every property" }, ...PROPERTY_OPTIONS.map((p) => ({ value: p.id, label: p.label }))]}
                selected={draft.propertyIds.length === 0 ? ["__all__"] : draft.propertyIds}
                onChange={(next) => {
                  const houses = next.filter((id) => id !== "__all__");
                  const pickedAll = next.includes("__all__");
                  const wasAll = draft.propertyIds.length === 0;
                  if (pickedAll && !wasAll) {
                    patch({ propertyIds: [] });
                    return;
                  }
                  patch({ propertyIds: houses });
                }}
              />
            </div>
          ) : null}
          {stepId === "trades" ? (
            <div className="space-y-4" data-attr="vendor-form-trades">
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">{mode === "add" ? "What they do" : "Who can handle"}</legend>
                {VENDOR_TRADE_OPTIONS.map((trade) => {
                  const on = draft.trades.includes(trade);
                  return (
                    <label key={trade} className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card px-3 text-[13.5px]">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          const trades = on ? draft.trades.filter((item) => item !== trade) : [...draft.trades, trade];
                          patch({ trades, trade: trades[0] ?? trade });
                        }}
                        data-attr={`vendor-trade-${trade}`}
                      />
                      {trade}
                    </label>
                  );
                })}
              </fieldset>
            </div>
          ) : null}
          {stepId === "rates" ? (
            <TypicalPriceFields houses={rateHouses} trades={draft.trades} rates={draft.typicalRates} onChange={(typicalRates) => patch({ typicalRates })} />
          ) : null}
          {stepId === "review" ? (
            <div className="space-y-4">
              <p className="text-[13.5px]">{[draft.name, draft.trade, draft.email, draft.phone].filter(Boolean).join(" · ")}</p>
              <FieldSingleSelect
                label="Share on PropLane"
                dataAttr="vendor-share-on-proplane"
                value={draft.shareOnProplane ? "on" : "off"}
                onChange={(next) => patch({ shareOnProplane: next === "on" })}
                options={[
                  { value: "off", label: "Off — only on Your vendors" },
                  { value: "on", label: "On — show on PropLane vendors" },
                ]}
              />
              {mode === "edit" ? <ManagerVendorFormFields draft={draft} onPatch={patch} /> : null}
            </div>
          ) : null}
        </>
      )}
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────── A vendor's record ─────────────────────────── */

function StarsLine({ stars }: { stars: number }) {
  return <span aria-label={`${stars} of 5 stars`}>{"★".repeat(stars)}{"☆".repeat(5 - stars)}</span>;
}

export function DemoVendorRecord({ vendor, onBack, onAction }: { vendor: DemoVendor; onBack: () => void; onAction: (id: string) => void }) {
  const record = useMemo(() => demoVendorRecord(vendor), [vendor]);
  const [active, setActive] = useState("overview");
  const sections = recordSections("manager", "vendor", {}, active);
  // Message goes to this record's Communication section, like the real header's Message icon.
  const actions = registryActions(sections, (id) => (id === "message" ? setActive("communication") : onAction(id)), record.invited ? { invite: "Resend invite" } : undefined);

  let body: ReactNode;
  switch (active) {
    case "services":
      body = <ListCard title="Services" count={record.services.length} rows={record.services.map((s) => ({ id: s.id, label: s.title, value: [s.fact, s.figure].filter(Boolean).join(" · ") }))} empty="No services yet" />;
      break;
    case "invoices":
      body = <ListCard title="Outgoing payments" count={record.payments.length} rows={record.payments.map((p) => ({ id: p.id, label: p.title, value: `${p.place} · ${p.fact} · ${p.amount}` }))} empty="No payments yet" />;
      break;
    case "reviews":
      body = <ListCard title="Reviews" count={record.reviews.length} rows={record.reviews.map((r) => ({ id: r.id, label: r.at.split(",").slice(0, 2).join(","), value: <><StarsLine stars={r.stars} /> {r.body}</> }))} empty="No reviews yet" />;
      break;
    case "communication":
      body = <DemoRecordThread name={vendor.name} subtitle={vendor.trade} messages={record.messages} selfName="You" />;
      break;
    default:
      body = <FactCards cards={record.overview} />;
  }
  return (
    <DemoRecordPage
      title={vendor.name}
      subtitle={vendor.trade}
      avatarName={vendor.name}
      backLabel="Back to vendors"
      onBack={onBack}
      actions={actions.map((a) => (a.id === "message" ? { ...a, tone: "primary" as const } : a))}
      sections={sections}
      recordId={vendor.id}
      activeId={active}
      onActive={setActive}
      ariaLabel="Vendor sections"
    >
      {body}
    </DemoRecordPage>
  );
}

/** A PropLane vendor's record (`recordSections("manager","vendorCatalog")`). */
export function DemoCatalogVendorRecord({ vendor, added, onBack, onAction }: { vendor: CatalogVendorFixture; added: boolean; onBack: () => void; onAction: (id: string) => void }) {
  const record = useMemo(() => demoCatalogVendorRecord(vendor), [vendor]);
  const [active, setActive] = useState("overview");
  const sections = recordSections("manager", "vendorCatalog", {}, active);
  const actions = registryActions(sections, onAction, added ? { add: "Open" } : undefined);
  let body: ReactNode;
  switch (active) {
    case "pricing":
      body = <FactCards cards={record.pricing} />;
      break;
    case "jobs":
      body = <ListCard title="Jobs" count={record.jobs.length} rows={record.jobs.map((j) => ({ id: j.id, label: j.title, value: j.fact }))} empty="No jobs yet" />;
      break;
    case "reviews":
      body = <ListCard title="Reviews" count={record.reviews.length} rows={record.reviews.map((r) => ({ id: r.id, label: r.at, value: <><StarsLine stars={r.stars} /> {r.body}</> }))} empty="No reviews yet" />;
      break;
    case "communication":
      body = <DemoRecordThread name={vendor.name} subtitle={vendor.trades} messages={[]} selfName="You" />;
      break;
    case "documents":
      body = <ListCard title="Documents" count={record.documents.length} rows={record.documents.map((d) => ({ id: d.id, label: d.kind, value: d.name }))} empty="No documents" />;
      break;
    default:
      body = <FactCards cards={record.overview} />;
  }
  return (
    <DemoRecordPage
      title={vendor.name}
      subtitle={[vendor.trades.split(",")[0], vendor.city].filter(Boolean).join(" · ")}
      avatarName={vendor.name}
      backLabel="Back to PropLane vendors"
      onBack={onBack}
      actions={actions}
      sections={sections}
      recordId={vendor.id}
      activeId={active}
      onActive={setActive}
      ariaLabel="Vendor sections"
    >
      {body}
    </DemoRecordPage>
  );
}
