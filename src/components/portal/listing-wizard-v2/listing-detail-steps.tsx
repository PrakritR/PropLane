"use client";

/**
 * The four leasing steps of the listing editor: Application, Lease, Move-in, Pricing.
 *
 * Every row edits IN PLACE. Nothing here opens a modal: a row is a name and a chevron, its one or two
 * main controls inline (a switch, a fee, a Sends dropdown), a ⋯ menu, and the chevron unfolds the rest
 * of the form underneath it.
 *
 * - Application -> "Needed" switch, the fee, the lease it leads to, and the questions (the same question
 *   rows the application editor modal draws). "Application before a tour" is a dropdown that saves the
 *   workspace setting through its existing route.
 * - Lease       -> "Offered" switch, its type, the applications that lead to it, "Allow custom dates" /
 *   "Allow month-to-month", and the document name, start and clauses (the same clause editor the lease
 *   form's Document step draws).
 * - Move-in     -> "Sends" dropdown and the questions (the same question rows the move-in editor draws).
 * - Pricing     -> the room (or whole-house) fields the room pricing workspace edits, drawn by the same
 *   components.
 *
 * Storage is unchanged. All of it patches the wizard's own submission, so it is saved with the draft or
 * the live listing exactly like every other step; the one thing outside the submission is the workspace
 * "Application before a tour" setting, which saves through `/api/portal/manager-application-settings`.
 * The fee is never a template field: it reads and writes the placement fields the Pricing step and the
 * fee resolver use (`listing-inline-forms.ts`).
 *
 * Nothing here is required to publish.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { PortalTableExpandChevron } from "@/components/portal/portal-data-table";
import { PortalRowMenu } from "@/components/portal/portal-row-menu";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import {
  FloatingLabelField,
  MoneyInput,
  PanelSection,
  SegmentedControl,
  StepColumn,
  StepHeading,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { InlineApplicationQuestions } from "@/components/portal/listing-wizard-v2/inline-application-questions";
import { importLeasePdf } from "@/components/portal/listing-wizard-v2/inline-lease-upload";
import {
  RoomPricingFields,
  WholeHousePricingFields,
  roomPricingPatch,
} from "@/components/portal/property-room-pricing-workspace";
import { PropertyLeaseDocumentEditor } from "@/components/portal/property-lease-document-editor";
import { MoveInQuestionsEditor } from "@/components/portal/move-in-forms/move-in-questions-editor";
import {
  cleanMoveInTemplateForSave,
  dueForTriggerChange,
  duplicateMoveInTemplate,
  MOVE_IN_TRIGGER_OPTIONS,
  removeMoveInTemplate,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { sanitizeCustomApplicationFieldsForSave } from "@/components/portal/application-question-edit-modal";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  applicationFeeLabelForSelection,
  applicationFeeRangeAcrossRooms,
  applicationFeeRangeLabel,
} from "@/lib/application-fee-by-room";
import {
  isCosignerApplicationTemplate,
  mappableApplicationTemplates,
} from "@/lib/application-lease-mapping";
import {
  applicationFeeScopeForTemplate,
  applicationsOfLease,
  createInlineApplication,
  duplicateLeaseTemplate,
  leaseChoicesForApplication,
  leaseOfApplication,
  linkApplicationToLease,
  patchApplicationTemplate,
  publishPendingApplicationDrafts,
  readApplicationFeeInput,
  releaseDeletedLeaseLinks,
  setApplicationsOfLease,
  submissionWithStandardLease,
  uniqueFormLabel,
  withApplicationFee,
  withApplicationTemplates,
} from "@/lib/listing-inline-forms";
import { listingPricingLeaseTabs } from "@/lib/listing-fee-scope";
import { normalizeLeasingPipelinePreferences, type ApplicationBeforeTour } from "@/lib/leasing-pipeline-preferences";
import {
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  resolveAllowedLeaseTerms,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { MOVE_IN_FORM_STARTERS, newMoveInFormTemplate, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import type { MoveInFormStarterKey, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import {
  applicationFormVariantForTemplate,
  isApplicationTemplateOffered,
  readPropertyApplicationTemplates,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  normalizePropertyApplicationTemplateLabel,
  submissionAfterRemovingApplicationTemplate,
  syncPropertyApplicationTemplatesFromListing,
} from "@/lib/property-application-template-sync";
import {
  leaseOptionFlags,
  leaseTermsAllowOptions,
  submissionWithLeaseOption,
  submissionWithLeaseTemplates,
  type LeaseOptionKey,
} from "@/lib/property-form-stay-type-routing";
import { resolvePropertyLeaseEditHtml } from "@/lib/property-lease-edit";
import {
  readPropertyLeaseTemplates,
  removePropertyLeaseTemplate,
  updatePropertyLeaseTemplate,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import {
  addLeaseTemplateFromSeed,
  availableLeaseTemplateSeeds,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import { leaseSourceFromDraft } from "@/lib/property-lease-source";
import { propertyPricingRoomAmount } from "@/lib/property-pricing-summary";
import { SHORT_TERM_LEASE_TERM, LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { WorkspacePricingDefaults } from "@/lib/workspace-pricing-defaults";
import { cn } from "@/lib/utils";

/** The step ids this file draws. */
export type ListingDetailStepId = "application" | "lease" | "movein" | "pricing";

export const LISTING_DETAIL_STEP_IDS: readonly ListingDetailStepId[] = ["application", "lease", "movein", "pricing"];

export const WORKSPACE_APPLICATIONS_LEASES_SETTINGS_HREF = "/portal/profile?tab=applicationsLeases";

/** What the editor hands each step. Most of it is only needed to keep older callers compiling: the steps edit in place. */
export type ListingDetailDoors = {
  /** The saved record's id (a draft or a live listing); null until the first save. */
  recordId: string | null;
  /** An existing live listing, or a draft. */
  mode: "draft" | "listing";
  managerUserId: string | null;
  /** Saves the wizard's work and resolves the record id, or null when it could not be saved. */
  ensureSaved?: () => Promise<string | null>;
  showToast: (message: string) => void;
  /** Saves, leaves the wizard and opens a Settings page. Absent = no Settings door. */
  onOpenSettings?: (href: string) => void;
  workspacePricingDefaults?: WorkspacePricingDefaults;
};

type StepProps = {
  sub: ManagerListingSubmissionV1;
  onChange: (next: ManagerListingSubmissionV1) => void;
  doors: ListingDetailDoors;
};

/* ─────────────────────────── the facts each step shows ─────────────────────────── */

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

const rentLabel = (n: number) => `$${Math.round(n).toLocaleString("en-US")}/mo`;

function applicationTemplatesOf(sub: ManagerListingSubmissionV1): PropertyApplicationTemplate[] {
  return readPropertyApplicationTemplates(syncPropertyApplicationTemplatesFromListing(sub));
}

function leaseTemplatesOf(sub: ManagerListingSubmissionV1): PropertyLeaseTemplate[] {
  return readPropertyLeaseTemplates(syncPropertyLeaseTemplatesFromListing(sub));
}

/** "$50", "From $35" or "No fee" for one application, from the one fee resolver the listing uses. */
export function applicationFeeFact(sub: ManagerListingSubmissionV1, template: PropertyApplicationTemplate): string {
  const short = applicationFormVariantForTemplate(template) === "short_term";
  const range = applicationFeeRangeAcrossRooms(sub, short ? "short" : "long");
  if (range) return applicationFeeRangeLabel(range) || "No fee";
  const raw = applicationFeeLabelForSelection(sub, { rentalType: short ? "short_term" : "standard" }).trim();
  if (!raw || /^\$?0+(\.0+)?$/.test(raw)) return "No fee";
  return raw.startsWith("$") ? raw : /^\d/.test(raw) ? `$${raw}` : raw;
}

function leaseTypeFact(template: PropertyLeaseTemplate): string {
  if (template.offered === false) return "Not offered";
  if (template.listingSeedKey === "primary") return "Long-term";
  if (template.listingSeedKey === "short-term") return "Short term";
  if (template.listingSeedKey === "airbnb") return "Airbnb";
  return template.leaseTemplateDocName?.trim() ? "Uploaded" : "Custom";
}

/** The lowest rent across rooms, or the whole-house rent, as "$1,100/mo"; null when none is set. */
export function pricingFromFact(sub: ManagerListingSubmissionV1): string | null {
  const priced = (sub.rooms ?? []).map((room) => room.monthlyRent).filter((n) => n > 0);
  if (priced.length > 0) return rentLabel(Math.min(...priced));
  if (isEntireHomeListing(sub)) {
    const whole = entireHomeMonthlyRentAmount(sub);
    if (whole > 0) return rentLabel(whole);
  }
  return null;
}

/** One line per leasing step: the rail's summary, the right-hand panel and Review all read this. */
export function listingDetailSummaries(sub: ManagerListingSubmissionV1): Record<ListingDetailStepId, string> {
  const applications = applicationTemplatesOf(sub);
  const leases = leaseTemplatesOf(sub);
  const forms = readMoveInFormTemplates(sub);
  const fee = applications[0] ? applicationFeeFact(sub, applications[0]) : "No fee";
  const from = pricingFromFact(sub);
  return {
    application: `${plural(applications.filter(isApplicationTemplateOffered).length, "application")} · ${fee === "No fee" ? "no fee" : `fee ${fee}`}`,
    lease: leases.length === 0 ? "None yet" : plural(leases.length, "lease"),
    movein: plural(forms.length, "form"),
    pricing: from ? `From ${from}` : "Rent not set",
  };
}

/* ─────────────────────────── shared little pieces ─────────────────────────── */

function RowCard({ children, dataAttr }: { children: ReactNode; dataAttr: string }) {
  return (
    <div className="max-w-[760px] overflow-hidden rounded-2xl border border-border bg-card" data-attr={dataAttr}>
      {children}
    </div>
  );
}

/**
 * A flat row that unfolds in place: the name with its chevron after it, the row's main controls, a ⋯ menu,
 * an optional second line of controls, and (open) the rest of the form underneath.
 */
function FormRow({
  name,
  open,
  onToggle,
  first = false,
  dataAttr,
  toggleDataAttr,
  controls,
  menu,
  below,
  children,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
  first?: boolean;
  dataAttr: string;
  toggleDataAttr: string;
  controls?: ReactNode;
  menu?: ReactNode;
  below?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cn(!first && "border-t border-border")} data-attr={dataAttr}>
      <div className="flex min-h-[56px] flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
          data-attr={toggleDataAttr}
          onClick={onToggle}
          className="flex min-w-0 flex-1 basis-[9rem] items-center gap-1.5 text-left text-[14px] font-semibold text-foreground"
        >
          <span className="truncate">{name}</span>
          <PortalTableExpandChevron expanded={open} />
        </button>
        {controls}
        {menu}
      </div>
      {below ? <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 pb-2.5">{below}</div> : null}
      {open ? (
        <div className="space-y-3 border-t border-border bg-foreground/[0.02] px-3.5 py-3" data-attr={`${dataAttr}-body`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A small label beside the control it names (a switch, a money box). */
function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <span className="text-[12px] font-semibold text-muted">{label}</span>
      {children}
    </span>
  );
}

function AddLine({ label, onClick, dataAttr }: { label: string; onClick: () => void; dataAttr: string }) {
  return (
    <button
      type="button"
      data-attr={dataAttr}
      onClick={onClick}
      className="flex min-h-[48px] w-full items-center gap-2 border-t border-border px-3.5 text-[13px] font-semibold text-primary transition hover:bg-primary/[0.04]"
    >
      <Plus className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

function EmptyRows({ text }: { text: string }) {
  return <div className="px-3.5 py-4 text-[13px] text-muted">{text}</div>;
}

/** A name that saves as it is typed, except when it is empty or another form already has it. */
function NameField({
  id,
  label,
  value,
  taken,
  onCommit,
  dataAttr,
}: {
  id: string;
  label: string;
  value: string;
  taken: readonly string[];
  onCommit: (next: string) => void;
  dataAttr: string;
}) {
  const [text, setText] = useState(value);
  // The stored name changed from outside (not by this box): show it.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (text.trim() !== value) setText(value);
  }
  const clashes = (candidate: string) =>
    taken.some((other) => other.trim().toLowerCase() === candidate.trim().toLowerCase());
  const error = !text.trim() ? "Enter a name." : clashes(text) ? `"${text.trim()}" already exists.` : null;
  return (
    <FloatingLabelField
      id={id}
      label={label}
      value={text}
      error={error}
      dataAttr={dataAttr}
      onChange={(next) => {
        setText(next);
        const trimmed = next.trim();
        if (trimmed && !clashes(trimmed)) onCommit(trimmed);
      }}
    />
  );
}

/** Delete / Duplicate, with a tap to confirm the delete. */
function useRowMenu() {
  const confirm = useConfirm();
  return useCallback(
    (name: string, handlers: { onDuplicate?: () => void; onDelete: () => void }, dataAttr: string) => (
      <PortalRowMenu
        label={name}
        dataAttr={`${dataAttr}-menu`}
        items={[
          handlers.onDuplicate
            ? { id: "duplicate", label: "Duplicate", dataAttr: `${dataAttr}-duplicate`, onSelect: handlers.onDuplicate }
            : null,
          {
            id: "delete",
            label: "Delete",
            danger: true,
            dataAttr: `${dataAttr}-delete`,
            onSelect: () => {
              void confirm({
                title: `Delete ${name}?`,
                description: `Delete ${name}?`,
                confirmLabel: "Delete",
                tone: "danger",
                note: null,
              }).then((ok) => {
                if (ok) handlers.onDelete();
              });
            },
          },
        ]}
      />
    ),
    [confirm],
  );
}

function toggleId(set: ReadonlySet<string>, id: string, on?: boolean): ReadonlySet<string> {
  const next = new Set(set);
  const want = on ?? !next.has(id);
  if (want) next.add(id);
  else next.delete(id);
  return next;
}

/* ─────────────────────────── Application ─────────────────────────── */

const BEFORE_TOUR_OPTIONS = [
  { value: "not_needed", label: "Not needed" },
  { value: "required", label: "Required" },
];

/**
 * "Application before a tour" is one value for the whole workspace. It reads as "Not needed" until the
 * stored value arrives (the workspace default), and a pick saves straight to the workspace setting through
 * the route Settings uses. A failed save puts the old value back.
 */
function useApplicationBeforeTour(showToast: (message: string) => void) {
  const [value, setValue] = useState<ApplicationBeforeTour>("not_needed");
  // A pick made before the stored value arrives wins over it.
  const picked = useRef(false);
  useEffect(() => {
    if (typeof fetch !== "function") return;
    let cancelled = false;
    void fetch("/api/portal/manager-application-settings", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { leasingPipeline?: unknown } | null) => {
        if (cancelled || !body || picked.current) return;
        setValue(normalizeLeasingPipelinePreferences(body.leasingPipeline).applicationBeforeTour);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const save = (next: ApplicationBeforeTour) => {
    const previous = value;
    picked.current = true;
    setValue(next);
    void fetch("/api/portal/manager-application-settings", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leasingPipeline: { applicationBeforeTour: next } }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("save failed");
      })
      .catch(() => {
        setValue(previous);
        showToast("Could not save.");
      });
  };
  return { value, save };
}

/**
 * Publishes what the inline question editor left in draft, so applicants see it. One new version per
 * editing pause (and when a row closes or the step leaves), never one per keystroke.
 */
function useDraftPublisher(sub: ManagerListingSubmissionV1, onChange: (next: ManagerListingSubmissionV1) => void) {
  const subRef = useRef(sub);
  const onChangeRef = useRef(onChange);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    subRef.current = sub;
    onChangeRef.current = onChange;
  });
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = publishPendingApplicationDrafts(subRef.current, sanitizeCustomApplicationFieldsForSave);
    if (next !== subRef.current) onChangeRef.current(next);
  }, []);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1200);
  }, [flush]);
  useEffect(() => () => flush(), [flush]);
  return { flush, schedule };
}

const NO_LEASE = "__default__";

export function StepApplication({ sub, onChange, doors }: StepProps) {
  const synced = useMemo(() => syncPropertyApplicationTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyApplicationTemplates(synced), [synced]);
  const leases = useMemo(() => leaseTemplatesOf(sub), [sub]);
  const leaseOptions = useMemo(
    () => leaseChoicesForApplication(leases).map((lease) => ({ value: lease.id, label: lease.label?.trim() || "Lease" })),
    [leases],
  );
  const catalog = { applications: templates, leases };
  const rowMenu = useRowMenu();
  const publisher = useDraftPublisher(sub, onChange);
  const beforeTour = useApplicationBeforeTour(doors.showToast);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [startFrom, setStartFrom] = useState<Record<string, string>>({});

  const commitTemplates = (next: PropertyApplicationTemplate[]) => onChange(withApplicationTemplates(synced, next));
  const replace = (next: PropertyApplicationTemplate) =>
    commitTemplates(templates.map((row) => (row.id === next.id ? next : row)));

  const toggle = (id: string) => {
    if (openIds.has(id)) {
      publisher.flush();
      setFreshIds((current) => toggleId(current, id, false));
    }
    setOpenIds((current) => toggleId(current, id));
  };

  const add = () => {
    const created = createInlineApplication(synced, templates, "proplane");
    commitTemplates([...templates, created]);
    setOpenIds((current) => toggleId(current, created.id, true));
    setFreshIds((current) => toggleId(current, created.id, true));
    publisher.schedule();
  };

  const duplicate = (template: PropertyApplicationTemplate) => {
    const copy = createInlineApplication(synced, templates, template.id);
    const index = templates.findIndex((row) => row.id === template.id);
    const next = [...templates];
    next.splice(index + 1, 0, copy);
    commitTemplates(next);
    setOpenIds((current) => toggleId(current, copy.id, true));
    publisher.schedule();
  };

  const remove = (template: PropertyApplicationTemplate) =>
    onChange(submissionAfterRemovingApplicationTemplate(synced, templates.filter((row) => row.id !== template.id)));

  const startFromOptions = (template: PropertyApplicationTemplate) => [
    { value: "proplane", label: "PropLane standard" },
    ...templates
      .filter((row) => row.id !== template.id)
      .map((row) => ({ value: row.id, label: normalizePropertyApplicationTemplateLabel(row.label) || "Application" })),
  ];

  return (
    <StepColumn wide>
      <StepHeading title="Application" />
      <RowCard dataAttr="listing-v2-application-rows">
        {templates.length === 0 ? <EmptyRows text="No applications yet" /> : null}
        {templates.map((template, index) => {
          const name = normalizePropertyApplicationTemplateLabel(template.label) || "Application";
          const scope = applicationFeeScopeForTemplate(template);
          const fee = readApplicationFeeInput(synced, scope);
          const isCosigner = isCosignerApplicationTemplate(template);
          const open = openIds.has(template.id);
          const leaseId = leaseOfApplication(catalog, template.id);
          return (
            <FormRow
              key={template.id}
              first={index === 0}
              name={name}
              open={open}
              onToggle={() => toggle(template.id)}
              dataAttr="listing-v2-application-row"
              toggleDataAttr="listing-v2-application-toggle"
              controls={
                <>
                  <Labeled label="Fee">
                    <MoneyInput
                      label={`${name} application fee`}
                      value={fee.value}
                      placeholder={fee.placeholder}
                      dataAttr="listing-v2-application-fee"
                      onChange={(raw) => onChange(withApplicationTemplates(withApplicationFee(synced, scope, raw), templates))}
                    />
                  </Labeled>
                  <Labeled label="Needed">
                    <PortalSettingsToggle
                      checked={isApplicationTemplateOffered(template)}
                      label={`${name}: needed`}
                      dataAttr="listing-v2-application-needed"
                      onChange={(on) => commitTemplates(patchApplicationTemplate(templates, template.id, { offered: on }))}
                    />
                  </Labeled>
                </>
              }
              menu={rowMenu(name, { onDuplicate: () => duplicate(template), onDelete: () => remove(template) }, "listing-v2-application")}
            >
              {freshIds.has(template.id) ? (
                <FieldSingleSelect
                  label="Start from"
                  value={startFrom[template.id] ?? "proplane"}
                  options={startFromOptions(template)}
                  dataAttr="listing-v2-application-start-from"
                  onChange={(source) => {
                    setStartFrom((current) => ({ ...current, [template.id]: source }));
                    const fresh = createInlineApplication(
                      synced,
                      templates.filter((row) => row.id !== template.id),
                      source,
                    );
                    replace({
                      ...template,
                      kind: fresh.kind,
                      formVariant: fresh.formVariant,
                      draftQuestionConfig: fresh.draftQuestionConfig,
                    });
                    publisher.schedule();
                  }}
                />
              ) : null}
              <NameField
                id={`application-name-${template.id}`}
                label="Application name"
                value={name}
                taken={templates.filter((row) => row.id !== template.id).map((row) => row.label)}
                dataAttr="listing-v2-application-name"
                onCommit={(label) => replace({ ...template, label, updatedAt: new Date().toISOString() })}
              />
              {isCosigner ? null : (
                <FieldSingleSelect
                  label="Lease"
                  value={leaseId ?? NO_LEASE}
                  options={[{ value: NO_LEASE, label: "Property default" }, ...leaseOptions]}
                  dataAttr="listing-v2-application-lease"
                  onChange={(next) =>
                    commitTemplates(linkApplicationToLease(catalog, template.id, next === NO_LEASE ? null : next))
                  }
                />
              )}
              <InlineApplicationQuestions
                sub={synced}
                template={template}
                onTemplate={(next) => {
                  replace(next);
                  publisher.schedule();
                }}
              />
            </FormRow>
          );
        })}
        <AddLine label="Add application" onClick={add} dataAttr="listing-v2-application-add" />
      </RowCard>
      <div className="mt-6">
        <RowCard dataAttr="listing-v2-application-before-tour">
          <div className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 px-3.5 py-1.5">
            <span className="min-w-0 text-[14px] font-semibold text-foreground">Application before a tour</span>
            <FieldSingleSelect
              hideLabel
              label="Application before a tour"
              variant="cell"
              wrapperClassName="w-48"
              value={beforeTour.value}
              options={BEFORE_TOUR_OPTIONS}
              dataAttr="listing-v2-application-before-tour-select"
              onChange={(next) => beforeTour.save(next as ApplicationBeforeTour)}
            />
          </div>
        </RowCard>
      </div>
    </StepColumn>
  );
}

/* ─────────────────────────── Lease ─────────────────────────── */

/** The clause editor for one open lease: the generated document (or the manager's edits to it), edited in place. */
function InlineLeaseDocument({
  sub,
  template,
  onHtml,
  onUpload,
  busy,
}: {
  sub: ManagerListingSubmissionV1;
  template: PropertyLeaseTemplate;
  onHtml: (html: string) => void;
  onUpload: () => void;
  busy: boolean;
}) {
  const baseline = useMemo(() => {
    const draft = {
      leaseConfigMode: template.leaseConfigMode,
      leaseCustomKind: template.leaseCustomKind,
      customLeaseTerms: template.customLeaseTerms ?? "",
      leaseTemplateDocUrl: template.leaseTemplateDocUrl ?? null,
      leaseTemplateDocName: template.leaseTemplateDocName ?? "",
      leaseTemplateHtmlOverride: "",
    };
    try {
      return resolvePropertyLeaseEditHtml({
        sub: { ...sub, ...draft },
        draft,
        source: leaseSourceFromDraft(draft),
        templateKind: template.kind,
      });
    } catch {
      return "";
    }
  }, [
    sub,
    template.kind,
    template.leaseConfigMode,
    template.leaseCustomKind,
    template.customLeaseTerms,
    template.leaseTemplateDocUrl,
    template.leaseTemplateDocName,
  ]);
  const html = template.leaseTemplateHtmlOverride?.trim() || baseline;
  if (!html.trim()) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={onUpload}
        data-attr="listing-v2-lease-upload"
        className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-card text-sm font-semibold text-primary disabled:opacity-60"
      >
        {busy ? "Reading your PDF…" : "Upload a PDF"}
      </button>
    );
  }
  return (
    <div data-attr="listing-v2-lease-document">
      <PropertyLeaseDocumentEditor
        className="min-h-[min(380px,50vh)]"
        html={html}
        baselineHtml={baseline}
        onChange={(next) => onHtml(next.trim() === baseline.trim() ? "" : next)}
      />
    </div>
  );
}

const LEASE_OPTIONS: ReadonlyArray<{ key: LeaseOptionKey; label: string }> = [
  { key: "custom", label: "Allow custom dates" },
  { key: "monthToMonth", label: "Allow month-to-month" },
];

export function StepLease({ sub, onChange, doors }: StepProps) {
  const synced = useMemo(() => syncPropertyLeaseTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyLeaseTemplates(synced), [synced]);
  const applications = useMemo(() => applicationTemplatesOf(sub), [sub]);
  const catalog = { applications, leases: templates };
  const applicationOptions = useMemo(
    () =>
      mappableApplicationTemplates(applications).map((application) => ({
        value: application.id,
        label: normalizePropertyApplicationTemplateLabel(application.label) || "Application",
      })),
    [applications],
  );
  // The lease types this property offers that have no lease yet: shown as off, and switched on to add them.
  const missingSeeds = useMemo(() => availableLeaseTemplateSeeds(synced), [synced]);
  const confirm = useConfirm();
  const rowMenu = useRowMenu();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<string | null>(null);

  const commitLeases = (
    next: PropertyLeaseTemplate[],
    extra: { touched?: LeaseOptionKey[]; applications?: PropertyApplicationTemplate[] } = {},
  ) => {
    const written = submissionWithLeaseTemplates(synced, next, extra.touched ?? []);
    onChange(extra.applications ? withApplicationTemplates(written, extra.applications) : written);
  };
  const patchLease = (id: string, patch: Partial<PropertyLeaseTemplate>) =>
    commitLeases(updatePropertyLeaseTemplate(templates, id, patch));

  const addStandard = () => {
    const added = submissionWithStandardLease(synced, templates, "long-term");
    onChange(added.sub);
    if (added.leaseId) {
      setOpenIds((current) => toggleId(current, added.leaseId, true));
    }
  };

  const duplicate = (template: PropertyLeaseTemplate) => {
    const copy = duplicateLeaseTemplate(templates, template.id);
    if (!copy) return;
    const index = templates.findIndex((row) => row.id === template.id);
    const next = [...templates];
    next.splice(index + 1, 0, copy);
    commitLeases(next);
    setOpenIds((current) => toggleId(current, copy.id, true));
  };

  const remove = (template: PropertyLeaseTemplate) => {
    const remaining = removePropertyLeaseTemplate(templates, template.id);
    commitLeases(remaining, { applications: releaseDeletedLeaseLinks(applications, remaining) });
  };

  const pickPdf = (id: string) => {
    uploadFor.current = id;
    fileRef.current?.click();
  };

  const onFile = async (file: File | null) => {
    const id = uploadFor.current;
    uploadFor.current = null;
    const template = templates.find((row) => row.id === id);
    if (!file || !template) return;
    const fields = await importLeasePdf({
      file,
      kind: template.kind,
      showToast: doors.showToast,
      setBusy: (busy) => setBusyId(busy ? template.id : null),
    });
    if (fields) patchLease(template.id, fields);
  };

  const changeStart = async (template: PropertyLeaseTemplate, next: string) => {
    const seeded = Boolean(template.listingSeedKey);
    const current = template.leaseCustomKind === "document" ? "upload" : seeded ? "standard" : template.kind === "short-term" ? "short-term" : "long-term";
    if (next === current) return;
    const hasWork = Boolean(template.leaseTemplateHtmlOverride?.trim() || template.leaseTemplateDocUrl);
    if (
      hasWork &&
      !(await confirm({ description: "Replace this lease's document?", confirmLabel: "Replace", tone: "danger", note: null }))
    ) {
      return;
    }
    if (next === "upload") {
      pickPdf(template.id);
      return;
    }
    patchLease(template.id, {
      kind: next === "short-term" ? "short-term" : next === "long-term" ? "long-term" : template.kind,
      leaseConfigMode: "standard",
      leaseCustomKind: "terms",
      customLeaseTerms: "",
      leaseTemplateDocUrl: null,
      leaseTemplateDocName: "",
      leaseTemplateHtmlOverride: "",
      leaseTemplateImportReview: undefined,
    });
  };

  const rowCount = templates.length + missingSeeds.length;

  return (
    <StepColumn wide>
      <StepHeading title="Lease" />
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a lease PDF"
        accept="application/pdf,.pdf"
        data-attr="listing-v2-lease-file"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          void onFile(file);
        }}
      />
      <RowCard dataAttr="listing-v2-lease-rows">
        {rowCount === 0 ? <EmptyRows text="No leases yet" /> : null}
        {templates.map((template, index) => {
          const name = template.label?.trim() || "Lease";
          const open = openIds.has(template.id);
          const terms = template.applicationLeaseTerms ?? [];
          const flags = leaseOptionFlags(terms);
          const showOptions = template.kind !== "short-term" && leaseTermsAllowOptions(terms);
          const seeded = Boolean(template.listingSeedKey);
          const startValue =
            template.leaseCustomKind === "document" ? "upload" : seeded ? "standard" : template.kind === "short-term" ? "short-term" : "long-term";
          return (
            <FormRow
              key={template.id}
              first={index === 0}
              name={name}
              open={open}
              onToggle={() => setOpenIds((current) => toggleId(current, template.id))}
              dataAttr="listing-v2-lease-row"
              toggleDataAttr="listing-v2-lease-toggle"
              controls={
                <>
                  <span className="shrink-0 text-[13px] text-muted" data-attr="listing-v2-lease-type">
                    {leaseTypeFact(template)}
                  </span>
                  <Labeled label="Offered">
                    <PortalSettingsToggle
                      checked={template.offered !== false}
                      label={`${name}: offered`}
                      dataAttr="listing-v2-lease-offered"
                      onChange={(on) => patchLease(template.id, { offered: on })}
                    />
                  </Labeled>
                </>
              }
              menu={rowMenu(name, { onDuplicate: () => duplicate(template), onDelete: () => remove(template) }, "listing-v2-lease")}
              below={
                <>
                  {applicationOptions.length > 0 ? (
                    <CheckboxMultiSelect
                      hideLabel
                      label={`Applications for ${name}`}
                      variant="cell"
                      className="w-56"
                      options={applicationOptions}
                      selected={applicationsOfLease(catalog, template.id).map((row) => row.id)}
                      emptyLabel="No applications"
                      dataAttr="listing-v2-lease-applications"
                      onChange={(ids) =>
                        commitLeases(templates, { applications: setApplicationsOfLease(catalog, template.id, ids) })
                      }
                    />
                  ) : null}
                  {showOptions
                    ? LEASE_OPTIONS.map((option) => (
                        <label key={option.key} className="flex cursor-pointer items-center gap-2 py-1 text-[13px] font-semibold text-foreground">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border"
                            checked={flags[option.key]}
                            data-attr={`listing-v2-lease-${option.key === "custom" ? "allow-custom-dates" : "allow-month-to-month"}`}
                            onChange={(event) =>
                              onChange(submissionWithLeaseOption(synced, templates, template.id, option.key, event.target.checked))
                            }
                          />
                          {option.label}
                        </label>
                      ))
                    : null}
                </>
              }
            >
              <NameField
                id={`lease-name-${template.id}`}
                label="Lease document name"
                value={name}
                taken={templates.filter((row) => row.id !== template.id).map((row) => row.label ?? "")}
                dataAttr="listing-v2-lease-name"
                onCommit={(label) => patchLease(template.id, { label })}
              />
              <FieldSingleSelect
                label="Start from"
                value={startValue}
                dataAttr="listing-v2-lease-start-from"
                options={
                  seeded
                    ? [
                        { value: "standard", label: "PropLane standard" },
                        { value: "upload", label: "Upload a PDF" },
                      ]
                    : [
                        { value: "long-term", label: "PropLane standard long-term" },
                        { value: "short-term", label: "PropLane standard short term" },
                        { value: "upload", label: "Upload a PDF" },
                      ]
                }
                onChange={(next) => void changeStart(template, next)}
              />
              <InlineLeaseDocument
                sub={synced}
                template={template}
                busy={busyId === template.id}
                onUpload={() => pickPdf(template.id)}
                onHtml={(html) => patchLease(template.id, { leaseTemplateHtmlOverride: html })}
              />
            </FormRow>
          );
        })}
        {missingSeeds.map((seed, index) => (
          <FormRow
            key={seed.seedKey}
            first={templates.length === 0 && index === 0}
            name={seed.label}
            open={false}
            onToggle={() => {}}
            dataAttr="listing-v2-lease-default-row"
            toggleDataAttr="listing-v2-lease-default-toggle"
            controls={
              <Labeled label="Offered">
                <PortalSettingsToggle
                  checked={false}
                  label={`${seed.label}: offered`}
                  dataAttr="listing-v2-lease-default-offered"
                  onChange={(on) => {
                    if (on) onChange(addLeaseTemplateFromSeed(synced, seed.seedKey));
                  }}
                />
              </Labeled>
            }
          />
        ))}
        <AddLine label="Add lease" onClick={addStandard} dataAttr="listing-v2-lease-add" />
      </RowCard>
    </StepColumn>
  );
}

/* ─────────────────────────── Move-in ─────────────────────────── */

/** The open form's name and questions. Held locally so a question still being typed is not dropped by the store's clean-up. */
function MoveInInlineBody({
  template,
  taken,
  onTemplate,
  fresh,
}: {
  template: MoveInFormTemplate;
  taken: readonly string[];
  onTemplate: (next: MoveInFormTemplate) => void;
  fresh: boolean;
}) {
  const [questions, setQuestions] = useState(template.questions);
  const setBoth = (nextQuestions: MoveInFormTemplate["questions"], patch: Partial<MoveInFormTemplate> = {}) => {
    setQuestions(nextQuestions);
    onTemplate(cleanMoveInTemplateForSave({ ...template, ...patch, questions: nextQuestions }));
  };
  const starterOptions = [
    { value: "blank", label: "Blank form" },
    ...MOVE_IN_FORM_STARTERS.map((starter) => ({ value: starter.starterKey ?? starter.id, label: starter.name })),
  ];
  return (
    <>
      {fresh ? (
        <FieldSingleSelect
          label="Start from"
          value={template.starterKey ?? "blank"}
          options={starterOptions}
          dataAttr="listing-v2-movein-start-from"
          onChange={(value) => {
            const starter = MOVE_IN_FORM_STARTERS.find((item) => (item.starterKey ?? item.id) === value);
            const nextQuestions = starter ? structuredClone(starter.questions) : [];
            setQuestions(nextQuestions);
            onTemplate({
              ...template,
              questions: nextQuestions,
              starterKey: starter ? (value as MoveInFormStarterKey) : undefined,
              due: starter?.due ?? template.due,
              name: starter && /^New form( \d+)?$/.test(template.name) ? starter.name : template.name,
            });
          }}
        />
      ) : null}
      <NameField
        id={`move-in-name-${template.id}`}
        label="Form name"
        value={template.name}
        taken={taken}
        dataAttr="listing-v2-movein-name"
        onCommit={(name) => onTemplate({ ...template, name })}
      />
      <MoveInQuestionsEditor questions={questions} onChange={(next) => setBoth(next)} />
    </>
  );
}

export function StepMoveIn({ sub, onChange }: StepProps) {
  const templates = useMemo(() => readMoveInFormTemplates(sub), [sub]);
  const rowMenu = useRowMenu();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());

  /**
   * The first write also stores the starters. Only the form the manager touched keeps its own Sends;
   * untouched starters are stored as "Only when I send it" (same rule as the Move-in tab).
   */
  const write = (list: MoveInFormTemplate[], editedId: string | null) => {
    const firstSave = !Array.isArray((sub as { moveInFormTemplates?: unknown }).moveInFormTemplates);
    const next = firstSave
      ? list.map((item) => (item.id.startsWith("starter-") && item.id !== editedId ? { ...item, trigger: "manual" as const } : item))
      : list;
    onChange({ ...sub, moveInFormTemplates: next });
  };
  const replace = (template: MoveInFormTemplate) =>
    write(templates.map((item) => (item.id === template.id ? template : item)), template.id);

  const add = () => {
    const created: MoveInFormTemplate = {
      ...newMoveInFormTemplate("built"),
      name: uniqueFormLabel(templates.map((item) => item.name), "New form"),
      // A new form never messages a resident until the manager picks when.
      trigger: "manual",
    };
    write([...templates, created], created.id);
    setOpenIds((current) => toggleId(current, created.id, true));
    setFreshIds((current) => toggleId(current, created.id, true));
  };

  const duplicate = (template: MoveInFormTemplate) => {
    const { list, copy } = duplicateMoveInTemplate(templates, template.id, newMoveInFormTemplate("built").id);
    if (!copy) return;
    write(list, copy.id);
    setOpenIds((current) => toggleId(current, copy.id, true));
  };

  return (
    <StepColumn wide>
      <StepHeading title="Move-in" />
      <RowCard dataAttr="listing-v2-movein-rows">
        {templates.length === 0 ? <EmptyRows text="No move-in forms yet" /> : null}
        {templates.map((template, index) => {
          const name = template.name.trim() || "Untitled form";
          const open = openIds.has(template.id);
          return (
            <FormRow
              key={template.id}
              first={index === 0}
              name={name}
              open={open}
              onToggle={() => {
                setOpenIds((current) => toggleId(current, template.id));
                if (open) setFreshIds((current) => toggleId(current, template.id, false));
              }}
              dataAttr="listing-v2-movein-row"
              toggleDataAttr="listing-v2-movein-toggle"
              controls={
                <Labeled label="Sends">
                  <FieldSingleSelect
                    hideLabel
                    label={`${name} sends`}
                    variant="cell"
                    wrapperClassName="w-60"
                    value={template.trigger}
                    options={MOVE_IN_TRIGGER_OPTIONS}
                    dataAttr="listing-v2-movein-sends"
                    onChange={(value) =>
                      replace({
                        ...template,
                        trigger: value as MoveInFormTemplate["trigger"],
                        due: dueForTriggerChange(value as MoveInFormTemplate["trigger"], template.due),
                      })
                    }
                  />
                </Labeled>
              }
              menu={rowMenu(
                name,
                {
                  onDuplicate: () => duplicate(template),
                  onDelete: () => write(removeMoveInTemplate(templates, template.id), null),
                },
                "listing-v2-movein",
              )}
            >
              <MoveInInlineBody
                key={template.id}
                template={template}
                taken={templates.filter((item) => item.id !== template.id).map((item) => item.name)}
                onTemplate={replace}
                fresh={freshIds.has(template.id)}
              />
            </FormRow>
          );
        })}
        <AddLine label="Add form" onClick={add} dataAttr="listing-v2-movein-add" />
      </RowCard>
    </StepColumn>
  );
}

/* ─────────────────────────── Pricing ─────────────────────────── */

export function StepPricing({ sub, onChange }: StepProps) {
  const wholeHome = isEntireHomeListing(sub);
  const rooms = (sub.rooms ?? []).filter((room) => room.name.trim() || room.monthlyRent > 0);
  const offersStays = resolveAllowedLeaseTerms(sub).includes(SHORT_TERM_LEASE_TERM) || Boolean(sub.shortTermRentalsAllowed);
  const tabs = listingPricingLeaseTabs(sub);
  const termOptions = [
    { value: LONG_TERM_LEASE_TERM, label: "Long-term" },
    ...(offersStays && (tabs.includes(SHORT_TERM_LEASE_TERM) || sub.shortTermRentalsAllowed)
      ? [{ value: SHORT_TERM_LEASE_TERM, label: "Short term" }]
      : []),
  ];
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [term, setTerm] = useState<string>(LONG_TERM_LEASE_TERM);
  const activeTerm = termOptions.some((option) => option.value === term) ? term : LONG_TERM_LEASE_TERM;

  const patch = (next: Partial<ManagerListingSubmissionV1>) => onChange({ ...sub, ...next });
  const updateRoom = (roomId: string, next: ManagerRoomSubmission) => patch(roomPricingPatch(sub, roomId, next));

  const termSwitch =
    termOptions.length > 1 ? (
      <SegmentedControl
        ariaLabel="Lease type"
        value={activeTerm}
        options={termOptions}
        dataAttrPrefix="listing-v2-pricing-term"
        onChange={setTerm}
      />
    ) : null;

  const wholeAmount = entireHomeMonthlyRentAmount(sub);

  return (
    <StepColumn wide>
      <StepHeading title="Pricing" />
      <RowCard dataAttr="listing-v2-pricing-rows">
        {wholeHome ? (
          <FormRow
            first
            name="Whole house"
            open={openIds.has("whole")}
            onToggle={() => setOpenIds((current) => toggleId(current, "whole"))}
            dataAttr="listing-v2-pricing-row"
            toggleDataAttr="listing-v2-pricing-toggle"
            controls={<span className="shrink-0 text-[13px] text-muted">{wholeAmount > 0 ? `$${Math.round(wholeAmount).toLocaleString("en-US")}/mo` : "Rent not set"}</span>}
          >
            {termSwitch}
            <WholeHousePricingFields draft={sub} activeStepId={activeTerm} patch={patch} />
          </FormRow>
        ) : rooms.length === 0 ? (
          <EmptyRows text="No rooms to price yet" />
        ) : (
          rooms.map((room, index) => {
              const name = room.name.trim() || "Room";
              const amount = propertyPricingRoomAmount(room);
              const open = openIds.has(room.id);
              return (
                <FormRow
                  key={room.id}
                  first={index === 0}
                  name={name}
                  open={open}
                  onToggle={() => setOpenIds((current) => toggleId(current, room.id))}
                  dataAttr="listing-v2-pricing-row"
                  toggleDataAttr="listing-v2-pricing-toggle"
                  controls={<span className="shrink-0 text-[13px] text-muted">{amount === "—" ? "Rent not set" : amount}</span>}
                >
                  {termSwitch}
                  <RoomPricingFields
                    draft={sub}
                    room={room}
                    activeTerm={activeTerm}
                    patch={patch}
                    setDraft={onChange}
                    updateRoom={updateRoom}
                  />
                </FormRow>
              );
            })
        )}
      </RowCard>
    </StepColumn>
  );
}

/* ─────────────────────────── right-hand panel ─────────────────────────── */

const SUMMARY_ROWS: ReadonlyArray<{ id: ListingDetailStepId; label: string }> = [
  { id: "application", label: "Applications" },
  { id: "lease", label: "Leases" },
  { id: "movein", label: "Move-in forms" },
  { id: "pricing", label: "Pricing" },
];

/** The four leasing steps in one place, the current one in bold. */
export function ListingDetailSummaryPanel({ sub, current }: { sub: ManagerListingSubmissionV1; current: ListingDetailStepId }) {
  const summaries = listingDetailSummaries(sub);
  const leaseNames = leaseTemplatesOf(sub)
    .map((template) => template.label?.trim())
    .filter(Boolean)
    .join(", ");
  return (
    <PanelSection title="Leasing summary">
      <dl className="space-y-2.5" data-attr="listing-v2-detail-summary">
        {SUMMARY_ROWS.map((row) => (
          <div key={row.id} className="flex items-baseline justify-between gap-3" data-attr={`listing-v2-detail-summary-${row.id}`}>
            <dt className={cn("text-[12.5px]", row.id === current ? "font-bold text-foreground" : "text-muted")}>{row.label}</dt>
            <dd className={cn("min-w-0 text-right text-[13px]", row.id === current ? "font-bold text-foreground" : "font-semibold text-foreground")}>
              {row.id === "lease" && leaseNames ? leaseNames : summaries[row.id]}
            </dd>
          </div>
        ))}
      </dl>
    </PanelSection>
  );
}
