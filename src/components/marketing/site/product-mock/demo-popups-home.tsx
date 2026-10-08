"use client";

/**
 * The pop-ups and record pages the manager Properties and Calendar tabs open, for the home demo.
 *
 *  Properties
 *   - New property: the REAL `ListingEditorV2` (the wizard behind the round +), mounted bare with a fixture
 *     submission. It needs no network to render; the steps that read a workspace setting (Application,
 *     Lease, Move-in, Pricing) are answered by an empty stub while the pop-up is open so nothing leaves the page.
 *   - Send listing: a static copy of `ShareLeadLinkModal kind="listing"` (the real one reads the whole portfolio).
 *   - A property's record page: `recordSections("manager", "property")` + `DemoRecordPage`.
 *  Calendar
 *   - Add tour / Add task / Add service: static copies of `ScheduleTourSimpleModal`, `ManagerTaskFormModal`
 *     and `ManagerAddServiceModal` (each loads the portfolio and the team), with the real rail, field labels
 *     and footer words.
 *   - Your availability: the real `CalendarAvailabilityDialog`.
 *   - A tour / task / service record page.
 *
 * Nothing here saves: the primary closes the pop-up and the panel toasts "(sample)". Loaded on demand.
 */

import { useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalContainerProvider } from "@/components/ui/portal-container-context";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { DemoPopupHostContext } from "@/components/marketing/site/product-mock/demo-popup-host";
import { DemoPopupLayer, DemoWorkspacePopup } from "@/components/marketing/site/product-mock/demo-popup";
import {
  DemoRecordPage,
  DemoRecordThread,
  RecordFactCard,
  RecordFactRow,
  recordActionsFromSections,
} from "@/components/marketing/site/product-mock/demo-record";
import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { IMPORT_FILE_ACCEPT, IMPORT_FILE_CHIPS } from "@/components/portal/listing-wizard-v2/import-upload-step";
import { CheckboxOption, StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { emptyRoom, createNewListingWizardSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  PreviewPanel,
  ReviewCard,
  WizardField,
  WizardLine,
  WizardMultiSelect,
  WizardRow,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { PortalMessageSendViaDropdown, PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS } from "@/components/portal/portal-message-compose-fields";
import { ShareLeadLinkPreviewPanel } from "@/components/portal/share-lead-link-preview-panel";
import { CalendarAvailabilityDialog } from "@/components/portal/calendar-availability-dialog";
import { FIELD_SELECT_MENU_DATA_ATTR } from "@/components/ui/field-select-portal-interaction";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { DateField } from "@/components/ui/date-field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { MODAL_FIELD_LABEL_CLASS, PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS, PORTAL_MODAL_FORM_GRID_CLASS } from "@/components/ui/modal";
import { MANAGER_TASK_FORM_KINDS, MANAGER_TASK_FORM_KIND_LABELS, type ManagerTaskFormKind } from "@/lib/manager-task-form-support";
import {
  MANAGER_TASK_PRIORITIES,
  MANAGER_TASK_PRIORITY_LABELS,
  MANAGER_TASK_URGENCIES,
  MANAGER_TASK_URGENCY_LABELS,
  type ManagerTaskPriority,
  type ManagerTaskUrgency,
} from "@/lib/manager-tasks";
import { buildLeadInviteEmailBody, leadInviteSubject } from "@/lib/lead-invite-email";
import { buildManagerListingUrl } from "@/lib/manager-property-links";
import { recordSections } from "@/lib/portals/record-sections";
import type { AvailabilityDraft } from "@/lib/calendar-availability-window";
import {
  APPLICATION_ROWS,
  LEASE_ROWS,
  SERVICE_ROWS,
  type CalendarFixtureItem,
  type PropertyFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";
import { MANAGER_FORMS } from "@/components/marketing/site/product-mock/fixtures-more";
import {
  DEMO_AVAILABILITY_START,
  DEMO_TOUR_ROOMS,
  SERVICE_TYPES,
  TASK_ASSIGNEES,
  TOUR_OPEN_TIMES,
  calendarRecordFor,
  homePropertyFacts,
  homePropertyTitle,
  shareablePropertyOptions,
} from "@/components/marketing/site/product-mock/fixtures-popups-home";

/* ─────────────────────────────── shared plumbing ─────────────────────────────── */

/** Escape closes, like the other demo pop-ups (unless a field menu owns the key). */
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

/**
 * The real wizard's Application / Lease / Move-in / Pricing steps read the workspace's settings with `fetch`.
 * While the demo pop-up is open those reads get an empty answer, so the page makes no request; the original
 * `fetch` comes back when the pop-up closes.
 */
function useNoNetwork() {
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const original = window.fetch;
    window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const read = (init?.method ?? "GET").toUpperCase() === "GET";
      return new Response(read ? "null" : "{}", { status: read ? 404 : 200, headers: { "Content-Type": "application/json" } });
    }) as typeof window.fetch;
    return () => {
      window.fetch = original;
    };
  }, []);
}

/** The real pop-up providers (confirm + toast, and modal portals) scoped to the demo window. */
function DemoProviders({ children }: { children: ReactNode }) {
  const host = useContext(DemoPopupHostContext);
  return (
    <PortalContainerProvider container={host}>
      <AppUiProvider>{children}</AppUiProvider>
    </PortalContainerProvider>
  );
}

function parseRent(label: string): number {
  return Number(label.replace(/[^0-9.]/g, "")) || 0;
}

/** The New property wizard's starting values: a sample home with the fields the Create button needs filled in. */
function sampleNewListing(): ManagerListingSubmissionV1 {
  return {
    ...createNewListingWizardSubmission(),
    buildingName: "Cedar House",
    address: "1820 Cedar Ave",
    city: "Seattle",
    state: "WA",
    zip: "98122",
    neighborhood: "Capitol Hill",
    listingPropertyTypeId: "house",
    listingPlaceCategoryId: "shared_home",
    rooms: [1450, 1550].map((rent, index) => ({ ...emptyRoom(index), monthlyRent: rent })),
  };
}

/** A property row as the wizard's submission (the Edit door). */
function submissionForProperty(row: PropertyFixtureRow): ManagerListingSubmissionV1 {
  const facts = homePropertyFacts(row);
  const rent = parseRent(row.rentLabel) || 1400;
  return {
    ...createNewListingWizardSubmission(),
    buildingName: homePropertyTitle(row) === "Untitled draft" ? "" : row.title,
    address: row.street,
    city: facts.city,
    state: facts.state,
    zip: facts.zip,
    neighborhood: row.neighborhood,
    listingPropertyTypeId: row.rooms === 1 ? "apartment" : "house",
    listingPlaceCategoryId: row.rooms === 1 ? "entire_home" : "shared_home",
    rooms: facts.rooms.map((name, index) => ({ ...emptyRoom(index), name, monthlyRent: rent })),
  };
}

/* ─────────────────────────────── New property ─────────────────────────────── */

/**
 * The round + on Properties (and Edit on a property record): the real listing wizard. A new property opens on a
 * sample home (so Create property can finish), titled by its building name like the real wizard; Edit opens
 * the property's own values.
 */
export function DemoNewPropertyPopup({
  onClose,
  onCreated,
  editing,
}: {
  onClose: () => void;
  onCreated: () => void;
  /** Present when editing an existing property (the record's Edit icon). */
  editing?: PropertyFixtureRow;
}) {
  useNoNetwork();
  useEscape(onClose);
  const [submission, setSubmission] = useState<ManagerListingSubmissionV1>(() =>
    editing ? submissionForProperty(editing) : sampleNewListing(),
  );
  const label = submission.buildingName.trim() || submission.address.trim() || "New listing";
  const isEdit = Boolean(editing);
  return (
    <DemoProviders>
      <DemoPopupLayer label={label}>
        <div className="relative h-full w-full" data-attr="demo-new-property-popup">
          <ListingEditorV2
            title={label}
            submission={submission}
            onChange={setSubmission}
            onClose={onClose}
            onPublish={async () => {
              onCreated();
              return true;
            }}
            isEdit={isEdit}
            saveState={isEdit ? "Saved" : "Not saved yet"}
            propertyId={editing?.id ?? null}
            headerUpload={isEdit ? undefined : { accept: IMPORT_FILE_ACCEPT, chips: IMPORT_FILE_CHIPS, onPick: () => undefined }}
            onDiscardDraft={isEdit ? undefined : onClose}
          />
        </div>
      </DemoPopupLayer>
    </DemoProviders>
  );
}

/* ─────────────────────────────── Send listing ─────────────────────────────── */

const SHARE_STEPS = [
  { id: "home", label: "Home" },
  { id: "recipient", label: "Recipient" },
  { id: "review", label: "Review" },
];

/** Share listing link (the Share icon on Properties): `ShareLeadLinkModal kind="listing"`, "Send listing". */
export function DemoShareListingPopup({
  properties,
  presetIds,
  onClose,
  onSent,
}: {
  properties: Pick<PropertyFixtureRow, "id" | "title" | "street" | "stage" | "rooms">[];
  presetIds?: string[];
  onClose: () => void;
  onSent: () => void;
}) {
  const options = useMemo(() => shareablePropertyOptions(properties), [properties]);
  const [step, setStep] = useState(0);
  const [propertyIds, setPropertyIds] = useState<string[]>(presetIds?.length ? presetIds : options.slice(0, 1).map((o) => o.value));
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  const [name, setName] = useState("Jamie P.");
  const [email, setEmail] = useState("jamie.p@example.com");
  const [phone, setPhone] = useState("");
  const viaEmail = sendVia.includes("email");
  const viaSms = sendVia.includes("sms");
  const chosen = properties.filter((p) => propertyIds.includes(p.id));
  const propertyTitle = chosen.length === 1 ? chosen[0]!.title : chosen.length > 1 ? `${chosen.length} properties` : "";
  const linkUrl = chosen.length === 1 ? buildManagerListingUrl("https://www.proplane.com", chosen[0]!.id) : "";
  const emailValid = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email.trim());
  const recipientReady = (viaEmail || viaSms) && (!viaEmail || emailValid) && (!viaSms || phone.replace(/\D/g, "").length >= 10);
  const body = linkUrl
    ? buildLeadInviteEmailBody({ kind: "listing", prospectName: name, propertyTitle, linkUrl, listingCount: chosen.length })
    : "";
  const steps = SHARE_STEPS.map((s) => ({
    ...s,
    summary:
      s.id === "home" ? propertyTitle || "No property yet" : s.id === "recipient" ? (name.trim() ? [name.trim(), viaEmail ? email.trim() : ""].filter(Boolean).join(" · ") : "Who receives this") : propertyIds.length && recipientReady ? "Ready to send" : "Finish required fields",
    attention: s.id === "home" ? (propertyIds.length === 0 ? 1 : 0) : s.id === "recipient" ? (recipientReady ? 0 : 1) : 0,
  }));

  return (
    <DemoWorkspacePopup
      title="Send listing"
      steps={steps}
      step={step}
      onStep={setStep}
      sidePanel={
        <ShareLeadLinkPreviewPanel
          kind="listing"
          prospectName={name}
          prospectEmail={email}
          prospectPhone={phone}
          propertyTitle={propertyTitle}
          viaEmail={viaEmail}
          viaSms={viaSms}
          senderName="Seattle Homes"
          workNumber="(206) 555-0100"
          previewBody={body}
          propertyMissing={propertyIds.length === 0}
          recipientReady={recipientReady}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Send", onFinish: onSent, hideStepCount: true }}
      onClose={onClose}
      dataAttr="share-lead-popup"
    >
      {(index) => (
        <StepColumn>
          {index === 0 ? (
            <>
              <StepHeading title="Home" />
              <WizardSection title="Property" dataAttr="share-lead-home">
                <WizardMultiSelect
                  label="Properties"
                  dataAttr="share-lead-property-multi"
                  emptyLabel="Select properties"
                  emptyMenuText="No properties"
                  options={options}
                  selected={propertyIds}
                  onChange={setPropertyIds}
                  required
                />
                <div className="mt-3 border-t border-border/60 pt-3">
                  <WizardLine
                    label="Listing link"
                    control={
                      <span className="flex max-w-[min(320px,55vw)] items-center gap-1">
                        <span className="truncate text-[13px] font-semibold text-foreground">{linkUrl || "—"}</span>
                        <PortalIconAction icon={Copy} label="Copy listing link" disabled={!linkUrl} data-attr="share-lead-copy-link" />
                      </span>
                    }
                  />
                </div>
              </WizardSection>
            </>
          ) : null}
          {index === 1 ? (
            <>
              <StepHeading title="Recipient" />
              <WizardSection title="Delivery" dataAttr="share-lead-delivery">
                <PortalMessageSendViaDropdown selected={sendVia} onChange={setSendVia} smsAvailable footerNote="" dataAttr="share-lead-send-via" />
              </WizardSection>
              <WizardSection title="Contact" dataAttr="share-lead-recipient">
                <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
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
                </div>
              </WizardSection>
            </>
          ) : null}
          {index === 2 ? (
            <>
              <StepHeading title="Review" />
              <ReviewCard
                title="Home"
                status={propertyIds.length === 0 ? "incomplete" : "complete"}
                onEdit={() => setStep(0)}
                facts={[
                  { label: "Property", value: propertyTitle || "Not set", missing: propertyIds.length === 0 },
                  { label: "Listing link", value: linkUrl ? "Ready" : "Not set", missing: !linkUrl },
                ]}
              />
              <ReviewCard
                title="Recipient"
                status={recipientReady ? "complete" : "incomplete"}
                onEdit={() => setStep(1)}
                facts={[
                  { label: "Name", value: name.trim() || "—" },
                  { label: "Channel", value: viaEmail && viaSms ? "Email and text" : viaSms ? "Text" : viaEmail ? "Email" : "Not set", missing: !viaEmail && !viaSms },
                  ...(viaEmail ? [{ label: "Email", value: email.trim() || "Not set", missing: !emailValid }] : []),
                ]}
              />
              <WizardSection title="Listing email" dataAttr="share-lead-review-listing">
                <div className="space-y-2 text-sm">
                  <div>Subject: {leadInviteSubject("listing", propertyTitle, chosen.length > 1 ? chosen.length : undefined)}</div>
                  {chosen.map((p) => (
                    <div key={p.id} className="rounded-xl border border-border p-3">
                      <strong>{p.title}</strong>
                      <div className="text-xs text-muted">{p.street}</div>
                    </div>
                  ))}
                </div>
              </WizardSection>
            </>
          ) : null}
        </StepColumn>
      )}
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────────── Property record ─────────────────────────────── */

function cardGrid(children: ReactNode) {
  return <div className="grid min-w-0 gap-3 lg:grid-cols-2">{children}</div>;
}

function emptyRows(text: string) {
  return <RecordFactRow label={text} value="" />;
}

function PropertySectionBody({ id, row }: { id: string; row: PropertyFixtureRow }) {
  const facts = homePropertyFacts(row);
  const title = homePropertyTitle(row);
  const apps = APPLICATION_ROWS.filter((a) => a.property === row.title);
  const leases = LEASE_ROWS.filter((l) => l.place.startsWith(row.title));
  const forms = MANAGER_FORMS.filter((f) => f.place.startsWith(row.title));
  const services = SERVICE_ROWS.filter((s) => s.property === row.title);
  const stageLabel = row.stage === "listed" ? "Listed" : row.stage === "unlisted" ? "Off the market" : "Draft";
  switch (id) {
    case "preview":
      return cardGrid(
        <>
          <RecordFactCard title="Listing preview">
            <div className="relative m-3 aspect-[16/9] overflow-hidden rounded-[10px] border border-border" data-attr="property-preview-cover">
              <NoImagePlaceholder variant="compact" />
            </div>
            <RecordFactRow label="Name" value={title} />
            <RecordFactRow label="Address" value={`${row.street} · ${row.neighborhood}`} />
            <RecordFactRow label="From" value={facts.rent ? `${facts.rent} a month` : "Price not set"} />
            <RecordFactRow label="Rooms" value={String(row.rooms)} />
          </RecordFactCard>
          <RecordFactCard title="Rooms" count={facts.rooms.length}>
            {facts.rooms.map((room) => (
              <RecordFactRow key={room} label={room} value={facts.rent ? `${facts.rent} a month` : "Price not set"} />
            ))}
            <RecordFactRow label="Status" value={stageLabel} />
          </RecordFactCard>
        </>,
      );
    case "house-details":
      return cardGrid(
        <>
          <RecordFactCard title="The home itself">
            <RecordFactRow label="Property type" value={facts.type} />
            <RecordFactRow label="How you rent it" value={facts.rentModel} />
            <RecordFactRow label="Stays you offer" value={facts.stays} />
            <RecordFactRow label="Bedrooms" value={String(row.rooms)} />
            <RecordFactRow label="Bathrooms" value={String(facts.bathrooms)} />
            <RecordFactRow label="Floors" value={String(facts.floors)} />
          </RecordFactCard>
          <RecordFactCard title="Where it is">
            <RecordFactRow label="Street address" value={facts.street} />
            <RecordFactRow label="City" value={facts.city} />
            <RecordFactRow label="State" value={facts.state} />
            <RecordFactRow label="ZIP" value={facts.zip} />
            <RecordFactRow label="Neighborhood" value={facts.neighborhood} />
          </RecordFactCard>
          <RecordFactCard title="Amenities">
            {facts.amenities.map((a) => (
              <RecordFactRow key={a} label={a} value="" />
            ))}
          </RecordFactCard>
        </>,
      );
    case "application":
      return (
        <RecordFactCard title="Applications" count={apps.length}>
          {apps.length ? apps.map((a) => <RecordFactRow key={a.id} label={a.name} value={`${a.unit} · ${a.stage}`} />) : emptyRows("No applications yet")}
        </RecordFactCard>
      );
    case "lease":
      return (
        <RecordFactCard title="Leases" count={leases.length}>
          {leases.length ? leases.map((l) => <RecordFactRow key={l.id} label={l.resident} value={`${l.stage} · ${l.updated}`} />) : emptyRows("No leases yet")}
        </RecordFactCard>
      );
    case "forms":
      return (
        <RecordFactCard title="Forms" count={forms.length}>
          {forms.length ? forms.map((f) => <RecordFactRow key={f.id} label={f.title} value={`${f.resident} · ${f.when}`} />) : emptyRows("No forms yet")}
        </RecordFactCard>
      );
    case "move-in":
      return (
        <RecordFactCard title="Move-in">
          <RecordFactRow label="Available" value="Now" />
          <RecordFactRow label="Instructions" value="Keys at the front door lockbox" />
          {facts.rooms.map((room) => (
            <RecordFactRow key={room} label={room} value="Available now" />
          ))}
        </RecordFactCard>
      );
    case "pricing":
      return (
        <RecordFactCard title="Pricing" count={facts.rooms.length}>
          {facts.rooms.map((room) => (
            <RecordFactRow key={room} label={room} value={facts.rent ? `${facts.rent} a month` : "Rent not set"} />
          ))}
        </RecordFactCard>
      );
    case "requests":
      return (
        <RecordFactCard title="Services" count={services.length}>
          {services.length ? services.map((s) => <RecordFactRow key={s.id} label={s.title} value={s.detail} />) : emptyRows("No services yet")}
        </RecordFactCard>
      );
    case "promotion":
      return (
        <RecordFactCard title="Promotion">
          {emptyRows("No promotions yet")}
        </RecordFactCard>
      );
    default:
      return (
        <RecordFactCard title="AI info">
          <RecordFactRow label="Address" value={`${row.street}, ${facts.city}`} />
          <RecordFactRow label="Rooms" value={String(row.rooms)} />
          <RecordFactRow label="Rent" value={facts.rent || "Not set"} />
        </RecordFactCard>
      );
  }
}

/** A property's record page: Property · Leasing · Operations rail; Edit, Share, Duplicate, Unlist and Delete up top. */
export function DemoPropertyRecord({
  row,
  onBack,
  onEdit,
  onShare,
  onToast,
}: {
  row: PropertyFixtureRow;
  onBack: () => void;
  onEdit: () => void;
  onShare: () => void;
  onToast: (text: string) => void;
}) {
  const [active, setActive] = useState("preview");
  const sections = useMemo(() => recordSections("manager", "property", { stage: row.stage === "draft" ? "drafts" : row.stage }, active), [row.stage, active]);
  const actions = useMemo(() => {
    const base = recordActionsFromSections(sections, (id) => {
      if (id === "edit") onEdit();
      else if (id === "share") onShare();
      else if (id === "duplicate") onToast("Property duplicated (sample)");
      else if (id === "unlist") onToast(row.stage === "unlisted" ? "Relisted (sample)" : "Unlisted (sample)");
      else if (id === "delete") onToast("Property deleted (sample)");
    });
    // A draft is not on the market, so it has no Share or Unlist; an unlisted house offers Relist.
    return base
      .filter((a) => !(row.stage === "draft" && (a.id === "share" || a.id === "unlist")))
      .filter((a) => !(row.stage === "unlisted" && a.id === "share"))
      .map((a) => (a.id === "unlist" && row.stage === "unlisted" ? { ...a, label: "Relist" } : a));
  }, [sections, row.stage, onEdit, onShare, onToast]);
  const title = homePropertyTitle(row);
  return (
    <DemoRecordPage
      title={title}
      subtitle={`${row.street} · ${row.neighborhood}`}
      avatarName={title}
      backLabel="Back to properties"
      onBack={onBack}
      actions={actions}
      sections={sections}
      recordId={row.id}
      activeId={active}
      onActive={setActive}
      ariaLabel="Property sections"
    >
      <PropertySectionBody id={active} row={row} />
    </DemoRecordPage>
  );
}

/* ─────────────────────────────── Add tour ─────────────────────────────── */

const TOUR_STEP_LABELS = ["Home", "Date & time", "Visitor", "Review"];

/** The Calendar +'s "New tour": `ScheduleTourSimpleModal` ("Add tour"). */
export function DemoAddTourPopup({ properties, onClose, onAdded }: { properties: string[]; onClose: () => void; onAdded: () => void }) {
  const [step, setStep] = useState(0);
  const [property, setProperty] = useState(properties[0] ?? "");
  const [room, setRoom] = useState("");
  const [format, setFormat] = useState("in_person");
  const [date, setDate] = useState("2025-09-26");
  const [slot, setSlot] = useState<string | null>("2 pm");
  const [name, setName] = useState("Jamie P.");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("jamie.p@example.com");
  const [notes, setNotes] = useState("");
  const facts: [string, string][] = [
    ["Property", property],
    ["Room", room || "Any room"],
    ["Format", format === "virtual" ? "Virtual" : "In person"],
    ["Date & time", slot ? `${date} · ${slot} Pacific` : ""],
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
      steps={TOUR_STEP_LABELS.map((label, index) => ({ id: String(index), label, attention: (index === 0 && !property) || (index === 1 && !slot) || (index === 2 && !name.trim()) ? 1 : 0 }))}
      step={step}
      onStep={setStep}
      stepHeading=""
      railHeader={<div className="rounded-2xl border border-dashed border-border p-6 text-center font-semibold">Contact and tour</div>}
      sidePanel={
        <aside>
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wide">Tour preview</h3>
          {review}
        </aside>
      }
      footer={{ kind: "wizard", lastLabel: "Add tour", onFinish: onAdded }}
      onClose={onClose}
      dataAttr="schedule-tour-simple-popup"
    >
      {(index) => (
        <>
          {index === 0 ? (
            <>
              <WizardSection title="Property" dataAttr="schedule-tour-simple-home">
                <WizardRow cols={2}>
                  <WizardSelect label="Property" value={property} onChange={setProperty} options={properties.map((p) => ({ value: p, label: p }))} placeholder="Select property…" dataAttr="schedule-tour-simple-property" />
                  <WizardSelect label="Room" value={room} onChange={setRoom} options={[{ value: "", label: "Any room" }, ...DEMO_TOUR_ROOMS.slice(1).map((r) => ({ value: r, label: r }))]} placeholder="Select room…" dataAttr="schedule-tour-simple-room" />
                </WizardRow>
              </WizardSection>
              <WizardSelect label="Format" value={format} onChange={setFormat} options={[{ value: "in_person", label: "In person" }, { value: "virtual", label: "Virtual" }]} dataAttr="schedule-tour-simple-format" />
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
                  {TOUR_OPEN_TIMES.map((time) => (
                    <button
                      key={time}
                      type="button"
                      onClick={() => setSlot(time)}
                      aria-pressed={time === slot}
                      data-attr="schedule-tour-simple-slot"
                      className={
                        time === slot
                          ? "rounded-full border border-primary bg-primary px-3 py-1.5 text-[13px] font-semibold text-white transition"
                          : "rounded-full border border-border bg-card px-3 py-1.5 text-[13px] font-semibold text-foreground transition hover:border-primary/50"
                      }
                    >
                      {time}
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

/* ─────────────────────────────── Add task ─────────────────────────────── */

const TASK_STEPS = ["Task", "Property", "When", "Review"];

/** The Calendar +'s "New task": `ManagerTaskFormModal` ("Add task"). */
export function DemoAddTaskPopup({ properties, onClose, onAdded }: { properties: string[]; onClose: () => void; onAdded: () => void }) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<ManagerTaskFormKind>("general");
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("me");
  const [property, setProperty] = useState("");
  const [urgency, setUrgency] = useState<ManagerTaskUrgency>("scheduled");
  const [priority, setPriority] = useState<ManagerTaskPriority>("medium");
  const [scheduleDate, setScheduleDate] = useState("2025-09-26");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("09:30");
  const [dueDate, setDueDate] = useState("");
  const [repeats, setRepeats] = useState("none");
  const [notes, setNotes] = useState("");
  const [checklist, setChecklist] = useState("");
  const [attachments, setAttachments] = useState("");
  const fieldClass = PORTAL_MODAL_FORM_FIELD_CLASS;
  const fullRow = `${PORTAL_MODAL_FORM_FIELD_CLASS} ${PORTAL_MODAL_FORM_FULL_ROW_CLASS}`;
  const steps = [
    { id: "task", label: "Task", summary: title.trim() || "What to do" },
    { id: "property", label: "Property", summary: property || "Optional" },
    { id: "when", label: "When", summary: scheduleDate || (urgency === "urgent" ? "Urgent" : "Timing") },
    { id: "review", label: "Review", summary: "Add task" },
  ];
  void TASK_STEPS;
  return (
    <DemoWorkspacePopup
      title="Add task"
      steps={steps}
      step={step}
      onStep={setStep}
      stepHeading=""
      sidePanel={
        <PreviewPanel
          title="Task preview"
          name={title || "Untitled task"}
          facts={[
            { label: "Property", value: property || "Not set" },
            { label: "Type", value: MANAGER_TASK_FORM_KIND_LABELS[kind] },
          ]}
          creates={[]}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Add task", onFinish: onAdded }}
      onClose={onClose}
      dataAttr="manager-task-popup"
    >
      {(index) => (
        <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
          {index === 0 ? (
            <>
              <div className={fullRow}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-kind">
                  Task type
                </label>
                <Select id="demo-task-kind" className="mt-1" value={kind} onChange={(e) => setKind(e.target.value as ManagerTaskFormKind)} data-attr="manager-task-kind">
                  {MANAGER_TASK_FORM_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {MANAGER_TASK_FORM_KIND_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className={fullRow}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-title">
                  Description
                </label>
                <Input id="demo-task-title" aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Inspect unit, meet vendor, follow up…" data-attr="manager-task-title-input" />
              </div>
              <div className={fullRow}>
                <WizardSelect label="Assignee" value={assignee} onChange={setAssignee} options={TASK_ASSIGNEES} dataAttr="manager-task-assignee" />
              </div>
            </>
          ) : null}
          {index === 1 ? (
            <>
              <div className={fullRow}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-property">
                  Property (optional)
                </label>
                <Select id="demo-task-property" value={property} onChange={(e) => setProperty(e.target.value)} data-attr="manager-task-property">
                  <option value="">No property</option>
                  {properties.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </div>
              {kind === "work-order" ? (
                <div className={fullRow}>
                  <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-category">
                    Category
                  </label>
                  <Select id="demo-task-category" defaultValue="General" data-attr="manager-task-work-order-category">
                    {["General", "Plumbing", "Electrical", "Appliance"].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <div className={fullRow}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-resident">
                  Resident (optional)
                </label>
                <Select id="demo-task-resident" defaultValue="" data-attr="manager-task-resident">
                  <option value="">Select resident</option>
                  <option value="liam">Liam Foster · Alder House</option>
                  <option value="maya">Maya Chen · Maple Duplex</option>
                </Select>
              </div>
              {property ? (
                <div className={fullRow}>
                  <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-room">
                    Room (optional)
                  </label>
                  <Select id="demo-task-room" defaultValue="" data-attr="manager-task-room">
                    <option value="">No room</option>
                    <option value="1">Room 1</option>
                    <option value="2">Room 2</option>
                  </Select>
                </div>
              ) : null}
            </>
          ) : null}
          {index === 2 ? (
            <>
              <div className={fieldClass}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-urgency">
                  Timing
                </label>
                <Select id="demo-task-urgency" value={urgency} onChange={(e) => setUrgency(e.target.value as ManagerTaskUrgency)} data-attr="manager-task-urgency">
                  {MANAGER_TASK_URGENCIES.map((value) => (
                    <option key={value} value={value}>
                      {MANAGER_TASK_URGENCY_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className={fieldClass}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-priority">
                  Priority
                </label>
                <Select id="demo-task-priority" value={priority} onChange={(e) => setPriority(e.target.value as ManagerTaskPriority)} data-attr="manager-task-priority">
                  {MANAGER_TASK_PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {MANAGER_TASK_PRIORITY_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </div>
              {urgency === "deadline" ? (
                <div className={fieldClass}>
                  <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-due">
                    Due date
                  </label>
                  <Input id="demo-task-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} data-attr="manager-task-due-date" />
                </div>
              ) : null}
              {urgency === "scheduled" ? (
                <div className={`${fieldClass} lg:col-span-2`} data-attr="manager-task-schedule">
                  <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-schedule-date">
                    Schedule
                  </label>
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:grid-cols-[1.25fr_1fr_auto_1fr]">
                    <Input id="demo-task-schedule-date" type="date" aria-label="Schedule date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} className="col-span-3 min-w-0 sm:col-span-1" />
                    <Input type="time" aria-label="Start time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="min-w-0" />
                    <span aria-hidden="true" className="text-sm text-muted">
                      –
                    </span>
                    <Input type="time" aria-label="End time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="min-w-0" />
                  </div>
                </div>
              ) : null}
              <div className={fieldClass}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-recurrence">
                  Repeats
                </label>
                <Select id="demo-task-recurrence" value={repeats} onChange={(e) => setRepeats(e.target.value)} data-attr="manager-task-recurrence">
                  <option value="none">Does not repeat</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month (same day, month-end clamped)</option>
                </Select>
              </div>
            </>
          ) : null}
          {index === 3 ? (
            <>
              <div className={fullRow}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-notes">
                  Notes (optional)
                </label>
                <textarea id="demo-task-notes" className="min-h-[88px] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} data-attr="manager-task-notes" />
              </div>
              <div className={fullRow}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-checklist">
                  Checklist (one step per line)
                </label>
                <textarea id="demo-task-checklist" className="min-h-[72px] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm" placeholder={"Check the filter\nPhotograph the unit"} value={checklist} onChange={(e) => setChecklist(e.target.value)} data-attr="manager-task-checklist" />
              </div>
              <div className={fullRow}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="demo-task-attachments">
                  Attachments (one link per line, optional name first)
                </label>
                <textarea id="demo-task-attachments" className="min-h-[56px] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm" placeholder={"Quote https://example.com/quote.pdf"} value={attachments} onChange={(e) => setAttachments(e.target.value)} data-attr="manager-task-attachments" />
              </div>
            </>
          ) : null}
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────────── Add service ─────────────────────────────── */

/** The Calendar +'s "New service": `ManagerAddServiceModal` ("Add service"). */
export function DemoAddServicePopup({ properties, onClose, onAdded }: { properties: string[]; onClose: () => void; onAdded: () => void }) {
  const [step, setStep] = useState(0);
  const [property, setProperty] = useState("");
  const [room, setRoom] = useState("");
  const [resident, setResident] = useState("");
  const [type, setType] = useState("");
  const [priority, setPriority] = useState("medium");
  const [serviceTitle, setServiceTitle] = useState("");
  const [description, setDescription] = useState("");
  const [addTask, setAddTask] = useState(false);
  const [assignee, setAssignee] = useState("me");
  const [charge, setCharge] = useState("");
  const name = serviceTitle.trim() || SERVICE_TYPES.find((t) => t.value === type)?.label || "Service";
  const steps = [
    { id: "where", label: "Where", summary: property || "Property", attention: property ? 0 : 1 },
    { id: "what", label: "What", summary: type ? name : "Service", attention: type ? 0 : 1 },
    { id: "review", label: "Review", summary: "Ready" },
  ];
  return (
    <DemoWorkspacePopup
      title="Add service"
      steps={steps}
      step={step}
      onStep={setStep}
      stepHeading=""
      sidePanel={
        <PreviewPanel
          title="Service"
          name={name}
          facts={[
            { label: "Property", value: property || "—", warn: !property },
            { label: "Room", value: room || "—" },
            { label: "Resident", value: resident || "—" },
            { label: "Priority", value: priority },
          ]}
          creates={[
            { tone: "yes", text: resident ? `Logged service for ${resident}` : "Logged service" },
            addTask ? { tone: "yes", text: "Assignment message to the assignee" } : { tone: "no", text: "No assignment message until you assign" },
          ]}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Add service", onFinish: onAdded }}
      onClose={onClose}
      dataAttr="manager-add-service-popup"
    >
      {(index) => (
        <StepColumn>
          {index === 0 ? (
            <>
              <StepHeading title="Where" />
              <WizardSelect label="Property" value={property} onChange={setProperty} options={properties.map((p) => ({ value: p, label: p }))} placeholder="Select property" dataAttr="manager-service-intake-property" />
              <WizardSelect label="Room" value={room} onChange={setRoom} options={[{ value: "", label: "None" }, { value: "Room 1", label: "Room 1" }, { value: "Room 2", label: "Room 2" }]} placeholder={property ? "Optional" : "Select property first"} disabled={!property} dataAttr="manager-service-intake-room" />
              <WizardSelect label="Resident" value={resident} onChange={setResident} options={[{ value: "", label: "None" }, { value: "Liam Foster", label: "Liam Foster · Room 1" }, { value: "Maya Chen", label: "Maya Chen · Unit B" }]} placeholder={property ? "Optional" : "Select property first"} disabled={!property} dataAttr="manager-service-intake-resident" />
            </>
          ) : null}
          {index === 1 ? (
            <>
              <StepHeading title="Service" />
              <WizardSelect label="Service type" value={type} onChange={setType} options={SERVICE_TYPES} placeholder="Choose a service type" dataAttr="service-intake-type" />
              <WizardSelect label="Priority" value={priority} onChange={setPriority} options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} dataAttr="service-intake-priority" />
              <WizardField label="Title" required>
                <Input value={serviceTitle} onChange={(e) => setServiceTitle(e.target.value)} placeholder="Short summary (e.g. Kitchen faucet leaking)" data-attr="service-intake-title" />
              </WizardField>
              <WizardField label="Description" required>
                <Textarea className="min-h-[72px]" value={description} onChange={(e) => setDescription(e.target.value)} data-attr="service-intake-description" />
              </WizardField>
              <div>
                <p className="mb-1 text-[11px] font-medium text-muted">Photos (0/6)</p>
              </div>
              <div>
                <CheckboxOption label="Add task" checked={addTask} onChange={setAddTask} dataAttr="manager-add-service-task-toggle" />
                {addTask ? (
                  <div className="mt-1">
                    <WizardSelect label="Assignee" value={assignee} onChange={setAssignee} options={TASK_ASSIGNEES} dataAttr="manager-add-service-task-assignee" />
                  </div>
                ) : null}
              </div>
              <WizardField label="Resident charge">
                <Input value={charge} onChange={(e) => setCharge(e.target.value)} inputMode="decimal" className="bg-card" data-attr="manager-add-service-resident-charge" />
              </WizardField>
            </>
          ) : null}
          {index === 2 ? (
            <>
              <StepHeading title="Review" />
              <PreviewPanel
                title="Service"
                name={name}
                facts={[
                  { label: "Property", value: property || "—" },
                  { label: "Room", value: room || "—" },
                  { label: "Resident", value: resident || "—" },
                  { label: "Priority", value: priority },
                  { label: "Assignee", value: addTask ? (TASK_ASSIGNEES.find((a) => a.value === assignee)?.label ?? "—") : "—" },
                ]}
                creates={[{ tone: "yes", text: "Logs a manager-initiated service" }]}
              />
            </>
          ) : null}
        </StepColumn>
      )}
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────────── Your availability ─────────────────────────────── */

/** The Calendar +'s "Add availability": the real `CalendarAvailabilityDialog`, "Your availability". */
export function DemoAvailabilityPopup({ properties, onClose, onSaved }: { properties: { id: string; label: string }[]; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const initial = useMemo<AvailabilityDraft>(
    () => ({
      kinds: DEMO_AVAILABILITY_START.kinds as AvailabilityDraft["kinds"],
      on: "days",
      weekdays: DEMO_AVAILABILITY_START.weekdays,
      date: "",
      repeat: "weekly",
      startSlot: DEMO_AVAILABILITY_START.startSlot,
      endSlotExclusive: DEMO_AVAILABILITY_START.endSlotExclusive,
      propertyIds: ["all"],
      weekMonday: "2025-09-22",
    }),
    [],
  );
  return (
    <DemoProviders>
      <CalendarAvailabilityDialog open onClose={onClose} initial={initial} editing={false} propertyOptions={properties} onSave={onSaved} />
    </DemoProviders>
  );
}

/* ─────────────────────────────── Calendar item records ─────────────────────────────── */

const SAMPLE_THREAD = (name: string) => [
  { id: "m1", author: name, body: "Thanks, see you then.", at: "Yesterday", direction: "inbound" as const },
];

/** What a calendar item opens: the tour, task or service record page. */
export function DemoCalendarRecord({ item, onBack, onToast }: { item: CalendarFixtureItem; onBack: () => void; onToast: (text: string) => void }) {
  const record = useMemo(() => calendarRecordFor(item), [item]);
  const [active, setActive] = useState(record.kind === "service" ? "service" : "overview");
  const sections = useMemo(() => recordSections("manager", record.kind, record.kind === "service" ? { serviceKind: "work-order" } : {}, active), [record.kind, active]);
  const confirmed = record.kind === "tour" && record.status === "Confirmed";
  const actions = useMemo(
    () =>
      recordActionsFromSections(
        sections,
        (id) => onToast(`${sections.headerActions.find((a) => a.id === id)?.label ?? id} (sample)`),
        record.kind === "task" ? "complete" : undefined,
      ).filter((a) => !(confirmed && a.id === "confirm")),
    [sections, record.kind, confirmed, onToast],
  );

  let title: string;
  let subtitle: string;
  let back: string;
  let aria: string;
  let body: ReactNode;
  if (record.kind === "tour") {
    title = record.guest;
    subtitle = `${record.property} · ${record.when}`;
    back = "Back to calendar";
    aria = "Tour sections";
    body =
      active === "communication" ? (
        <DemoRecordThread name={record.guest} subtitle={record.email} messages={SAMPLE_THREAD(record.guest)} selfName="You" onSent={() => onToast("Sent (sample)")} />
      ) : (
        cardGrid(
          <>
            <RecordFactCard title="Tour">
              <RecordFactRow label="Property" value={record.property} />
              <RecordFactRow label="Room" value={record.room} />
              <RecordFactRow label="When" value={record.when} />
              <RecordFactRow label="Format" value={record.format} />
              <RecordFactRow label="Status" value={record.status} />
            </RecordFactCard>
            <RecordFactCard title="Prospect">
              <RecordFactRow label="Name" value={record.guest} />
              <RecordFactRow label="Email" value={record.email} />
              <RecordFactRow label="Phone" value={record.phone} />
            </RecordFactCard>
          </>,
        )
      );
  } else if (record.kind === "task") {
    title = record.title;
    subtitle = `${record.property} · ${record.when}`;
    back = "Back to calendar";
    aria = "Task sections";
    body =
      active === "linked" ? (
        <RecordFactCard title="Linked">
          <RecordFactRow label="Lease" value={record.linked} />
          <RecordFactRow label="Property" value={record.property} />
        </RecordFactCard>
      ) : active === "communication" ? (
        <DemoRecordThread name={record.assignee} messages={[]} selfName="You" onSent={() => onToast("Sent (sample)")} />
      ) : (
        <RecordFactCard title="Task">
          <RecordFactRow label="Task" value={record.title} />
          <RecordFactRow label="Type" value="General" />
          <RecordFactRow label="Property" value={record.property} />
          <RecordFactRow label="Assignee" value={record.assignee} />
          <RecordFactRow label="Priority" value={record.priority} />
          <RecordFactRow label="Timing" value={record.timing} />
          <RecordFactRow label="When" value={record.when} />
          <RecordFactRow label="Status" value={record.status} />
        </RecordFactCard>
      );
  } else {
    title = record.title;
    subtitle = `${record.property} · ${record.resident}`;
    back = "Back to calendar";
    aria = "Service sections";
    body =
      active === "vendors" ? (
        <RecordFactCard title="Vendors" count={1}>
          <RecordFactRow label={record.vendor} value={record.status} />
        </RecordFactCard>
      ) : active === "incoming-payments" ? (
        <RecordFactCard title="Incoming payments">{emptyRows("No charges yet")}</RecordFactCard>
      ) : active === "outgoing-payments" ? (
        <RecordFactCard title="Outgoing payments">{emptyRows("No payments yet")}</RecordFactCard>
      ) : active === "communication" ? (
        <DemoRecordThread name={record.vendor} messages={SAMPLE_THREAD(record.vendor)} selfName="You" onSent={() => onToast("Sent (sample)")} />
      ) : (
        <RecordFactCard title="Service">
          <RecordFactRow label="Service" value={record.title} />
          <RecordFactRow label="Property" value={record.property} />
          <RecordFactRow label="Resident" value={record.resident} />
          <RecordFactRow label="Status" value={record.status} />
          <RecordFactRow label="When" value={record.when} />
          {record.detail ? <RecordFactRow label="Details" value={record.detail} /> : null}
        </RecordFactCard>
      );
  }
  return (
    <DemoRecordPage title={title} subtitle={subtitle} avatarName={title} backLabel={back} onBack={onBack} actions={actions} sections={sections} recordId={item.id} activeId={active} onActive={setActive} ariaLabel={aria}>
      {body}
    </DemoRecordPage>
  );
}
