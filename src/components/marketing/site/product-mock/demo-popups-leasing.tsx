"use client";

/**
 * The pop-ups and record pages the manager Tours, Applications and Leases pages open, drawn for the home demo
 * from fixture props (captain 2026-10-08: "a lot of the pop ups in home page are not accurate to real portal").
 *
 *  Tours         "Tour availability" (Modal), "Send tour link" (`ShareLeadLinkModal kind="tour"`), "Add tour"
 *                (`ScheduleTourSimpleModal`), the tour record (Tour · Communication), and the small notification
 *                previews a tour action opens.
 *  Applications  "Send application" (`ShareLeadLinkModal kind="apply"`), "Add application" (`AddResidentWizard
 *                mode="application"`: the real step components, prop-driven) and the application record
 *                (Application · Background check · Communication).
 *  Leases        "Send lease" (`LeaseSendSheet pickResident`: one dialog, no step rail) and the lease record
 *                (Lease · Communication).
 *
 * The real doors fetch (properties, open tour times, residents, leases) and mount the assistant, so the demo
 * cannot mount them. This file draws the same shell (`demo-popup.tsx`) and the same words from the same pieces
 * (the add-workspace parts, `ShareLeadLinkPreviewPanel`, the wizard's own `ContactStep` / `HomeStep` /
 * `ApplicationStep` / `DocumentsStep` / `ReviewStep` / `ResidentSidePanel`, `recordSections`, `RecordFactCard`).
 * Nothing here fetches or saves: a primary only calls back and the panel toasts "(sample)". Loaded on demand.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  Bell,
  CalendarClock,
  CalendarDays,
  Check,
  Clock,
  Copy,
  Download,
  FileSignature,
  FolderOpen,
  Home,
  MessageSquare,
  Pencil,
  Send,
  Trash2,
  Undo2,
  Upload,
  Users,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { DemoFilterSheet, portalFilterActiveCount } from "@/components/marketing/site/product-mock/demo-filter";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { LeaseFilterFields, type LeaseUpdatedWindow } from "@/components/portal/lease-filter-fields";
import { DEFAULT_PORTAL_LIST_GROUP_MODE, type PortalListGroupMode } from "@/lib/portal-list-grouping";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { PortalMessageSendViaDropdown, portalMessageChannelsFromSelection } from "@/components/portal/portal-message-compose-fields";
import { ShareLeadLinkPreviewPanel } from "@/components/portal/share-lead-link-preview-panel";
import { StepColumn, SegmentedControl } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  ReviewCard,
  WizardField,
  WizardLine,
  WizardMultiSelect,
  WizardRow,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { WorkspaceFileCard, WorkspaceHeaderUploadPresent } from "@/components/portal/add-workspace/upload-action";
import { ContactStep } from "@/components/portal/resident-wizard/step-contact";
import { HomeStep } from "@/components/portal/resident-wizard/step-home";
import { ApplicationStep } from "@/components/portal/resident-wizard/step-application";
import { DocumentsStep } from "@/components/portal/resident-wizard/step-documents";
import { ReviewStep } from "@/components/portal/resident-wizard/step-review";
import { ResidentSidePanel } from "@/components/portal/resident-wizard/side-panel";
import type { ResidentWizardDerived } from "@/components/portal/resident-wizard/derived";
import { emptyAddPersonForm, type AddPersonForm } from "@/components/portal/resident-wizard/state";
import { DateField } from "@/components/ui/date-field";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { buildLeadInviteEmailBody, leadInviteSubject, type LeadInviteKind } from "@/lib/lead-invite-email";
import { recordSections } from "@/lib/portals/record-sections";
import { APPLICATION_DETAIL_TAB_LABELS } from "@/lib/portal-detail-routes";
import { cn } from "@/lib/utils";
import { DemoWorkspacePopup } from "@/components/marketing/site/product-mock/demo-popup";
import {
  DemoRecordPage,
  DemoRecordThread,
  RecordFactCard,
  RecordFactRow,
  type DemoRecordAction,
} from "@/components/marketing/site/product-mock/demo-record";
import { MANAGER_NAME, type ApplicationFixtureRow, type LeaseFixtureRow, type TourFixtureRow } from "@/components/marketing/site/product-mock/fixtures";
import {
  DEMO_LEASE_CANDIDATES,
  DEMO_LEASE_FEE,
  DEMO_LEASE_FORMS,
  LEASING_PROPERTIES,
  TOUR_AVAILABILITY_DAYS,
  TOUR_AVAILABILITY_HOURS,
  TOUR_NOTES,
  TOUR_OPEN_SLOTS,
  applicationTabOf,
  demoApplicationDetail,
  demoLeaseDetail,
  demoLeaseSchedule,
  demoLeaseSigners,
  demoScreening,
  demoShareLink,
  demoThread,
  hourLabel,
  placeProperty,
  placeRoom,
  tourStatusLabel,
  type DemoLeaseCandidate,
  type DemoSigner,
} from "@/components/marketing/site/product-mock/fixtures-popups-leasing";

const money = (amount: number) => `$${Math.round(amount).toLocaleString("en-US")}`;
const firstName = (name: string) => name.split(/\s+/)[0] || name;

/** The pop-up's cancel at the footer's left, like the real send pop-ups. */
function CancelButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} className="min-h-[44px] rounded-full px-6 text-[13.5px] font-semibold text-muted hover:bg-foreground/5" data-attr="demo-popup-cancel">
      Cancel
    </button>
  );
}

/* ═════════════════════════════════ the Filter popovers ═════════════════════════════════ */

type PropertyOption = { id: string; label: string };

/** Tours: Property (one house) and Group by (Sort by resident / Sort by house), `pro-tours.tsx`. */
export function DemoToursFilter({
  groupMode,
  onGroupModeChange,
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
}: {
  groupMode: PortalListGroupMode;
  onGroupModeChange: (next: PortalListGroupMode) => void;
  propertyOptions: PropertyOption[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
}) {
  return (
    <DemoFilterSheet
      activeCount={propertyFilters.length > 0 ? 1 : 0}
      compactPanel
      commandStripTrigger
      filterFieldCount={2}
      mobileFlushBody
      constrainDropdownToTitleBand={false}
      onReset={() => {
        onPropertyFiltersChange([]);
        onGroupModeChange(DEFAULT_PORTAL_LIST_GROUP_MODE);
      }}
      dataAttr="tours-filter-sheet-open"
    >
      <PortalListGroupFilterFields
        groupMode={groupMode}
        onGroupModeChange={onGroupModeChange}
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={onPropertyFiltersChange}
        propertyDataAttr="tours-filter-property"
        groupModeDataAttr="tours-filter-group-mode"
      />
    </DemoFilterSheet>
  );
}

/** Applications: one field, Property (several houses), `pro-applications.tsx`. */
export function DemoApplicationsFilter({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
}: {
  propertyOptions: PropertyOption[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
}) {
  return (
    <DemoFilterSheet
      activeCount={portalFilterActiveCount([propertyFilters])}
      compactPanel
      commandStripTrigger
      filterFieldCount={1}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => onPropertyFiltersChange([])}
      dataAttr="applications-filter-sheet-open"
    >
      <ApplicationFilterSortFields propertyOptions={propertyOptions} propertyFilters={propertyFilters} onPropertyFiltersChange={onPropertyFiltersChange} selectionMode="multi" />
    </DemoFilterSheet>
  );
}

/** Leases: Property · Stage · Updated (`lease-filter-fields.tsx`). */
export function DemoLeasesFilter({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  stageOptions,
  stageFilters,
  onStageFiltersChange,
  updatedWindow,
  onUpdatedWindowChange,
}: {
  propertyOptions: PropertyOption[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  stageOptions: { value: string; label: string }[];
  stageFilters: string[];
  onStageFiltersChange: (next: string[]) => void;
  updatedWindow: LeaseUpdatedWindow;
  onUpdatedWindowChange: (next: LeaseUpdatedWindow) => void;
}) {
  return (
    <DemoFilterSheet
      activeCount={portalFilterActiveCount([propertyFilters, stageFilters, updatedWindow === "any" ? "" : updatedWindow])}
      compactPanel
      commandStripTrigger
      filterFieldCount={3}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => {
        onPropertyFiltersChange([]);
        onStageFiltersChange([]);
        onUpdatedWindowChange("any");
      }}
      dataAttr="leases-filter-sheet-open"
    >
      <LeaseFilterFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={onPropertyFiltersChange}
        stageOptions={stageOptions}
        stageFilters={stageFilters}
        onStageFiltersChange={onStageFiltersChange}
        updatedWindow={updatedWindow}
        onUpdatedWindowChange={onUpdatedWindowChange}
      />
    </DemoFilterSheet>
  );
}

/* ═════════════════════════════════ small notification preview ═════════════════════════════════ */

/**
 * `PortalNotificationPreviewModal`: who it goes to, the subject and the message, a "don't message" door, and
 * one commit word. Tours open it for Confirm / Decline / Cancel / Reschedule / Message guest, Leases for a
 * signing reminder, Applications for a completion reminder.
 */
export function DemoNotifyPopup({
  title,
  recipient,
  recipientPhone,
  subject,
  body,
  skipLabel,
  confirmLabel,
  onClose,
  onConfirm,
  onSkip,
}: {
  title: string;
  recipient: string;
  recipientPhone?: string;
  subject: string;
  body: string;
  skipLabel?: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
  onSkip?: () => void;
}) {
  const [via, setVia] = useState<string[]>(["email"]);
  const [subjectText, setSubjectText] = useState(subject);
  const [bodyText, setBodyText] = useState(body);
  return (
    <DemoWorkspacePopup
      title={title}
      steps={[{ id: "notify", label: title }]}
      stepHeading=""
      footer={{
        kind: "done",
        label: confirmLabel,
        onDone: onConfirm,
        left: skipLabel ? (
          <button type="button" onClick={onSkip ?? onClose} className="min-h-[44px] rounded-full px-5 text-[13.5px] font-semibold text-muted hover:bg-foreground/5" data-attr="demo-notify-skip">
            {skipLabel}
          </button>
        ) : (
          <CancelButton onClose={onClose} />
        ),
      }}
      onClose={onClose}
      dataAttr="demo-notify-popup"
    >
      {() => (
        <div className="max-w-[560px] space-y-4">
          <WizardField label="To">
            <Input value={[recipient, recipientPhone].filter(Boolean).join(" · ")} readOnly data-attr="demo-notify-to" />
          </WizardField>
          <PortalMessageSendViaDropdown selected={via} onChange={setVia} smsAvailable={Boolean(recipientPhone)} footerNote="" dataAttr="demo-notify-send-via" />
          {subject ? (
            <WizardField label="Subject">
              <Input value={subjectText} onChange={(e) => setSubjectText(e.target.value)} data-attr="demo-notify-subject" />
            </WizardField>
          ) : null}
          <WizardField label="Message">
            <Textarea className="min-h-[140px]" value={bodyText} onChange={(e) => setBodyText(e.target.value)} data-attr="demo-notify-body" />
          </WizardField>
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

/* ═════════════════════════════════ Tours ═════════════════════════════════ */

/** "Tour availability": the Modal behind the Add availability icon, a Property select over the week's open windows. */
export function DemoTourAvailabilityPopup({ onClose }: { onClose: () => void }) {
  const [propertyId, setPropertyId] = useState(LEASING_PROPERTIES[0]!.id);
  const [open, setOpen] = useState<Record<string, Set<string>>>(() => {
    const seed: Record<string, Set<string>> = {};
    for (const property of LEASING_PROPERTIES) {
      const keys = new Set<string>();
      for (const day of TOUR_AVAILABILITY_DAYS) for (const [from, to] of day.windows) for (let hour = from; hour < to; hour += 1) keys.add(`${day.id}:${hour}`);
      seed[property.id] = keys;
    }
    return seed;
  });
  const current = open[propertyId] ?? new Set<string>();
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev[propertyId] ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [propertyId]: next };
    });
  const property = LEASING_PROPERTIES.find((p) => p.id === propertyId) ?? LEASING_PROPERTIES[0]!;

  return (
    <DemoWorkspacePopup
      title="Tour availability"
      steps={[{ id: "availability", label: "Tour availability" }]}
      stepHeading=""
      footer={{ kind: "done", onDone: onClose }}
      onClose={onClose}
      dataAttr="tour-availability-modal"
    >
      {() => (
        <div className="space-y-4">
          <div className="max-w-sm">
            <FieldSingleSelect
              label="Property"
              value={propertyId}
              onChange={setPropertyId}
              options={LEASING_PROPERTIES.map((p) => ({ value: p.id, label: p.label }))}
              dataAttr="tour-availability-property"
            />
          </div>
          <section className="overflow-hidden rounded-[10px] border border-border bg-card" aria-label={`Tour availability for ${property.label}`}>
            <div className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b border-border bg-[var(--pl-surface-muted)] text-[12px] font-semibold text-muted">
              <span />
              {TOUR_AVAILABILITY_DAYS.map((day) => (
                <span key={day.id} className="px-1 py-2 text-center">
                  {day.label}
                </span>
              ))}
            </div>
            {TOUR_AVAILABILITY_HOURS.map((hour) => (
              <div key={hour} className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b border-border/60 last:border-b-0">
                <span className="px-2 py-1.5 text-right text-[11.5px] text-muted">{hourLabel(hour)}</span>
                {TOUR_AVAILABILITY_DAYS.map((day) => {
                  const key = `${day.id}:${hour}`;
                  const on = current.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={on}
                      aria-label={`${day.label} ${hourLabel(hour)}`}
                      onClick={() => toggle(key)}
                      data-attr="tour-availability-cell"
                      className={cn("h-7 border-l border-border/60 transition", on ? "bg-primary/15 hover:bg-primary/25" : "bg-card hover:bg-foreground/[0.04]")}
                    />
                  );
                })}
              </div>
            ))}
          </section>
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

const SHARE_STEPS_ID = ["home", "recipient", "review"] as const;

/**
 * `ShareLeadLinkModal`: Home (the house, the room, the link to copy) · Recipient (how it goes, who gets it) · Review,
 * with the real invite preview flush right. `kind` is the tour link (Tours) or the application link (Applications).
 */
export function DemoShareLinkPopup({
  kind,
  onClose,
  onSent,
  onToast,
  startAtReview = false,
}: {
  kind: Extract<LeadInviteKind, "tour" | "apply">;
  onClose: () => void;
  onSent: () => void;
  onToast?: (text: string) => void;
  /** Open on Review with everything filled, so the commit word ("Send") is the footer primary at once (the hero story's cursor clicks it). */
  startAtReview?: boolean;
}) {
  const apply = kind === "apply";
  const [step, setStep] = useState(startAtReview ? SHARE_STEPS_ID.length - 1 : 0);
  const [propertyIds, setPropertyIds] = useState<string[]>([apply ? "prop-willow" : "prop-alder"]);
  const [room, setRoom] = useState(apply ? "Room 3" : "");
  const [sendVia, setSendVia] = useState<string[]>(["email", "sms"]);
  const [name, setName] = useState("Jordan");
  const [email, setEmail] = useState("jordan@example.com");
  const [phone, setPhone] = useState("(206) 555-0186");
  const [note, setNote] = useState("");
  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);

  const chosen = propertyIds.map((id) => LEASING_PROPERTIES.find((p) => p.id === id)).filter((p): p is (typeof LEASING_PROPERTIES)[number] => Boolean(p));
  const single = chosen.length === 1 ? chosen[0]! : null;
  const roomShown = single && single.rooms.includes(room) ? room : "";
  const propertyTitle = chosen.length === 0 ? "" : chosen.length > 1 ? `${chosen.length} properties` : [single!.label, roomShown].filter(Boolean).join(" · ");
  const subjectTitle = single ? roomShown || single.label : "";
  const linkLabel = apply ? "Apply link" : "Tour link";
  const linkUrl = demoShareLink(kind, chosen.map((p) => p.label));
  const subject = leadInviteSubject(kind, subjectTitle, chosen.length > 1 ? chosen.length : undefined);
  const previewBody = buildLeadInviteEmailBody({ kind, prospectName: name, propertyTitle: propertyTitle || "a property", linkUrl, managerNote: note, tourCount: chosen.length });
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneValid = phone.replace(/\D/g, "").length >= 10;
  const recipientReady = (viaEmail || viaSms) && (!viaEmail || emailValid) && (!viaSms || phoneValid);
  const channel = viaEmail && viaSms ? "Email and text" : viaSms ? "Text" : viaEmail ? "Email" : "Not set";
  const goTo = (id: (typeof SHARE_STEPS_ID)[number]) => setStep(SHARE_STEPS_ID.indexOf(id));

  const steps = useMemo(
    () => [
      { id: "home", label: "Home", summary: propertyTitle || "No property yet" },
      { id: "recipient", label: "Recipient", summary: name.trim() ? [name.trim(), viaEmail ? email.trim() : "", viaSms ? phone.trim() : ""].filter(Boolean).join(" · ") : "Who receives this" },
      { id: "review", label: "Review", summary: chosen.length === 0 || !recipientReady ? "Finish required fields" : "Ready to send" },
    ],
    [propertyTitle, name, email, phone, viaEmail, viaSms, chosen.length, recipientReady],
  );

  return (
    <DemoWorkspacePopup
      title={apply ? "Send application" : "Send tour link"}
      steps={steps}
      step={step}
      onStep={setStep}
      sidePanel={
        <div className="space-y-3">
          <ShareLeadLinkPreviewPanel
            kind={kind}
            prospectName={name}
            prospectEmail={email}
            prospectPhone={phone}
            propertyTitle={propertyTitle}
            viaEmail={viaEmail}
            viaSms={viaSms}
            senderName={MANAGER_NAME}
            workNumber="(206) 555-0100"
            previewBody={previewBody}
            propertyMissing={chosen.length === 0}
            recipientReady={recipientReady}
          />
          <section aria-label="Subject">
            <h3 className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">Subject</h3>
            <p className="rounded-2xl border border-border bg-card p-3.5 text-[13px] font-semibold text-foreground" data-attr="share-lead-subject">
              {subject}
            </p>
          </section>
        </div>
      }
      footer={{ kind: "wizard", lastLabel: "Send", onFinish: onSent, hideStepCount: true }}
      onClose={onClose}
      dataAttr="share-lead-popup"
    >
      {(index) => (
        <StepColumn>
          {index === 0 ? (
            <WizardSection title="Property" dataAttr="share-lead-home">
              <WizardMultiSelect
                label="Properties"
                dataAttr="share-lead-property-multi"
                emptyLabel="Select properties"
                emptyMenuText="No properties"
                options={LEASING_PROPERTIES.map((p) => ({ value: p.id, label: p.label }))}
                selected={propertyIds}
                onChange={(next) => {
                  setPropertyIds(next);
                  setRoom("");
                }}
                required
              />
              {single && single.rooms.length > 0 ? (
                <div className="mt-3">
                  <WizardSelect
                    label="Room"
                    value={roomShown}
                    onChange={setRoom}
                    options={[{ value: "", label: "Any room" }, ...single.rooms.map((r) => ({ value: r, label: r }))]}
                    dataAttr="share-lead-room"
                  />
                </div>
              ) : null}
              <div className="mt-3 border-t border-border/60 pt-3">
                <WizardLine
                  label={linkLabel}
                  control={
                    <span className="flex max-w-[min(320px,55vw)] items-center gap-1">
                      <span className="truncate text-[13px] font-semibold text-foreground">{linkUrl || "—"}</span>
                      <PortalIconAction icon={Copy} label={`Copy ${linkLabel.toLowerCase()}`} disabled={!linkUrl} data-attr="share-lead-copy-link" onClick={() => onToast?.("Link copied (sample)")} />
                    </span>
                  }
                />
              </div>
            </WizardSection>
          ) : null}
          {index === 1 ? (
            <>
              <WizardSection title="Delivery" dataAttr="share-lead-delivery">
                <PortalMessageSendViaDropdown selected={sendVia} onChange={setSendVia} smsAvailable footerNote="" dataAttr="share-lead-send-via" />
              </WizardSection>
              <WizardSection title="Contact" dataAttr="share-lead-recipient">
                <WizardRow cols={2}>
                  <WizardField label="Name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} data-attr="share-lead-name" />
                  </WizardField>
                  {viaEmail ? (
                    <WizardField label="Email" required>
                      <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-attr="share-lead-email" />
                    </WizardField>
                  ) : null}
                  {viaSms ? (
                    <WizardField label="Phone" required>
                      <PhoneNumberField value={phone} onChange={setPhone} dataAttr="share-lead-phone" />
                    </WizardField>
                  ) : null}
                </WizardRow>
              </WizardSection>
            </>
          ) : null}
          {index === 2 ? (
            <>
              <ReviewCard
                title="Home"
                status={chosen.length === 0 ? "incomplete" : "complete"}
                onEdit={() => goTo("home")}
                dataAttr="share-lead-review-home"
                facts={[
                  { label: "Property", value: propertyTitle || "Not set", missing: chosen.length === 0 },
                  { label: linkLabel, value: linkUrl ? "Ready" : "Not set", missing: !linkUrl },
                ]}
              />
              <ReviewCard
                title="Recipient"
                status={recipientReady ? "complete" : "incomplete"}
                onEdit={() => goTo("recipient")}
                dataAttr="share-lead-review-recipient"
                facts={[
                  { label: "Name", value: name.trim() || "—" },
                  { label: "Channel", value: channel, missing: !viaEmail && !viaSms },
                  ...(viaEmail ? [{ label: "Email", value: email.trim() || "Not set", missing: !emailValid }] : []),
                  ...(viaSms ? [{ label: "Phone", value: phone.trim() || "Not set", missing: !phoneValid }] : []),
                ]}
              />
              <WizardSection title="Note" dataAttr="share-lead-review-note">
                <Textarea aria-label="Message" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[96px]" data-attr="share-lead-message" />
              </WizardSection>
            </>
          ) : null}
        </StepColumn>
      )}
    </DemoWorkspacePopup>
  );
}

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** "Add tour": `ScheduleTourSimpleModal`, Home · Date & time · Visitor · Review, the "Tour preview" flush right. */
export function DemoAddTourPopup({ onClose, onAdded }: { onClose: () => void; onAdded: (tour: Pick<TourFixtureRow, "guest" | "email" | "phone" | "place" | "when" | "format">) => void }) {
  const [step, setStep] = useState(0);
  const [propertyId, setPropertyId] = useState("prop-alder");
  const [room, setRoom] = useState("");
  const [format, setFormat] = useState<"in_person" | "virtual">("in_person");
  const [date, setDate] = useState("2025-09-27");
  const [slot, setSlot] = useState("2:00 PM");
  const [name, setName] = useState("Taylor Brooks");
  const [phone, setPhone] = useState("(206) 555-0102");
  const [email, setEmail] = useState("taylor.brooks@example.com");
  const [notes, setNotes] = useState("");
  const property = LEASING_PROPERTIES.find((p) => p.id === propertyId);
  const roomShown = property?.rooms.includes(room) ? room : "";

  const issues = [
    !property ? "Choose a property." : "",
    !slot ? "Choose an open time." : "",
    !name.trim() ? "Enter the visitor's name." : "",
  ];
  const steps = useMemo(
    () => ["Home", "Date & time", "Visitor", "Review"].map((label, index) => ({ id: String(index), label, attention: issues[index] ? 1 : 0 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [property, slot, name],
  );
  const facts: [string, string][] = [
    ["Property", property?.label ?? ""],
    ["Room", roomShown || "Any room"],
    ["Format", format === "virtual" ? "Virtual" : "In person"],
    ["Date & time", slot ? `${longDate(date)} · ${slot} Pacific` : ""],
    ["Visitor", name],
    ["Email", email],
    ["Phone", phone],
    ["Notes", notes],
  ];
  const review = (
    <dl className="divide-y divide-border rounded-2xl border border-border bg-card px-5">
      {facts.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 py-4 text-sm">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 break-words text-right font-semibold">{value || "Not set"}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <DemoWorkspacePopup
      title="Add tour"
      steps={steps}
      step={step}
      onStep={setStep}
      stepHeading=""
      saveState="Not saved yet"
      railHeader={<div className="rounded-2xl border border-dashed border-border p-6 text-center font-semibold">Contact and tour</div>}
      sidePanel={
        <aside>
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wide">Tour preview</h3>
          {review}
        </aside>
      }
      footer={{
        kind: "wizard",
        lastLabel: "Add tour",
        onFinish: () =>
          onAdded({
            guest: name.trim() || "Visitor",
            email: email.trim(),
            phone: phone.trim(),
            place: [property?.label ?? "", roomShown].filter(Boolean).join(" · "),
            when: `${new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${slot}`,
            format: format === "virtual" ? "virtual" : undefined,
          }),
      }}
      onClose={onClose}
      dataAttr="schedule-tour-simple-popup"
    >
      {(index) => (
        <>
          {index === 0 ? (
            <>
              <WizardSection title="Property" dataAttr="schedule-tour-simple-home">
                <WizardRow cols={2}>
                  <WizardSelect
                    label="Property"
                    value={propertyId}
                    onChange={(next) => {
                      setPropertyId(next);
                      setRoom("");
                    }}
                    options={LEASING_PROPERTIES.map((p) => ({ value: p.id, label: p.label }))}
                    placeholder="Select property…"
                    dataAttr="schedule-tour-simple-property"
                  />
                  {property && property.rooms.length > 0 ? (
                    <WizardSelect
                      label="Room"
                      value={roomShown}
                      onChange={setRoom}
                      options={[{ value: "", label: "Any room" }, ...property.rooms.map((r) => ({ value: r, label: r }))]}
                      placeholder="Select room…"
                      dataAttr="schedule-tour-simple-room"
                    />
                  ) : (
                    <WizardSelect
                      label="Lease bundle"
                      value=""
                      onChange={() => undefined}
                      options={[{ value: "", label: "None: the whole place" }]}
                      dataAttr="schedule-tour-simple-bundle"
                    />
                  )}
                </WizardRow>
              </WizardSection>
              <WizardSelect
                label="Format"
                value={format}
                onChange={(next) => setFormat(next === "virtual" ? "virtual" : "in_person")}
                options={[
                  { value: "in_person", label: "In person" },
                  { value: "virtual", label: "Virtual" },
                ]}
                dataAttr="schedule-tour-simple-format"
              />
            </>
          ) : null}
          {index === 1 ? (
            <WizardSection title="Date & time" dataAttr="schedule-tour-simple-when">
              <WizardField label="Date" required>
                <DateField value={date} onChange={setDate} aria-label="Tour date" data-attr="schedule-tour-simple-date" />
              </WizardField>
              <div className="mt-3">
                <span className="mb-1.5 block text-[12.5px] font-bold text-foreground">Open times · Pacific time</span>
                <div className="flex flex-wrap gap-2" data-attr="schedule-tour-simple-slots">
                  {TOUR_OPEN_SLOTS.map((label) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setSlot(label)}
                      data-attr="schedule-tour-simple-slot"
                      aria-pressed={label === slot}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[13px] font-semibold transition",
                        label === slot ? "border-primary bg-primary text-white" : "border-border bg-card text-foreground hover:border-primary/50",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </WizardSection>
          ) : null}
          {index === 2 ? (
            <WizardSection title="Visitor" dataAttr="schedule-tour-simple-visitor">
              <WizardRow cols={3}>
                <WizardField label="Name" required>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" data-attr="schedule-tour-simple-name" />
                </WizardField>
                <WizardField label="Phone">
                  <PhoneNumberField value={phone} onChange={setPhone} dataAttr="schedule-tour-simple-phone" />
                </WizardField>
                <WizardField label="Email">
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" data-attr="schedule-tour-simple-email" />
                </WizardField>
              </WizardRow>
              <div className="mt-3">
                <WizardField label="Notes for the tour">
                  <Textarea className="min-h-[72px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Parking, which key, who to meet…" data-attr="schedule-tour-simple-notes" />
                </WizardField>
              </div>
            </WizardSection>
          ) : null}
          {index === 3 ? <WizardSection title="Review">{review}</WizardSection> : null}
        </>
      )}
    </DemoWorkspacePopup>
  );
}

/** What a tour record's header can do, per bucket (pro-tours.tsx: Confirm · Message guest · Reschedule · Decline / Cancel · Delete). */
export type DemoTourActionId = "confirm" | "message" | "reschedule" | "decline" | "cancel" | "delete";

export function DemoTourRecord({ row, onBack, onAction }: { row: TourFixtureRow; onBack: () => void; onAction: (id: DemoTourActionId) => void }) {
  const sections = useMemo(() => recordSections("manager", "tour", { tourBucket: row.bucket }), [row.bucket]);
  const [active, setActive] = useState("overview");
  const pending = row.bucket === "pending";
  const upcoming = row.bucket === "upcoming";
  const act = (id: DemoTourActionId) => () => onAction(id);
  const actions: DemoRecordAction[] = [];
  if (pending) actions.push({ id: "confirm", label: "Confirm", icon: Check, tone: "primary", onClick: act("confirm") });
  actions.push({ id: "message", label: "Message guest", icon: MessageSquare, onClick: act("message") });
  if (pending || upcoming) actions.push({ id: "reschedule", label: "Reschedule", icon: CalendarClock, onClick: act("reschedule") });
  if (pending) actions.push({ id: "decline", label: "Decline", icon: XCircle, onClick: act("decline") });
  else if (upcoming) actions.push({ id: "cancel", label: "Cancel tour", icon: XCircle, onClick: act("cancel") });
  actions.push({ id: "delete", label: "Delete tour", icon: Trash2, tone: "danger", onClick: act("delete") });
  const notes = TOUR_NOTES[row.id];
  const property = placeProperty(row.place);
  const room = placeRoom(row.place);

  return (
    <DemoRecordPage
      title={row.guest}
      subtitle={row.when}
      avatarName={row.guest}
      backLabel="Back to tours"
      onBack={onBack}
      actions={actions}
      sections={sections}
      recordId={row.id}
      activeId={active}
      onActive={setActive}
      ariaLabel="Tour sections"
    >
      {active === "communication" ? (
        <DemoRecordThread name={row.guest} subtitle={row.place} messages={demoThread("tour", row.guest, row.place, MANAGER_NAME)} selfName={MANAGER_NAME} />
      ) : (
        <div className="space-y-4" data-attr="tour-detail-sections">
          <RecordFactCard title="Tour" dataAttr="record-overview-card-tour">
            <RecordFactRow label="Status" value={tourStatusLabel(row.bucket)} />
            <RecordFactRow label="When" value={row.when} />
            <RecordFactRow label="Property" value={property} />
            <RecordFactRow label="Room" value={room || "—"} />
            <RecordFactRow label="Format" value={row.format === "virtual" ? "Virtual" : "In person"} />
            {notes ? <RecordFactRow label="Notes" value={notes} /> : null}
          </RecordFactCard>
          <RecordFactCard title="Prospect" dataAttr="record-overview-card-prospect">
            <RecordFactRow label="Name" value={row.guest} />
            <RecordFactRow label="Email" value={row.email || "—"} />
            <RecordFactRow label="Phone" value={row.phone || "—"} />
          </RecordFactCard>
        </div>
      )}
    </DemoRecordPage>
  );
}

/* ═════════════════════════════════ Applications ═════════════════════════════════ */

const APPLICATION_STEP_IDS = ["contact", "home", "application", "documents", "review"] as const;

/** The listing-derived data the real steps read from the local stores, written out for the demo's house. */
function demoDerived(propertyId: string): ResidentWizardDerived {
  const property = LEASING_PROPERTIES.find((p) => p.id === propertyId);
  const rooms = property?.rooms ?? [];
  const rent = Number((property?.rentLabel ?? "").replace(/[^0-9]/g, "")) || undefined;
  return {
    roomOptions: rooms.map((name) => ({ id: name, name, monthlyRent: rent })),
    bundleOptions: [],
    leaseTermOptions: [],
    leaseTermPresetValues: [],
    customLeaseTermHidden: false,
    rentedByRoom: rooms.length > 0,
    entireHome: Boolean(property) && rooms.length === 0,
    showBundleSelect: false,
    showRoomSelect: rooms.length > 0,
    rentalType: "standard",
    isShortTerm: false,
    isAirbnb: false,
    isMonthToMonth: false,
    applicationConfig: null,
    customQuestions: property
      ? [
          { id: "q-smoke", key: "smoke", label: "Do you smoke?", type: "yes_no", required: false, options: [] },
          { id: "q-movein", key: "move-in-note", label: "Anything we should know about your move-in date?", type: "long_text", required: false, options: [] },
        ]
      : [],
    fieldEnabled: () => true,
    listingSays: property ? `${rooms[0] ? `${rooms[2] ?? rooms[0]}` : property.label}${rent ? ` · $${rent.toLocaleString("en-US")}/mo listed` : ""}` : null,
  };
}

function demoApplicationForm(): AddPersonForm {
  return {
    ...emptyAddPersonForm("prospect"),
    name: "Taylor Brooks",
    email: "taylor.brooks@example.com",
    phone: "(206) 555-0102",
    propertyId: "prop-alder",
    roomId: "Room 3",
    application: {
      dateOfBirth: "1996-04-12",
      occupancyCount: "1",
      pets: "",
      employer: "Northwind Coffee",
      jobTitle: "Shift lead",
      monthlyIncome: "3900",
      employmentStart: "2022-03-01",
      currentStreet: "412 Pine St",
      currentCity: "Seattle",
      currentState: "WA",
      currentZip: "98101",
      currentLandlordName: "Harper Property Group",
      currentMoveIn: "2023-06-01",
      prevStreet: "88 Union Ave",
      prevCity: "Tacoma",
      prevState: "WA",
      prevLandlordName: "Lee Property Co",
      ref1Name: "Dana Whitfield",
      ref1Relationship: "Former landlord",
      ref1Phone: "(206) 555-0170",
      evictionHistory: "No",
      bankruptcyHistory: "No",
      criminalHistory: "No",
    },
    customAnswers: { smoke: "no" },
  };
}

/**
 * "Add application": `AddResidentWizard mode="application"`. The five steps are the wizard's own components,
 * fed a hand-written `derived` (the listing data the real hook reads from local stores).
 */
export function DemoAddApplicationPopup({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (application: Pick<ApplicationFixtureRow, "name" | "email" | "property" | "unit">) => void;
}) {
  const [form, setForm] = useState<AddPersonForm>(demoApplicationForm);
  const [step, setStep] = useState(0);
  const patch = (next: Partial<AddPersonForm>) => setForm((prev) => ({ ...prev, ...next }));
  const derived = useMemo(() => demoDerived(form.propertyId), [form.propertyId]);
  const property = LEASING_PROPERTIES.find((p) => p.id === form.propertyId);
  const propertyLabel = property?.label ?? null;
  const a = form.application;
  const appFilled = [a.employer ? "Employment" : null, a.currentStreet ? "address" : null, a.ref1Name ? "1 reference" : null].filter(Boolean).join(" · ");
  const steps = [
    { id: "contact", label: "Applicant", summary: form.name.trim() ? [form.name.trim(), form.email.trim()].filter(Boolean).join(" · ") : "Who is applying" },
    { id: "home", label: "Home", summary: propertyLabel ? `${propertyLabel}${derived.listingSays ? ` · ${derived.listingSays.split(" · ")[0]}` : ""}` : "No property yet" },
    { id: "application", label: "Application", offPath: true, summary: appFilled || "The house's questions" },
    { id: "documents", label: "Documents", offPath: true, summary: form.documents.length ? `${form.documents.length} attached` : "None attached" },
    { id: "review", label: "Review", summary: "Ready to add" },
  ];
  const goTo = (id: string) => setStep(Math.max(0, APPLICATION_STEP_IDS.indexOf(id as (typeof APPLICATION_STEP_IDS)[number])));
  const noop = () => undefined;

  return (
    <DemoWorkspacePopup
      title="Add application"
      subtitle={propertyLabel ?? undefined}
      saveState="Not saved yet"
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
      sidePanel={<ResidentSidePanel form={form} derived={derived} propertyLabel={propertyLabel} mode="application" />}
      footer={{
        kind: "wizard",
        lastLabel: "Add application",
        onFinish: () => onAdded({ name: form.name.trim() || "Applicant", email: form.email.trim(), property: propertyLabel ?? "", unit: form.roomId || "Whole home" }),
      }}
      onClose={onClose}
      dataAttr="application-wizard-popup"
    >
      {(index) => (
        <WorkspaceHeaderUploadPresent.Provider value>
          {index === 0 ? (
            <WorkspaceFileCard accept="application/pdf,image/*" chips={[".pdf", "images", "PDF up to 3.5 MB"]} onPick={noop} label="Upload a file" dataAttr="residents-wizard-header-upload" />
          ) : null}
          {index === 0 ? <ContactStep form={form} patch={patch} strip={{ kind: "blank" }} onPickFile={noop} onUndoFill={noop} busy={false} lockKind mode="application" /> : null}
          {index === 1 ? <HomeStep form={form} patch={patch} derived={derived} propertyOptions={LEASING_PROPERTIES.map((p) => ({ id: p.id, label: p.label }))} /> : null}
          {index === 2 ? <ApplicationStep form={form} patch={patch} derived={derived} propertyLabel={propertyLabel} onPickApplicationFile={noop} /> : null}
          {index === 3 ? <DocumentsStep form={form} patch={patch} onPickFile={noop} busy={false} /> : null}
          {index === 4 ? <ReviewStep form={form} patch={patch} derived={derived} propertyLabel={propertyLabel} goTo={goTo} mode="application" /> : null}
        </WorkspaceHeaderUploadPresent.Provider>
      )}
    </DemoWorkspacePopup>
  );
}

export type DemoApplicationActionId = "approve" | "send-lease" | "upload-for-resident" | "download" | "pending" | "reject" | "delete";

/** An application record: Application · Background check · Communication, with the row's actions in the header. */
export function DemoApplicationRecord({
  row,
  onBack,
  onAction,
}: {
  row: ApplicationFixtureRow;
  onBack: () => void;
  onAction: (id: DemoApplicationActionId) => void;
}) {
  const tab = applicationTabOf(row);
  const sections = useMemo(() => recordSections("manager", "application", { bucket: tab }), [tab]);
  const [active, setActive] = useState("overview");
  const detail = demoApplicationDetail(row);
  const screening = demoScreening(row);
  const approvable = tab === "pending";
  const act = (id: DemoApplicationActionId) => () => onAction(id);

  // Approve · Send lease · Upload for resident · Download · Move to pending · Decline · Delete (pro-applications.tsx).
  const actions: DemoRecordAction[] = [];
  if (approvable) actions.push({ id: "approve", label: "Approve", icon: Check, tone: "primary", demoTarget: "sheet-primary", onClick: act("approve") });
  if (tab === "approved") actions.push({ id: "send-lease", label: "Send lease", icon: Send, tone: "primary", onClick: act("send-lease") });
  actions.push({ id: "upload-for-resident", label: "Upload for resident", icon: Upload, onClick: act("upload-for-resident") });
  actions.push({ id: "download", label: "Download", icon: Download, onClick: act("download") });
  if (tab !== "pending") actions.push({ id: "pending", label: "Move to pending", icon: Undo2, onClick: act("pending") });
  if (tab !== "rejected") actions.push({ id: "reject", label: "Decline", icon: X, tone: "danger", onClick: act("reject") });
  actions.push({ id: "delete", label: "Delete", icon: Trash2, tone: "danger", onClick: act("delete") });

  const status = tab === "approved" ? "Approved" : tab === "rejected" ? "Declined" : "Pending";
  const subtitle = `${row.property} · ${row.unit}`;

  return (
    <DemoRecordPage
      title={row.name}
      subtitle={subtitle}
      avatarName={row.name}
      backLabel="Back to applications"
      onBack={onBack}
      actions={actions}
      sections={sections}
      recordId={row.id}
      activeId={active}
      onActive={setActive}
      ariaLabel="Application sections"
    >
      {active === "communication" ? (
        <DemoRecordThread name={row.name} subtitle={subtitle} messages={demoThread("application", row.name, row.property, MANAGER_NAME)} selfName={MANAGER_NAME} />
      ) : active === "screening" ? (
        <div className="space-y-4" data-attr="application-section-screening">
          <RecordFactCard title={APPLICATION_DETAIL_TAB_LABELS.screening} dataAttr="record-overview-card-screening">
            <RecordFactRow label="Status" value={screening.status} tone={screening.status === "Passed" ? "ok" : screening.status === "Flagged" ? "bad" : undefined} />
            {screening.rows.map((r) => (
              <RecordFactRow key={r.label} label={r.label} value={r.value} tone={r.tone} />
            ))}
          </RecordFactCard>
        </div>
      ) : (
        <div className="space-y-4" data-attr="application-section-application">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted" data-attr="application-facts">
            <PortalRowFact icon={tab === "approved" ? Check : Clock} srLabel="Status">
              {status}
            </PortalRowFact>
            <PortalRowFact icon={Wallet} srLabel="Income">
              {money(detail.income)}/mo income
            </PortalRowFact>
            <PortalRowFact icon={Home} srLabel="Home">
              {subtitle}
            </PortalRowFact>
            <PortalRowFact icon={CalendarDays} srLabel="Move-in">
              Move-in {detail.moveIn}
            </PortalRowFact>
            {row.sharedFact ? (
              <PortalRowFact icon={Users} srLabel="Resident">
                {row.sharedFact}
              </PortalRowFact>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <RecordFactCard title="Applicant" dataAttr="application-card-applicant">
              <RecordFactRow label="Full name" value={row.name} />
              <RecordFactRow label="Email" value={row.email} />
              <RecordFactRow label="Phone" value={detail.phone} />
              <RecordFactRow label="Preferred contact" value={detail.preferred} />
            </RecordFactCard>
            <RecordFactCard title="Home" dataAttr="application-card-home">
              <RecordFactRow label="Property" value={row.property} />
              <RecordFactRow label="Room" value={row.unit} />
              <RecordFactRow label="Move-in" value={detail.moveIn} />
              <RecordFactRow label="Lease term" value={detail.term} />
            </RecordFactCard>
            <RecordFactCard title="About them" dataAttr="application-card-about">
              <RecordFactRow label="Date of birth" value={detail.dob} />
              <RecordFactRow label="Occupants" value={detail.occupants} />
              <RecordFactRow label="Pets" value={detail.pets} />
            </RecordFactCard>
            <RecordFactCard title="Employment & income" dataAttr="application-card-employment">
              <RecordFactRow label="Employer" value={detail.employer} />
              <RecordFactRow label="Job title" value={detail.jobTitle} />
              <RecordFactRow label="Monthly income" value={money(detail.income)} />
              <RecordFactRow label="Employed since" value={detail.employedSince} />
            </RecordFactCard>
            <RecordFactCard title="Current address" dataAttr="application-card-current">
              <RecordFactRow label="Address" value={detail.currentAddress} />
              <RecordFactRow label="Landlord" value={detail.currentLandlord} />
              <RecordFactRow label="Since" value={detail.currentSince} />
            </RecordFactCard>
            <RecordFactCard title="Previous address" dataAttr="application-card-previous">
              <RecordFactRow label="Address" value={detail.previousAddress} />
            </RecordFactCard>
            <RecordFactCard title="References & emergency contact" dataAttr="application-card-references">
              <RecordFactRow label="Reference" value={detail.reference} />
              <RecordFactRow label="Emergency contact" value={detail.emergency} />
            </RecordFactCard>
            <RecordFactCard title="Disclosures" dataAttr="application-card-disclosures">
              <RecordFactRow label="History" value={detail.disclosures} />
            </RecordFactCard>
            <RecordFactCard title={`${row.property} asks`} dataAttr="application-card-asks">
              {detail.asks.map((ask) => (
                <RecordFactRow key={ask.label} label={ask.label} value={ask.value} />
              ))}
            </RecordFactCard>
          </div>
        </div>
      )}
    </DemoRecordPage>
  );
}

/* ═════════════════════════════════ Leases ═════════════════════════════════ */

/** The lease on paper: the document pane of the Send lease pop-up and of the lease record. */
function LeasePaper({ resident, place, rent, deposit, start, end, className }: { resident: string; place: string; rent: number; deposit: number; start: string; end: string; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)} data-attr="lease-document-preview">
      <div className="mx-auto max-w-[520px] space-y-3 px-8 py-6 text-[12.5px] leading-relaxed text-foreground">
        <p className="text-center text-[13px] font-bold uppercase tracking-wide">Residential lease agreement</p>
        <p>
          This agreement is between the property manager (the Landlord) and <b>{resident}</b> (the Resident) for <b>{place}</b>.
        </p>
        <p>
          <b>1. Term.</b> The lease starts {start} and ends {end}.
        </p>
        <p>
          <b>2. Rent.</b> The Resident pays {money(rent)} each month, due on the first day of the month.
        </p>
        <p>
          <b>3. Security deposit.</b> The Resident pays a security deposit of {money(deposit)} at signing.
        </p>
        <p>
          <b>4. Use.</b> The home is the Resident&apos;s residence. Guests and pets follow the house rules attached to this lease.
        </p>
        <div className="grid grid-cols-2 gap-6 pt-3 text-[12px] text-muted">
          <span className="border-t border-border pt-1">Resident signature</span>
          <span className="border-t border-border pt-1">Landlord signature</span>
        </div>
      </div>
    </div>
  );
}

function MoneyField({ value, label, suffix, onChange }: { value: string; label: string; suffix?: string; onChange: (next: string) => void }) {
  return (
    <span className="flex items-center gap-1.5 font-bold text-muted">
      <span>$</span>
      <Input aria-label={label} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} />
      {suffix ? <span className="shrink-0 text-[13px] font-semibold">{suffix}</span> : null}
    </span>
  );
}

/** A labelled group of rows, the way the Send lease pop-up prints "Payments schedule" and "Roommates on this lease". */
function SendLeaseList({ title, dataAttr, children }: { title: string; dataAttr: string; children: ReactNode }) {
  return (
    <div data-attr={dataAttr}>
      <p className="mb-1 text-[13px] font-bold text-foreground">{title}</p>
      <div className="divide-y divide-border/60 rounded-xl border border-border px-4">{children}</div>
    </div>
  );
}

/**
 * "Send lease": `LeaseSendSheet pickResident`, one dialog with no step rail. The Start from a file card, the
 * Resident select, PropLane lease | Upload PDF, the terms, the document, the confirmation box, the schedule,
 * the fee waiver, the ready rows and the message line, and one primary: Send for signature.
 */
export function DemoSendLeasePopup({ onClose, onSent, candidates = DEMO_LEASE_CANDIDATES }: { onClose: () => void; onSent: (candidate: DemoLeaseCandidate) => void; candidates?: DemoLeaseCandidate[] }) {
  const [candidateId, setCandidateId] = useState(candidates[0]!.id);
  const candidate = candidates.find((c) => c.id === candidateId) ?? candidates[0]!;
  const [source, setSource] = useState<"lease" | "pdf">("lease");
  const [form, setForm] = useState(DEMO_LEASE_FORMS[0]!.value);
  const [start, setStart] = useState("2025-10-01");
  const [end, setEnd] = useState("2026-09-30");
  const [rent, setRent] = useState(String(candidate.rent));
  const [deposit, setDeposit] = useState(String(candidate.rent));
  const [confirmed, setConfirmed] = useState(true);
  const [waived, setWaived] = useState(false);
  const [invited, setInvited] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const unit = candidate.place;
  const [message, setMessage] = useState("");
  const rentNumber = Number(rent) || 0;
  const depositNumber = Number(deposit) || 0;
  const schedule = demoLeaseSchedule(rentNumber, depositNumber);
  const pretty = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const messageText = message || `Hi ${firstName(candidate.name)}, your lease for ${unit} is ready to review and sign.`;

  const pick = (id: string) => {
    const next = candidates.find((c) => c.id === id);
    setCandidateId(id);
    if (next) {
      setRent(String(next.rent));
      setDeposit(String(next.rent));
    }
    setInvited(false);
    setConfirmed(true);
  };

  return (
    <DemoWorkspacePopup
      title={`Send lease · ${candidate.name}`}
      steps={[{ id: "send-lease", label: "Send lease" }]}
      stepHeading=""
      footer={{ kind: "done", label: "Send for signature", onDone: () => onSent(candidate), left: <CancelButton onClose={onClose} /> }}
      onClose={onClose}
      dataAttr="lease-send-sheet"
    >
      {() => (
        <div className="mx-auto max-w-[640px] space-y-5" data-attr="lease-send-body">
          <WorkspaceFileCard accept="application/pdf,.pdf" chips={[".pdf", "up to 3.5 MB"]} dataAttr="lease-send-header-upload" onPick={() => setSource("pdf")} />
          <FieldSingleSelect
            label="Resident"
            value={candidateId}
            onChange={pick}
            placeholder="Choose a resident"
            options={candidates.map((c) => ({ value: c.id, label: `${c.name} · ${c.place}` }))}
            dataAttr="lease-send-resident"
          />
          <SegmentedControl<"lease" | "pdf">
            value={source}
            onChange={setSource}
            ariaLabel="Lease source"
            dataAttrPrefix="lease-send-source"
            options={[
              { value: "lease", label: "PropLane lease" },
              { value: "pdf", label: "Upload PDF" },
            ]}
          />
          <div className="min-w-0 space-y-4">
            {source === "lease" ? (
              <FieldSingleSelect label="Lease form" value={form} onChange={setForm} options={DEMO_LEASE_FORMS} dataAttr="lease-send-lease-type" />
            ) : (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border px-4 py-3" data-attr="lease-send-pdf">
                <p className="min-w-0 truncate text-[13px] font-semibold">Lease.pdf</p>
                <PortalIconAction icon={Upload} label="Replace PDF" data-attr="lease-send-replace-pdf" />
              </div>
            )}
            <div className="space-y-2" data-attr="lease-send-terms">
              <div className="grid grid-cols-2 gap-x-3.5 gap-y-3 max-sm:grid-cols-1">
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs font-bold text-muted">Start</p>
                  <DateField value={start} onChange={setStart} aria-label="Lease start" />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs font-bold text-muted">End</p>
                  <DateField value={end} onChange={setEnd} aria-label="Lease end" />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs font-bold text-muted">Rent</p>
                  <MoneyField value={rent} label="Monthly rent" suffix="/ month" onChange={setRent} />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs font-bold text-muted">Deposit</p>
                  <MoneyField value={deposit} label="Security deposit" onChange={setDeposit} />
                </div>
              </div>
            </div>
            <LeasePaper className="h-72 overflow-y-auto" resident={candidate.name} place={unit} rent={rentNumber} deposit={depositNumber} start={pretty(start)} end={pretty(end)} />
            <button
              type="button"
              role="checkbox"
              aria-checked={confirmed}
              onClick={() => setConfirmed((v) => !v)}
              data-attr="lease-send-confirm-box"
              className={cn("flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm font-bold", confirmed ? "border-primary bg-primary/5" : "border-border")}
            >
              <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md border", confirmed ? "border-primary bg-primary text-white" : "border-border")} aria-hidden>
                {confirmed ? "✓" : null}
              </span>
              This is the lease I&apos;m sending
            </button>
            <SendLeaseList title="Payments schedule" dataAttr="lease-send-schedule">
              {schedule.map((row) => (
                <div key={row.key} className="flex min-h-11 items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="text-muted">{row.label}</span>
                  <span className="font-bold text-foreground">{money(row.amount)}</span>
                </div>
              ))}
            </SendLeaseList>
            <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border px-4 py-1.5 text-sm" data-attr="lease-send-fee">
              <span className="min-w-0 font-semibold text-foreground">Waive the lease fee · {money(DEMO_LEASE_FEE)}</span>
              <PortalSettingsToggle checked={waived} onChange={setWaived} label="Waive the lease fee" dataAttr="lease-send-waive-fee" />
            </div>
            {candidate.shared && source === "lease" ? (
              <SendLeaseList title="Roommates on this lease" dataAttr="lease-send-roommates">
                {candidate.shared.map((mate) => (
                  <div key={mate.name} className="flex min-h-11 items-center justify-between gap-3 py-2.5 text-sm" data-attr="lease-send-roommate">
                    <span className="min-w-0 truncate font-semibold text-foreground">{mate.name}</span>
                    <span className="shrink-0 text-muted">
                      {mate.bed} · {money(candidate.rent)}
                    </span>
                  </div>
                ))}
              </SendLeaseList>
            ) : null}
            <div data-attr="lease-send-ready">
              <p className="mb-1 text-[13px] font-bold text-foreground">Ready to send</p>
              <div className="divide-y divide-border/60 rounded-xl border border-border px-4">
                <div className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm" data-attr="lease-send-ready-invite">
                  <span className="min-w-0 text-foreground">
                    {invited ? `Invite sent · waiting for ${firstName(candidate.name)} to create an account` : `${firstName(candidate.name)} has no PropLane account yet`}
                  </span>
                  {invited ? null : (
                    <Button type="button" variant="outline" className="shrink-0 rounded-full" onClick={() => setInvited(true)}>
                      Send invite
                    </Button>
                  )}
                </div>
              </div>
            </div>
            <div>
              <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border/60 py-2.5">
                <span className="min-w-0 text-sm font-semibold text-foreground">Email · Your lease for {unit} is ready to sign</span>
                <PortalIconAction icon={Pencil} label={noteOpen ? "Hide message" : "Edit message"} active={noteOpen} data-attr="lease-send-edit-message" onClick={() => setNoteOpen((v) => !v)} />
              </div>
              {noteOpen ? <Textarea aria-label="Message to the resident" rows={5} value={messageText} onChange={(e) => setMessage(e.target.value)} data-attr="lease-send-message" /> : null}
            </div>
          </div>
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

export type DemoLeaseActionId = "edit" | "send" | "remind" | "sign" | "download" | "mark-signed" | "delete";

function SignerStrip({ signers, onRemind, onSign }: { signers: DemoSigner[]; onRemind: () => void; onSign: () => void }) {
  const fact = (s: DemoSigner) =>
    s.state === "signed" ? { icon: Check, text: `Signed ${s.at}`.trim() } : s.state === "sent" ? { icon: Send, text: `Sent ${s.at}`.trim() } : { icon: Clock, text: "Waiting" };
  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm" data-attr="lease-signers" aria-label="Who signed">
      <h3 className="text-[14px] font-extrabold text-foreground">Who signed</h3>
      {signers.map((s) => {
        const f = fact(s);
        const Icon = f.icon;
        return (
          <div key={s.role} className="flex min-w-0 items-center gap-2 text-[13.5px]" data-attr={`lease-signer-${s.role.toLowerCase()}`}>
            <span className="text-muted">{s.role}</span>
            <span className="min-w-0 truncate font-bold text-foreground">{s.name}</span>
            <span className="inline-flex shrink-0 items-center gap-1 text-muted">
              <Icon className="size-3.5" strokeWidth={1.6} aria-hidden />
              {f.text}
            </span>
            {s.action === "remind" ? <PortalIconAction icon={Bell} label={`Remind ${firstName(s.name)}`} data-attr="lease-signer-remind" onClick={onRemind} /> : null}
            {s.action === "sign" ? (
              <Button type="button" variant="outline" className="shrink-0 rounded-full" data-attr="lease-signer-sign" onClick={onSign}>
                Sign
              </Button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/** A lease record: Lease (who signed, the terms line, the document) · Communication, with the stage's actions in the header. */
export function DemoLeaseRecord({ row, onBack, onAction }: { row: LeaseFixtureRow; onBack: () => void; onAction: (id: DemoLeaseActionId) => void }) {
  const sections = useMemo(() => recordSections("manager", "lease", { leaseListTab: row.bucket === "completed" ? "completed" : row.bucket === "signed" ? "manager" : row.bucket === "resident" ? "resident" : "draft" }), [row.bucket]);
  const [active, setActive] = useState("overview");
  const detail = demoLeaseDetail(row);
  const signers = demoLeaseSigners(row, MANAGER_NAME);
  const act = (id: DemoLeaseActionId) => () => onAction(id);

  // Edit lease · Send / Remind / Countersign · Download, then Mark as signed and Delete in the overflow (pro-leases-pipeline-panel.tsx).
  const actions: DemoRecordAction[] = [];
  if (row.bucket === "manager" || row.bucket === "resident") actions.push({ id: "edit", label: "Edit lease", icon: Pencil, onClick: act("edit") });
  if (row.bucket === "manager") actions.push({ id: "send", label: "Send lease", icon: Send, tone: "primary", demoTarget: "sheet-primary", onClick: act("send") });
  if (row.bucket === "resident") actions.push({ id: "remind", label: "Send reminder", icon: Bell, tone: "primary", onClick: act("remind") });
  if (row.bucket === "signed") actions.push({ id: "sign", label: "Countersign", icon: FileSignature, tone: "primary", demoTarget: "sheet-primary", onClick: act("sign") });
  actions.push({ id: "download", label: "Download", icon: Download, onClick: act("download") });
  if (row.bucket !== "completed") {
    actions.push({ id: "mark-signed", label: "Mark as signed", icon: FileSignature, onClick: act("mark-signed") });
    actions.push({ id: "delete", label: "Delete", icon: Trash2, tone: "danger", onClick: act("delete") });
  }

  return (
    <DemoRecordPage
      title={row.resident}
      subtitle={row.place}
      avatarName={row.resident}
      backLabel="Back to leases"
      onBack={onBack}
      actions={actions}
      sections={sections}
      recordId={row.id}
      activeId={active}
      onActive={setActive}
      ariaLabel="Lease sections"
    >
      {active === "communication" ? (
        <DemoRecordThread name={row.resident} subtitle={row.place} messages={demoThread("lease", row.resident, row.place, MANAGER_NAME)} selfName={MANAGER_NAME} />
      ) : (
        <div className="space-y-4" data-attr="lease-section-lease">
          <SignerStrip signers={signers} onRemind={act("remind")} onSign={act("sign")} />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted" data-attr="lease-facts">
            <PortalRowFact icon={Home} srLabel="Place">
              {row.place}
            </PortalRowFact>
            <PortalRowFact icon={Wallet} srLabel="Rent">
              {money(detail.rent)}/mo
            </PortalRowFact>
            <PortalRowFact icon={CalendarDays} srLabel="Term">
              {detail.start} – {detail.end}
            </PortalRowFact>
          </div>
          <LeasePaper resident={row.resident} place={row.place} rent={detail.rent} deposit={detail.deposit} start={detail.start} end={detail.end} />
        </div>
      )}
    </DemoRecordPage>
  );
}
