"use client";

/**
 * The pop-ups and record pages of the manager Payments (incoming), Services and Communication tabs, drawn for the
 * home demo from fixture props. Same words as the real ones, read from their source:
 *
 *  - Add charge (`ManagerAddPaymentModal`): rail Who / Amount / Review, last label "Add charge", "Charge" preview.
 *  - Edit payment (`renderEditPaymentModal`): Amount + Due date, "Charge preview", Save / Mark as paid.
 *  - Add service (`ManagerAddServiceModal`): rail Where / What / Review, last label "Add service", with the real
 *    `ServiceIntakeFormFields`, `ServiceIntakePhotoPicker` and `ServiceTasksField` for the What step.
 *  - New message (`ManagerCommunicationComposeModal`): To / Subject / Message, the tools row, "Message preview".
 *  - A charge's record and a service's record: `DemoRecordPage` over `recordSections("manager", ...)`.
 *
 * The real doors fetch and mount the assistant, so they cannot render on the public page; this file draws the same
 * shell and fields from the same exported pieces. Nothing is sent or saved: the primary closes and the panel toasts
 * "(sample)". Loaded on demand (`demo-popups-lazy-money.tsx`).
 */

import { useState } from "react";
import {
  BadgeCheck,
  Bell,
  CalendarDays,
  CheckCircle2,
  Mail,
  MessageSquare,
  Paperclip,
  Pencil,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PanelSection, StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PreviewPanel, WizardField, WizardSelect } from "@/components/portal/add-workspace/parts";
import { PopupMessagePreview, PopupRecordPreview } from "@/components/portal/popup-live-preview";
import {
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageSubjectField,
  portalMessageFieldLabel,
} from "@/components/portal/portal-message-compose-fields";
import { InboxComposerScheduleMenu } from "@/components/portal/inbox-composer-tools";
import {
  ServiceIntakeFormFields,
  ServiceIntakePhotoPicker,
  type ServiceIntakeFormState,
} from "@/components/portal/service-intake-form-fields";
import { ServiceTasksField } from "@/components/portal/service-tasks-field";
import { RecordFactCard, RecordFactRow, StatTile, RecordStatTiles } from "@/components/portal/portal-record-overview-kit";
import { Input } from "@/components/ui/input";
import { MANAGER_PAYMENT_PRESETS } from "@/lib/payment-policy";
import { MAINTENANCE_SERVICE_OFFER_ID } from "@/lib/service-intake";
import { recordSections } from "@/lib/portals/record-sections";
import { DemoWorkspacePopup } from "@/components/marketing/site/product-mock/demo-popup";
import { DemoRecordPage, DemoRecordThread, recordActionsFromSections, type DemoRecordAction } from "@/components/marketing/site/product-mock/demo-record";
import {
  COMM_CONVERSATIONS,
  VENDOR_ROWS,
  type PaymentFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";
import {
  COMM_RECIPIENTS,
  DEMO_PAYMENT_PROPERTIES,
  DEMO_SERVICE_PROPERTIES,
  DEMO_TASK_VENDORS,
  DEMO_TEAM_MEMBERS,
  PAYMENT_TYPE_TITLES,
  demoPaymentDetail,
  demoResidentsForProperty,
  demoServiceResidents,
  demoServiceRooms,
  paymentIsRefundable,
  serviceNextStep,
  type MoneyServiceRow,
} from "@/components/marketing/site/product-mock/fixtures-popups-money";

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/* ───────────────────────────── Add charge ───────────────────────────── */

export function DemoAddChargePopup({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [propertyId, setPropertyId] = useState(DEMO_PAYMENT_PROPERTIES[0]!.id);
  const property = DEMO_PAYMENT_PROPERTIES.find((p) => p.id === propertyId) ?? DEMO_PAYMENT_PROPERTIES[0]!;
  const residents = demoResidentsForProperty(property.label);
  const [residentId, setResidentId] = useState(demoResidentsForProperty(DEMO_PAYMENT_PROPERTIES[0]!.label)[0]?.id ?? "");
  const resident = residents.find((r) => r.id === residentId);
  const [preset, setPreset] = useState("rent");
  const [chargeTitle, setChargeTitle] = useState(PAYMENT_TYPE_TITLES.rent!);
  const [amount, setAmount] = useState("1650");
  const [dueIso, setDueIso] = useState("2025-10-01");
  const [bucket, setBucket] = useState("pending");

  const presetLabel = MANAGER_PAYMENT_PRESETS.find((p) => p.id === preset)?.label ?? "Charge";
  const amountNum = Number.parseFloat(amount);
  const amountLabel = Number.isFinite(amountNum) && amountNum > 0 ? `$${amountNum.toFixed(2)}` : "Not set";
  const residentLabel = resident?.name ?? "Not set";
  const steps = [
    { id: "who", label: "Who" },
    { id: "amount", label: "Amount" },
    { id: "review", label: "Review" },
  ] as const;

  return (
    <DemoWorkspacePopup
      title="Add charge"
      saveState="Not saved yet"
      steps={steps}
      stepHeading=""
      sidePanel={
        <PreviewPanel
          title="Charge"
          name={residentLabel}
          facts={[
            { label: "Resident", value: residentLabel, warn: !resident },
            { label: "Type", value: presetLabel },
            { label: "Amount", value: amountLabel },
          ]}
          creates={[
            { tone: "yes", text: "Pending charge on Incoming" },
            { tone: "no", text: "Reminder uses your payment settings" },
          ]}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Add charge", onFinish: onAdded }}
      onClose={onClose}
      dataAttr="payments-add"
    >
      {(index) =>
        index === 0 ? (
          <StepColumn>
            <StepHeading title="Property and resident" />
            <WizardSelect
              label="Property"
              value={propertyId}
              onChange={(next) => {
                setPropertyId(next);
                setResidentId(demoResidentsForProperty(DEMO_PAYMENT_PROPERTIES.find((p) => p.id === next)?.label ?? "")[0]?.id ?? "");
              }}
              options={DEMO_PAYMENT_PROPERTIES.map((p) => ({ value: p.id, label: p.label }))}
              placeholder="Select property"
            />
            <WizardSelect
              label="Resident"
              value={residentId}
              onChange={setResidentId}
              options={residents.map((r) => ({ value: r.id, label: r.name }))}
              placeholder={residents.length === 0 ? "No residents at this property" : "Select resident"}
            />
          </StepColumn>
        ) : index === 1 ? (
          <StepColumn>
            <StepHeading title="Amount" />
            <WizardSelect
              label="Type"
              value={preset}
              onChange={(next) => {
                setPreset(next);
                if (next in PAYMENT_TYPE_TITLES) setChargeTitle(PAYMENT_TYPE_TITLES[next]!);
              }}
              options={MANAGER_PAYMENT_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            />
            <WizardField label="Charge title" required>
              <Input value={chargeTitle} onChange={(e) => setChargeTitle(e.target.value)} placeholder="April rent" autoComplete="off" />
            </WizardField>
            <WizardField label="Amount" required>
              <Input type="number" inputMode="decimal" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1100" />
            </WizardField>
            <WizardField label="Due">
              <Input type="date" value={dueIso} onChange={(e) => setDueIso(e.target.value)} />
            </WizardField>
            <WizardSelect
              label="Status"
              value={bucket}
              onChange={setBucket}
              options={[
                { value: "pending", label: "Pending" },
                { value: "overdue", label: "Overdue" },
                { value: "paid", label: "Paid" },
              ]}
            />
          </StepColumn>
        ) : (
          <StepColumn>
            <StepHeading title="Review" />
            <PreviewPanel
              title="Charge"
              name={residentLabel}
              facts={[
                { label: "Resident", value: residentLabel },
                { label: "Type", value: presetLabel },
                { label: "Amount", value: amountLabel },
              ]}
              creates={[{ tone: "yes", text: "Creates a charge on Incoming" }]}
            />
          </StepColumn>
        )
      }
    </DemoWorkspacePopup>
  );
}

/* ───────────────────────────── Edit payment ───────────────────────────── */

export function DemoEditPaymentPopup({
  row,
  onClose,
  onSaved,
  onMarkPaid,
  onDelete,
}: {
  row: PaymentFixtureRow;
  onClose: () => void;
  onSaved: () => void;
  onMarkPaid: () => void;
  onDelete: () => void;
}) {
  const [amount, setAmount] = useState(String(Number(row.amount.replace(/[^0-9.]/g, ""))));
  const [due, setDue] = useState("2025-10-01");
  return (
    <DemoWorkspacePopup
      title="Edit payment"
      saveState="Saved"
      headerActions={<PortalIconAction icon={Trash2} label="Delete" tone="danger" data-attr="payments-edit-delete" onClick={onDelete} />}
      steps={[{ id: "edit", label: "Edit payment" }]}
      stepHeading=""
      sidePanel={
        <PanelSection title="Charge preview">
          <PopupRecordPreview
            rows={[
              { label: "Amount", value: amount ? `$${amount}` : "Not set" },
              { label: "Due date", value: due ? longDate(due) : "Not set" },
            ]}
          />
        </PanelSection>
      }
      footer={{
        kind: "done",
        label: "Save",
        onDone: onSaved,
        left: (
          <button
            type="button"
            onClick={onMarkPaid}
            data-attr="payments-edit-mark-paid"
            className="min-h-[44px] rounded-lg border border-[var(--input)] bg-card px-4 text-[13.5px] font-semibold text-foreground lg:min-h-9"
          >
            Mark as paid
          </button>
        ),
      }}
      onClose={onClose}
      dataAttr="payments-edit-modal"
    >
      {() => (
        <div className="max-w-[560px] space-y-3">
          <div>
            <p className="text-sm font-semibold text-foreground">{row.resident}</p>
            <p className="text-xs text-muted">{row.chargeTitle}</p>
            <p className="mt-0.5 text-xs text-muted">{row.property}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <WizardField label="Amount" required>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </WizardField>
            <WizardField label="Due date" required>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </WizardField>
          </div>
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

/* ───────────────────────────── Payment record ───────────────────────────── */

/** The header icons of a charge's record (`buildPaymentRecordHeaderActions`): by state, delete last and red. */
function paymentActions(row: PaymentFixtureRow, onAction: (id: string) => void): DemoRecordAction[] {
  const act = (id: string) => () => onAction(id);
  if (row.bucket === "paid") {
    return paymentIsRefundable(row) ? [{ id: "refund", label: "Refund", icon: RotateCcw, tone: "primary", onClick: act("refund") }] : [];
  }
  return [
    { id: "payment-settings", label: "Payment settings", icon: Settings, onClick: act("payment-settings") },
    { id: "mark-paid", label: "Mark paid offline", icon: BadgeCheck, onClick: act("mark-paid") },
    { id: "send-reminder", label: "Send reminder", icon: Bell, tone: "primary", onClick: act("send-reminder"), demoTarget: "sheet-primary" },
    { id: "edit", label: "Edit", icon: Pencil, onClick: act("edit") },
    { id: "delete", label: "Delete", icon: Trash2, tone: "danger", onClick: act("delete") },
  ];
}

/** The charge's thread, when the resident has one among the fixture conversations. */
function threadFor(name: string) {
  const conversation = COMM_CONVERSATIONS.find((c) => c.name === name);
  return conversation ? conversation.messages.map((m) => ({ id: m.id, author: m.author, body: m.body, at: m.at, direction: m.direction })) : [];
}

export function DemoPaymentRecordView({
  row,
  onBack,
  onAction,
}: {
  row: PaymentFixtureRow;
  onBack: () => void;
  onAction: (id: string) => void;
}) {
  const [active, setActive] = useState("overview");
  const detail = demoPaymentDetail(row);
  const sections = recordSections("manager", "payment", { direction: "incoming", bucket: row.bucket }, active);
  return (
    <DemoRecordPage
      title={row.resident}
      subtitle={`${row.chargeTitle} · ${row.property}`}
      avatarName={row.resident}
      backLabel="Back to incoming payments"
      onBack={onBack}
      actions={paymentActions(row, onAction)}
      sections={sections}
      recordId={row.id}
      activeId={active}
      onActive={setActive}
      ariaLabel="Payment sections"
    >
      {active === "communication" ? (
        <DemoRecordThread name={row.resident} subtitle={row.property} messages={threadFor(row.resident)} selfName="You" />
      ) : (
        <div className="space-y-3 px-3 py-2 sm:px-4" data-attr="payment-overview-panel">
          <RecordStatTiles>
            <StatTile dataAttr="payment-overview-tile-amount" label="Amount" value={detail.amount} />
            <StatTile dataAttr="payment-overview-tile-status" label="Status" value={detail.status} tone={row.bucket === "overdue" ? "danger" : undefined} />
            <StatTile dataAttr="payment-overview-tile-due" label="Due date" value={detail.dueLabel} />
            {detail.paidOn ? (
              <StatTile dataAttr="payment-overview-tile-paid" label="Paid on" value={detail.paidOn} detail={detail.paidVia ?? undefined} />
            ) : detail.days ? (
              <StatTile dataAttr="payment-overview-tile-days" label={detail.days.label} value={detail.days.value} />
            ) : null}
          </RecordStatTiles>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <RecordFactCard title="Details" dataAttr="payment-overview-card-details">
              <RecordFactRow label="Resident" value={row.resident} />
              <RecordFactRow label="Property" value={row.property} />
              {detail.room ? <RecordFactRow label="Room" value={detail.room} /> : null}
              <RecordFactRow label="Charge" value={row.chargeTitle} />
              <RecordFactRow label={row.bucket === "paid" ? "Paid into" : "Pays into"} value="PropLane balance" />
            </RecordFactCard>
            <RecordFactCard title="History" dataAttr="payment-overview-history">
              <ol className="space-y-4 p-4">
                {detail.history.map((event, index) => (
                  <li key={`${event.at}-${index}`} className="border-l-2 border-primary/30 pl-3">
                    <span className="block text-sm font-medium">{event.at}</span>
                    <span className="text-xs text-muted">{event.label}</span>
                  </li>
                ))}
              </ol>
            </RecordFactCard>
          </div>
        </div>
      )}
    </DemoRecordPage>
  );
}

/* ───────────────────────────── Add service ───────────────────────────── */

export function DemoAddServicePopup({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [propertyId, setPropertyId] = useState(DEMO_SERVICE_PROPERTIES[0]!.id);
  const property = DEMO_SERVICE_PROPERTIES.find((p) => p.id === propertyId) ?? DEMO_SERVICE_PROPERTIES[0]!;
  const rooms = demoServiceRooms(property.label);
  const residents = demoServiceResidents(property.label);
  const [room, setRoom] = useState("");
  const [residentEmail, setResidentEmail] = useState(residents[0]?.email ?? "");
  const resident = residents.find((r) => r.email === residentEmail);
  const [addTask, setAddTask] = useState(false);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [residentCharge, setResidentCharge] = useState("");
  const [form, setForm] = useState<ServiceIntakeFormState>({
    // The "Maintenance" entry of the real service-type list (`buildServiceIntakeOptions`).
    optionKey: `repair:${MAINTENANCE_SERVICE_OFFER_ID}`,
    title: "",
    description: "Kitchen faucet is dripping.",
    categoryLabel: "General",
    priority: "Medium",
    customPriceLimit: "",
    arrivalPreset: "Anytime",
    arrivalCustom: "",
    entryPermission: "allowed",
    entryNotes: "",
  });
  const roomLabel = room || resident?.room || "";
  const serviceTitle = form.title.trim() || (form.optionKey.startsWith("repair:") ? `${form.categoryLabel} maintenance` : "Service");
  const steps = [
    { id: "where", label: "Where" },
    { id: "what", label: "What" },
    { id: "review", label: "Review" },
  ] as const;

  return (
    <DemoWorkspacePopup
      title="Add service"
      saveState="Not saved yet"
      steps={steps}
      stepHeading=""
      sidePanel={
        <PreviewPanel
          title="Service"
          name={serviceTitle}
          facts={[
            { label: "Property", value: property.label },
            { label: "Room", value: roomLabel || "—" },
            { label: "Resident", value: resident?.name ?? "—" },
            { label: "Priority", value: form.priority },
          ]}
          creates={[
            { tone: "yes", text: resident ? `Logged service for ${resident.name}` : "Logged service" },
            { tone: "no", text: "No assignment message until you assign" },
          ]}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Add service", onFinish: onAdded }}
      onClose={onClose}
      dataAttr="manager-add-service"
    >
      {(index) =>
        index === 0 ? (
          <StepColumn>
            <StepHeading title="Where" />
            <WizardSelect
              label="Property"
              value={propertyId}
              onChange={(value) => {
                setPropertyId(value);
                setRoom("");
                setResidentEmail(demoServiceResidents(DEMO_SERVICE_PROPERTIES.find((p) => p.id === value)?.label ?? "")[0]?.email ?? "");
              }}
              options={DEMO_SERVICE_PROPERTIES.map((p) => ({ value: p.id, label: p.label }))}
              placeholder="Select property"
              dataAttr="manager-service-intake-property"
            />
            <WizardSelect
              label="Room"
              value={room}
              onChange={setRoom}
              options={[{ value: "", label: "None" }, ...rooms.map((r) => ({ value: r, label: r }))]}
              placeholder="Optional"
              dataAttr="manager-service-intake-room"
            />
            <WizardSelect
              label="Resident"
              value={residentEmail}
              onChange={setResidentEmail}
              options={[{ value: "", label: "None" }, ...residents.map((r) => ({ value: r.email, label: `${r.name} · ${r.room}` }))]}
              placeholder="Optional"
              dataAttr="manager-service-intake-resident"
            />
          </StepColumn>
        ) : index === 1 ? (
          <StepColumn>
            <StepHeading title="Service" />
            <ServiceIntakeFormFields
              catalogOffers={[]}
              form={form}
              onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
              voice="manager"
              photoSlot={<ServiceIntakePhotoPicker onPick={() => undefined} />}
            />
            <ServiceTasksField
              enabled={addTask}
              onEnabledChange={setAddTask}
              assignee={assigneeId ? { type: "vendor", id: assigneeId, name: DEMO_TASK_VENDORS.find((v) => v.id === assigneeId)?.name ?? "" } : null}
              onAssigneeChange={(next) => setAssigneeId(next?.id ?? null)}
              teamMembers={DEMO_TEAM_MEMBERS}
              vendors={DEMO_TASK_VENDORS}
              dataAttr="manager-add-service-task"
            />
            <WizardField label="Resident charge">
              <Input value={residentCharge} onChange={(e) => setResidentCharge(e.target.value)} inputMode="decimal" className="bg-card" data-attr="manager-add-service-resident-charge" />
            </WizardField>
          </StepColumn>
        ) : (
          <StepColumn>
            <StepHeading title="Review" />
            <PreviewPanel
              title="Service"
              name={serviceTitle}
              facts={[
                { label: "Property", value: property.label },
                { label: "Room", value: roomLabel || "—" },
                { label: "Resident", value: resident?.name ?? "—" },
                { label: "Priority", value: form.priority },
                { label: "Assignee", value: "—" },
              ]}
              creates={[{ tone: "yes", text: "Logs a manager-initiated service" }]}
            />
          </StepColumn>
        )
      }
    </DemoWorkspacePopup>
  );
}

/* ───────────────────────────── Service record ───────────────────────────── */

const NEXT_STEP_ICON: Record<string, typeof CheckCircle2> = {
  dispatch: Send,
  schedule: CalendarDays,
  approve: CheckCircle2,
  complete: CheckCircle2,
  "approve-change-order": CheckCircle2,
};

/** Message · Edit · Cancel service (Decline request on an add-on) · Delete, and the one filled next step first. */
function serviceActions(row: MoneyServiceRow, onAction: (id: string) => void): DemoRecordAction[] {
  const act = (id: string) => () => onAction(id);
  const next = serviceNextStep(row);
  const actions: DemoRecordAction[] = [];
  if (next) {
    actions.push({
      id: next.id,
      label: next.label,
      icon: NEXT_STEP_ICON[next.id] ?? CheckCircle2,
      tone: "primary",
      onClick: act(next.id),
      demoTarget: "sheet-primary",
    });
  }
  actions.push(
    { id: "message", label: "Message", icon: Mail, onClick: act("message") },
    { id: "edit", label: "Edit", icon: Pencil, onClick: act("edit") },
  );
  if (row.stage !== "completed") {
    actions.push({ id: "cancel", label: row.kind === "add-on" ? "Decline request" : "Cancel service", icon: XCircle, tone: "danger", onClick: act("cancel") });
  }
  actions.push({ id: "delete", label: "Delete", icon: Trash2, tone: "danger", onClick: act("delete") });
  return actions;
}

const STAGE_LABEL: Record<MoneyServiceRow["stage"], string> = { open: "Open", assigned: "Assigned", scheduled: "Scheduled", completed: "Completed" };

export function DemoServiceRecordView({
  row,
  onBack,
  onAction,
}: {
  row: MoneyServiceRow;
  onBack: () => void;
  onAction: (id: string) => void;
}) {
  const [active, setActive] = useState("service");
  const ctx = row.kind === "add-on" ? ({ serviceKind: "request", serviceBucket: "pending" } as const) : ({ serviceKind: "work-order", serviceBucket: row.stage === "completed" ? "completed" : row.stage } as const);
  const sections = recordSections("manager", "service", ctx, active);
  const actions = active === "service" ? serviceActions(row, onAction) : recordActionsFromSections(sections, onAction);
  const vendor = VENDOR_ROWS.find((v) => v.name === row.vendor);
  return (
    <DemoRecordPage
      title={row.title}
      subtitle={row.resident}
      avatarName={row.resident}
      backLabel="Back to services"
      onBack={onBack}
      actions={actions}
      sections={sections}
      recordId={row.id}
      activeId={active}
      onActive={setActive}
      ariaLabel="Service sections"
    >
      {active === "vendors" ? (
        <div className="space-y-3 px-3 py-2 sm:px-4" data-attr="service-vendors-panel">
          <RecordFactCard title="Vendors" count={vendor ? 1 : 0}>
            {vendor ? (
              <>
                <RecordFactRow label="Vendor" value={vendor.name} />
                <RecordFactRow label="Trade" value={vendor.trade} />
                <RecordFactRow label="Visit" value={row.visit ?? "Not scheduled"} />
                <RecordFactRow label="Price" value={row.price ?? "Not set"} />
              </>
            ) : (
              <RecordFactRow label="Vendor" value="None yet" />
            )}
          </RecordFactCard>
        </div>
      ) : active === "incoming-payments" ? (
        <div className="space-y-3 px-3 py-2 sm:px-4" data-attr="service-incoming-payments-panel">
          <RecordFactCard title="Incoming payments">
            {row.kind === "add-on" && row.price ? (
              <>
                <RecordFactRow label="Resident" value={row.resident} />
                <RecordFactRow label="Charge" value={`${row.title} · ${row.price}`} />
              </>
            ) : (
              <RecordFactRow label="Charges" value="None" />
            )}
          </RecordFactCard>
        </div>
      ) : active === "outgoing-payments" ? (
        <div className="space-y-3 px-3 py-2 sm:px-4" data-attr="service-outgoing-payments-panel">
          <RecordFactCard title="Outgoing payments">
            {row.vendor && row.price ? (
              <>
                <RecordFactRow label="Payee" value={row.vendor} />
                <RecordFactRow label="Amount" value={row.price} />
              </>
            ) : (
              <RecordFactRow label="Payments" value="None" />
            )}
          </RecordFactCard>
        </div>
      ) : active === "communication" ? (
        <DemoRecordThread name={row.resident} subtitle={row.property} messages={threadFor(row.resident)} selfName="You" />
      ) : (
        <div className="space-y-3 px-3 py-2 sm:px-4" data-attr="service-overview-panel">
          <RecordStatTiles>
            <StatTile dataAttr="service-tile-stage" label="Stage" value={STAGE_LABEL[row.stage]} />
            <StatTile dataAttr="service-tile-visit" label="Visit" value={row.visit?.split(" – ")[0] ?? "Not scheduled"} detail={row.visit?.includes(" – ") ? row.visit.split(" – ")[1] : undefined} />
            <StatTile dataAttr="service-tile-price" label="Price" value={row.price ?? "Not set"} />
          </RecordStatTiles>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <RecordFactCard title="Request">
              <RecordFactRow label="Service" value={row.title} />
              <RecordFactRow label="Details" value={row.detail} />
            </RecordFactCard>
            <RecordFactCard title="Home">
              <RecordFactRow label="Property" value={row.property} />
              {row.room ? <RecordFactRow label="Room" value={row.room} /> : null}
              <RecordFactRow label="Resident" value={row.resident} />
              {row.vendor ? <RecordFactRow label="Assigned to" value={row.vendor} /> : null}
            </RecordFactCard>
          </div>
        </div>
      )}
    </DemoRecordPage>
  );
}

/* ───────────────────────────── New message ───────────────────────────── */

type Channel = "proplane" | "email" | "sms";

export function DemoNewMessagePopup({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [selected, setSelected] = useState<string[]>(["comm-liam"]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("Your faucet repair");
  const [body, setBody] = useState("Hi Liam, Pacific Plumbing is booked for Thursday between 10 and 12.");
  const [via, setVia] = useState<Channel[]>(["email"]);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [sendAt, setSendAt] = useState("2025-09-26T09:00");

  const recipients = COMM_RECIPIENTS.filter((r) => selected.includes(r.key)).map((r) => r.label);
  const sendLabel = scheduleLater ? "Schedule" : via.length > 1 || via.length === 0 ? "Send message" : via[0] === "sms" ? "Send SMS" : via[0] === "email" ? "Send email" : "Send message";
  const channels: { id: Channel; label: string; icon: typeof Mail }[] = [
    { id: "proplane", label: "In-app", icon: MessageSquare },
    { id: "email", label: "Email", icon: Mail },
    { id: "sms", label: "Text message", icon: Send },
  ];

  return (
    <DemoWorkspacePopup
      title="New message"
      steps={[{ id: "compose", label: "New message" }]}
      stepHeading=""
      sidePanel={
        <PanelSection title="Message preview">
          <div className="space-y-3">
            <PopupRecordPreview rows={[{ label: "Recipients", value: recipients.join(", ") || "Not selected" }]} />
            <PopupMessagePreview subject={subject} body={body} recipient={recipients.join(", ")} channel={sendLabel} sendAt={scheduleLater ? sendAt : undefined} />
          </div>
        </PanelSection>
      }
      footer={{ kind: "wizard", lastLabel: sendLabel, onFinish: onSent, hideStepCount: true }}
      onClose={onClose}
      dataAttr="communication-compose"
    >
      {() => (
        <PortalMessageComposeModalBody>
          <div className="relative">
            <label className={portalMessageFieldLabel()} htmlFor="communication-compose-recipient">
              To
            </label>
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border px-3 py-2">
              {COMM_RECIPIENTS.filter((r) => selected.includes(r.key)).map((r) => (
                <button
                  type="button"
                  key={r.key}
                  className="inline-flex items-center gap-1 text-sm"
                  aria-label={`Remove ${r.label}`}
                  onClick={() => setSelected((prev) => prev.filter((key) => key !== r.key))}
                >
                  {r.label} ×
                </button>
              ))}
              <input
                id="communication-compose-recipient"
                role="combobox"
                aria-expanded={open}
                aria-controls="communication-compose-recipient-options"
                aria-autocomplete="list"
                value={query}
                placeholder="Name, email or phone number"
                className="min-w-32 flex-1 bg-transparent py-2 text-sm outline-none"
                onFocus={() => setOpen(true)}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOpen(true);
                }}
                data-attr="communication-compose-recipient"
              />
            </div>
            {open ? (
              <div
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg"
                id="communication-compose-recipient-options"
                role="listbox"
                aria-label="Recipients"
              >
                {COMM_RECIPIENTS.filter((r) => !selected.includes(r.key) && r.label.toLowerCase().includes(query.toLowerCase())).map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      setSelected((prev) => [...prev, r.key]);
                      setQuery("");
                      setOpen(false);
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <PortalMessageSubjectField value={subject} onChange={setSubject} dataAttr="communication-compose-subject" />
          <PortalMessageBodyField value={body} onChange={setBody} placeholder="Write your message…" minHeightClass="min-h-[7rem]" dataAttr="communication-compose-body" />
          <div className="flex items-center gap-2" data-attr="communication-compose-tools">
            <button type="button" aria-label="Attach files" title="Attach files" className="grid h-10 w-10 place-items-center rounded-full text-muted hover:bg-accent" data-attr="communication-compose-attach">
              <Paperclip className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" aria-label="Draft with PropLane" title="Draft with PropLane" className="grid h-10 w-10 place-items-center rounded-full text-primary" data-attr="communication-compose-draft">
              <Sparkles className="h-4 w-4" aria-hidden />
            </button>
            <InboxComposerScheduleMenu
              scheduleLater={scheduleLater}
              onScheduleLaterChange={setScheduleLater}
              sendAt={sendAt}
              onSendAtChange={setSendAt}
              scheduleDataAttr="communication-compose-schedule-later"
              sendAtDataAttr="communication-compose-schedule-at"
            />
            {channels.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                title={label}
                aria-label={label}
                aria-pressed={via.includes(id)}
                className={`grid h-10 w-10 place-items-center rounded-full ${via.includes(id) ? "bg-primary/10 text-primary" : "text-muted"}`}
                onClick={() => setVia((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]))}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </button>
            ))}
          </div>
        </PortalMessageComposeModalBody>
      )}
    </DemoWorkspacePopup>
  );
}

