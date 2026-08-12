"use client";

import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { PropertySearchPicker } from "@/components/marketing/property-search-picker";
import { CosignerInviteCallout } from "@/components/marketing/cosigner-invite-callout";
import { GroupInviteCallout } from "@/components/marketing/group-invite-callout";
import { GroupLeaderAppIdField } from "@/components/marketing/group-leader-app-id-field";
import { ApplicationFeeInlinePayment } from "@/components/marketing/application-fee-inline-payment";
import { ApplicationPhotoField, IncomeProofPhotos } from "@/components/marketing/application-photo-field";
import { SmsConsentCheckbox } from "@/components/marketing/sms-consent-checkbox";
import { listingApplicationFeeChannels, resolveApplicationFeePayChannel, isAchApplicationFeeChannel } from "@/lib/rental-application/application-fee-channel";
import {
  applicationFeeChargeLabel,
  applicationFeeReviewNote,
  applicationFeeWaiverExplanation,
} from "@/lib/rental-application/application-fee-display";
import { ApplyFieldRow } from "@/app/(public)/rent/apply/apply-field-row";
import {
  LEASE_TERM_OPTIONS,
  SHORT_TERM_LEASE_TERM,
  getBundleChoiceLabel,
  getBundleOptionsForProperty,
  getPropertyById,
  getRoomChoiceLabel,
  isEntireHomeProperty,
  isPropertyRentedByRoom,
  isRoomApprovedConflict,
  isRoomPendingConflict,
  listingAllowedLeaseTerms,
  roomSelectOptionsWithNone,
} from "@/lib/rental-application/data";
import {
  paymentAtSigningPriceLabel,
  utilitiesListingEstimateLabel,
} from "@/lib/rental-application/listing-fees-display";
import type { RentalWizardErrors, RentalWizardFormState, YesNo } from "@/lib/rental-application/types";
import { makeApplicationGroupId } from "@/lib/rental-application/application-groups";
import { digitsOnly, formatMoneyBlur } from "@/lib/rental-application/masks";
import {
  customFieldAnswerValue,
  customFieldErrorKey,
  customFieldsForWizardStep,
  displayableCustomFieldAnswers,
  formatCustomFieldAnswerDisplay,
  listingCustomApplicationFields,
  upsertCustomFieldAnswer,
} from "@/lib/rental-application/custom-fields";
import { normalizeCustomApplicationFields, type ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import { wizardSectionErrorClass } from "@/lib/wizard-field-errors";
import {
  activeApplicationWizardSteps,
  applicationConfigForVariant,
  isWizardFormFieldEnabled,
} from "@/lib/rental-application/application-field-catalog";

const pillWrap = "flex flex-wrap gap-2 rounded-full border border-border bg-accent/30 p-1 [html[data-theme=dark]_&]:border-white/12 [html[data-theme=dark]_&]:bg-white/6";
const pillActive = "rounded-full px-4 py-2.5 text-sm font-semibold bg-primary text-primary-foreground shadow-sm transition min-h-[44px] sm:min-h-0";
const pillIdle =
  "rounded-full px-4 py-2.5 text-sm font-semibold text-muted transition hover:bg-card hover:text-foreground min-h-[44px] sm:min-h-0 [html[data-theme=dark]_&]:text-white/72 [html[data-theme=dark]_&]:hover:bg-white/10 [html[data-theme=dark]_&]:hover:text-white";
const groupRoleStack = "flex flex-col gap-2 sm:flex-row sm:items-stretch";
const choiceActive =
  "w-full rounded-xl border border-primary bg-primary/12 px-4 py-3.5 text-left text-sm font-semibold leading-snug text-foreground transition sm:flex-1 sm:py-2.5 sm:text-center [html[data-theme=dark]_&]:border-primary/70 [html[data-theme=dark]_&]:bg-primary/22 [html[data-theme=dark]_&]:text-white";
const choiceIdle =
  "w-full rounded-xl border border-border bg-card/80 px-4 py-3.5 text-left text-sm font-semibold leading-snug text-foreground transition hover:border-primary/35 hover:bg-accent/25 sm:flex-1 sm:py-2.5 sm:text-center [html[data-theme=dark]_&]:border-white/14 [html[data-theme=dark]_&]:bg-white/5 [html[data-theme=dark]_&]:text-white/82 [html[data-theme=dark]_&]:hover:border-primary/45 [html[data-theme=dark]_&]:hover:bg-white/8";

function Label({
  children,
  required,
  optional,
  htmlFor,
}: {
  children: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-semibold text-foreground">
      {children}
      {required ? <span className="text-primary"> *</span> : null}
      {optional ? <span className="pl-1 font-normal text-muted/70">(optional)</span> : null}
    </label>
  );
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1.5 text-sm text-red-600">{msg}</p>;
}

function WizardFieldGate({
  fieldKey,
  enabled,
  children,
}: {
  fieldKey: string;
  enabled: (key: string) => boolean;
  children: ReactNode;
}) {
  if (!enabled(fieldKey)) return null;
  return <>{children}</>;
}

function StepIntro({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-sm leading-relaxed text-muted ${className}`}>{children}</p>;
}

function YesNoPills({
  value,
  onChange,
  error,
  name,
  fieldKey,
  suppressError = false,
}: {
  value: YesNo;
  onChange: (v: "yes" | "no") => void;
  error?: string;
  name: string;
  fieldKey?: string;
  /** When a parent row (e.g. ApplyFieldRow) renders the error message. */
  suppressError?: boolean;
}) {
  return (
    <div data-wizard-field={fieldKey} className={wizardSectionErrorClass(Boolean(error))}>
      {/* aria-pressed is what tells a screen reader which pill is chosen — the
          active styling alone is invisible to assistive tech. */}
      <div className={pillWrap} role="group" aria-label={name}>
        <button
          type="button"
          aria-pressed={value === "yes"}
          className={value === "yes" ? pillActive : pillIdle}
          onClick={() => onChange("yes")}
        >
          Yes
        </button>
        <button
          type="button"
          aria-pressed={value === "no"}
          className={value === "no" ? pillActive : pillIdle}
          onClick={() => onChange("no")}
        >
          No
        </button>
      </div>
      {suppressError ? null : <FieldError msg={error} />}
    </div>
  );
}

export type WizardStepsProps = {
  step: number;
  form: RentalWizardFormState;
  errors: RentalWizardErrors;
  /**
   * `public` and `portal` are the two live applicant surfaces; `manager` is the
   * manager-on-behalf flow. `editor` is read-only for payment purposes.
   */
  mode?: "public" | "portal" | "manager" | "editor";
  propertyOptions: { value: string; label: string }[];
  propertyLocked?: boolean;
  emailLocked?: boolean;
  patch: (p: Partial<RentalWizardFormState>) => void;
  applicationFeeGate: {
    needsFee: boolean;
    paid: boolean;
    displayLabel: string;
    amount: number;
    waived?: boolean;
    /** True while the server's authoritative fee is still being resolved — hold payment UI, never claim "no fee". */
    pending?: boolean;
  };
  applicationFeeCheckBusy?: boolean;
  applicationFeeCheckError?: string | null;
  applicationFeePaymentVerified?: boolean;
  onCheckApplicationFeePayment?: () => void;
  /** Waiver-code entry (a named part of the fee step, not a buried field). */
  waiverCodeBusy?: boolean;
  waiverCodeError?: string | null;
  onApplyWaiverCode?: () => void;
  /** App path the inline (embedded) fee payment returns to after completion. */
  applyReturnPath?: string;
  /** Incremented when public approved-occupancy sync completes; ties room availability to server data. */
  occupancySyncEpoch: number;
  showAvailabilityWarnings: boolean;
  setPhone: (next: string) => void;
  setLandlordPhone: (next: string) => void;
  setPrevLandlordPhone: (next: string) => void;
  setSupervisorPhone: (next: string) => void;
  setRef1Phone: (next: string) => void;
  setRef2Phone: (next: string) => void;
  setSsn: (next: string) => void;
  goToStep: (n: number) => void;
  editFromReview: (n: number) => void;
  /**
   * Lazily returns (minting on first call) the stable application id that
   * ID/income photo uploads attach to — the SAME axis id the autosave uses, so
   * an attached photo resumes with the rest of the answers.
   */
  getApplicationId?: () => string;
  /** Mint/persist the stable application id so invite links can be shown immediately. */
  onEnsureApplicationId?: () => void;
  /** Stable application id for invite links (updates when {@link onEnsureApplicationId} runs). */
  savedApplicationId?: string;
  /**
   * Guest (no-session) capture is gated on the row's resident-setup token —
   * minted when the draft first autosaves — which authorizes the photo writes.
   */
  photoSetupTokenRequired?: boolean;
  getPhotoSetupToken?: () => string | null;
};

function displayOrDash(v: string | null | undefined) {
  const t = (v ?? "").trim();
  return t ? t : <span className="text-muted/70">Not provided</span>;
}

function maskSsnReview(ssn: string) {
  const d = digitsOnly(ssn);
  if (d.length !== 9) return ssn.trim() || "Not provided";
  return `***-**-${d.slice(5)}`;
}

function ReviewSection({
  title,
  stepTarget,
  onEdit,
  children,
}: {
  title: string;
  stepTarget: number;
  onEdit: (step: number) => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-accent/30 p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-muted">{title}</h3>
        <button type="button" onClick={() => onEdit(stepTarget)} className="shrink-0 text-sm font-semibold text-primary hover:underline">
          Edit
        </button>
      </div>
      <dl className="mt-4 space-y-3 text-sm">{children}</dl>
    </section>
  );
}

function ReviewRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border/80 pb-3 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,38%)_1fr] sm:gap-4">
      <dt className="font-medium text-muted">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </div>
  );
}

/** One manager-defined application question, rendered by its configured type. */
function CustomQuestionField({
  field,
  value,
  error,
  onChange,
}: {
  field: ManagerCustomApplicationField;
  value: string;
  error?: string;
  onChange: (next: string) => void;
}) {
  const inputId = `custom-${field.key}`;
  const errorClass = error ? "border-red-400 ring-2 ring-red-100" : "";

  if (field.type === "checkbox") {
    return (
      <div className="space-y-2" data-wizard-field={customFieldErrorKey(field.key)}>
        <label
          className={`flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 ${
            error ? "border-red-300 bg-red-50/50 ring-2 ring-red-100" : "border-border"
          }`}
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border text-primary"
            checked={value === "yes"}
            onChange={(e) => onChange(e.target.checked ? "yes" : "")}
          />
          <span className="text-sm font-medium text-foreground">
            {field.label}
            {field.required ? <span className="text-primary"> *</span> : null}
          </span>
        </label>
        <FieldError msg={error} />
      </div>
    );
  }

  return (
    <div className="space-y-2" data-wizard-field={customFieldErrorKey(field.key)}>
      <Label htmlFor={inputId} required={field.required} optional={!field.required}>
        {field.label}
      </Label>
      {field.type === "select" ? (
        <Select id={inputId} value={value} onChange={(e) => onChange(e.target.value)} className={errorClass}>
          <option value="">Select</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      ) : field.type === "date" ? (
        <DateField id={inputId} value={value} onChange={onChange} className={errorClass} />
      ) : (
        <Input
          id={inputId}
          inputMode={field.type === "number" ? "decimal" : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={errorClass}
        />
      )}
      <FieldError msg={error} />
    </div>
  );
}

export function RentalWizardStepBody(p: WizardStepsProps) {
  const {
    step,
    form,
    errors,
    mode = "public",
    propertyOptions,
    propertyLocked,
    patch,
    editFromReview,
    applicationFeeGate,
    occupancySyncEpoch,
    showAvailabilityWarnings,
    applicationFeeCheckBusy,
    applicationFeeCheckError,
    applicationFeePaymentVerified,
    onCheckApplicationFeePayment,
    waiverCodeBusy,
    waiverCodeError,
    onApplyWaiverCode,
    applyReturnPath,
    onEnsureApplicationId,
    savedApplicationId = "",
  } = p;

  const listingSub = (() => {
    const prop = getPropertyById(form.propertyId);
    return prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
  })();
  // Field visibility + manager custom questions resolve for the form the
  // applicant is on: short-term guests and long-term tenants see different,
  // independently-configured question sets. `rentalType` is derived from the
  // step-3 lease-term dropdown (the single listing-permission gate), so the two
  // can never disagree.
  const applicationConfig = applicationConfigForVariant(listingSub, form.rentalType);
  const showWizardField = (key: string) => isWizardFormFieldEnabled(applicationConfig, key);

  // Photo uploads are read-only in the portal's editor (an already-submitted
  // application is never re-uploaded). `getApplicationId` mints/returns the
  // stable axis id an upload attaches to; falls back to the form email context.
  const photosReadOnly = mode === "editor";
  const getApplicationId = p.getApplicationId ?? (() => form.email.trim().toLowerCase() || "");

  // Manager custom questions render inside their configured section's step (untagged → step 9).
  const stepManagerQuestions = (() => {
    if (step < 2 || step > 9) return null;
    const stepProp = getPropertyById(form.propertyId);
    const fields = customFieldsForWizardStep(
      listingCustomApplicationFields(applicationConfig),
      step,
    );
    if (fields.length === 0) return null;
    return (
      <div className="space-y-5 rounded-2xl border border-border bg-accent/20 p-4 sm:p-5">
        <div>
          <h3 className="text-base font-bold tracking-tight text-foreground">Questions from your property manager</h3>
          <StepIntro className="mt-1.5">
            {stepProp?.title ? `The manager of ${stepProp.title} asks all applicants:` : "The property manager asks all applicants:"}
          </StepIntro>
        </div>
        {fields.map((field) => (
          <CustomQuestionField
            key={field.key}
            field={field}
            value={customFieldAnswerValue(form.customFieldAnswers, field.key)}
            error={errors[customFieldErrorKey(field.key)]}
            onChange={(next) =>
              patch({ customFieldAnswers: upsertCustomFieldAnswer(form.customFieldAnswers, field, next) })
            }
          />
        ))}
      </div>
    );
  })();

  if (step === 1) {
    const showCosigner = showWizardField("hasCosigner");
    const showGroup = showWizardField("applyingAsGroup");
    const joiningGroup = Boolean(form.groupLeaderAppId.trim());
    const organizingGroup = form.applyingAsGroup === "yes" && !joiningGroup;
    const inviteAppId = savedApplicationId.trim();

    return (
      <div className="rental-wizard-step space-y-4">
        <div className="divide-y divide-border/60 rounded-2xl border border-border bg-card/30 [html[data-theme=dark]_&]:border-white/10 [html[data-theme=dark]_&]:bg-white/4">
          {showGroup ? (
            <>
              <ApplyFieldRow
                label="Applying as part of a group?"
                error={errors.applyingAsGroup}
                fieldKey="applyingAsGroup"
                inline
                showRequiredMarker={false}
                labelClassName="text-sm font-semibold text-foreground"
                className="px-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
              >
                <YesNoPills
                  value={form.applyingAsGroup}
                  error={errors.applyingAsGroup}
                  name="Group application"
                  fieldKey="applyingAsGroup"
                  suppressError
                  onChange={(v) => {
                    if (v === "no") {
                      patch({
                        applicantRole: "signer",
                        applyingAsGroup: v,
                        groupRole: null,
                        groupSize: "",
                        groupId: "",
                        groupLeaderAppId: "",
                      });
                      return;
                    }
                    onEnsureApplicationId?.();
                    patch({
                      applicantRole: "signer",
                      applyingAsGroup: v,
                      groupRole: joiningGroup ? "joining" : "first",
                      groupId: joiningGroup
                        ? form.groupId
                        : form.groupId.trim() || makeApplicationGroupId(),
                    });
                  }}
                />
              </ApplyFieldRow>

              {form.applyingAsGroup === "yes" ? (
                <>
                  <p className="px-4 pt-3 text-xs leading-relaxed text-muted sm:px-5">
                    One person applies first and gets a Group ID. Everyone else pastes that same
                    ID below so the manager sees you as one household. Each of you still files
                    your own application and is billed your own charges.
                  </p>

                  <ApplyFieldRow
                    label="Organizer application ID"
                    optional
                    inline
                    error={errors.groupLeaderAppId}
                    fieldKey="groupLeaderAppId"
                    labelClassName="text-sm font-semibold text-foreground"
                    className="px-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,280px)] sm:px-5"
                  >
                    <GroupLeaderAppIdField
                      value={form.groupLeaderAppId}
                      onChange={(next) => {
                        const trimmed = next.trim();
                        patch({
                          groupLeaderAppId: next,
                          groupRole: trimmed ? "joining" : "first",
                          groupId: trimmed ? form.groupId : makeApplicationGroupId(),
                          ...(trimmed ? { groupSize: "" } : {}),
                        });
                      }}
                      error={errors.groupLeaderAppId}
                      onResolved={(preview) => {
                        if (preview) {
                          patch({
                            groupLeaderAppId: preview.leaderAppId,
                            groupId: preview.groupId,
                            groupRole: "joining",
                            ...(preview.propertyId && !form.propertyId.trim()
                              ? { propertyId: preview.propertyId }
                              : {}),
                            ...(preview.groupSize != null && !form.groupSize.trim()
                              ? { groupSize: String(preview.groupSize) }
                              : {}),
                          });
                        }
                      }}
                      suppressError
                    />
                  </ApplyFieldRow>
                </>
              ) : null}

              {organizingGroup ? (
                <ApplyFieldRow
                  label="How many people in the group?"
                  error={errors.groupSize}
                  fieldKey="groupSize"
                  inline
                  labelClassName="text-sm font-semibold text-foreground"
                  className="px-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,280px)] sm:px-5"
                >
                  {/*
                    The organizer's declared size is load-bearing, not a nicety:
                    `buildBundleApplicationGroups` derives the group's expected size
                    from it (driving "Group N/M", missingCount and isComplete), and
                    `bundle-cost-split` divides the move-in charges by it. It was
                    never collected anywhere in the UI — only ever read back — so
                    every group read as "size unknown" and no split could be made.
                  */}
                  <Input
                    id="groupSize"
                    type="number"
                    inputMode="numeric"
                    min={2}
                    max={12}
                    step={1}
                    placeholder="e.g. 3"
                    value={form.groupSize}
                    onChange={(e) => patch({ groupSize: e.target.value })}
                    className={errors.groupSize ? "border-red-400 ring-2 ring-red-100" : ""}
                    aria-describedby="groupSizeHelp"
                  />
                  <p id="groupSizeHelp" className="mt-1.5 text-xs text-muted">
                    Everyone applying together, including you. Each person is billed their own
                    charges — move-in costs are not split across the group.
                  </p>
                </ApplyFieldRow>
              ) : null}

              {joiningGroup ? (
                <div className="px-4 pb-4 sm:px-5">
                  <p className="rounded-xl border border-border bg-card/40 px-3 py-2.5 text-xs leading-relaxed text-muted">
                    You are joining the group started by{" "}
                    <span className="font-semibold text-foreground">{form.groupLeaderAppId.trim()}</span>. The
                    organizer declared the group size — you do not need to enter it. Finish your own
                    application and the manager will see you both on the same household.
                  </p>
                </div>
              ) : null}

              {organizingGroup && inviteAppId ? (
                <div className="px-4 pb-4 sm:px-5">
                  <GroupInviteCallout
                    leaderAppId={inviteAppId}
                    organizerName={form.fullLegalName.trim() || undefined}
                    groupSize={form.groupSize.trim() || undefined}
                    propertyId={form.propertyId.trim() || undefined}
                    pendingSubmit
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {showCosigner ? (
            <>
              <ApplyFieldRow
                label="Will someone co-sign with you?"
                error={errors.hasCosigner}
                fieldKey="hasCosigner"
                inline
                showRequiredMarker={false}
                labelClassName="text-sm font-semibold text-foreground"
                className="px-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
              >
                <YesNoPills
                  value={form.hasCosigner}
                  error={errors.hasCosigner}
                  name="Co-signer"
                  fieldKey="hasCosigner"
                  suppressError
                  onChange={(v) => {
                    if (v === "yes") onEnsureApplicationId?.();
                    patch({ applicantRole: "signer", hasCosigner: v });
                  }}
                />
              </ApplyFieldRow>
              {form.hasCosigner === "yes" && inviteAppId ? (
                <div className="px-4 pb-4 sm:px-5">
                  <CosignerInviteCallout
                    signerAppId={inviteAppId}
                    signerName={form.fullLegalName.trim() || undefined}
                    pendingSubmit
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    );
  }

  if (step === 3) {
    void occupancySyncEpoch;
    const selectedProperty = getPropertyById(form.propertyId);
    // A single lease-term dropdown carries short-term too: listingAllowedLeaseTerms
    // includes "Short-Term Stay" exactly when the listing permits it, so there is no
    // separate "Application type" toggle that could contradict the term.
    const leaseTermOptions = form.propertyId.trim()
      ? listingAllowedLeaseTerms(form.propertyId)
      : [...LEASE_TERM_OPTIONS];
    const rooms = roomSelectOptionsWithNone(form.propertyId, { includeUnavailable: true }).filter((o) => o.value !== "");
    const roomsWithNone = roomSelectOptionsWithNone(form.propertyId, { includeUnavailable: true });
    // Whole-unit listings (leased as one place, not room-by-room) don't ask for
    // ranked 1st/2nd/3rd room choices — see the property step below.
    const isByRoom = isPropertyRentedByRoom(form.propertyId);
    // Entire-home pricing: itemized rooms are bedrooms on display, not units —
    // there is nothing to choose (the application is for the whole home).
    const entireHome = Boolean(form.propertyId) && isEntireHomeProperty(form.propertyId);
    const bundleOptions = form.propertyId
      ? getBundleOptionsForProperty(form.propertyId, { rentalType: form.rentalType })
      : [];
    const bundleSelected = Boolean(form.bundleId.trim());
    const propertySearchOptions = propertyOptions.map((o) => {
      const prop = getPropertyById(o.value);
      return {
        id: o.value,
        title: o.label,
        subtitle: prop?.address,
        tags: prop ? [prop.neighborhood, prop.rentLabel].filter(Boolean) : undefined,
        searchText: prop ? `${prop.title} ${prop.address} ${prop.neighborhood} ${prop.buildingName} ${prop.zip}` : o.label,
      };
    });
    const room1ApprovedConflict = form.roomChoice1
      ? isRoomApprovedConflict(form.roomChoice1, form.leaseStart, form.leaseEnd)
      : false;
    const room1PendingConflict = !room1ApprovedConflict && form.roomChoice1
      ? isRoomPendingConflict(form.roomChoice1, form.leaseStart, form.leaseEnd)
      : false;
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>
            Your property manager shared this listing with you. Choose your room preferences and lease dates you are prepared to
            sign.
          </StepIntro>
        </div>

        <WizardFieldGate fieldKey="propertyId" enabled={showWizardField}>
        <div className="space-y-2" data-wizard-field="propertyId">
          <Label htmlFor="propertyId" required>
            Property name
          </Label>
          {propertyLocked ? (
            selectedProperty ? (
            <div className="rounded-xl border border-border bg-accent/30 px-4 py-3 text-sm">
              <p className="font-semibold text-foreground">{selectedProperty.title}</p>
              {selectedProperty.address ? (
                <p className="mt-1 text-muted">{selectedProperty.address}</p>
              ) : null}
            </div>
            ) : (
              <div className="rounded-xl border border-border bg-accent/30 px-4 py-3 text-sm text-muted">
                Loading property…
              </div>
            )
          ) : (
          <div className={errors.propertyId ? "rounded-xl ring-2 ring-red-100" : ""}>
          <PropertySearchPicker
            options={propertySearchOptions}
            value={form.propertyId || null}
            onChange={(id) => {
              const pid = id ?? "";
              // Whole-unit listings aren't chosen by room: auto-select the sole
              // unit (or the property itself) so no ranked room choice is asked.
              // Entire-home listings always apply for the whole place — their
              // itemized rooms are bedrooms, never selectable units.
              const wholeUnit = Boolean(pid) && !isPropertyRentedByRoom(pid);
              const isEntire = Boolean(pid) && isEntireHomeProperty(pid);
              const unitOpts = wholeUnit && !isEntire
                ? roomSelectOptionsWithNone(pid, { includeUnavailable: true }).filter((o) => o.value !== "")
                : [];
              const autoRoom = isEntire ? pid : wholeUnit && unitOpts.length <= 1 ? (unitOpts[0]?.value ?? pid) : "";
              patch({ propertyId: pid, bundleId: "", roomChoice1: autoRoom, roomChoice2: "", roomChoice3: "", leaseTerm: "", rentalType: "standard" });
            }}
            placeholder="Search by address, neighborhood, or property name…"
            emptyMessage="No properties match your search."
            listEmptyMessage="No properties available to apply for."
            ariaLabel="Search properties to apply for"
          />
          </div>
          )}
          <FieldError msg={errors.propertyId} />
        </div>
        </WizardFieldGate>

        <WizardFieldGate fieldKey="leaseTerm" enabled={showWizardField}>
        <div className="space-y-2" data-wizard-field="leaseTerm">
          <Label htmlFor="leaseTerm" required>
            Lease term
          </Label>
          <Select
            id="leaseTerm"
            value={form.leaseTerm}
            onChange={(e) => {
              const v = e.target.value;
              // The single dropdown carries short-term as one option; rentalType is
              // derived from the choice so the two can never contradict each other.
              const rentalType = v === SHORT_TERM_LEASE_TERM ? "short_term" : "standard";
              const nextBundleOptions = form.propertyId.trim()
                ? getBundleOptionsForProperty(form.propertyId, { rentalType })
                : [];
              const keepBundle =
                Boolean(form.bundleId.trim()) &&
                nextBundleOptions.some((o) => o.value === form.bundleId);
              patch(
                v === "Month-to-Month"
                  ? {
                      leaseTerm: v,
                      leaseEnd: "",
                      rentalType,
                      ...(keepBundle ? {} : { bundleId: "" }),
                    }
                  : {
                      leaseTerm: v,
                      rentalType,
                      ...(keepBundle ? {} : { bundleId: "" }),
                    },
              );
            }}
            className={errors.leaseTerm ? "border-red-400 ring-2 ring-red-100" : ""}
          >
            <option value="">Select lease length</option>
            {leaseTermOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <FieldError msg={errors.leaseTerm} />
          {form.rentalType === "short_term" ? (
            <div className="rounded-xl border border-border bg-card p-3 text-sm leading-6 text-foreground">
              <p>
                Daily cost: <span className="font-semibold">{selectedProperty?.listingSubmission?.shortTermDailyCost || "Set by host"}</span>
                {" · "}
                Deposit: <span className="font-semibold">{selectedProperty?.listingSubmission?.shortTermDeposit || "Set by host"}</span>
              </p>
              {selectedProperty?.listingSubmission?.shortTermRequirements?.trim() ? (
                <p className="mt-1 text-muted">{selectedProperty.listingSubmission.shortTermRequirements.trim()}</p>
              ) : null}
            </div>
          ) : null}
          {form.leaseTerm === "Month-to-Month" ? (
            <p className="rounded-lg border px-3 py-2 text-sm portal-banner-pending">
              Month-to-month leases include an additional <span className="font-semibold">$25</span> charge to rent.
            </p>
          ) : null}
        </div>
        </WizardFieldGate>

        {bundleOptions.length > 0 ? (
          <div className="space-y-2" data-wizard-field="bundleId">
            <Label htmlFor="bundleId">Lease bundle</Label>
            <p className="text-xs text-muted">
              {form.rentalType === "short_term"
                ? "Short-term bundle pricing for your stay. Choose a bundle or leave as none."
                : `This listing offers bundle pricing. Choose a bundle to apply for it${isByRoom ? " instead of individual rooms" : ""}, or leave as none.`}
            </p>
            <Select
              id="bundleId"
              value={form.bundleId}
              disabled={!form.propertyId || !form.leaseTerm}
              onChange={(e) => {
                const next = e.target.value;
                if (next && isByRoom) {
                  patch({
                    bundleId: next,
                    roomChoice1: "",
                    roomChoice2: "",
                    roomChoice3: "",
                  });
                } else {
                  patch({ bundleId: next });
                }
              }}
            >
              <option value="">
                {form.rentalType === "short_term"
                  ? "None: standard short-term stay"
                  : `None: ${isByRoom ? "apply for individual rooms" : "standard lease"}`}
              </option>
              {bundleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        <WizardFieldGate fieldKey="roomChoice1" enabled={showWizardField}>
        {isByRoom && !bundleSelected ? (
        <div className="space-y-2">
          <Label required>Room preferences</Label>
          <p className="text-xs text-muted">
            Your first choice is used for availability and processing; second and third choices help with placement.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">1st choice</span>
              <div data-wizard-field="roomChoice1">
                <Select
                  value={form.roomChoice1}
                  disabled={!form.propertyId}
                  onChange={(e) => patch({ roomChoice1: e.target.value })}
                  className={errors.roomChoice1 ? "border-red-400 ring-2 ring-red-100" : ""}
                >
                <option value="">{form.propertyId ? "Select a room" : "Select a property first"}</option>
                {rooms.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <FieldError msg={errors.roomChoice1} />
              </div>
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">2nd choice</span>
              <Select
                value={form.roomChoice2}
                disabled={!form.propertyId}
                onChange={(e) => patch({ roomChoice2: e.target.value })}
                className={errors.roomChoice2 ? "border-red-400 ring-2 ring-red-100" : ""}
              >
                {roomsWithNone.map((o) => (
                  <option key={o.label + o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <FieldError msg={errors.roomChoice2} />
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">3rd choice</span>
              <Select
                value={form.roomChoice3}
                disabled={!form.propertyId}
                onChange={(e) => patch({ roomChoice3: e.target.value })}
                className={errors.roomChoice3 ? "border-red-400 ring-2 ring-red-100" : ""}
              >
                {roomsWithNone.map((o) => (
                  <option key={`t-${o.label}-${o.value}`} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <FieldError msg={errors.roomChoice3} />
            </div>
          </div>
        </div>
        ) : !isByRoom && !entireHome && rooms.length > 1 ? (
        // Whole-unit listing with multiple units: pick one unit, no ranked choices.
        <div className="space-y-2">
          <Label required>Unit</Label>
          <p className="text-xs text-muted">
            This home is leased as a whole unit. Choose the unit you&apos;re applying for.
          </p>
          <div data-wizard-field="roomChoice1">
            <Select
              value={form.roomChoice1}
              disabled={!form.propertyId}
              onChange={(e) => patch({ roomChoice1: e.target.value, roomChoice2: "", roomChoice3: "" })}
              className={errors.roomChoice1 ? "border-red-400 ring-2 ring-red-100" : ""}
            >
              <option value="">{form.propertyId ? "Select a unit" : "Select a property first"}</option>
              {rooms.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <FieldError msg={errors.roomChoice1} />
          </div>
        </div>
        ) : (
          // Whole-unit listing with a single unit (roomChoice1 auto-filled on
          // property select) or a bundle application: nothing to ask.
          <div data-wizard-field="roomChoice1" className="hidden" aria-hidden />
        )}
        </WizardFieldGate>

        <WizardFieldGate fieldKey="leaseStart" enabled={showWizardField}>
        <div className={form.leaseTerm === "Month-to-Month" ? "space-y-2" : "grid gap-4 sm:grid-cols-2"}>
          <div className="space-y-2">
            <Label htmlFor="leaseStart" required>
              {form.rentalType === "short_term" ? "Check-in date" : "Lease start date"}
            </Label>
            <DateField
              id="leaseStart"
              min="2020-01-01"
              max="2035-12-31"
              value={form.leaseStart}
              onChange={(next) => patch({ leaseStart: next })}
              className={errors.leaseStart ? "border-red-400 ring-2 ring-red-100" : ""}
            />
            <FieldError msg={errors.leaseStart} />
          </div>
          {form.leaseTerm !== "Month-to-Month" ? (
            <div className="space-y-2">
              <Label htmlFor="leaseEnd" required>
                {form.rentalType === "short_term" ? "Check-out date" : "Lease end date"}
              </Label>
              <DateField
                id="leaseEnd"
                min="2020-01-01"
                max="2040-12-31"
                value={form.leaseEnd}
                onChange={(next) => patch({ leaseEnd: next })}
                className={errors.leaseEnd ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.leaseEnd} />
            </div>
          ) : null}
        </div>
        </WizardFieldGate>
        {showAvailabilityWarnings && showWizardField("roomChoice1") && room1ApprovedConflict ? (
          <p className="rounded-xl border px-4 py-3 text-sm portal-banner-pending">
            Warning: your first-choice room does not appear available for the selected move-in dates, but you can still submit
            this application.
          </p>
        ) : null}
        {showAvailabilityWarnings && showWizardField("roomChoice1") && !room1ApprovedConflict && room1PendingConflict ? (
          <p className="rounded-xl border px-4 py-3 text-sm portal-banner-pending">
            Warning: someone else has already applied for your first-choice room on these dates, but you can still submit this
            application.
          </p>
        ) : null}
        {form.rentalType === "short_term" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="shortTermCheckInTime" required>
                Check-in time
              </Label>
              <Input
                id="shortTermCheckInTime"
                type="time"
                value={form.shortTermCheckInTime}
                onChange={(e) => patch({ shortTermCheckInTime: e.target.value })}
                className={errors.shortTermCheckInTime ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.shortTermCheckInTime} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shortTermCheckOutTime" required>
                Check-out time
              </Label>
              <Input
                id="shortTermCheckOutTime"
                type="time"
                value={form.shortTermCheckOutTime}
                onChange={(e) => patch({ shortTermCheckOutTime: e.target.value })}
                className={errors.shortTermCheckOutTime ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.shortTermCheckOutTime} />
            </div>
          </div>
        ) : null}

        {form.rentalType === "short_term" ? (
          <label
            className="flex items-start gap-3 rounded-xl border border-border bg-card p-3 text-sm leading-6 text-foreground"
            htmlFor="shortTermRulesAck"
          >
            <input
              id="shortTermRulesAck"
              type="checkbox"
              checked={form.shortTermRulesAck}
              onChange={(e) => patch({ shortTermRulesAck: e.target.checked })}
              className="mt-1 h-4 w-4 shrink-0"
              data-attr="short-term-rules-ack"
            />
            <span>
              {`I have read and agree to follow the host's house rules for this short-term stay${
                selectedProperty?.listingSubmission?.shortTermRequirements?.trim() ? " shown above" : ""
              }.`}
              {errors.shortTermRulesAck ? (
                <span className="mt-1 block text-red-500">{errors.shortTermRulesAck}</span>
              ) : null}
            </span>
          </label>
        ) : null}

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>
            Start with how we can reach you, then confirm your identity exactly as it appears on your ID. This section is
            encrypted in transit in production environments.
          </StepIntro>
        </div>

        <div className="space-y-5">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Contact</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <WizardFieldGate fieldKey="fullLegalName" enabled={showWizardField}>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="fullLegalName" required>
                Full legal name
              </Label>
              <Input
                id="fullLegalName"
                value={form.fullLegalName}
                onChange={(e) => patch({ fullLegalName: e.target.value })}
                placeholder="First and last name"
                autoComplete="name"
                className={errors.fullLegalName ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.fullLegalName} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="phone" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="phone" required>
                Phone number
              </Label>
              <Input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={form.phone}
                onChange={(e) => p.setPhone(e.target.value)}
                placeholder="(###) ###-####"
                className={errors.phone ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.phone} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="email" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="email" required>
                Email address
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(e) => patch({ email: e.target.value })}
                placeholder="you@example.com"
                readOnly={Boolean(p.emailLocked)}
                disabled={Boolean(p.emailLocked)}
                className={errors.email ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.email} />
            </div>
            </WizardFieldGate>
          </div>
          {/* A2P 10DLC SMS opt-in. Optional (never required to apply); the number
              entered above is the one that would receive texts, so the control
              follows the Phone question's gate. Unchecked by default; consent +
              timestamp persist on the submitted snapshot (the server re-stamps
              the timestamp + wording version on upsert). */}
          <WizardFieldGate fieldKey="phone" enabled={showWizardField}>
            <SmsConsentCheckbox
              inputId="sms-consent"
              checked={Boolean(form.smsConsent)}
              onChange={(next) =>
                patch({ smsConsent: next, smsConsentAt: next ? new Date().toISOString() : undefined })
              }
            />
          </WizardFieldGate>
        </div>

        <div className="space-y-5">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Identity</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <WizardFieldGate fieldKey="dateOfBirth" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="dateOfBirth" required>
                Date of birth
              </Label>
              <DateField
                id="dateOfBirth"
                value={form.dateOfBirth}
                onChange={(next) => patch({ dateOfBirth: next })}
                className={errors.dateOfBirth ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.dateOfBirth} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="ssn" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="ssn" required>
                Social Security number
              </Label>
              <Input
                id="ssn"
                inputMode="numeric"
                autoComplete="off"
                value={form.ssn}
                onChange={(e) => p.setSsn(e.target.value)}
                placeholder="###-##-####"
                className={errors.ssn ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.ssn} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="driversLicense" enabled={showWizardField}>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="driversLicense" required>
                Driver&apos;s license or ID number
              </Label>
              <Input
                id="driversLicense"
                value={form.driversLicense}
                onChange={(e) => patch({ driversLicense: e.target.value })}
                className={errors.driversLicense ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.driversLicense} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="idPhotoFront" enabled={showWizardField}>
            <div className="space-y-3 sm:col-span-2">
              <div>
                <Label>
                  Photo of your driver&apos;s license or ID
                  <span className="pl-1 font-normal text-muted/70">(optional)</span>
                </Label>
                <p className="mt-1 text-xs text-muted">
                  Clear front and back photos — shared only with the property manager for this application.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ApplicationPhotoField
                  slot="idFront"
                  label="Front of ID"
                  uploadOnly
                  attachment={form.idPhotoFront}
                  onChange={(next) => patch({ idPhotoFront: next })}
                  getApplicationId={getApplicationId}
                  setupTokenRequired={p.photoSetupTokenRequired}
                  getSetupToken={p.getPhotoSetupToken}
                  readOnly={photosReadOnly}
                  dataAttr="application-id-photo-front"
                />
                <ApplicationPhotoField
                  slot="idBack"
                  label="Back of ID"
                  uploadOnly
                  attachment={form.idPhotoBack}
                  onChange={(next) => patch({ idPhotoBack: next })}
                  getApplicationId={getApplicationId}
                  setupTokenRequired={p.photoSetupTokenRequired}
                  getSetupToken={p.getPhotoSetupToken}
                  readOnly={photosReadOnly}
                  dataAttr="application-id-photo-back"
                />
              </div>
            </div>
            </WizardFieldGate>
          </div>
        </div>

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 4) {
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>Where you live today. Landlord and move dates help us verify your rental history.</StepIntro>
        </div>
        <WizardFieldGate fieldKey="currentStreet" enabled={showWizardField}>
        <div className="space-y-2">
          <Label htmlFor="currentStreet" required>
            Street address
          </Label>
          <Input
            id="currentStreet"
            value={form.currentStreet}
            onChange={(e) => patch({ currentStreet: e.target.value })}
            autoComplete="street-address"
            className={errors.currentStreet ? "border-red-400 ring-2 ring-red-100" : ""}
          />
          <FieldError msg={errors.currentStreet} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-1">
            <Label htmlFor="currentCity" required>
              City
            </Label>
            <Input
              id="currentCity"
              value={form.currentCity}
              onChange={(e) => patch({ currentCity: e.target.value })}
              className={errors.currentCity ? "border-red-400 ring-2 ring-red-100" : ""}
            />
            <FieldError msg={errors.currentCity} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="currentState" required>
              State
            </Label>
            <Input
              id="currentState"
              value={form.currentState}
              onChange={(e) => patch({ currentState: e.target.value.toUpperCase() })}
              maxLength={2}
              placeholder="WA"
              className={errors.currentState ? "border-red-400 ring-2 ring-red-100" : ""}
            />
            <FieldError msg={errors.currentState} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="currentZip" required>
              ZIP code
            </Label>
            <Input
              id="currentZip"
              inputMode="numeric"
              value={form.currentZip}
              onChange={(e) => patch({ currentZip: e.target.value })}
              className={errors.currentZip ? "border-red-400 ring-2 ring-red-100" : ""}
            />
            <FieldError msg={errors.currentZip} />
          </div>
        </div>
        </WizardFieldGate>
        <WizardFieldGate fieldKey="currentLandlordName" enabled={showWizardField}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="currentLandlordName" optional>
              Current landlord name
            </Label>
            <Input
              id="currentLandlordName"
              value={form.currentLandlordName}
              onChange={(e) => patch({ currentLandlordName: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="currentLandlordPhone" optional>
              Current landlord phone
            </Label>
            <Input
              id="currentLandlordPhone"
              type="tel"
              value={form.currentLandlordPhone}
              onChange={(e) => p.setLandlordPhone(e.target.value)}
              placeholder="(###) ###-####"
              className={errors.currentLandlordPhone ? "border-red-400 ring-2 ring-red-100" : ""}
            />
            <FieldError msg={errors.currentLandlordPhone} />
          </div>
        </div>
        </WizardFieldGate>
        <WizardFieldGate fieldKey="currentMoveIn" enabled={showWizardField}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="currentMoveIn" optional>
              Current move-in date
            </Label>
            <DateField id="currentMoveIn" value={form.currentMoveIn} onChange={(next) => patch({ currentMoveIn: next })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="currentMoveOut" optional>
              Current move-out date
            </Label>
            <DateField id="currentMoveOut" value={form.currentMoveOut} onChange={(next) => patch({ currentMoveOut: next })} />
          </div>
        </div>
        </WizardFieldGate>
        <WizardFieldGate fieldKey="currentReasonLeaving" enabled={showWizardField}>
        <div className="space-y-2">
          <Label htmlFor="currentReasonLeaving" optional>
            Reason for leaving
          </Label>
          <Textarea
            id="currentReasonLeaving"
            value={form.currentReasonLeaving}
            onChange={(e) => patch({ currentReasonLeaving: e.target.value })}
            placeholder="e.g. relocating for work, lease ending…"
            rows={3}
          />
        </div>
        </WizardFieldGate>

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 5) {
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>If this is your first lease, you can indicate that you have no prior address to report.</StepIntro>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border text-primary"
            checked={form.noPreviousAddress}
            onChange={(e) => patch({ noPreviousAddress: e.target.checked })}
          />
          <span className="text-sm font-medium text-foreground">I do not have a previous address to provide</span>
        </label>

        {!form.noPreviousAddress ? (
          <>
            <WizardFieldGate fieldKey="prevStreet" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="prevStreet" required>
                Street address
              </Label>
              <Input
                id="prevStreet"
                value={form.prevStreet}
                onChange={(e) => patch({ prevStreet: e.target.value })}
                disabled={form.noPreviousAddress}
                className={errors.prevStreet ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.prevStreet} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="prevCity" required>
                  City
                </Label>
                <Input
                  id="prevCity"
                  value={form.prevCity}
                  onChange={(e) => patch({ prevCity: e.target.value })}
                  className={errors.prevCity ? "border-red-400 ring-2 ring-red-100" : ""}
                />
                <FieldError msg={errors.prevCity} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prevState" required>
                  State
                </Label>
                <Input
                  id="prevState"
                  value={form.prevState}
                  onChange={(e) => patch({ prevState: e.target.value.toUpperCase() })}
                  maxLength={2}
                  className={errors.prevState ? "border-red-400 ring-2 ring-red-100" : ""}
                />
                <FieldError msg={errors.prevState} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prevZip" required>
                  ZIP code
                </Label>
                <Input
                  id="prevZip"
                  value={form.prevZip}
                  onChange={(e) => patch({ prevZip: e.target.value })}
                  className={errors.prevZip ? "border-red-400 ring-2 ring-red-100" : ""}
                />
                <FieldError msg={errors.prevZip} />
              </div>
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="prevLandlordName" enabled={showWizardField}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="prevLandlordName" optional>
                  Previous landlord name
                </Label>
                <Input id="prevLandlordName" value={form.prevLandlordName} onChange={(e) => patch({ prevLandlordName: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prevLandlordPhone" optional>
                  Previous landlord phone
                </Label>
                <Input
                  id="prevLandlordPhone"
                  type="tel"
                  value={form.prevLandlordPhone}
                  onChange={(e) => p.setPrevLandlordPhone(e.target.value)}
                  placeholder="(###) ###-####"
                  className={errors.prevLandlordPhone ? "border-red-400 ring-2 ring-red-100" : ""}
                />
                <FieldError msg={errors.prevLandlordPhone} />
              </div>
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="prevMoveIn" enabled={showWizardField}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="prevMoveIn" optional>
                  Move-in date
                </Label>
                <DateField id="prevMoveIn" value={form.prevMoveIn} onChange={(next) => patch({ prevMoveIn: next })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prevMoveOut" optional>
                  Move-out date
                </Label>
                <DateField id="prevMoveOut" value={form.prevMoveOut} onChange={(next) => patch({ prevMoveOut: next })} />
              </div>
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="prevReasonLeaving" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="prevReasonLeaving" optional>
                Reason for leaving
              </Label>
              <Textarea
                id="prevReasonLeaving"
                value={form.prevReasonLeaving}
                onChange={(e) => patch({ prevReasonLeaving: e.target.value })}
                rows={3}
              />
            </div>
            </WizardFieldGate>
          </>
        ) : null}

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 6) {
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>
            Income helps us confirm you can meet rent obligations when you are employed. Enter at least one positive amount
            in the income section below. If you are not employed, income is optional; use Other income for benefits or support
            if applicable, and explain gaps on the next screens if needed.
          </StepIntro>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border text-primary"
            checked={form.notEmployed}
            onChange={(e) => patch({ notEmployed: e.target.checked })}
          />
          <span className="text-sm font-medium text-foreground">I am not currently employed</span>
        </label>

        {errors._general ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errors._general}</p> : null}

        <div className={`space-y-5 rounded-2xl border border-border p-5 sm:p-6 ${form.notEmployed ? "opacity-50" : ""}`}>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Employment</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <WizardFieldGate fieldKey="employer" enabled={showWizardField}>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="employer" required={!form.notEmployed}>
                Employer
              </Label>
              <Input
                id="employer"
                value={form.employer}
                disabled={form.notEmployed}
                onChange={(e) => patch({ employer: e.target.value })}
                className={errors.employer ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.employer} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="employerAddress" optional>
                Employer address
              </Label>
              <Input id="employerAddress" value={form.employerAddress} disabled={form.notEmployed} onChange={(e) => patch({ employerAddress: e.target.value })} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="supervisorName" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="supervisorName" optional>
                Supervisor name
              </Label>
              <Input id="supervisorName" value={form.supervisorName} disabled={form.notEmployed} onChange={(e) => patch({ supervisorName: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="supervisorPhone" optional>
                Supervisor phone
              </Label>
              <Input
                id="supervisorPhone"
                type="tel"
                value={form.supervisorPhone}
                disabled={form.notEmployed}
                onChange={(e) => p.setSupervisorPhone(e.target.value)}
                placeholder="(###) ###-####"
                className={errors.supervisorPhone ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.supervisorPhone} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="jobTitle" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="jobTitle" optional>
                Job title
              </Label>
              <Input id="jobTitle" value={form.jobTitle} disabled={form.notEmployed} onChange={(e) => patch({ jobTitle: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="employmentStart" optional>
                Employment start date
              </Label>
              <DateField id="employmentStart" value={form.employmentStart} disabled={form.notEmployed} onChange={(next) => patch({ employmentStart: next })} />
            </div>
            </WizardFieldGate>
          </div>
        </div>

        {(showWizardField("monthlyIncome") || showWizardField("otherIncome")) ? (
        <div className="space-y-4 rounded-2xl border border-border p-5 sm:p-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Income</p>
            <StepIntro>
              If you are employed, provide at least one of the amounts below (you do not need to fill all three). If you
              checked &ldquo;not currently employed,&rdquo; all income fields are optional.
            </StepIntro>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <WizardFieldGate fieldKey="monthlyIncome" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="monthlyIncome">Monthly gross income</Label>
              <Input
                id="monthlyIncome"
                inputMode="decimal"
                value={form.monthlyIncome}
                onChange={(e) => patch({ monthlyIncome: e.target.value })}
                onBlur={() => patch({ monthlyIncome: formatMoneyBlur(form.monthlyIncome) })}
                placeholder="e.g. 4,200"
                className={errors.monthlyIncome ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.monthlyIncome} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="annualIncome" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="annualIncome">Annual gross income</Label>
              <Input
                id="annualIncome"
                inputMode="decimal"
                value={form.annualIncome}
                onChange={(e) => patch({ annualIncome: e.target.value })}
                onBlur={() => patch({ annualIncome: formatMoneyBlur(form.annualIncome) })}
                placeholder="e.g. 52,000"
                className={errors.annualIncome ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.annualIncome} />
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="otherIncome" enabled={showWizardField}>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="otherIncome">Other income</Label>
              <Input
                id="otherIncome"
                value={form.otherIncome}
                onChange={(e) => patch({ otherIncome: e.target.value })}
                onBlur={() => patch({ otherIncome: formatMoneyBlur(form.otherIncome) })}
                placeholder="Benefits, stipends, trust distributions…"
                className={errors.otherIncome ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.otherIncome} />
            </div>
            </WizardFieldGate>
          </div>
          <WizardFieldGate fieldKey="incomeProofPhotos" enabled={showWizardField}>
          <div className="space-y-3 border-t border-border pt-4 [html[data-theme=dark]_&]:border-white/12">
            <div>
              <Label>
                Proof of income
                <span className="pl-1 font-normal text-muted/70">(optional)</span>
              </Label>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Attach a recent pay stub, an offer letter, or a bank statement to back up the amounts above. Photos or
                PDFs are fine. These are shared only with the property manager for this application and are kept with
                your application record — stored privately, never public.
              </p>
            </div>
            <IncomeProofPhotos
              attachments={form.incomeProofPhotos}
              onChange={(next) => patch({ incomeProofPhotos: next })}
              getApplicationId={getApplicationId}
              setupTokenRequired={p.photoSetupTokenRequired}
              getSetupToken={p.getPhotoSetupToken}
              readOnly={photosReadOnly}
            />
          </div>
          </WizardFieldGate>
        </div>
        ) : null}

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 7) {
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>List people who can speak to your character or employment. Avoid family members when possible.</StepIntro>
        </div>
        <WizardFieldGate fieldKey="ref1Name" enabled={showWizardField}>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted/70">Reference 1</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ref1Name" required>
                Name
              </Label>
              <Input id="ref1Name" value={form.ref1Name} onChange={(e) => patch({ ref1Name: e.target.value })} className={errors.ref1Name ? "border-red-400 ring-2 ring-red-100" : ""} />
              <FieldError msg={errors.ref1Name} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ref1Relationship" required>
                Relationship
              </Label>
              <Input
                id="ref1Relationship"
                value={form.ref1Relationship}
                onChange={(e) => patch({ ref1Relationship: e.target.value })}
                placeholder="e.g. supervisor, colleague"
                className={errors.ref1Relationship ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.ref1Relationship} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="ref1Phone" required>
                Phone
              </Label>
              <Input
                id="ref1Phone"
                type="tel"
                value={form.ref1Phone}
                onChange={(e) => p.setRef1Phone(e.target.value)}
                placeholder="(###) ###-####"
                className={errors.ref1Phone ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.ref1Phone} />
            </div>
          </div>
        </div>
        </WizardFieldGate>
        <WizardFieldGate fieldKey="ref2Name" enabled={showWizardField}>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted/70">Reference 2</p>
          <p className="mt-1 text-xs text-muted">Optional. Leave blank if you only have one reference.</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ref2Name" optional>
                Name
              </Label>
              <Input id="ref2Name" value={form.ref2Name} onChange={(e) => patch({ ref2Name: e.target.value })} className={errors.ref2Name ? "border-red-400 ring-2 ring-red-100" : ""} />
              <FieldError msg={errors.ref2Name} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ref2Relationship" optional>
                Relationship
              </Label>
              <Input id="ref2Relationship" value={form.ref2Relationship} onChange={(e) => patch({ ref2Relationship: e.target.value })} className={errors.ref2Relationship ? "border-red-400 ring-2 ring-red-100" : ""} />
              <FieldError msg={errors.ref2Relationship} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="ref2Phone" optional>
                Phone
              </Label>
              <Input
                id="ref2Phone"
                type="tel"
                value={form.ref2Phone}
                onChange={(e) => p.setRef2Phone(e.target.value)}
                placeholder="(###) ###-####"
                className={errors.ref2Phone ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.ref2Phone} />
            </div>
          </div>
        </div>
        </WizardFieldGate>

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 8) {
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>
            These questions are standard for rental screening. Your answers are reviewed in context; answer honestly.
          </StepIntro>
        </div>
        <WizardFieldGate fieldKey="occupancyCount" enabled={showWizardField}>
        <div className="space-y-2">
          <Label htmlFor="occupancyCount" required>
            Number of occupants
          </Label>
          <Select
            id="occupancyCount"
            value={form.occupancyCount}
            onChange={(e) => patch({ occupancyCount: e.target.value })}
            className={errors.occupancyCount ? "border-red-400 ring-2 ring-red-100" : ""}
          >
            <option value="">Select</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </Select>
          {Number(form.occupancyCount) > 1 && (
            <p className="rounded-lg border px-3 py-2 text-xs leading-relaxed portal-banner-pending">
              <span className="font-semibold">Note:</span> More than 1 occupant may increase the total cost. Each additional occupant must submit their own application. Set up a group in step 1 and share your invite link so all applications stay linked.
            </p>
          )}
          <FieldError msg={errors.occupancyCount} />
        </div>
        </WizardFieldGate>
        <WizardFieldGate fieldKey="pets" enabled={showWizardField}>
        <div className="space-y-2">
          <Label htmlFor="pets" optional>
            Pets
          </Label>
          <Textarea id="pets" value={form.pets} onChange={(e) => patch({ pets: e.target.value })} placeholder="Type, breed, weight, or write “None”" rows={2} />
        </div>
        </WizardFieldGate>

        <WizardFieldGate fieldKey="evictionHistory" enabled={showWizardField}>
        <div className="space-y-3 rounded-xl border border-border bg-accent/30 p-4">
          <Label required>Eviction history</Label>
          <YesNoPills
            value={form.evictionHistory}
            error={errors.evictionHistory}
            name="Eviction history"
            fieldKey="evictionHistory"
            onChange={(v) => patch({ evictionHistory: v, evictionDetails: v === "no" ? "" : form.evictionDetails })}
          />
          {form.evictionHistory === "yes" ? (
            <div className="space-y-2">
              <Label htmlFor="evictionDetails">Brief details</Label>
              <Textarea
                id="evictionDetails"
                value={form.evictionDetails}
                onChange={(e) => patch({ evictionDetails: e.target.value })}
                rows={3}
                className={errors.evictionDetails ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.evictionDetails} />
            </div>
          ) : null}
        </div>
        </WizardFieldGate>
        <WizardFieldGate fieldKey="bankruptcyHistory" enabled={showWizardField}>
        <div className="space-y-3 rounded-xl border border-border bg-accent/30 p-4">
          <Label required>Bankruptcy history</Label>
          <YesNoPills
            value={form.bankruptcyHistory}
            error={errors.bankruptcyHistory}
            name="Bankruptcy history"
            fieldKey="bankruptcyHistory"
            onChange={(v) => patch({ bankruptcyHistory: v, bankruptcyDetails: v === "no" ? "" : form.bankruptcyDetails })}
          />
          {form.bankruptcyHistory === "yes" ? (
            <div className="space-y-2">
              <Label htmlFor="bankruptcyDetails">Brief details</Label>
              <Textarea
                id="bankruptcyDetails"
                value={form.bankruptcyDetails}
                onChange={(e) => patch({ bankruptcyDetails: e.target.value })}
                rows={3}
                className={errors.bankruptcyDetails ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.bankruptcyDetails} />
            </div>
          ) : null}
        </div>
        </WizardFieldGate>
        <WizardFieldGate fieldKey="criminalHistory" enabled={showWizardField}>
        <div className="space-y-3 rounded-xl border border-border bg-accent/30 p-4">
          <Label required>Criminal history</Label>
          <YesNoPills
            value={form.criminalHistory}
            error={errors.criminalHistory}
            name="Criminal history"
            fieldKey="criminalHistory"
            onChange={(v) => patch({ criminalHistory: v, criminalDetails: v === "no" ? "" : form.criminalDetails })}
          />
          {form.criminalHistory === "yes" ? (
            <div className="space-y-2">
              <Label htmlFor="criminalDetails">Brief details</Label>
              <Textarea
                id="criminalDetails"
                value={form.criminalDetails}
                onChange={(e) => patch({ criminalDetails: e.target.value })}
                rows={3}
                className={errors.criminalDetails ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.criminalDetails} />
            </div>
          ) : null}
        </div>
        </WizardFieldGate>

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 9) {
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>Review the authorizations below. Your typed name carries the same effect as a handwritten signature.</StepIntro>
        </div>
        <div className="rounded-2xl border border-border bg-accent/30 p-5 text-sm leading-relaxed text-foreground">
          <p>
            By submitting this application, you authorize the property manager to obtain consumer reports (including credit and
            criminal history) and to verify employment, income, and rental history. If your manager has automatic screening
            enabled, a report may be ordered when you submit. You understand that false or incomplete information may result in
            denial or termination of a lease.
          </p>
        </div>
        <WizardFieldGate fieldKey="consentCredit" enabled={showWizardField}>
        <label
          data-wizard-field="consentCredit"
          className={`flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 ${errors.consentCredit ? "border-red-300 bg-red-50/50 ring-2 ring-red-100" : "border-border"}`}
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border text-primary"
            checked={form.consentCredit}
            onChange={(e) => patch({ consentCredit: e.target.checked })}
          />
          <span className="text-sm font-medium text-foreground">I authorize a credit and background check.</span>
        </label>
        <FieldError msg={errors.consentCredit} />
        </WizardFieldGate>
        <WizardFieldGate fieldKey="consentTruth" enabled={showWizardField}>
        <label
          data-wizard-field="consentTruth"
          className={`flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 ${errors.consentTruth ? "border-red-300 bg-red-50/50 ring-2 ring-red-100" : "border-border"}`}
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border text-primary"
            checked={form.consentTruth}
            onChange={(e) => patch({ consentTruth: e.target.checked })}
          />
          <span className="text-sm font-medium text-foreground">I confirm the information provided is true and complete.</span>
        </label>
        <FieldError msg={errors.consentTruth} />
        </WizardFieldGate>
        <WizardFieldGate fieldKey="digitalSignature" enabled={showWizardField}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2" data-wizard-field="digitalSignature">
            <Label htmlFor="digitalSignature" required>
              Digital signature (type your full legal name)
            </Label>
            <Input
              id="digitalSignature"
              value={form.digitalSignature}
              onChange={(e) => patch({ digitalSignature: e.target.value })}
              className={errors.digitalSignature ? "border-red-400 ring-2 ring-red-100" : ""}
            />
            <FieldError msg={errors.digitalSignature} />
          </div>
          <div className="space-y-2" data-wizard-field="dateSigned">
            <Label htmlFor="dateSigned" required>
              Date signed
            </Label>
            <DateField id="dateSigned" value={form.dateSigned} onChange={(next) => patch({ dateSigned: next })} className={errors.dateSigned ? "border-red-400 ring-2 ring-red-100" : ""} />
            <FieldError msg={errors.dateSigned} />
          </div>
        </div>
        </WizardFieldGate>

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 10) {
    const prop = getPropertyById(form.propertyId);
    const roomLabel = (id: string) => getRoomChoiceLabel(id);
    const reviewByRoom = isPropertyRentedByRoom(form.propertyId);
    const reviewBundleLabel = form.bundleId.trim()
      ? getBundleChoiceLabel(form.propertyId, form.bundleId, { rentalType: form.rentalType })
      : "";
    // Only review the sections this form actually asks. The short-term form
    // skips the screening sections, so the summary (and its "Edit" links) must
    // not reference steps the applicant never walked through.
    const activeStepSet = new Set(
      activeApplicationWizardSteps(applicationConfig, normalizeCustomApplicationFields),
    );
    const showCosignerReview = showWizardField("hasCosigner");
    const showGroupReview = showWizardField("applyingAsGroup");
    const showHouseholdReview = showCosignerReview || showGroupReview;
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>Confirm everything below, then continue to the application fee step.</StepIntro>
        </div>
        <div className="space-y-4">
          {showHouseholdReview ? (
            <ReviewSection title="Household application" stepTarget={1} onEdit={editFromReview}>
              {showGroupReview ? (
                <>
                  <ReviewRow k="Applying as group" v={form.applyingAsGroup === "yes" ? "Yes" : form.applyingAsGroup === "no" ? "No" : "—"} />
                  {form.applyingAsGroup === "yes" && form.groupLeaderAppId.trim() ? (
                    <ReviewRow k="Organizer application ID" v={displayOrDash(form.groupLeaderAppId)} />
                  ) : null}
                </>
              ) : null}
              {showCosignerReview ? (
                <ReviewRow k="Co-signer planned" v={form.hasCosigner === "yes" ? "Yes" : form.hasCosigner === "no" ? "No" : "—"} />
              ) : null}
            </ReviewSection>
          ) : null}
          {activeStepSet.has(3) ? (
          <ReviewSection title="Property information" stepTarget={3} onEdit={editFromReview}>
            <ReviewRow k="Property" v={displayOrDash(prop?.title)} />
            {reviewBundleLabel ? (
              <ReviewRow k="Lease bundle" v={reviewBundleLabel} />
            ) : reviewByRoom ? (
              <>
                <ReviewRow k="1st choice room" v={displayOrDash(roomLabel(form.roomChoice1))} />
                <ReviewRow k="2nd choice room" v={displayOrDash(roomLabel(form.roomChoice2))} />
                <ReviewRow k="3rd choice room" v={displayOrDash(roomLabel(form.roomChoice3))} />
              </>
            ) : (
              <ReviewRow k="Unit" v={displayOrDash(roomLabel(form.roomChoice1))} />
            )}
            <ReviewRow k="Lease term" v={displayOrDash(form.leaseTerm)} />
            <ReviewRow k={form.rentalType === "short_term" ? "Check-in date" : "Lease start"} v={displayOrDash(form.leaseStart)} />
            {form.leaseTerm !== "Month-to-Month" ? <ReviewRow k={form.rentalType === "short_term" ? "Check-out date" : "Lease end"} v={displayOrDash(form.leaseEnd)} /> : null}
            {form.rentalType === "short_term" ? (
              <>
                <ReviewRow k="Check-in time" v={displayOrDash(form.shortTermCheckInTime)} />
                <ReviewRow k="Check-out time" v={displayOrDash(form.shortTermCheckOutTime)} />
                <ReviewRow k="House rules" v={form.shortTermRulesAck ? "Acknowledged" : "—"} />
              </>
            ) : null}
          </ReviewSection>
          ) : null}
          {prop?.listingSubmission?.v === 1 ? (
            activeStepSet.has(3) ? (
            <ReviewSection title="Housing charges (this listing)" stepTarget={3} onEdit={editFromReview}>
              <ReviewRow
                k="Application fee"
                v={
                  <>
                    <span>{applicationFeeChargeLabel(applicationFeeGate)}</span>
                    {applicationFeeReviewNote(applicationFeeGate, Boolean(form.applicationFeeWaived)) ? (
                      <span className="mt-0.5 block text-xs text-muted">
                        {applicationFeeReviewNote(applicationFeeGate, Boolean(form.applicationFeeWaived))}
                      </span>
                    ) : null}
                  </>
                }
              />
              <ReviewRow k="Security deposit" v={displayOrDash(prop.listingSubmission.securityDeposit)} />
              <ReviewRow k="Move-in fee" v={displayOrDash(prop.listingSubmission.moveInFee)} />
              <ReviewRow k="Payment due at signing" v={displayOrDash(paymentAtSigningPriceLabel(prop.listingSubmission))} />
              <ReviewRow k="Utilities (estimate, by room)" v={displayOrDash(utilitiesListingEstimateLabel(prop.listingSubmission))} />
            </ReviewSection>
            ) : null
          ) : activeStepSet.has(3) ? (
            <ReviewSection title="Housing charges" stepTarget={3} onEdit={editFromReview}>
              <ReviewRow
                k="Listing fees"
                v="This property has not published detailed fee lines yet. Confirm dollar amounts with the property manager before you pay or sign."
              />
            </ReviewSection>
          ) : null}
          {activeStepSet.has(2) ? (
          <ReviewSection title="Signer information" stepTarget={2} onEdit={editFromReview}>
            {showWizardField("fullLegalName") ? <ReviewRow k="Legal name" v={displayOrDash(form.fullLegalName)} /> : null}
            {showWizardField("phone") ? <ReviewRow k="Phone" v={displayOrDash(form.phone)} /> : null}
            {showWizardField("email") ? <ReviewRow k="Email" v={displayOrDash(form.email)} /> : null}
            {showWizardField("dateOfBirth") ? <ReviewRow k="Date of birth" v={displayOrDash(form.dateOfBirth)} /> : null}
            {showWizardField("ssn") ? <ReviewRow k="SSN" v={maskSsnReview(form.ssn)} /> : null}
            {showWizardField("driversLicense") ? <ReviewRow k="ID number" v={displayOrDash(form.driversLicense)} /> : null}
          </ReviewSection>
          ) : null}
          {activeStepSet.has(4) || activeStepSet.has(5) ? (
          <ReviewSection title="Address history" stepTarget={4} onEdit={editFromReview}>
            <ReviewRow
              k="Current address"
              v={displayOrDash(
                [form.currentStreet, [form.currentCity, form.currentState, form.currentZip].filter(Boolean).join(" ")]
                  .filter(Boolean)
                  .join(", "),
              )}
            />
            <ReviewRow
              k="Landlord (current)"
              v={displayOrDash([form.currentLandlordName, form.currentLandlordPhone].filter(Boolean).join(" · "))}
            />
            <ReviewRow
              k="Move-in / move-out (current)"
              v={displayOrDash([form.currentMoveIn, form.currentMoveOut].filter(Boolean).join(" → "))}
            />
            <ReviewRow k="Reason for leaving (current)" v={displayOrDash(form.currentReasonLeaving)} />
            {form.noPreviousAddress ? (
              <ReviewRow k="Previous address" v="Not provided (none reported)" />
            ) : (
              <>
                <ReviewRow
                  k="Previous address"
                  v={displayOrDash(
                    [form.prevStreet, [form.prevCity, form.prevState, form.prevZip].filter(Boolean).join(" ")]
                      .filter(Boolean)
                      .join(", "),
                  )}
                />
                <ReviewRow
                  k="Landlord (previous)"
                  v={displayOrDash([form.prevLandlordName, form.prevLandlordPhone].filter(Boolean).join(" · "))}
                />
                <ReviewRow
                  k="Move-in / move-out (previous)"
                  v={displayOrDash([form.prevMoveIn, form.prevMoveOut].filter(Boolean).join(" → "))}
                />
                <ReviewRow k="Reason for leaving (previous)" v={displayOrDash(form.prevReasonLeaving)} />
              </>
            )}
          </ReviewSection>
          ) : null}
          {activeStepSet.has(6) ? (
          <ReviewSection title="Employment and income" stepTarget={6} onEdit={editFromReview}>
            <ReviewRow k="Not employed" v={form.notEmployed ? "Yes" : "No"} />
            <ReviewRow k="Employer" v={displayOrDash(form.employer)} />
            <ReviewRow k="Employer address" v={displayOrDash(form.employerAddress)} />
            <ReviewRow k="Supervisor" v={displayOrDash([form.supervisorName, form.supervisorPhone].filter(Boolean).join(" · "))} />
            <ReviewRow k="Job title" v={displayOrDash(form.jobTitle)} />
            <ReviewRow k="Employment start" v={displayOrDash(form.employmentStart)} />
            <ReviewRow k="Monthly income" v={displayOrDash(form.monthlyIncome)} />
            <ReviewRow k="Annual income" v={displayOrDash(form.annualIncome)} />
            <ReviewRow k="Other income" v={displayOrDash(form.otherIncome)} />
          </ReviewSection>
          ) : null}
          {activeStepSet.has(7) ? (
          <ReviewSection title="References" stepTarget={7} onEdit={editFromReview}>
            <ReviewRow k="Reference 1" v={displayOrDash(`${form.ref1Name} · ${form.ref1Relationship} · ${form.ref1Phone}`)} />
            <ReviewRow k="Reference 2" v={form.ref2Name.trim() ? displayOrDash(`${form.ref2Name} · ${form.ref2Relationship} · ${form.ref2Phone}`) : displayOrDash("")} />
          </ReviewSection>
          ) : null}
          {activeStepSet.has(8) ? (
          <ReviewSection title="Additional details" stepTarget={8} onEdit={editFromReview}>
            <ReviewRow k="Occupants" v={displayOrDash(form.occupancyCount)} />
            <ReviewRow k="Pets" v={displayOrDash(form.pets)} />
            <ReviewRow k="Eviction" v={form.evictionHistory === "yes" ? `Yes: ${form.evictionDetails}` : form.evictionHistory === "no" ? "No" : "—"} />
            <ReviewRow k="Bankruptcy" v={form.bankruptcyHistory === "yes" ? `Yes: ${form.bankruptcyDetails}` : form.bankruptcyHistory === "no" ? "No" : "—"} />
            <ReviewRow k="Criminal history" v={form.criminalHistory === "yes" ? `Yes: ${form.criminalDetails}` : form.criminalHistory === "no" ? "No" : "—"} />
          </ReviewSection>
          ) : null}
          {displayableCustomFieldAnswers(form.customFieldAnswers).length > 0 ? (
            <ReviewSection title="Manager questions" stepTarget={8} onEdit={editFromReview}>
              {displayableCustomFieldAnswers(form.customFieldAnswers).map((answer) => (
                <ReviewRow key={answer.key} k={answer.label} v={displayOrDash(formatCustomFieldAnswerDisplay(answer))} />
              ))}
            </ReviewSection>
          ) : null}
          {activeStepSet.has(9) ? (
          <ReviewSection title="Consent and signature" stepTarget={9} onEdit={editFromReview}>
            {showWizardField("consentCredit") ? (
              <ReviewRow k="Credit / background" v={form.consentCredit ? "Authorized" : "Not checked"} />
            ) : null}
            <ReviewRow k="Accuracy confirmed" v={form.consentTruth ? "Yes" : "Not checked"} />
            <ReviewRow k="Signature" v={displayOrDash(form.digitalSignature)} />
            <ReviewRow k="Date signed" v={displayOrDash(form.dateSigned)} />
          </ReviewSection>
          ) : null}
        </div>
        <p className="text-center text-xs text-muted">Next: application fee confirmation before final submit.</p>
      </div>
    );
  }

  if (step === 11) {
    const prop = form.propertyId ? getPropertyById(form.propertyId) : undefined;
    const sub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
    const channels = listingApplicationFeeChannels(sub);
    const payChannel = resolveApplicationFeePayChannel(sub, form.applicationFeePayChannel);
    // Headline application fee for the summary card, from the gate — which the
    // wizard derives from the SERVER's authoritative fee preview (manager-level
    // setting), never from the listing's grandfathered `applicationFee` text.
    // Any plan-based service fee (card channel only) is itemized inside the
    // inline payment form, so the exact amount charged is always disclosed
    // before the applicant pays — never a surprise here.
    const appFeeLabel = applicationFeeGate.needsFee ? applicationFeeGate.displayLabel : "—";
    const codeWaived = Boolean(form.applicationFeeWaived);
    const managerUserIdForPay = prop?.managerUserId?.trim() ?? "";
    const enabledChannels = [
      channels.ach ? ("ach" as const) : null,
      channels.zelle ? ("zelle" as const) : null,
      channels.venmo ? ("venmo" as const) : null,
      channels.other ? ("other" as const) : null,
    ].filter((channel): channel is "ach" | "zelle" | "venmo" | "other" => Boolean(channel));
    const feeStillDue = applicationFeeGate.needsFee && !applicationFeeGate.paid;
    const showChannelPick = feeStillDue && enabledChannels.length > 1;
    const showZelleInstructions = feeStillDue && payChannel === "zelle" && sub?.zelleContact?.trim();
    const showVenmoInstructions = feeStillDue && payChannel === "venmo" && sub?.venmoContact?.trim();
    const showOtherInstructions = feeStillDue && payChannel === "other" && sub?.applicationFeeOtherInstructions?.trim();
    const singleChannelLabel =
      enabledChannels.length === 1
        ? enabledChannels[0] === "ach"
          ? "Card or Apple Pay"
          : enabledChannels[0] === "zelle"
            ? "Zelle"
            : enabledChannels[0] === "venmo"
              ? "Venmo"
              : "Other"
        : null;
    return (
      <div className="space-y-6">
        <div>
          <StepIntro>
            The application fee is the only payment collected here — any deposit is billed later, under Payments, after
            you&apos;re approved.
          </StepIntro>
        </div>

        {applicationFeeGate.needsFee ? (
          <div className="rounded-2xl border border-border bg-accent/30 p-5 sm:p-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Application fee</p>
            <p className="mt-2 text-3xl font-bold tabular-nums text-foreground">{appFeeLabel}</p>
            {!applicationFeeGate.paid ? (
              <p className="mt-1 text-xs text-muted">The exact total is itemized before you pay.</p>
            ) : null}
            {applicationFeeGate.paid ? (
              <p className="mt-3 rounded-xl border px-4 py-3 text-sm font-medium portal-banner-success">
                Paid
              </p>
            ) : null}
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-accent/30 px-4 py-3 text-sm text-foreground">
            {applicationFeeWaiverExplanation(applicationFeeGate, codeWaived)}
          </div>
        )}

        {/* Fee waiver code — optional; quieter than amount, after fee display. */}
        {!applicationFeeGate.paid ? (
          <div className="space-y-2 rounded-2xl border border-border bg-card p-4" data-attr="application-fee-waiver-section">
            <p className="text-sm font-semibold text-foreground">Fee waiver code <span className="font-normal text-muted">(optional)</span></p>
            {codeWaived ? (
              <p className="rounded-xl border px-4 py-3 text-sm font-medium portal-banner-success" data-attr="application-fee-waiver-applied">
                Waiver applied — no application fee is due.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted">
                  Have a code from the property manager? Enter it to waive the application fee.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={form.applicationFeeWaiverCode}
                    onChange={(e) => patch({ applicationFeeWaiverCode: e.target.value })}
                    placeholder="Enter code"
                    data-attr="application-fee-waiver-code-input"
                    className="sm:max-w-[220px]"
                    disabled={waiverCodeBusy}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="px-4 text-[13px]"
                    disabled={waiverCodeBusy || !form.applicationFeeWaiverCode.trim()}
                    data-attr="application-fee-waiver-code-apply"
                    onClick={() => onApplyWaiverCode?.()}
                  >
                    {waiverCodeBusy ? "Applying…" : "Apply code"}
                  </Button>
                </div>
                {waiverCodeError ? <p className="text-xs font-medium text-red-600">{waiverCodeError}</p> : null}
              </>
            )}
          </div>
        ) : null}
        {showChannelPick ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-5">
            <p className="text-sm font-semibold text-foreground">Payment method</p>
            {channels.ach ? (
              <label className="flex cursor-pointer gap-3 rounded-xl border border-border bg-accent/30 p-3">
                <input
                  type="radio"
                  name="application-fee-channel"
                  className="mt-1 h-4 w-4 shrink-0 border-border text-primary"
                  checked={payChannel === "ach"}
                  onChange={() => patch({ applicationFeePayChannel: "ach", applicationFeeZelleSentConfirmed: false })}
                />
                <span>
                  <span className="text-sm font-semibold text-foreground">Card or Apple Pay</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                    Pay instantly with Apple Pay, Google Pay, or any debit/credit card. No added fees — PropLane covers payment processing.
                  </span>
                </span>
              </label>
            ) : null}
            {channels.zelle ? (
              <label className="flex cursor-pointer gap-3 rounded-xl border border-border bg-accent/30 p-3">
                <input
                  type="radio"
                  name="application-fee-channel"
                  className="mt-1 h-4 w-4 shrink-0 border-border text-primary"
                  checked={form.applicationFeePayChannel === "zelle"}
                  onChange={() => patch({ applicationFeePayChannel: "zelle", applicationFeeZelleSentConfirmed: false })}
                />
                <span>
                  <span className="text-sm font-semibold text-foreground">Zelle</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                    Submit now and manager sees the fee as pending.
                  </span>
                </span>
              </label>
            ) : null}
            {channels.venmo ? (
              <label className="flex cursor-pointer gap-3 rounded-xl border border-border bg-accent/30 p-3">
                <input
                  type="radio"
                  name="application-fee-channel"
                  className="mt-1 h-4 w-4 shrink-0 border-border text-primary"
                  checked={form.applicationFeePayChannel === "venmo"}
                  onChange={() => patch({ applicationFeePayChannel: "venmo", applicationFeeZelleSentConfirmed: false })}
                />
                <span>
                  <span className="text-sm font-semibold text-foreground">Venmo</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                    Submit now and manager sees the fee as pending.
                  </span>
                </span>
              </label>
            ) : null}
            {channels.other ? (
              <label className="flex cursor-pointer gap-3 rounded-xl border border-border bg-accent/30 p-3">
                <input
                  type="radio"
                  name="application-fee-channel"
                  className="mt-1 h-4 w-4 shrink-0 border-border text-primary"
                  checked={form.applicationFeePayChannel === "other"}
                  onChange={() => patch({ applicationFeePayChannel: "other", applicationFeeZelleSentConfirmed: false })}
                />
                <span>
                  <span className="text-sm font-semibold text-foreground">Other</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                    Follow the manager&apos;s instructions to pay the fee.
                  </span>
                </span>
              </label>
            ) : null}
          </div>
        ) : null}
        {feeStillDue && singleChannelLabel ? (
          <div className="rounded-2xl border border-border bg-card px-4 py-4 text-sm text-foreground">
            <span className="font-semibold text-foreground">Payment method:</span> {singleChannelLabel}
          </div>
        ) : null}
        {feeStillDue && isAchApplicationFeeChannel(payChannel) ? (
          applicationFeeGate.pending ? (
            <div className="flex min-h-[80px] items-center justify-center rounded-2xl border border-border bg-card text-sm text-muted">
              Confirming the application fee…
            </div>
          ) : mode !== "editor" && form.propertyId && form.email.includes("@") && managerUserIdForPay ? (
            // Inline (embedded) card payment for BOTH apply surfaces (public
            // and portal) — the applicant pays without leaving the
            // application. The `editor` surface (reviewing an already-submitted
            // application) must never mint a payment. On completion Stripe
            // returns the applicant here and the fee is verified server-side;
            // an abandoned/failed payment keeps them on this step with their
            // answers intact.
            <ApplicationFeeInlinePayment
              propertyId={form.propertyId}
              residentEmail={form.email.trim()}
              residentName={form.fullLegalName.trim() || undefined}
              managerUserId={managerUserIdForPay}
              rentalType={form.rentalType}
              returnPath={applyReturnPath ?? "/rent/apply"}
            />
          ) : (
            <div className="rounded-2xl border px-4 py-4 text-sm portal-banner-info">
              Pay securely with Apple Pay, Google Pay, or card. Your application submits as soon as the payment is
              confirmed.
            </div>
          )
        ) : null}
        {feeStillDue && !isAchApplicationFeeChannel(payChannel) ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5" data-attr="application-fee-manual-pay">
            {showZelleInstructions ? (
              <div className="rounded-xl border px-4 py-3 text-sm portal-banner-success">
                <p className="font-semibold">Send by Zelle</p>
                <p className="mt-2 rounded-lg border border-emerald-300/80 bg-card px-3 py-2 font-mono text-base font-bold tracking-tight">
                  {sub!.zelleContact!.trim()}
                </p>
                <p className="mt-2 leading-relaxed">
                  Send the amount due above, then tap <span className="font-semibold">Check payment</span> below.
                </p>
              </div>
            ) : null}
            {showVenmoInstructions ? (
              <div className="rounded-xl border px-4 py-3 text-sm portal-banner-info">
                <p className="font-semibold">Send by Venmo</p>
                <p className="mt-2 rounded-lg border border-sky-300/80 bg-card px-3 py-2 font-mono text-base font-bold tracking-tight">
                  {sub!.venmoContact!.trim()}
                </p>
                <p className="mt-2 leading-relaxed">
                  Send the amount due above, then tap <span className="font-semibold">Check payment</span> below.
                </p>
              </div>
            ) : null}
            {showOtherInstructions ? (
              <div className="rounded-xl border px-4 py-3 text-sm portal-banner-pending">
                <p className="font-semibold">Payment instructions</p>
                <p className="mt-2 whitespace-pre-wrap leading-relaxed">{sub!.applicationFeeOtherInstructions!.trim()}</p>
                <p className="mt-2 leading-relaxed">
                  Follow the instructions above, then tap <span className="font-semibold">Check payment</span> below.
                </p>
              </div>
            ) : null}
            {applicationFeePaymentVerified ? (
              <p className="text-sm font-medium text-[var(--status-confirmed-fg)]">Payment verified.</p>
            ) : applicationFeeCheckError ? (
              <p className="text-sm text-red-600">{applicationFeeCheckError}</p>
            ) : (
              <p className="text-sm text-muted">
                After you send payment, check that we received it before submitting your application.
              </p>
            )}
            <Button
              type="button"
              variant="primary"
              className="w-full rounded-full sm:w-auto"
              disabled={applicationFeeCheckBusy || applicationFeeGate.paid}
              data-attr="application-fee-check-payment"
              onClick={() => onCheckApplicationFeePayment?.()}
            >
              {applicationFeeCheckBusy ? "Checking…" : applicationFeeGate.paid ? "Payment received" : "Check payment"}
            </Button>
          </div>
        ) : null}
        <FieldError msg={errors.applicationFeeZelleSentConfirmed} />
      </div>
    );
  }

  return null;
}
