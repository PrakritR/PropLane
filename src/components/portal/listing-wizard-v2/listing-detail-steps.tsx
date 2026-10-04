"use client";

/**
 * The four leasing steps of the listing editor: Application, Lease, Move-in, Pricing.
 *
 * Each is a few flat rows (name, one figure, a pencil) over data the property already
 * carries, and the pencil opens the SAME full editor the property page opens:
 *
 * - Application -> `ManagerApplicationQuestionsEditorModal`
 * - Lease       -> `PropertyLeaseFormModal` (or the imported-lease questions editor)
 * - Move-in     -> `MoveInFormEditorModal`
 * - Pricing     -> `PropertyRoomPricingWorkspace`
 *
 * No new storage. Application, lease and move-in edits patch the wizard's own submission
 * (the modals' `onPersistSubmission` / `onSave` hooks), so they are saved with the draft or
 * the live listing exactly like every other step. The pricing workspace persists through
 * the property's own save target, so the wizard saves first and reads the result back.
 *
 * A brand-new draft shows the defaults that will be created. "Edit in full" saves the
 * draft first (docs/agents/property-drafts.md: a draft is a real record) and then opens;
 * without a record id it says so rather than opening a form that cannot save.
 *
 * Nothing here is required to publish.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pencil, Settings } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { StepColumn, StepHeading, PanelSection } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { ManagerLeaseQuestionsEditorModal } from "@/components/portal/pro-lease-questions-editor-modal";
import { PropertyRoomPricingWorkspace, type PropertyPricingSubject } from "@/components/portal/property-room-pricing-workspace";
import { MoveInFormEditorModal, type MoveInEditorRoom } from "@/components/portal/move-in-forms/move-in-form-editor-modal";
import { cleanMoveInTemplateForSave, triggerSummary } from "@/components/portal/move-in-forms/move-in-form-model";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  applicationFeeLabelForSelection,
  applicationFeeRangeAcrossRooms,
  applicationFeeRangeLabel,
} from "@/lib/application-fee-by-room";
import { readAdminPropertyRows } from "@/lib/demo-admin-property-inventory";
import { sortRoomIndicesByFloor } from "@/lib/listing-floor-order";
import { normalizeLeasingPipelinePreferences, type ApplicationBeforeTour } from "@/lib/leasing-pipeline-preferences";
import {
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  resolveManagerListingSubmissionForPropertyId,
  type ManagerPricingSaveTarget,
} from "@/lib/manager-property-save-target";
import { readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import type { MoveInFormTemplate } from "@/lib/move-in-forms/types";
import {
  applicationFormVariantForTemplate,
  readPropertyApplicationTemplates,
  withPropertyApplicationTemplatesExplicit,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  normalizePropertyApplicationTemplateLabel,
  syncPropertyApplicationTemplatesFromListing,
} from "@/lib/property-application-template-sync";
import {
  readPropertyLeaseTemplates,
  syncLegacyLeaseFieldsFromTemplates,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import { buildLeaseTemplateSeeds, syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";
import { propertyPricingRoomAmount, propertyPricingWholeHouseSummary } from "@/lib/property-pricing-summary";
import type { WorkspacePricingDefaults } from "@/lib/workspace-pricing-defaults";
import { cn } from "@/lib/utils";

/** The step ids this file draws. */
export type ListingDetailStepId = "application" | "lease" | "movein" | "pricing";

export const LISTING_DETAIL_STEP_IDS: readonly ListingDetailStepId[] = ["application", "lease", "movein", "pricing"];

export const WORKSPACE_APPLICATIONS_LEASES_SETTINGS_HREF = "/portal/profile?tab=applicationsLeases";

/** What the editor hands each step so "Edit in full" can open a real editor. */
export type ListingDetailDoors = {
  /** The saved record's id (a draft or a live listing); null until the first save. */
  recordId: string | null;
  /** An existing live listing, or a draft. Decides which save target the pricing workspace uses. */
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

function moveInSendsFact(template: MoveInFormTemplate): string {
  const summary = triggerSummary(template.trigger);
  return template.trigger === "manual" ? summary : `Sends ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
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
    application: `${plural(applications.length, "application")} · ${fee === "No fee" ? "no fee" : `fee ${fee}`}`,
    lease: leases.length === 0 ? "None yet" : plural(leases.length, "lease"),
    movein: plural(forms.length, "form"),
    pricing: from ? `From ${from}` : "Rent not set",
  };
}

/* ─────────────────────────── shared little pieces ─────────────────────────── */

function RowCard({ children, dataAttr }: { children: ReactNode; dataAttr: string }) {
  return (
    <div className="max-w-[620px] overflow-hidden rounded-2xl border border-border bg-card" data-attr={dataAttr}>
      {children}
    </div>
  );
}

function DetailRow({
  label,
  value,
  first = false,
  action,
  dataAttr,
}: {
  label: string;
  value?: ReactNode;
  first?: boolean;
  action?: ReactNode;
  dataAttr?: string;
}) {
  return (
    <div className={cn("flex min-h-[56px] items-center gap-3 px-3.5 py-1.5", !first && "border-t border-border")} data-attr={dataAttr}>
      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">{label}</span>
      {value != null && value !== "" ? <span className="shrink-0 text-[13px] text-muted">{value}</span> : null}
      {action ?? null}
    </div>
  );
}

function EditInFull({ name, onClick, disabled, dataAttr }: { name: string; onClick: () => void; disabled?: boolean; dataAttr: string }) {
  return (
    <PortalIconAction
      icon={Pencil}
      label="Edit in full"
      aria-label={`Edit ${name} in full`}
      disabled={disabled}
      data-attr={dataAttr}
      onClick={onClick}
    />
  );
}

function EmptyRows({ text }: { text: string }) {
  return <div className="px-3.5 py-4 text-[13px] text-muted">{text}</div>;
}

/** Saves a brand-new draft on demand, then runs the opener with the record id. */
function useEditInFull(doors: ListingDetailDoors) {
  const [busy, setBusy] = useState(false);
  const run = async (open: (recordId: string) => void) => {
    if (busy) return;
    setBusy(true);
    try {
      const id = doors.recordId ?? (doors.ensureSaved ? await doors.ensureSaved() : null);
      if (!id) {
        doors.showToast("Save the property first, then edit in full.");
        return;
      }
      open(id);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/* ─────────────────────────── Application ─────────────────────────── */

/** "Application before a tour" is one value for the whole workspace: read it, never write it here. */
function useApplicationBeforeTour(): ApplicationBeforeTour | null {
  const [value, setValue] = useState<ApplicationBeforeTour | null>(null);
  useEffect(() => {
    if (typeof fetch !== "function") return;
    let cancelled = false;
    void fetch("/api/portal/manager-application-settings", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { leasingPipeline?: unknown } | null) => {
        if (cancelled || !body) return;
        setValue(normalizeLeasingPipelinePreferences(body.leasingPipeline).applicationBeforeTour);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}

export function StepApplication({ sub, onChange, doors }: StepProps) {
  const synced = useMemo(() => syncPropertyApplicationTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyApplicationTemplates(synced), [synced]);
  const beforeTour = useApplicationBeforeTour();
  const { busy, run } = useEditInFull(doors);
  const [editing, setEditing] = useState<{ recordId: string; template: PropertyApplicationTemplate } | null>(null);

  return (
    <StepColumn>
      <StepHeading title="Application" />
      <RowCard dataAttr="listing-v2-application-rows">
        {templates.length === 0 ? (
          <EmptyRows text="No applications yet" />
        ) : (
          templates.map((template, index) => {
            const name = normalizePropertyApplicationTemplateLabel(template.label) || "Application";
            return (
              <DetailRow
                key={template.id}
                first={index === 0}
                label={name}
                value={applicationFeeFact(sub, template)}
                dataAttr="listing-v2-application-row"
                action={
                  <EditInFull
                    name={name}
                    disabled={busy}
                    dataAttr="listing-v2-application-edit"
                    onClick={() => void run((recordId) => setEditing({ recordId, template }))}
                  />
                }
              />
            );
          })
        )}
      </RowCard>
      <div className="mt-6">
        <RowCard dataAttr="listing-v2-application-before-tour">
          <DetailRow
            first
            label="Application before a tour"
            value={beforeTour === "required" ? "Required" : beforeTour === "not_needed" ? "Not needed" : "—"}
            action={
              doors.onOpenSettings ? (
                <PortalIconAction
                  icon={Settings}
                  label="Open in Settings"
                  aria-label="Open Application before a tour in Settings"
                  data-attr="listing-v2-application-before-tour-settings"
                  onClick={() => doors.onOpenSettings?.(WORKSPACE_APPLICATIONS_LEASES_SETTINGS_HREF)}
                />
              ) : undefined
            }
          />
        </RowCard>
      </div>
      {editing ? (
        <ManagerApplicationQuestionsEditorModal
          open
          title="Edit application"
          sub={synced}
          managerUserId={doors.managerUserId ?? ""}
          applicationPreviewPropertyId={editing.recordId}
          initialVariant={editing.template.formVariant ?? "standard"}
          lockVariant
          templateEditorMode="edit"
          applicationTemplate={editing.template}
          templates={templates}
          signingOrder="application_then_lease"
          onPersistSubmission={(merged) => {
            onChange(merged);
            return true;
          }}
          onClose={() => setEditing(null)}
          onSaved={() => {}}
          showToast={doors.showToast}
        />
      ) : null}
    </StepColumn>
  );
}

/* ─────────────────────────── Lease ─────────────────────────── */

export function StepLease({ sub, onChange, doors }: StepProps) {
  const synced = useMemo(() => syncPropertyLeaseTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyLeaseTemplates(synced), [synced]);
  const { busy, run } = useEditInFull(doors);
  const [editing, setEditing] = useState<{ recordId: string; template: PropertyLeaseTemplate } | null>(null);

  const saveTemplates = (
    nextTemplates: PropertyLeaseTemplate[],
    applications?: PropertyApplicationTemplate[],
  ): boolean => {
    const withLeases = syncLegacyLeaseFieldsFromTemplates(synced, nextTemplates);
    onChange(applications ? withPropertyApplicationTemplatesExplicit(withLeases, applications) : withLeases);
    return true;
  };
  const importedLease = Boolean(editing?.template.draftQuestionConfig || editing?.template.publishedQuestionConfig);
  // The lease types this property offers that have no lease yet: shown as the defaults a manager adds
  // on the Lease tab (sync never conjures one), so a brand-new draft is not an empty step.
  const missingSeeds = useMemo(
    () => buildLeaseTemplateSeeds(synced).filter((seed) => !templates.some((template) => template.listingSeedKey === seed.seedKey)),
    [synced, templates],
  );

  return (
    <StepColumn>
      <StepHeading title="Lease" />
      <RowCard dataAttr="listing-v2-lease-rows">
        {templates.length === 0 && missingSeeds.length === 0 ? (
          <EmptyRows text="No leases yet" />
        ) : (
          <>
            {templates.map((template, index) => {
              const name = template.label?.trim() || "Lease";
              return (
                <DetailRow
                  key={template.id}
                  first={index === 0}
                  label={name}
                  value={leaseTypeFact(template)}
                  dataAttr="listing-v2-lease-row"
                  action={
                    <EditInFull
                      name={name}
                      disabled={busy}
                      dataAttr="listing-v2-lease-edit"
                      onClick={() => void run((recordId) => setEditing({ recordId, template }))}
                    />
                  }
                />
              );
            })}
            {missingSeeds.map((seed, index) => (
              <DetailRow
                key={seed.seedKey}
                first={templates.length === 0 && index === 0}
                label={seed.label}
                value="Not added yet"
                dataAttr="listing-v2-lease-default-row"
              />
            ))}
          </>
        )}
      </RowCard>
      {editing && !importedLease ? (
        <PropertyLeaseFormModal
          open
          mode="edit"
          sub={synced}
          template={editing.template}
          templates={templates}
          propertyId={editing.recordId}
          onClose={() => setEditing(null)}
          onSave={(nextTemplates, extra) => saveTemplates(nextTemplates, extra?.applications)}
          showToast={doors.showToast}
        />
      ) : null}
      {editing && importedLease ? (
        <ManagerLeaseQuestionsEditorModal
          key={editing.template.id}
          open
          template={editing.template}
          templates={templates}
          propertyId={editing.recordId}
          onClose={() => setEditing(null)}
          onSave={async (nextTemplates) => saveTemplates(nextTemplates)}
          showToast={doors.showToast}
        />
      ) : null}
    </StepColumn>
  );
}

/* ─────────────────────────── Move-in ─────────────────────────── */

function moveInRooms(sub: ManagerListingSubmissionV1): MoveInEditorRoom[] {
  if (isEntireHomeListing(sub)) return [];
  return sortRoomIndicesByFloor(sub.rooms).map((index) => {
    const room = sub.rooms[index]!;
    return { id: room.id, label: room.name.trim() || `Room ${index + 1}` };
  });
}

export function StepMoveIn({ sub, onChange, doors }: StepProps) {
  const templates = useMemo(() => readMoveInFormTemplates(sub), [sub]);
  const rooms = useMemo(() => moveInRooms(sub), [sub]);
  const { userId: viewerId } = usePortalSession();
  const canUploadPdf = !viewerId || !doors.managerUserId || viewerId === doors.managerUserId;
  const { busy, run } = useEditInFull(doors);
  const [editing, setEditing] = useState<{ recordId: string; template: MoveInFormTemplate } | null>(null);

  const save = async (template: MoveInFormTemplate): Promise<boolean> => {
    // The first save writes the starters out too. Only the form the manager saved keeps its own
    // Sends; untouched starters are stored as "Only when I send it" (same rule as the Move-in tab).
    const firstSave = !Array.isArray((sub as { moveInFormTemplates?: unknown }).moveInFormTemplates);
    const cleaned = cleanMoveInTemplateForSave(template);
    const list = templates.map((item) => (item.id === cleaned.id ? cleaned : item));
    const next = firstSave
      ? list.map((item) => (item.id.startsWith("starter-") && item.id !== cleaned.id ? { ...item, trigger: "manual" as const } : item))
      : list;
    onChange({ ...sub, moveInFormTemplates: next });
    return true;
  };

  return (
    <StepColumn>
      <StepHeading title="Move-in" />
      <RowCard dataAttr="listing-v2-movein-rows">
        {templates.length === 0 ? (
          <EmptyRows text="No move-in forms yet" />
        ) : (
          templates.map((template, index) => {
            const name = template.name.trim() || "Untitled form";
            return (
              <DetailRow
                key={template.id}
                first={index === 0}
                label={name}
                value={moveInSendsFact(template)}
                dataAttr="listing-v2-movein-row"
                action={
                  <EditInFull
                    name={name}
                    disabled={busy}
                    dataAttr="listing-v2-movein-edit"
                    onClick={() => void run((recordId) => setEditing({ recordId, template }))}
                  />
                }
              />
            );
          })
        )}
      </RowCard>
      {editing ? (
        <MoveInFormEditorModal
          key={editing.template.id}
          mode="edit"
          initial={editing.template}
          rooms={rooms}
          propertyId={editing.recordId}
          startStep={0}
          onSave={(template) => save(template)}
          onClose={() => setEditing(null)}
          canUploadPdf={canUploadPdf}
        />
      ) : null}
    </StepColumn>
  );
}

/* ─────────────────────────── Pricing ─────────────────────────── */

/** What the pricing workspace saved straight to the store, read back so the wizard does not overwrite it. */
function readSavedSubmission(
  mode: "draft" | "listing",
  recordId: string,
  managerUserId: string,
): ManagerListingSubmissionV1 | null {
  if (mode === "draft") {
    const row = readAdminPropertyRows(5, managerUserId).find((candidate) => candidate.adminRefId === recordId);
    return row?.submission ? normalizeManagerListingSubmissionV1(row.submission) : null;
  }
  const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, recordId);
  return hit ? normalizeManagerListingSubmissionV1(hit.sub) : null;
}

export function StepPricing({ sub, onChange, doors }: StepProps) {
  const { busy, run } = useEditInFull(doors);
  const [editing, setEditing] = useState<{ recordId: string; subject: PropertyPricingSubject } | null>(null);
  const wholeHome = isEntireHomeListing(sub);
  const rooms = (sub.rooms ?? []).filter((room) => room.name.trim() || room.monthlyRent > 0);
  const applications = applicationTemplatesOf(sub);
  const fee = applications[0] ? applicationFeeFact(sub, applications[0]) : "No fee";
  const leases = resolveAllowedLeaseTerms(sub).join(", ");
  const saveTarget: ManagerPricingSaveTarget | null = editing
    ? { mode: doors.mode, saveId: editing.recordId }
    : null;

  const wholeAmount = propertyPricingWholeHouseSummary(sub).includes("/mo")
    ? propertyPricingWholeHouseSummary(sub).split(" · ").pop() ?? "—"
    : "—";

  return (
    <StepColumn>
      <StepHeading title="Pricing" />
      <RowCard dataAttr="listing-v2-pricing-rows">
        {wholeHome ? (
          <DetailRow
            first
            label="Whole house"
            value={wholeAmount}
            dataAttr="listing-v2-pricing-row"
            action={
              <EditInFull
                name="Whole house"
                disabled={busy}
                dataAttr="listing-v2-pricing-edit"
                onClick={() => void run((recordId) => setEditing({ recordId, subject: { kind: "whole" } }))}
              />
            }
          />
        ) : rooms.length === 0 ? (
          <EmptyRows text="No rooms to price yet" />
        ) : (
          rooms.map((room, index) => {
            const name = room.name.trim() || "Room";
            const amount = propertyPricingRoomAmount(room);
            return (
              <DetailRow
                key={room.id}
                first={index === 0}
                label={name}
                value={amount === "—" ? "Rent not set" : amount}
                dataAttr="listing-v2-pricing-row"
                action={
                  <EditInFull
                    name={name}
                    disabled={busy}
                    dataAttr="listing-v2-pricing-edit"
                    onClick={() => void run((recordId) => setEditing({ recordId, subject: { kind: "room", roomId: room.id } }))}
                  />
                }
              />
            );
          })
        )}
      </RowCard>
      <div className="mt-6">
        <RowCard dataAttr="listing-v2-pricing-fees">
          <DetailRow first label="Application fee" value={fee} />
          {leases ? <DetailRow label="Leases offered" value={leases} /> : null}
        </RowCard>
      </div>
      {editing && saveTarget && doors.managerUserId ? (
        <PropertyRoomPricingWorkspace
          open
          onClose={() => setEditing(null)}
          subject={editing.subject}
          sub={sub}
          saveTarget={saveTarget}
          managerUserId={doors.managerUserId}
          propertyLabel={sub.buildingName?.trim() || sub.address?.trim() || "Property"}
          onSaved={() => {
            const saved = readSavedSubmission(doors.mode, editing.recordId, doors.managerUserId!);
            if (saved) onChange(saved);
          }}
          showToast={doors.showToast}
          workspacePricingDefaults={doors.workspacePricingDefaults}
        />
      ) : null}
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
