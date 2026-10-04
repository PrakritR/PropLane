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
 *   components. On a by-the-room listing a Bundles section always follows the room cards: the Whole house
 *   card first (its own Offered switch), then the custom bundles, each with the same fields as a room.
 *
 * The round + on Application, Lease and Move-in offers the choices the property tabs' + offer, including
 * "Upload a PDF", which runs that step's existing upload (a brand-new draft is saved first through `ensureSaved`).
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
import { CalendarDays, Moon } from "lucide-react";
import { PortalRowMenu } from "@/components/portal/portal-row-menu";
import { STAY_LABEL, listingOfferedStays, visibleStaySections, type StaySectionKey } from "@/lib/listing-stays";
import { invalidateSharedGets } from "@/lib/shared-get-cache";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import {
  CardAction,
  FactRow,
  MoneyInput,
  PanelSection,
  RecordCard,
  RowSelectCell,
  StepColumn,
  StepHeading,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { importApplicationPdf } from "@/components/portal/listing-wizard-v2/inline-application-upload";
import { deriveFormNameFromFileName } from "@/components/portal/pro-property-application-questions-panel";
import { uploadMoveInFormPdf } from "@/lib/move-in-forms/client";
import { LEASE_TEMPLATE_MAX_BYTES } from "@/lib/lease-template-storage";
import { InlineApplicationQuestions } from "@/components/portal/listing-wizard-v2/inline-application-questions";
import { importLeasePdf } from "@/components/portal/listing-wizard-v2/inline-lease-upload";
import {
  BundlePricingFields,
  RoomPricingFields,
  WholeHousePricingFields,
  roomPricingPatch,
} from "@/components/portal/property-room-pricing-workspace";
import { PropertyLeaseDocumentEditor } from "@/components/portal/property-lease-document-editor";
import { MoveInQuestionsEditor } from "@/components/portal/move-in-forms/move-in-questions-editor";
import {
  cleanMoveInTemplateForSave,
  dueForTriggerChange,
  dueOptionsForTrigger,
  duplicateMoveInTemplate,
  MOVE_IN_TRIGGER_OPTIONS,
  moveInLeaseTypeOptions,
  type MoveInLeaseTypeLease,
  removeMoveInTemplate,
  triggerSummary,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { sanitizeCustomApplicationFieldsForSave } from "@/components/portal/application-question-edit-modal";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
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
  questionSliceForTemplate,
  readApplicationFeeInput,
  releaseDeletedLeaseLinks,
  setApplicationsOfLease,
  submissionWithStandardLease,
  uniqueFormLabel,
  withApplicationTemplates,
} from "@/lib/listing-inline-forms";
import { orderedEditorApplicationFields } from "@/lib/application-editor-fields";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import { pricingSectionOptions, type PricingLeaseOption } from "@/lib/pricing-lease-options";
import { LeasingQuickAddRow } from "@/components/portal/leasing-quick-add-row";
import { FormPromoCodesRow } from "@/components/portal/form-promo-codes";
import { centsToMoneyText, moneyTextToCents, templateFeeCents } from "@/lib/form-template-fees";
import {
  applicationForAppliesTo,
  missingApplicationDefaults,
  missingLeaseDefaults,
  missingMoveInStarters,
  submissionWithApplicationDefault,
  submissionWithLeaseDefault,
  submissionWithMoveInStarter,
} from "@/lib/leasing-quick-add";
import { parseMoneyAmount } from "@/lib/parse-money";
import { normalizeLeasingPipelinePreferences, type ApplicationBeforeTour } from "@/lib/leasing-pipeline-preferences";
import {
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import {
  MOVE_IN_FORM_STARTERS,
  moveInFormLeaseTypePatch,
  moveInFormLeaseTypeValue,
  newMoveInFormTemplate,
  readMoveInFormTemplates,
} from "@/lib/move-in-forms/templates";
import type { MoveInFormStarterKey, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import {
  applicationAllowsCosigner,
  applicationAppliesTo,
  applicationCoversStay,
  applicationFormVariantForTemplate,
  effectiveDefaultApplicationForStay,
  isApplicationTemplateOffered,
  readPropertyApplicationTemplates,
  staysOfAppliesTo,
  withApplicationAppliesTo,
  withApplicationDefaultToggled,
  withoutShortTermCosignerLinks,
  type ApplicationAppliesTo,
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
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";
import { leaseSourceFromDraft } from "@/lib/property-lease-source";
import { propertyPricingBundleTitle, propertyPricingRoomAmount } from "@/lib/property-pricing-summary";
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
  if (template.listingSeedKey === "primary") return "Long-term";
  if (template.listingSeedKey === "short-term") return "Short-term";
  if (template.listingSeedKey === "airbnb") return "Airbnb";
  return template.leaseTemplateDocName?.trim() ? "PDF" : "Custom";
}

/** True for a lease whose document is an uploaded PDF. */
const isPdfLease = (template: PropertyLeaseTemplate) =>
  template.leaseCustomKind === "document" && Boolean(template.leaseTemplateDocUrl || template.leaseTemplateDocName?.trim());

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

/**
 * The step heading with its count and the round blue + at the top right: exactly the Rooms /
 * Bathrooms / Shared spaces header.
 */
function CountHeading({
  count,
  noun,
  addLabel,
  onAdd,
  choices,
  dataAttr,
}: {
  count: number;
  noun: string;
  addLabel: string;
  /** A + that adds straight away. Absent when the + offers `choices`. */
  onAdd?: () => void;
  /** The + opens these choices instead (Build / Upload a PDF ...), the same ones the property tabs' + offer. */
  choices?: readonly AddChoice[];
  dataAttr: string;
}) {
  const choiceItem = (choice: AddChoice) => (
    <DropdownMenuItem key={choice.id} data-attr={choice.dataAttr} onSelect={() => choice.onSelect?.()}>
      {choice.label}
    </DropdownMenuItem>
  );
  return (
    <div className="pr9-top mb-3 flex items-center justify-between gap-2">
      <StepHeading title={`${count} ${count === 1 ? noun : `${noun}s`}`} />
      {choices ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PortalPrimaryIconAction label={addLabel} data-attr={dataAttr} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {choices.map((choice) =>
              choice.choices ? (
                <DropdownMenuSub key={choice.id}>
                  <DropdownMenuSubTrigger data-attr={choice.dataAttr}>{choice.label}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>{choice.choices.map(choiceItem)}</DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : (
                choiceItem(choice)
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <PortalPrimaryIconAction label={addLabel} onClick={onAdd} data-attr={dataAttr} />
      )}
    </div>
  );
}

/** One choice the round + offers; a choice with `choices` opens a nested list (Start from a template). */
type AddChoice = { id: string; label: string; dataAttr: string; onSelect?: () => void; choices?: readonly AddChoice[] };

/** The latest rendered value, readable after an await (an upload) without acting on a stale render. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * The saved record's id for an upload that needs one. A brand-new draft has none, so it is saved first
 * through the editor's `ensureSaved` (the same save "Edit in full" does) and the new id is used.
 */
async function resolveRecordId(doors: ListingDetailDoors): Promise<string | null> {
  const known = doors.recordId?.trim();
  if (known) return known;
  return (await doors.ensureSaved?.()) ?? null;
}

const SAVE_FAILED = "Could not save. Nothing was kept.";

/** True for a card whose content came from an uploaded PDF. */
const isPdfApplication = (template: PropertyApplicationTemplate) =>
  Boolean(template.draftQuestionConfig?.importProvenance?.sourcePath || template.draftQuestionConfig?.importProvenance?.sourceName);

/** The plain facts under a card's title. */
function Facts({ items }: { items: ReadonlyArray<string | null | false | undefined> }) {
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {items.filter(Boolean).map((item, index) => (
        <span key={index}>{item}</span>
      ))}
    </span>
  );
}

/** The standard empty card of a step's list (the round + at the top right is the only add). */
function EmptyStepCard({ title, dataAttr, section }: { title: string; dataAttr: string; section: string }) {
  return <PortalListEmptyCard title={title} section={section} workspaceAware={false} compact dataAttr={dataAttr} />;
}

/** The card's ⋯: Edit first, Duplicate, and a red Delete last (after a tap to confirm). */
function CardMenu({
  label,
  dataAttr,
  onEdit,
  onDuplicate,
  onDelete,
  extraItems,
}: {
  label: string;
  dataAttr: string;
  onEdit: () => void;
  onDuplicate?: () => void;
  /** Absent on a card that can only be edited (the Pricing room cards). */
  onDelete?: () => void;
  /** More actions between Edit and Duplicate (the application's default / applies-to moves). */
  extraItems?: ReadonlyArray<{ id: string; label: string; dataAttr: string; onSelect: () => void } | null | false | undefined>;
}) {
  const confirm = useConfirm();
  return (
    <div className="pr9-acts flex shrink-0 items-center gap-0.5">
      <PortalRowMenu
        label={label}
        dataAttr={`${dataAttr}-menu`}
        triggerClassName="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-foreground/[0.06]"
        iconClassName="h-5 w-5"
        items={[
          { id: "edit", label: "Edit", dataAttr: `${dataAttr}-edit`, onSelect: onEdit },
          ...(extraItems ?? []),
          onDuplicate ? { id: "duplicate", label: "Duplicate", dataAttr: `${dataAttr}-duplicate`, onSelect: onDuplicate } : null,
          onDelete
            ? {
                id: "delete",
                label: "Delete",
                danger: true,
                dataAttr: `${dataAttr}-delete`,
                onSelect: () => {
                  void confirm({
                    title: `Delete ${label}?`,
                    description: `Delete ${label}?`,
                    confirmLabel: "Delete",
                    tone: "danger",
                    note: null,
                  }).then((ok) => {
                    if (ok) onDelete();
                  });
                },
              }
            : null,
        ]}
      />
    </div>
  );
}

/** A name typed into a card: saved as it is typed, unless it is empty or another card has it. */
function useCardNames() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return {
    shown: (id: string, stored: string) => drafts[id] ?? stored,
    problem: (id: string, taken: readonly string[]): string | null => {
      const text = drafts[id];
      if (text === undefined) return null;
      if (!text.trim()) return "Enter a name.";
      return taken.some((other) => other.trim().toLowerCase() === text.trim().toLowerCase()) ? `"${text.trim()}" already exists.` : null;
    },
    edit: (id: string, text: string, taken: readonly string[], commit: (name: string) => void) => {
      setDrafts((current) => ({ ...current, [id]: text }));
      const trimmed = text.trim();
      if (trimmed && !taken.some((other) => other.trim().toLowerCase() === trimmed.toLowerCase())) commit(trimmed);
    },
    forget: (id: string) =>
      setDrafts((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }),
  };
}

function NameProblem({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="px-3.5 pt-2.5 text-[12px] font-semibold text-rose-600">
      {message}
    </p>
  ) : null;
}

/** One card open at a time, like the Rooms step. */
function useOneOpen() {
  const [open, setOpen] = useState<string | null>(null);
  return { open, setOpen, toggle: (id: string) => setOpen((current) => (current === id ? null : id)) };
}

const BODY_PAD = "border-t border-border px-3.5 py-3";

/* ─────────────────── Long term / Short term sections (no Both section) ─────────────────── */

/** A section header: a small glyph, the label and a rule line. Never a pill. */
function StayHeader({ section, label }: { section: StaySectionKey | "other"; label?: string }) {
  return (
    <div className="mb-2.5 mt-1 flex items-center gap-2 text-[13px] font-bold text-foreground/80" data-attr={`listing-v2-stay-header-${section}`}>
      {section === "long_term" ? <CalendarDays className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : null}
      {section === "short_term" ? <Moon className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : null}
      <span>{label ?? STAY_LABEL[section as StaySectionKey]}</span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}

/**
 * Draws a step's rows under exactly two sections, Long term and Short term. A row that applies to both stays is
 * drawn in EACH section as the same item. A stay the listing does not offer is not drawn, and nothing is
 * deleted: its rows come back when the stay is switched on again.
 */
function StaySectionList<T>({
  sub,
  rows,
  sectionsOf,
  render,
  empty,
}: {
  sub: ManagerListingSubmissionV1;
  rows: readonly T[];
  sectionsOf: (row: T) => readonly StaySectionKey[];
  render: (row: T, section: StaySectionKey) => ReactNode;
  /** What a visible Long term / Short term section with no rows says. Absent = the section is not drawn. */
  empty?: (section: "long_term" | "short_term") => ReactNode;
}) {
  const sections = visibleStaySections(sub);
  return (
    <div data-attr="listing-v2-stay-sections">
      {sections.map((section) => {
        const inSection = rows.filter((row) => sectionsOf(row).includes(section));
        if (inSection.length === 0 && !empty) return null;
        return (
          <section key={section} className="mb-4" data-attr={`listing-v2-stay-section-${section}`} aria-label={STAY_LABEL[section]}>
            <StayHeader section={section} />
            {inSection.length === 0 ? empty?.(section) : inSection.map((row) => render(row, section))}
          </section>
        );
      })}
    </div>
  );
}

/** Which section a lease sits in: its kind (a time-based or custom lease is a long-term one). */
export function leaseStaySection(lease: Pick<PropertyLeaseTemplate, "kind">): StaySectionKey {
  return lease.kind === "short-term" ? "short_term" : "long_term";
}

/**
 * Which sections a move-in form sits in: its lease type. "All" lease types is listed in BOTH sections (the
 * same form); a form tied to specific leases sits with their stay when they all share one, in both otherwise.
 */
export function moveInStaySections(
  template: Pick<MoveInFormTemplate, "leaseType" | "linkedLeaseTemplateIds">,
  leases: readonly Pick<PropertyLeaseTemplate, "id" | "kind">[],
): StaySectionKey[] {
  if (template.leaseType === "long-term") return ["long_term"];
  if (template.leaseType === "short-term") return ["short_term"];
  const linked = (template.linkedLeaseTemplateIds ?? [])
    .map((id) => leases.find((lease) => lease.id === id))
    .filter((lease): lease is Pick<PropertyLeaseTemplate, "id" | "kind"> => Boolean(lease))
    .map((lease) => leaseStaySection(lease));
  if (linked.length > 0 && linked.every((section) => section === linked[0])) return [linked[0]!];
  return ["long_term", "short_term"];
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
        // Other readers share a 30 s cache of the settings; drop it so they see this save.
        invalidateSharedGets("/api/portal/manager-application-settings");
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
 * editing pause (and when a card closes or the step leaves), never one per keystroke.
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

/** The "Applies to" dropdown: only the stays the listing offers, plus Both. */
function appliesToChoices(sub: ManagerListingSubmissionV1): { value: string; label: string }[] {
  const offered = listingOfferedStays(sub);
  return [
    offered.long_term ? { value: "long_term", label: "Long-term residents" } : null,
    offered.short_term ? { value: "short_term", label: "Short-term residents" } : null,
    { value: "both", label: "Both" },
  ].filter((option): option is { value: string; label: string } => Boolean(option));
}

/**
 * The first question of a new application: who it is for. Only the stays the listing offers, plus Both. The
 * lease and co-signer links of the new application default from the answer.
 */
function NewApplicationAsk({
  sub,
  value,
  onChange,
  onCancel,
  onCreate,
}: {
  sub: ManagerListingSubmissionV1;
  value: ApplicationAppliesTo;
  onChange: (next: ApplicationAppliesTo) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const options = appliesToChoices(sub);
  return (
    <div className="mb-3 overflow-hidden rounded-2xl border border-primary/40 bg-card" data-attr="listing-v2-application-applies-to-ask">
      <FactRow first required label="Applies to">
        <RowSelectCell
          ariaLabel="Applies to"
          value={value}
          options={options}
          dataAttr="listing-v2-application-applies-to"
          onChange={(next) => onChange(next as ApplicationAppliesTo)}
        />
      </FactRow>
      <div className="flex items-center justify-end gap-1.5 border-t border-border px-3.5 py-2.5">
        <CardAction onClick={onCancel} dataAttr="listing-v2-application-applies-to-cancel">
          Cancel
        </CardAction>
        <CardAction onClick={onCreate} tone="primary" dataAttr="listing-v2-application-applies-to-create">
          Create
        </CardAction>
      </div>
    </div>
  );
}

export function StepApplication({ sub, onChange, doors }: StepProps) {
  const synced = useMemo(() => syncPropertyApplicationTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyApplicationTemplates(synced), [synced]);
  const leases = useMemo(() => leaseTemplatesOf(sub), [sub]);
  const leaseOptions = useMemo(
    () => leaseChoicesForApplication(leases).map((lease) => ({ value: lease.id, label: lease.label?.trim() || "Lease" })),
    [leases],
  );
  const catalog = { applications: templates, leases };
  const publisher = useDraftPublisher(sub, onChange);
  const beforeTour = useApplicationBeforeTour(doors.showToast);
  const { open, setOpen, toggle } = useOneOpen();
  const names = useCardNames();
  const [startFrom, setStartFrom] = useState<Record<string, string>>({});
  const latest = useLatest({ synced, templates });
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  // Co-signer is long term only: whatever is written, a short-term application never keeps a co-signer link.
  const commitTemplates = (next: PropertyApplicationTemplate[]) =>
    onChange(withApplicationTemplates(synced, withoutShortTermCosignerLinks(next, leases)));
  const replace = (next: PropertyApplicationTemplate) =>
    commitTemplates(templates.map((row) => (row.id === next.id ? next : row)));

  // An application that applies to both stays is drawn in each section; only the copy that was clicked opens.
  const [openIn, setOpenIn] = useState<StaySectionKey | null>(null);
  const visibleSections = visibleStaySections(sub);
  const homeSection = (stays: readonly StaySectionKey[]) => stays.find((stay) => visibleSections.includes(stay)) ?? stays[0]!;
  const isOpenIn = (id: string, section: StaySectionKey, stays: readonly StaySectionKey[]) =>
    open === id && (openIn ?? homeSection(stays)) === section;
  const openNew = (id: string) => {
    setOpenIn(null);
    setOpen(id);
  };
  const toggleCard = (id: string, section: StaySectionKey, stays: readonly StaySectionKey[]) => {
    if (isOpenIn(id, section, stays)) {
      publisher.flush();
      names.forget(id);
      setStartFrom((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setOpen(null);
      setOpenIn(null);
      return;
    }
    setOpenIn(section);
    setOpen(id);
  };

  // "Applies to" is asked FIRST: the + opens this question, and the application is made only once it is answered.
  const [pendingNew, setPendingNew] = useState<{ mode: "standard" | "pdf"; appliesTo: ApplicationAppliesTo } | null>(null);
  const pdfAppliesTo = useRef<ApplicationAppliesTo | null>(null);
  const askAppliesTo = (mode: "standard" | "pdf") => {
    const offered = listingOfferedStays(sub);
    setPendingNew({ mode, appliesTo: offered.long_term ? "long_term" : "short_term" });
  };

  const add = (appliesTo: ApplicationAppliesTo) => {
    // A new application starts from the PropLane defaults for who it is for: its stay's form and lease,
    // and the Co-signer application.
    const created = applicationForAppliesTo(createInlineApplication(synced, templates, "proplane"), appliesTo, catalog);
    commitTemplates([...templates, created]);
    openNew(created.id);
    setStartFrom((current) => ({ ...current, [created.id]: "proplane" }));
    publisher.schedule();
  };

  /**
   * "Upload a PDF": the existing application PDF import. A brand-new draft is saved first so the import has a
   * property to store the original against; the application is created once the questions come back.
   */
  const importPdf = async (file: File | null) => {
    if (!file) return;
    const propertyId = await resolveRecordId(doors);
    if (!propertyId) {
      doors.showToast(SAVE_FAILED);
      return;
    }
    const before = latest.current;
    const fresh = createInlineApplication(before.synced, before.templates, "proplane", deriveFormNameFromFileName(file.name));
    const imported = await importApplicationPdf({
      propertyId,
      templateId: fresh.id,
      file,
      showToast: doors.showToast,
      setBusy: setImporting,
    });
    if (!imported) return;
    const now = latest.current;
    // Chosen in the "Applies to" question; a file picked without it goes to the first stay the listing offers,
    // never to a stay whose section is not drawn (the card would vanish).
    const target = pdfAppliesTo.current ?? (listingOfferedStays(sub).long_term ? "long_term" : "short_term");
    pdfAppliesTo.current = null;
    const created: PropertyApplicationTemplate = {
      ...applicationForAppliesTo(fresh, target, { applications: now.templates, leases }),
      draftQuestionConfig: imported.draft,
      updatedAt: new Date().toISOString(),
    };
    onChange(withApplicationTemplates(now.synced, [...now.templates, created]));
    openNew(created.id);
    publisher.schedule();
  };

  const duplicate = (template: PropertyApplicationTemplate) => {
    const copy = createInlineApplication(synced, templates, template.id);
    const index = templates.findIndex((row) => row.id === template.id);
    const next = [...templates];
    next.splice(index + 1, 0, copy);
    commitTemplates(next);
    openNew(copy.id);
    publisher.schedule();
  };

  const remove = (template: PropertyApplicationTemplate) => {
    onChange(submissionAfterRemovingApplicationTemplate(synced, templates.filter((row) => row.id !== template.id)));
    if (open === template.id) setOpen(null);
  };

  const appliesToOptions = appliesToChoices(sub);

  const startFromOptions = (template: PropertyApplicationTemplate) => [
    { value: "proplane", label: "PropLane standard" },
    ...templates
      .filter((row) => row.id !== template.id)
      .map((row) => ({ value: row.id, label: normalizePropertyApplicationTemplateLabel(row.label) || "Application" })),
  ];

  return (
    <StepColumn>
      <CountHeading
        count={templates.length}
        noun="application"
        addLabel="Add application"
        choices={[
          { id: "standard", label: "Build from PropLane standard", dataAttr: "listing-v2-add-application-standard", onSelect: () => askAppliesTo("standard") },
          { id: "pdf", label: "Upload a PDF", dataAttr: "listing-v2-add-application-pdf", onSelect: () => askAppliesTo("pdf") },
        ]}
        dataAttr="listing-v2-add-application-icon"
      />
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose an application PDF"
        accept="application/pdf,.pdf"
        disabled={importing}
        data-attr="listing-v2-application-file"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          void importPdf(file);
        }}
      />

      {pendingNew ? (
        <NewApplicationAsk
          sub={sub}
          value={pendingNew.appliesTo}
          onChange={(appliesTo) => setPendingNew({ ...pendingNew, appliesTo })}
          onCancel={() => setPendingNew(null)}
          onCreate={() => {
            const { mode, appliesTo } = pendingNew;
            setPendingNew(null);
            if (mode === "pdf") {
              pdfAppliesTo.current = appliesTo;
              fileRef.current?.click();
            } else {
              add(appliesTo);
            }
          }}
        />
      ) : null}
      <StaySectionList
        sub={sub}
        rows={templates}
        sectionsOf={(template) => staysOfAppliesTo(applicationAppliesTo(template, leases))}
        render={(template, section) => {
        const i = templates.findIndex((row) => row.id === template.id);
        const appliesTo = applicationAppliesTo(template, leases);
        const stays = staysOfAppliesTo(appliesTo);
        const isCosigner = isCosignerApplicationTemplate(template);
        const sectionCount = templates.filter(
          (row) => !isCosignerApplicationTemplate(row) && applicationCoversStay(row, section, leases),
        ).length;
        const isDefault =
          !isCosigner &&
          sectionCount >= 2 &&
          effectiveDefaultApplicationForStay(templates, section, leases)?.id === template.id;
        const stored = normalizePropertyApplicationTemplateLabel(template.label) || "Application";
        const name = names.shown(template.id, stored);
        const label = stored;
        const taken = templates.filter((row) => row.id !== template.id).map((row) => row.label);
        const scope = applicationFeeScopeForTemplate(template);
        // The fee is the APPLICATION's own (template level). A blank box shows what its rooms resolve to now.
        const ownFeeCents = templateFeeCents(template, "applicationFee");
        const fee = readApplicationFeeInput(synced, scope);
        const feeText = ownFeeCents === null ? "" : centsToMoneyText(ownFeeCents);
        const feeFallback = fee.value ? `$${fee.value}` : fee.placeholder;
        const cosignerOptions = templates
          .filter((row) => isCosignerApplicationTemplate(row))
          .map((row) => ({ value: row.id, label: normalizePropertyApplicationTemplateLabel(row.label) || "Co-signer application" }));
        const isOpen = isOpenIn(template.id, section, stays);
        const leaseId = leaseOfApplication(catalog, template.id);
        const leaseName = leaseId ? leases.find((lease) => lease.id === leaseId)?.label?.trim() : null;
        const questionCount = orderedEditorApplicationFields(questionSliceForTemplate(synced, template)).length;
        return (
          <RecordCard
            key={`${section}:${template.id}`}
            propertyEditor
            name={name}
            nameLabel={`Name for application ${i + 1}`}
            namePlaceholder={`Application ${i + 1}`}
            onName={(text) => names.edit(template.id, text, taken, (next) => replace({ ...template, label: next, updatedAt: new Date().toISOString() }))}
            facts={
              <Facts
                items={[
                  isDefault && "★ Default",
                  feeFallback || "No fee",
                  leaseName,
                  plural(questionCount, "question"),
                  isPdfApplication(template) && "PDF",
                  !isApplicationTemplateOffered(template) && "Not needed",
                ]}
              />
            }
            headerEnd={
              <CardMenu
                label={label}
                dataAttr="listing-v2-application"
                onEdit={() => toggleCard(template.id, section, stays)}
                onDuplicate={() => duplicate(template)}
                onDelete={() => remove(template)}
              />
            }
            open={isOpen}
            onToggle={() => toggleCard(template.id, section, stays)}
            toggleLabel={label}
            dataAttr="listing-v2-application-card"
          >
            <div data-attr="listing-v2-application-editor">
              <NameProblem message={names.problem(template.id, taken)} />
              {isCosigner ? null : (
              <FactRow first label="Applies to">
                <RowSelectCell
                  ariaLabel={`Who ${label} applies to`}
                  value={appliesTo}
                  options={appliesToOptions}
                  dataAttr="listing-v2-application-applies-to-row"
                  onChange={(next) => commitTemplates(withApplicationAppliesTo(templates, template.id, next as ApplicationAppliesTo))}
                />
              </FactRow>
              )}
              {isCosigner
                ? null
                : stays.map((stay) => (
                    <FactRow key={stay} label={`Default for ${STAY_LABEL[stay].toLowerCase()}`}>
                      <PortalSettingsToggle
                        checked={effectiveDefaultApplicationForStay(templates, stay, leases)?.id === template.id}
                        label={`${label}: default for ${STAY_LABEL[stay].toLowerCase()}`}
                        dataAttr={`listing-v2-application-default-${stay === "long_term" ? "long" : "short"}`}
                        onChange={() => commitTemplates(withApplicationDefaultToggled(templates, template.id, stay, leases))}
                      />
                    </FactRow>
                  ))}
              <FactRow first={isCosigner} label="Needed">
                <PortalSettingsToggle
                  checked={isApplicationTemplateOffered(template)}
                  label={`${label}: needed`}
                  dataAttr="listing-v2-application-needed"
                  onChange={(on) => commitTemplates(patchApplicationTemplate(templates, template.id, { offered: on }))}
                />
              </FactRow>
              {startFrom[template.id] !== undefined ? (
                <FactRow label="Start from">
                  <RowSelectCell
                    ariaLabel={`Start ${label} from`}
                    value={startFrom[template.id]!}
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
                </FactRow>
              ) : null}
              {isCosigner ? null : (
                <FactRow label="Lease">
                  <RowSelectCell
                    ariaLabel={`Lease for ${label}`}
                    value={leaseId ?? NO_LEASE}
                    options={[{ value: NO_LEASE, label: "Property default" }, ...leaseOptions]}
                    dataAttr="listing-v2-application-lease"
                    onChange={(next) =>
                      commitTemplates(linkApplicationToLease(catalog, template.id, next === NO_LEASE ? null : next))
                    }
                  />
                </FactRow>
              )}
              {!applicationAllowsCosigner(template, leases) || cosignerOptions.length === 0 ? null : (
                <FactRow label="Co-signer form">
                  <RowSelectCell
                    ariaLabel={`Co-signer form for ${label}`}
                    value={template.linkedCosignerApplicationTemplateId ?? NO_LEASE}
                    options={[{ value: NO_LEASE, label: "Property default" }, ...cosignerOptions]}
                    dataAttr="listing-v2-application-cosigner"
                    onChange={(next) =>
                      commitTemplates(
                        patchApplicationTemplate(templates, template.id, { linkedCosignerApplicationTemplateId: next === NO_LEASE ? null : next }),
                      )
                    }
                  />
                </FactRow>
              )}
              <FactRow label="Application fee">
                <MoneyInput
                  label={`${label} application fee`}
                  value={feeText}
                  placeholder={feeFallback}
                  inherited={ownFeeCents === null}
                  dataAttr="listing-v2-application-fee"
                  onChange={(raw) =>
                    commitTemplates(patchApplicationTemplate(templates, template.id, { feeCentsOverride: moneyTextToCents(sanitizeMoneyInput(raw)) }))
                  }
                />
              </FactRow>
              <FormPromoCodesRow
                variant="fact"
                kind="application"
                propertyId={doors.recordId}
                propertyLabel={synced.buildingName || synced.address}
                ensureSaved={doors.ensureSaved}
                dataAttr="listing-v2-application-promo-codes"
              />
              <div className={BODY_PAD}>
                <InlineApplicationQuestions
                  sub={synced}
                  template={template}
                  onTemplate={(next) => {
                    replace(next);
                    publisher.schedule();
                  }}
                />
              </div>
            </div>
          </RecordCard>
        );
        }}
      />
      {templates.length === 0 ? <EmptyStepCard title="No applications yet" section="applications" dataAttr="listing-v2-application-empty" /> : null}
      <LeasingQuickAddRow
        entries={missingApplicationDefaults(synced)}
        noun="application"
        dataAttr="listing-v2-application-quick-add"
        onAdd={(key) => onChange(submissionWithApplicationDefault(synced, key as never))}
      />

      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card" data-attr="listing-v2-application-before-tour">
        <FactRow first label="Application before a tour">
          <RowSelectCell
            ariaLabel="Application before a tour"
            value={beforeTour.value}
            options={BEFORE_TOUR_OPTIONS}
            dataAttr="listing-v2-application-before-tour-select"
            onChange={(next) => beforeTour.save(next as ApplicationBeforeTour)}
          />
        </FactRow>
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

const LEASE_OPTIONS: ReadonlyArray<{ key: LeaseOptionKey; label: string; fact: string; attr: string }> = [
  { key: "custom", label: "Allow custom dates", fact: "Custom dates", attr: "listing-v2-lease-allow-custom-dates" },
  { key: "monthToMonth", label: "Allow month-to-month", fact: "Month-to-month", attr: "listing-v2-lease-allow-month-to-month" },
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
  const confirm = useConfirm();
  const { open, setOpen, toggle } = useOneOpen();
  const names = useCardNames();
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<string | null>(null);
  const latest = useLatest({ synced, templates });

  const commitLeases = (
    next: PropertyLeaseTemplate[],
    extra: { touched?: LeaseOptionKey[]; applications?: PropertyApplicationTemplate[] } = {},
  ) => {
    const written = submissionWithLeaseTemplates(synced, next, extra.touched ?? []);
    onChange(extra.applications ? withApplicationTemplates(written, extra.applications) : written);
  };
  const patchLease = (id: string, patch: Partial<PropertyLeaseTemplate>) =>
    commitLeases(updatePropertyLeaseTemplate(templates, id, patch));

  const addStandard = (thenUpload = false) => {
    const added = submissionWithStandardLease(synced, templates, "long-term");
    onChange(added.sub);
    if (!added.leaseId) return;
    setOpen(added.leaseId);
    if (thenUpload) pickPdf(added.leaseId);
  };

  const duplicate = (template: PropertyLeaseTemplate) => {
    const copy = duplicateLeaseTemplate(templates, template.id);
    if (!copy) return;
    const index = templates.findIndex((row) => row.id === template.id);
    const next = [...templates];
    next.splice(index + 1, 0, copy);
    commitLeases(next);
    setOpen(copy.id);
  };

  const remove = (template: PropertyLeaseTemplate) => {
    const remaining = removePropertyLeaseTemplate(templates, template.id);
    commitLeases(remaining, { applications: releaseDeletedLeaseLinks(applications, remaining) });
    if (open === template.id) setOpen(null);
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
    // A brand-new draft is saved first, so the lease upload belongs to a real record.
    if (!doors.recordId?.trim() && doors.ensureSaved && !(await resolveRecordId(doors))) {
      doors.showToast(SAVE_FAILED);
      return;
    }
    const fields = await importLeasePdf({
      file,
      kind: template.kind,
      showToast: doors.showToast,
      setBusy: (busy) => setBusyId(busy ? template.id : null),
    });
    if (!fields) return;
    const now = latest.current;
    onChange(submissionWithLeaseTemplates(now.synced, updatePropertyLeaseTemplate(now.templates, template.id, fields), []));
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

  return (
    <StepColumn>
      <CountHeading
        count={templates.length}
        noun="lease"
        addLabel="Add lease"
        choices={[
          { id: "standard", label: "Add PropLane standard", dataAttr: "listing-v2-add-lease-standard", onSelect: () => addStandard(false) },
          { id: "pdf", label: "Upload a PDF", dataAttr: "listing-v2-add-lease-pdf", onSelect: () => addStandard(true) },
        ]}
        dataAttr="listing-v2-add-lease-icon"
      />
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

      <StaySectionList
        sub={sub}
        rows={templates}
        sectionsOf={(lease) => [leaseStaySection(lease)]}
        render={(template) => {
        const i = templates.findIndex((row) => row.id === template.id);
        const stored = template.label?.trim() || "Lease";
        const name = names.shown(template.id, template.label ?? "");
        const taken = templates.filter((row) => row.id !== template.id).map((row) => row.label ?? "");
        const isOpen = open === template.id;
        const terms = template.applicationLeaseTerms ?? [];
        const flags = leaseOptionFlags(terms);
        const showOptions = template.kind !== "short-term" && leaseTermsAllowOptions(terms);
        const seeded = Boolean(template.listingSeedKey);
        const tied = applicationsOfLease(catalog, template.id);
        const startValue =
          template.leaseCustomKind === "document" ? "upload" : seeded ? "standard" : template.kind === "short-term" ? "short-term" : "long-term";
        return (
          <RecordCard
            key={template.id}
            propertyEditor
            name={name}
            nameLabel={`Name for lease ${i + 1}`}
            namePlaceholder={`Lease ${i + 1}`}
            onName={(text) => names.edit(template.id, text, taken, (next) => patchLease(template.id, { label: next }))}
            facts={
              <Facts
                items={[
                  leaseTypeFact(template),
                  // A lease of its own that was uploaded already reads "PDF" as its type.
                  isPdfLease(template) && template.listingSeedKey && "PDF",
                  tied.length > 0 ? tied.map((row) => normalizePropertyApplicationTemplateLabel(row.label) || "Application").join(", ") : "No applications",
                  flags.custom && "Custom dates",
                  flags.monthToMonth && "Month-to-month",
                  template.offered === false && "Not offered",
                ]}
              />
            }
            headerEnd={
              <CardMenu
                label={stored}
                dataAttr="listing-v2-lease"
                onEdit={() => {
                  if (isOpen) names.forget(template.id);
                  toggle(template.id);
                }}
                onDuplicate={() => duplicate(template)}
                onDelete={() => remove(template)}
              />
            }
            open={isOpen}
            onToggle={() => {
              if (isOpen) names.forget(template.id);
              toggle(template.id);
            }}
            toggleLabel={stored}
            dataAttr="listing-v2-lease-card"
          >
            <div data-attr="listing-v2-lease-editor">
              <NameProblem message={names.problem(template.id, taken)} />
              <FactRow first label="Offered">
                <PortalSettingsToggle
                  checked={template.offered !== false}
                  label={`${stored}: offered`}
                  dataAttr="listing-v2-lease-offered"
                  onChange={(on) => patchLease(template.id, { offered: on })}
                />
              </FactRow>
              <FactRow label="Start from">
                <RowSelectCell
                  ariaLabel={`Start ${stored} from`}
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
              </FactRow>
              {applicationOptions.length > 0 ? (
                <FactRow label="Applications">
                  <CheckboxMultiSelect
                    hideLabel
                    label={`Applications for ${stored}`}
                    variant="cell"
                    className="min-w-[150px] max-w-[240px]"
                    options={applicationOptions}
                    selected={tied.map((row) => row.id)}
                    emptyLabel="No applications"
                    dataAttr="listing-v2-lease-applications"
                    onChange={(ids) => commitLeases(templates, { applications: setApplicationsOfLease(catalog, template.id, ids) })}
                  />
                </FactRow>
              ) : null}
              <FactRow label="Lease fee">
                <MoneyInput
                  label={`${stored} lease fee`}
                  value={templateFeeCents(template, "leaseFee") === null ? "" : centsToMoneyText(templateFeeCents(template, "leaseFee")!)}
                  inherited={templateFeeCents(template, "leaseFee") === null}
                  dataAttr="listing-v2-lease-fee"
                  onChange={(raw) => patchLease(template.id, { leaseFeeCents: moneyTextToCents(sanitizeMoneyInput(raw)) })}
                />
              </FactRow>
              <FormPromoCodesRow
                variant="fact"
                kind="lease"
                propertyId={doors.recordId}
                propertyLabel={synced.buildingName || synced.address}
                ensureSaved={doors.ensureSaved}
                dataAttr="listing-v2-lease-promo-codes"
              />
              {showOptions
                ? LEASE_OPTIONS.map((option) => (
                    <FactRow key={option.key} label={option.label}>
                      <input
                        type="checkbox"
                        aria-label={`${option.label} for ${stored}`}
                        className="h-5 w-5 rounded border-border"
                        checked={flags[option.key]}
                        data-attr={option.attr}
                        onChange={(event) =>
                          onChange(submissionWithLeaseOption(synced, templates, template.id, option.key, event.target.checked))
                        }
                      />
                    </FactRow>
                  ))
                : null}
              <div className={BODY_PAD}>
                <InlineLeaseDocument
                  sub={synced}
                  template={template}
                  busy={busyId === template.id}
                  onUpload={() => pickPdf(template.id)}
                  onHtml={(html) => patchLease(template.id, { leaseTemplateHtmlOverride: html })}
                />
              </div>
            </div>
          </RecordCard>
        );
        }}
      />
      {templates.length === 0 ? <EmptyStepCard title="No leases yet" section="leases" dataAttr="listing-v2-lease-empty" /> : null}
      <LeasingQuickAddRow
        entries={missingLeaseDefaults(synced)}
        noun="lease"
        dataAttr="listing-v2-lease-quick-add"
        onAdd={(key) => onChange(submissionWithLeaseDefault(synced, key as never))}
      />
    </StepColumn>
  );
}

/* ─────────────────────────── Move-in ─────────────────────────── */

function moveInSendsFact(template: MoveInFormTemplate): string {
  const summary = triggerSummary(template.trigger);
  return template.trigger === "manual" ? summary : `Sends ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
}

/** The open form's questions. Held locally so a question still being typed is not dropped by the store's clean-up. */
function MoveInInlineBody({
  template,
  onTemplate,
  fresh,
  leases,
}: {
  template: MoveInFormTemplate;
  onTemplate: (next: MoveInFormTemplate) => void;
  fresh: boolean;
  leases: readonly MoveInLeaseTypeLease[];
}) {
  const [questions, setQuestions] = useState(template.questions);
  const starterOptions = [
    { value: "blank", label: "Blank form" },
    ...MOVE_IN_FORM_STARTERS.map((starter) => ({ value: starter.starterKey ?? starter.id, label: starter.name })),
  ];
  return (
    <>
      <FactRow first label="Sends">
        <RowSelectCell
          ariaLabel={`${template.name || "Form"} sends`}
          value={template.trigger}
          options={MOVE_IN_TRIGGER_OPTIONS}
          dataAttr="listing-v2-movein-sends"
          onChange={(value) =>
            onTemplate({
              ...template,
              trigger: value as MoveInFormTemplate["trigger"],
              due: dueForTriggerChange(value as MoveInFormTemplate["trigger"], template.due),
            })
          }
        />
      </FactRow>
      <FactRow label="Lease type">
        <RowSelectCell
          ariaLabel={`${template.name || "Form"} lease type`}
          value={moveInFormLeaseTypeValue(template)}
          options={moveInLeaseTypeOptions(leases, template.linkedLeaseTemplateIds)}
          dataAttr="listing-v2-movein-lease-type"
          onChange={(value) => onTemplate({ ...template, ...moveInFormLeaseTypePatch(value, template) })}
        />
      </FactRow>
      <FactRow label="Due">
        <RowSelectCell
          ariaLabel={`${template.name || "Form"} due`}
          value={template.due}
          options={dueOptionsForTrigger(template.trigger)}
          dataAttr="listing-v2-movein-due"
          onChange={(value) => onTemplate({ ...template, due: value as MoveInFormTemplate["due"] })}
        />
      </FactRow>
      {template.source === "upload" ? (
        <FactRow label="PDF">
          <span className="truncate text-[13.5px] font-semibold text-foreground" data-attr="listing-v2-movein-pdf-name">
            {template.pdf?.fileName ?? "Not uploaded"}
          </span>
        </FactRow>
      ) : null}
      {fresh ? (
        <FactRow label="Start from">
          <RowSelectCell
            ariaLabel="Start from"
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
        </FactRow>
      ) : null}
      <div className={BODY_PAD}>
        <MoveInQuestionsEditor
          questions={questions}
          onChange={(next) => {
            setQuestions(next);
            onTemplate(cleanMoveInTemplateForSave({ ...template, questions: next }));
          }}
        />
      </div>
    </>
  );
}

export function StepMoveIn({ sub, onChange, doors }: StepProps) {
  const templates = useMemo(() => readMoveInFormTemplates(sub), [sub]);
  const leaseChoices = useMemo<MoveInLeaseTypeLease[]>(
    () =>
      leaseTemplatesOf(sub).map((lease) => ({
        id: lease.id,
        label: lease.label?.trim() || "Lease",
        custom: lease.listingSeedKey !== "primary" && lease.listingSeedKey !== "short-term" && lease.listingSeedKey !== "airbnb",
      })),
    [sub],
  );
  const moveInLeases = useMemo(() => leaseTemplatesOf(sub), [sub]);
  const { open, setOpen } = useOneOpen();
  // A form that applies to both stays is drawn in each section; only the copy that was clicked opens.
  const [openIn, setOpenIn] = useState<StaySectionKey | null>(null);
  const visibleSections = visibleStaySections(sub);
  const homeSection = (stays: readonly StaySectionKey[]) => stays.find((stay) => visibleSections.includes(stay)) ?? stays[0]!;
  const isOpenIn = (id: string, section: StaySectionKey, stays: readonly StaySectionKey[]) =>
    open === id && (openIn ?? homeSection(stays)) === section;
  const toggleCard = (id: string, section: StaySectionKey, stays: readonly StaySectionKey[]) => {
    if (isOpenIn(id, section, stays)) {
      setOpen(null);
      setOpenIn(null);
      return;
    }
    setOpenIn(section);
    setOpen(id);
  };
  const openNew = (id: string) => {
    setOpenIn(null);
    setOpen(id);
  };
  const [freshId, setFreshId] = useState<string | null>(null);
  const latest = useLatest({ sub, templates });
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  /**
   * The first write also stores the starters. Only the form the manager touched keeps its own Sends;
   * untouched starters are stored as "Only when I send it" (same rule as the Move-in tab).
   */
  const write = (list: MoveInFormTemplate[], editedId: string | null) => {
    const sub = latest.current.sub;
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
    openNew(created.id);
    setFreshId(created.id);
  };

  /** "Start from a template": one of the starters, added as the manager's own form that sends only when they say. */
  const addStarter = (starterKey: MoveInFormStarterKey) => {
    const created: MoveInFormTemplate = {
      ...newMoveInFormTemplate("built", starterKey),
      trigger: "manual",
    };
    created.name = uniqueFormLabel(templates.map((item) => item.name), created.name || "New form");
    write([...templates, created], created.id);
    openNew(created.id);
  };

  /**
   * "Upload a PDF": the existing move-in PDF upload (`uploadMoveInFormPdf`). A brand-new draft is saved first so
   * the PDF is stored against a real property; the form is added once the PDF is stored.
   */
  const uploadPdf = async (file: File | null) => {
    if (!file) return;
    if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
      doors.showToast("Choose a PDF file.");
      return;
    }
    if (file.size > LEASE_TEMPLATE_MAX_BYTES) {
      doors.showToast("The PDF must be 8 MB or smaller.");
      return;
    }
    const propertyId = await resolveRecordId(doors);
    if (!propertyId) {
      doors.showToast(SAVE_FAILED);
      return;
    }
    const blank = newMoveInFormTemplate("upload");
    const created: MoveInFormTemplate = {
      ...blank,
      name: uniqueFormLabel(latest.current.templates.map((item) => item.name), deriveFormNameFromFileName(file.name)),
      // A new form never messages a resident until the manager picks when.
      trigger: "manual",
    };
    setUploading(true);
    try {
      const { pdf } = await uploadMoveInFormPdf(propertyId, created.id, file);
      write([...latest.current.templates, { ...created, pdf }], created.id);
      openNew(created.id);
    } catch (error) {
      doors.showToast(error instanceof Error ? error.message : "Could not upload that PDF. Try again.");
    } finally {
      setUploading(false);
    }
  };

  const duplicate = (template: MoveInFormTemplate) => {
    const { list, copy } = duplicateMoveInTemplate(templates, template.id, newMoveInFormTemplate("built").id);
    if (!copy) return;
    write(list, copy.id);
    openNew(copy.id);
  };

  return (
    <StepColumn>
      <CountHeading
        count={templates.length}
        noun="move-in form"
        addLabel="Add move-in form"
        choices={[
          { id: "build", label: "Build a form", dataAttr: "listing-v2-add-movein-build", onSelect: add },
          { id: "pdf", label: "Upload a PDF", dataAttr: "listing-v2-add-movein-pdf", onSelect: () => fileRef.current?.click() },
          {
            id: "template",
            label: "Start from a template",
            dataAttr: "listing-v2-add-movein-template",
            choices: MOVE_IN_FORM_STARTERS.filter((starter) => starter.starterKey).map((starter) => ({
              id: starter.starterKey!,
              label: starter.name,
              dataAttr: `listing-v2-add-movein-starter-${starter.starterKey}`,
              onSelect: () => addStarter(starter.starterKey!),
            })),
          },
        ]}
        dataAttr="listing-v2-add-movein-icon"
      />
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a move-in form PDF"
        accept="application/pdf,.pdf"
        disabled={uploading}
        data-attr="listing-v2-movein-file"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          void uploadPdf(file);
        }}
      />

      <StaySectionList
        sub={sub}
        rows={templates}
        sectionsOf={(template) => moveInStaySections(template, moveInLeases)}
        render={(template, section) => {
        const stays = moveInStaySections(template, moveInLeases);
        const i = templates.findIndex((row) => row.id === template.id);
        const label = template.name.trim() || "Untitled form";
        const isOpen = isOpenIn(template.id, section, stays);
        return (
          <RecordCard
            key={`${section}:${template.id}`}
            propertyEditor
            name={template.name}
            nameLabel={`Name for move-in form ${i + 1}`}
            namePlaceholder={`Move-in form ${i + 1}`}
            onName={(text) => replace({ ...template, name: text })}
            facts={
              <Facts
                items={[
                  template.source === "upload" && "PDF",
                  plural(template.questions.length, "question"),
                  moveInSendsFact(template),
                ]}
              />
            }
            headerEnd={
              <CardMenu
                label={label}
                dataAttr="listing-v2-movein"
                onEdit={() => toggleCard(template.id, section, stays)}
                onDuplicate={() => duplicate(template)}
                onDelete={() => {
                  write(removeMoveInTemplate(templates, template.id), null);
                  if (open === template.id) setOpen(null);
                }}
              />
            }
            open={isOpen}
            onToggle={() => toggleCard(template.id, section, stays)}
            toggleLabel={label}
            dataAttr="listing-v2-movein-card"
          >
            <div data-attr="listing-v2-movein-editor">
              <MoveInInlineBody key={template.id} template={template} onTemplate={replace} fresh={freshId === template.id} leases={leaseChoices} />
            </div>
          </RecordCard>
        );
        }}
      />
      {templates.length === 0 ? <EmptyStepCard title="No move-in forms yet" section="move-in" dataAttr="listing-v2-movein-empty" /> : null}
      <LeasingQuickAddRow
        entries={missingMoveInStarters(sub)}
        noun="move-in form"
        dataAttr="listing-v2-movein-quick-add"
        onAdd={(key) => {
          const added = submissionWithMoveInStarter(latest.current.sub, key as MoveInFormStarterKey);
          write(readMoveInFormTemplates(added), null);
        }}
      />
    </StepColumn>
  );
}

/* ─────────────────────────── Pricing ─────────────────────────── */

/**
 * What an opened Pricing card holds, one section per stay the listing offers: Long term and Short term,
 * each fully independent (its own rent, deposit, move-in fee, application fee and added fees, no number shared
 * between them) and no Both section. A stay the listing does not offer ("Stays you offer" on Basics) draws
 * nothing and keeps its stored prices. Month-to-month, a custom lease and Airbnb follow their stay
 * (`pricing-lease-options.ts`), each under its own label.
 */
function PricingTermSections({
  sub,
  render,
}: {
  sub: ManagerListingSubmissionV1;
  render: (option: PricingLeaseOption) => ReactNode;
}) {
  const options = useMemo(() => pricingSectionOptions(sub), [sub]);
  const slug = (option: PricingLeaseOption) =>
    option.term === LONG_TERM_LEASE_TERM ? "long" : option.term === SHORT_TERM_LEASE_TERM ? "short" : option.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return (
    <div data-attr="listing-v2-pricing-options" className="border-t border-border px-3.5 pt-3">
      {options.map((option) => {
        const section = option.term === LONG_TERM_LEASE_TERM ? "long_term" : option.term === SHORT_TERM_LEASE_TERM ? "short_term" : "other";
        const label = section === "other" ? option.label : STAY_LABEL[section];
        return (
          <section key={option.id} aria-label={label} data-attr={`listing-v2-pricing-format-${slug(option)}`}>
            <StayHeader section={section} label={label} />
            <div className="-mx-3.5 mb-3">{render(option)}</div>
          </section>
        );
      })}
    </div>
  );
}

/** "$40/night", or "not set" when no nightly rate is typed. */
function nightlyText(raw: string | undefined): string {
  const amount = parseMoneyAmount(raw ?? "");
  return amount > 0 ? `$${Math.round(amount).toLocaleString("en-US")}/night` : "not set";
}

function RentOnRight({ text }: { text: string }) {
  return <span className="shrink-0 pr-2 text-[13.5px] font-bold tabular-nums text-foreground">{text}</span>;
}

export function StepPricing({ sub, onChange }: StepProps) {
  const wholeHome = isEntireHomeListing(sub);
  const rooms = (sub.rooms ?? []).filter((room) => room.name.trim() || room.monthlyRent > 0);
  const bundles = sub.bundles ?? [];
  const { open, setOpen, toggle } = useOneOpen();

  const patch = (next: Partial<ManagerListingSubmissionV1>) => onChange({ ...sub, ...next });
  const updateRoom = (roomId: string, next: ManagerRoomSubmission) => patch(roomPricingPatch(sub, roomId, next));

  const wholeAmount = entireHomeMonthlyRentAmount(sub);
  const roomLabel = (room: ManagerRoomSubmission, index: number) => room.name.trim() || `Room ${index + 1}`;

  const writeBundle = (id: string, next: Partial<ManagerBundleRow>) =>
    patch({ bundles: bundles.map((b) => (b.id === id ? { ...b, ...next } : b)) });
  const addBundle = () => {
    const id = `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    patch({ bundles: [...bundles, { id, label: "", price: "", strikethrough: "", promo: "", roomsLine: "", includedRoomIds: [] }] });
    setOpen(id);
  };
  const wholeHouseRent = typeof sub.entireHomeMonthlyRent === "number" ? sub.entireHomeMonthlyRent : 0;
  const wholeHouseOffered = Boolean(sub.entireHomeOffered);
  const stays = listingOfferedStays(sub);

  return (
    <StepColumn>
      <StepHeading title={wholeHome ? "Whole place" : plural(rooms.length, "room")} />
      {wholeHome ? (
        <RecordCard
          propertyEditor
          title="Whole place"
          facts={
            <Facts
              items={[
                stays.long_term && `Long-term · ${wholeAmount > 0 ? rentLabel(wholeAmount) : "rent not set"}`,
                stays.short_term && `Short-term · ${nightlyText(sub.shortTermDailyCost)}`,
              ]}
            />
          }
          headerEnd={
            <>
              <RentOnRight text={wholeAmount > 0 ? rentLabel(wholeAmount) : "Rent not set"} />
              <CardMenu label="Whole place" dataAttr="listing-v2-pricing-whole" onEdit={() => toggle("whole")} />
            </>
          }
          open={open === "whole"}
          onToggle={() => toggle("whole")}
          toggleLabel="Whole place"
          dataAttr="listing-v2-pricing-card"
        >
          <PricingTermSections sub={sub} render={(option) => <WholeHousePricingFields draft={sub} activeStepId={option.term} patch={patch} />} />
        </RecordCard>
      ) : rooms.length === 0 ? (
        <EmptyStepCard title="No rooms to price yet" section="payments" dataAttr="listing-v2-pricing-empty" />
      ) : (
        rooms.map((room, index) => {
          const amount = propertyPricingRoomAmount(room);
          const rentText = amount === "—" ? "Rent not set" : amount;
          return (
            <RecordCard
              key={room.id}
              propertyEditor
              title={roomLabel(room, index)}
              facts={
                <Facts
                  items={[
                    stays.long_term && `Long-term · ${amount === "—" ? "rent not set" : amount}`,
                    stays.short_term && `Short-term · ${nightlyText(room.shortTermRent)}`,
                  ]}
                />
              }
              headerEnd={
                <>
                  <RentOnRight text={rentText} />
                  <CardMenu label={roomLabel(room, index)} dataAttr="listing-v2-pricing-room" onEdit={() => toggle(room.id)} />
                </>
              }
              open={open === room.id}
              onToggle={() => toggle(room.id)}
              toggleLabel={roomLabel(room, index)}
              dataAttr="listing-v2-pricing-card"
            >
              <PricingTermSections
                sub={sub}
                render={(option) => (
                  <RoomPricingFields
                    draft={sub}
                    room={room}
                    activeTerm={option.term}
                    patch={patch}
                    setDraft={onChange}
                    updateRoom={updateRoom}
                  />
                )}
              />
            </RecordCard>
          );
        })
      )}

      {wholeHome ? null : (
        <div className="mt-6" data-attr="listing-v2-bundles">
          <div className="pr9-top mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[18px] font-extrabold tracking-tight text-foreground">Bundles</h3>
            <PortalPrimaryIconAction label="Add bundle" onClick={addBundle} data-attr="listing-v2-add-bundle-icon" />
          </div>
          <RecordCard
            propertyEditor
            title="Whole house"
            facts={
              <Facts
                items={[
                  stays.long_term && `Long-term · ${wholeHouseRent > 0 ? rentLabel(wholeHouseRent) : "rent not set"}`,
                  stays.short_term && `Short-term · ${nightlyText(sub.shortTermDailyCost)}`,
                  !wholeHouseOffered && "Not offered",
                ]}
              />
            }
            headerEnd={
              <>
                <RentOnRight text={wholeHouseRent > 0 ? rentLabel(wholeHouseRent) : "Rent not set"} />
                <CardMenu label="Whole house" dataAttr="listing-v2-whole-house" onEdit={() => toggle("whole-house")} />
              </>
            }
            open={open === "whole-house"}
            onToggle={() => toggle("whole-house")}
            toggleLabel="Whole house"
            dataAttr="listing-v2-whole-house-card"
          >
            <FactRow first label="Offered">
              <PortalSettingsToggle
                checked={wholeHouseOffered}
                label="Whole house: offered"
                dataAttr="listing-v2-whole-house-offered"
                onChange={(on) => patch({ entireHomeOffered: on, entireHomePriceSource: "own" })}
              />
            </FactRow>
            <PricingTermSections
              sub={sub}
              render={(option) => <WholeHousePricingFields draft={sub} activeStepId={option.term} patch={patch} offerToggle={false} />}
            />
          </RecordCard>
          {bundles.map((bundle) => {
            // Titled by its rooms, the same as the Pricing tab's Room bundles.
            const label = propertyPricingBundleTitle(bundle, sub);
            const included = (bundle.includedRoomIds ?? []).filter((id) => rooms.some((room) => room.id === id));
            const rent = parseMoneyAmount(bundle.price ?? "");
            return (
              <RecordCard
                key={bundle.id}
                propertyEditor
                title={label}
                facts={<Facts items={[included.length === 0 && "No rooms yet", rent > 0 ? rentLabel(rent) : "Rent not set"]} />}
                headerEnd={
                  <CardMenu
                    label={label}
                    dataAttr="listing-v2-bundle"
                    onEdit={() => toggle(bundle.id)}
                    onDuplicate={() => {
                      const copy = { ...structuredClone(bundle), id: `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: `${bundle.label.trim() || label} copy` };
                      const at = bundles.findIndex((b) => b.id === bundle.id);
                      patch({ bundles: [...bundles.slice(0, at + 1), copy, ...bundles.slice(at + 1)] });
                      setOpen(copy.id);
                    }}
                    onDelete={() => {
                      patch({ bundles: bundles.filter((b) => b.id !== bundle.id) });
                      if (open === bundle.id) setOpen(null);
                    }}
                  />
                }
                open={open === bundle.id}
                onToggle={() => toggle(bundle.id)}
                toggleLabel={label}
                dataAttr="listing-v2-bundle-card"
              >
                <FactRow first label="Rooms in the bundle">
                  <CheckboxMultiSelect
                    hideLabel
                    label={`Rooms in ${label}`}
                    variant="cell"
                    className="min-w-[150px] max-w-[240px]"
                    options={rooms.map((room, ri) => ({ value: room.id, label: roomLabel(room, ri) }))}
                    selected={included}
                    emptyLabel="Pick rooms"
                    dataAttr="listing-v2-bundle-rooms"
                    onChange={(ids) => writeBundle(bundle.id, { includedRoomIds: ids, roomsLine: "" })}
                  />
                </FactRow>
                <PricingTermSections
                  sub={sub}
                  render={(option) => (
                    <BundlePricingFields draft={sub} bundle={bundle} activeStepId={option.term} patch={patch} setDraft={onChange} />
                  )}
                />
              </RecordCard>
            );
          })}
        </div>
      )}
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
