"use client";

import { applicationRentalTypeFor } from "@/lib/rental-application/lease-terms";
import { Children, isValidElement, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { DateField } from "@/components/ui/date-field";
import { PropertySearchPicker } from "@/components/marketing/property-search-picker";
import { CosignerInviteCallout } from "@/components/marketing/cosigner-invite-callout";
import { GroupInviteCallout } from "@/components/marketing/group-invite-callout";
import { GroupLeaderAppIdField } from "@/components/marketing/group-leader-app-id-field";
import { ApplicationFeeInlinePayment } from "@/components/marketing/application-fee-inline-payment";
import { ApplicationPhotoField, IncomeProofPhotos } from "@/components/marketing/application-photo-field";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import { SmsConsentCheckbox } from "@/components/marketing/sms-consent-checkbox";
import {
  applicationFeeChargeLabel,
  applicationFeeReviewNote,
  applicationFeeWaiverExplanation,
} from "@/lib/rental-application/application-fee-display";
import { ApplyFieldRow } from "@/app/(public)/rent/apply/apply-field-row";
import {
  LEASE_TERM_CHOICES,
  SHORT_TERM_LEASE_TERM,
  firstChoiceRoomOptions,
  firstChoiceSelectionPatch,
  getBundleChoiceLabel,
  getBundleOptionsForProperty,
  getPropertyById,
  getRoomChoiceLabel,
  isEntireHomeProperty,
  isPropertyRentedByRoom,
  isRoomApprovedConflict,
  isRoomPendingConflict,
  listingLongTermLengths,
  listingOfferedLeaseTerms,
  roomSelectOptionsWithNone,
} from "@/lib/rental-application/data";
import { addMonthsToDateString, longTermLengthFor } from "@/lib/rental-application/long-term-length";
import { LONG_TERM_LEASE_TERM, sortLeaseTermsCanonical } from "@/lib/rental-application/lease-terms";
import {
  applicantListingQuote,
  formatQuoteMoney,
  paymentAtSigningPriceLabel,
  utilitiesListingEstimateLabel,
} from "@/lib/rental-application/listing-fees-display";
import type { ListingQuote } from "@/lib/listing-quote";
import type { RentalWizardErrors, RentalWizardFormState } from "@/lib/rental-application/types";
import { makeApplicationGroupId } from "@/lib/rental-application/application-groups";
import { digitsOnly, formatMoneyBlur } from "@/lib/rental-application/masks";
import {
  customFieldAnswerValue,
  customFieldErrorKey,
  customFieldsForWizardStep,
  formatCustomFieldAnswerDisplay,
  groupCustomFieldAnswersBySection,
  isCustomFieldHiddenByCondition,
  listingCustomApplicationFields,
  upsertCustomFieldAnswer,
} from "@/lib/rental-application/custom-fields";
import { normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";
import { applicationWizardStepForSection, RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";
import { Label, FieldError, YesNoPills } from "@/components/rental-application/form-field-controls";
import { CustomQuestionField } from "@/components/rental-application/custom-question-field";
import {
  activeApplicationWizardSteps,
  applicationFieldCatalogDef,
  isWizardFormFieldEnabled,
  resolveListingApplicationFields,
  type ApplicationConfigSlice,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";

/**
 * Every step a custom question's section can be asked on, taken from the section
 * catalog rather than typed out — a new section opens its own step here, and its
 * step body renders `stepManagerQuestions` like the other nine.
 */
const CUSTOM_QUESTION_WIZARD_STEPS = new Set(
  RENTAL_APPLICATION_SECTIONS.map((section) => section.wizardStep),
);

const groupRoleStack = "flex flex-col gap-2 sm:flex-row sm:items-stretch";
const choiceActive =
  "w-full rounded-xl border border-primary bg-primary/12 px-4 py-3.5 text-left text-sm font-semibold leading-snug text-foreground transition sm:flex-1 sm:py-2.5 sm:text-center [html[data-theme=dark]_&]:border-primary/70 [html[data-theme=dark]_&]:bg-primary/22 [html[data-theme=dark]_&]:text-white";
const choiceIdle =
  "w-full rounded-xl border border-border bg-card/80 px-4 py-3.5 text-left text-sm font-semibold leading-snug text-foreground transition hover:border-primary/35 hover:bg-accent/25 sm:flex-1 sm:py-2.5 sm:text-center [html[data-theme=dark]_&]:border-white/14 [html[data-theme=dark]_&]:bg-white/5 [html[data-theme=dark]_&]:text-white/82 [html[data-theme=dark]_&]:hover:border-primary/45 [html[data-theme=dark]_&]:hover:bg-white/8";

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

/** Reorder complete typed controls, then insert custom questions at their saved positions. */
function OrderedConfiguredQuestions({
  fields,
  children,
  renderCustom,
}: {
  fields: ResolvedApplicationField[];
  children: ReactNode;
  renderCustom: (field: ResolvedApplicationField) => ReactNode;
}) {
  const controls = new Map<string, ReactNode>();
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ fieldKey?: string }>(child) || typeof child.props.fieldKey !== "string") continue;
    controls.set(child.props.fieldKey, child);
  }
  return <>{fields.map((field) => {
    if (!field.isStandard) return renderCustom(field);
    const key = applicationFieldCatalogDef(field.standardKey!)?.wizardFormKeys[0];
    const control = key ? controls.get(key) : null;
    return control ? <div key={field.id} data-application-question-id={field.id}>{control}</div> : null;
  })}</>;
}

function StepIntro({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-sm leading-relaxed text-muted ${className}`}>{children}</p>;
}

export type WizardStepsProps = {
  step: number;
  form: RentalWizardFormState;
  errors: RentalWizardErrors;
  /** Unsaved manager preview; live applicants always resolve their pinned published version. */
  applicationConfigOverride?: ApplicationConfigSlice;
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
    listingUnavailable?: boolean;
    feePreviewFailed?: boolean;
  };
  /** Manager id resolved from the server fee preview when the browser catalog missed it. */
  resolvedManagerUserId?: string;
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
  /** Prior submitted application answers are available to copy into this form. */
  savedAutofillAvailable?: boolean;
  onApplySavedAutofill?: () => void;
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

function ApplicantPaysCard({ quote }: { quote: ListingQuote }) {
  const monthlyBreakdown = [
    quote.monthlyRent > 0 ? `rent ${formatQuoteMoney(quote.monthlyRent)}` : "",
    quote.monthlyUtilities > 0 ? `utilities ${formatQuoteMoney(quote.monthlyUtilities)}` : "",
    ...quote.monthlyFees.map((f) =>
      f.cadence === "weekly"
        ? `${f.label.toLowerCase()} ${formatQuoteMoney(f.amount)}/wk`
        : f.cadence === "daily"
          ? `${f.label.toLowerCase()} ${formatQuoteMoney(f.amount)}/day`
          : `${f.label.toLowerCase()} ${formatQuoteMoney(f.amount)}`,
    ),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <aside className="rounded-2xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">What a resident pays</h3>
      <p className="pt-3 text-[12px] font-extrabold uppercase tracking-[0.04em] text-foreground">Due at signing</p>
      {quote.signingLines.map((line) => (
        <div key={line.key} className="flex items-baseline justify-between gap-3 pt-2">
          <span className={line.dueAtSigning ? "text-[13px] text-foreground" : "text-[13px] text-muted"}>
            {line.label}
          </span>
          <b className="shrink-0 text-[13px] font-extrabold tabular-nums text-foreground">
            {formatQuoteMoney(line.amount)}
          </b>
        </div>
      ))}
      <div className="flex items-baseline justify-between pt-3">
        <span className="text-[13px] text-foreground">Total at signing</span>
        <b className="text-[24px] font-extrabold tabular-nums tracking-tight text-foreground">
          {formatQuoteMoney(quote.signingTotal)}
        </b>
      </div>
      {quote.isStay ? (
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-accent/50 p-2.5">
          <span className="text-[13px] font-semibold text-foreground">Stay rate</span>
          <b className="text-[15px] font-extrabold tabular-nums text-foreground">
            {quote.nightlyRate ? `${formatQuoteMoney(quote.nightlyRate)}/night` : "Not set"}
          </b>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl bg-accent/50 p-2.5">
          <span className="min-w-0">
            <b className="block text-[13px] font-semibold text-foreground">Then each month</b>
            {monthlyBreakdown ? <span className="text-[11.5px] text-muted">{monthlyBreakdown}</span> : null}
          </span>
          <b className="shrink-0 text-[15px] font-extrabold tabular-nums text-foreground">
            {formatQuoteMoney(quote.monthlyTotal)}
          </b>
        </div>
      )}
      {quote.applicationFees.length > 0 ? (
        <>
          <p className="mt-3 text-[12px] font-extrabold uppercase tracking-[0.04em] text-foreground">Application fee</p>
          {quote.applicationFees.map((fee) => (
            <div key={fee.id} className="flex items-baseline justify-between gap-3 pt-2">
              <span className="text-[13px] text-foreground">{fee.label}</span>
              <b className="shrink-0 text-[13px] font-extrabold tabular-nums text-foreground">
                {formatQuoteMoney(fee.amount)}
              </b>
            </div>
          ))}
        </>
      ) : null}
    </aside>
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
    waiverCodeBusy,
    waiverCodeError,
    onApplyWaiverCode,
    applyReturnPath,
    resolvedManagerUserId = "",
    onEnsureApplicationId,
    savedApplicationId = "",
    savedAutofillAvailable = false,
    onApplySavedAutofill,
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
  const applicationConfig = p.applicationConfigOverride ?? applicationConfigForApplicant(
    listingSub,
    applicationRentalTypeFor(form.rentalType),
    form.applicationTemplateId,
    form.applicationTemplateVersion,
  ).config;
  const showWizardField = (key: string) => isWizardFormFieldEnabled(applicationConfig, key);
  const resolvedQuestions = resolveListingApplicationFields(applicationConfig, normalizeCustomApplicationFields);
  const sectionQuestions = (section: ResolvedApplicationField["section"]) => resolvedQuestions.filter((field) => field.section === section);
  const standardQuestion = (section: ResolvedApplicationField["section"], firstKey: string) =>
    sectionQuestions(section).find((field) => field.isStandard && applicationFieldCatalogDef(field.standardKey!)?.wizardFormKeys[0] === firstKey);
  const renderCustomQuestion = (field: ResolvedApplicationField) => (
    <div key={field.id} data-application-question-id={field.id}>
      <CustomQuestionField field={field} value={customFieldAnswerValue(form.customFieldAnswers, field.key)}
        error={errors[customFieldErrorKey(field.key)]}
        onChange={(next) => patch({ customFieldAnswers: upsertCustomFieldAnswer(form.customFieldAnswers, field, next) })}
        getApplicationId={getApplicationId} setupTokenRequired={p.photoSetupTokenRequired}
        getSetupToken={p.getPhotoSetupToken} readOnly={photosReadOnly || field.filledBy === "manager"} />
    </div>
  );

  // Photo uploads are read-only in the portal's editor (an already-submitted
  // application is never re-uploaded). `getApplicationId` mints/returns the
  // stable axis id an upload attaches to; falls back to the form email context.
  const photosReadOnly = mode === "editor";
  const getApplicationId = p.getApplicationId ?? (() => form.email.trim().toLowerCase() || "");

  // Manager custom questions render inside their configured section's step
  // (untagged → step 8, `DEFAULT_CUSTOM_FIELD_SECTION_ID`).
  //
  // The range must cover EVERY step a section can map to — `household` is step 1
  // and `review` is step 10, and both were outside the old 2–9 window. Validation
  // has no such window: `validateRentalWizardStep` asks for the answer on
  // whatever step the question is tagged to, so a required question in either
  // section made Continue do nothing at all, with no field on screen to fix and
  // no error text anywhere (the household step is the FIRST one, so an
  // application could not be started or edited past it).
  const stepManagerQuestions = (() => {
    if (!CUSTOM_QUESTION_WIZARD_STEPS.has(step)) return null;
    const stepProp = getPropertyById(form.propertyId);
    const fields = customFieldsForWizardStep(
      listingCustomApplicationFields(applicationConfig),
      step,
    ).filter((field) => !isCustomFieldHiddenByCondition(field, form.customFieldAnswers));
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
            getApplicationId={getApplicationId}
            setupTokenRequired={p.photoSetupTokenRequired}
            getSetupToken={p.getPhotoSetupToken}
            readOnly={photosReadOnly || field.filledBy === "manager"}
          />
        ))}
      </div>
    );
  })();

  const autofillBanner =
    savedAutofillAvailable && onApplySavedAutofill && step === 2 ? (
      <div className="mb-5 rounded-2xl border border-primary/25 bg-primary/8 p-4 sm:p-5">
        <p className="text-sm font-semibold text-foreground">Use information from a previous application</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          We can fill in your contact, employment, and reference details. You&apos;ll still enter move-in dates, room
          choices, and anything specific to this property.
        </p>
        <Button
          type="button"
          className="mt-3 rounded-full px-4 text-[13px]"
          data-attr="rental-wizard-apply-saved-autofill"
          onClick={onApplySavedAutofill}
        >
          Autofill from previous application
        </Button>
      </div>
    ) : null;

  if (step === 1) {
    const showCosigner = showWizardField("hasCosigner");
    const showGroup = showWizardField("applyingAsGroup");
    const joiningGroup = Boolean(form.groupLeaderAppId.trim());
    const organizingGroup = form.applyingAsGroup === "yes" && !joiningGroup;
    const inviteAppId = savedApplicationId.trim();
    const propertyOffersBundles =
      form.propertyId.trim().length > 0 &&
      getBundleOptionsForProperty(form.propertyId, { rentalType: applicationRentalTypeFor(form.rentalType) }).length > 0;

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
                    ID below so the manager sees you as one household. Each of you still files your
                    own application
                    {propertyOffersBundles
                      ? ". If you all choose the same lease bundle, move-in costs split evenly across your group; otherwise each person is billed their own charges."
                      : " and is billed your own charges."}
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
                    Everyone applying together, including you.
                    {propertyOffersBundles
                      ? " Move-in costs split evenly when you all choose the same lease bundle; otherwise each person is billed their own charges."
                      : " Each person is billed their own charges."}
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

        {stepManagerQuestions}
      </div>
    );
  }

  if (step === 3) {
    void occupancySyncEpoch;
    const selectedProperty = getPropertyById(form.propertyId);
    const propertyQuestion = standardQuestion("property", "propertyId");
    const termQuestion = standardQuestion("property", "leaseTerm");
    const roomQuestion = standardQuestion("property", "roomChoice1");
    const datesQuestion = standardQuestion("property", "leaseStart");
    // A single lease-term dropdown carries short-term too: listingAllowedLeaseTerms
    // includes "Short-Term Stay" exactly when the listing permits it, so there is no
    // separate "Application type" toggle that could contradict the term.
    // The OFFERED terms, not every accepted value. A listing configured before
    // AXI-143 still stores 3/6/9/12-Month, and echoing those verbatim offered a
    // prospect lengths the manager can no longer pick while hiding
    // Month-to-Month and Custom entirely; listingOfferedLeaseTerms collapses
    // them onto Long-term, whose move-in / move-out dates ARE the term.
    const offeredLeaseTerms = form.propertyId.trim()
      ? listingOfferedLeaseTerms(form.propertyId)
      : [...LEASE_TERM_CHOICES];
    const longTermLengths = form.propertyId.trim() ? listingLongTermLengths(form.propertyId) : [];
    // A resumed draft — or an application started while a retired length was
    // still offered — keeps its OWN answer selectable. Dropping it would blank
    // what they already chose without a word, the same reason an already-picked
    // room stays in the ranked choices below.
    const chosenLeaseTerm = form.leaseTerm.trim();
    const leaseTermOptions =
      chosenLeaseTerm && !offeredLeaseTerms.includes(chosenLeaseTerm)
        ? sortLeaseTermsCanonical([...offeredLeaseTerms, chosenLeaseTerm])
        : offeredLeaseTerms;
    /**
     * The ranked 1st/2nd/3rd choices offer only rooms that are ACTUALLY
     * AVAILABLE. This list used to pass `includeUnavailable: true`, so an
     * applicant was asked to rank ten bedrooms most of which they could not
     * have (AXI-167).
     *
     * The one exception is a room ALREADY chosen on this application: a resumed
     * draft, or a room that filled up after the applicant picked it. Dropping it
     * from the options would blank their answer without a word, so it stays
     * selectable and validation — not a vanishing option — is what tells them.
     */
    const availableRooms = roomSelectOptionsWithNone(form.propertyId, {
      // Availability is judged against the dates the applicant actually asked
      // for, not against today. `isRoomChoiceAvailable` compares the requested
      // window with the occupancy of the residents already in the house, so a
      // room free next month is offered for a move-in next month even though it
      // is occupied right now — and one that is occupied THEN is not offered,
      // however empty it looks today. Without these two the filter answered a
      // different question than the applicant was asking.
      leaseStart: form.leaseStart,
      leaseEnd: form.leaseEnd,
    }).filter((o) => o.value !== "");
    const allRooms = roomSelectOptionsWithNone(form.propertyId, { includeUnavailable: true }).filter(
      (o) => o.value !== "",
    );
    const chosenRoomValues = new Set(
      [form.roomChoice1, form.roomChoice2, form.roomChoice3].map((v) => v.trim()).filter(Boolean),
    );
    const rooms = allRooms.filter(
      (o) => availableRooms.some((a) => a.value === o.value) || chosenRoomValues.has(o.value),
    );
    const roomsWithNone = [{ value: "", label: "None" }, ...rooms];
    const firstChoiceRooms = firstChoiceRoomOptions(form.propertyId, {
      leaseStart: form.leaseStart,
      leaseEnd: form.leaseEnd,
      leaseTerm: form.leaseTerm,
      keepValue: form.roomChoice1,
    });
    const listingQuote =
      selectedProperty?.listingSubmission?.v === 1 && form.roomChoice1.trim()
        ? applicantListingQuote(selectedProperty.listingSubmission, {
            roomChoice1: form.roomChoice1,
            leaseTerm: form.leaseTerm,
            residentSlot: form.residentSlot,
          })
        : null;
    // Whole-unit listings (leased as one place, not room-by-room) don't ask for
    // ranked 1st/2nd/3rd room choices — see the property step below.
    const isByRoom = isPropertyRentedByRoom(form.propertyId);
    // Entire-home pricing: itemized rooms are bedrooms on display, not units —
    // there is nothing to choose (the application is for the whole home).
    const entireHome = Boolean(form.propertyId) && isEntireHomeProperty(form.propertyId);
    const bundleOptions = form.propertyId
      ? getBundleOptionsForProperty(form.propertyId, { rentalType: applicationRentalTypeFor(form.rentalType) })
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
        <div className="space-y-2" data-wizard-field="propertyId" data-application-question-id={propertyQuestion?.id}>
          <Label htmlFor="propertyId" required={propertyQuestion?.required}>{propertyQuestion?.label ?? "Property name"}</Label>
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
              patch({
                propertyId: pid,
                bundleId: "",
                roomChoice1: autoRoom,
                roomChoice2: "",
                roomChoice3: "",
                leaseTerm: "",
                rentalType: "standard",
                residentSlot: undefined,
                managerRentOverride: "",
                managerUtilitiesOverride: "",
                managerSecurityDepositOverride: "",
              });
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
        <div className="space-y-2" data-wizard-field="leaseTerm" data-application-question-id={termQuestion?.id}>
          <Label htmlFor="leaseTerm" required={termQuestion?.required}>{termQuestion?.label ?? "Lease term"}</Label>
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
              const slotPatch = form.roomChoice1.trim()
                ? firstChoiceSelectionPatch(form.roomChoice1, {
                    propertyId: form.propertyId,
                    leaseTerm: v,
                  })
                : {};
              patch(
                v === "Month-to-Month"
                  ? {
                      leaseTerm: v,
                      leaseEnd: "",
                      rentalType,
                      ...(keepBundle ? {} : { bundleId: "" }),
                      ...slotPatch,
                    }
                  : {
                      leaseTerm: v,
                      rentalType,
                      ...(keepBundle ? {} : { bundleId: "" }),
                      ...slotPatch,
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
            {/*
              State-aware, because the old copy always read as an invitation
              ("choose a bundle… or leave as none") even when a bundle was
              ALREADY chosen — arriving pre-filled from an "Apply for this
              bundle" link. An applicant then read the filled field as a decision
              already made for them and did not realise they could change it
              (AXI-166). When one is selected, say so and name the way out.
            */}
            <p className="text-xs text-muted">
              {bundleSelected
                ? `You're applying for this bundle. Pick a different one, or choose “None” to apply ${isByRoom ? "for individual rooms" : "on the standard lease"} instead.`
                : form.rentalType === "short_term"
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
                    residentSlot: undefined,
                    managerRentOverride: "",
                    managerUtilitiesOverride: "",
                    managerSecurityDepositOverride: "",
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

        <div className={listingQuote ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] lg:items-start" : undefined}>
        <WizardFieldGate fieldKey="roomChoice1" enabled={showWizardField}>
        {isByRoom && !bundleSelected ? (
        <div className="space-y-2">
          <Label required={roomQuestion?.required}>{roomQuestion?.label ?? "Room preferences"}</Label>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">1st choice</span>
              <div data-wizard-field="roomChoice1">
                <Select
                  value={form.roomChoice1}
                  disabled={!form.propertyId}
                  onChange={(e) =>
                    patch(firstChoiceSelectionPatch(e.target.value, {
                      propertyId: form.propertyId,
                      leaseTerm: form.leaseTerm,
                    }))
                  }
                  className={errors.roomChoice1 ? "border-red-400 ring-2 ring-red-100" : ""}
                >
                <option value="">{form.propertyId ? "Select a room" : "Select a property first"}</option>
                {firstChoiceRooms.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>
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
        {listingQuote ? <ApplicantPaysCard quote={listingQuote} /> : null}
        </div>

        <WizardFieldGate fieldKey="leaseStart" enabled={showWizardField}>
        <div className={form.leaseTerm === "Month-to-Month" ? "space-y-2" : "grid gap-4 sm:grid-cols-2"}>
          <div className="space-y-2">
            <Label htmlFor="leaseStart" required={datesQuestion?.required}>{datesQuestion?.label ?? (form.rentalType === "short_term" ? "Check-in date" : "Lease start date")}</Label>
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
          {form.leaseTerm === LONG_TERM_LEASE_TERM && longTermLengths.length > 0 ? (
            <div className="space-y-2" data-wizard-field="longTermLength">
              <Label htmlFor="longTermLength">Lease length</Label>
              <Select
                id="longTermLength"
                value={longTermLengthFor(form.leaseStart, form.leaseEnd, longTermLengths)}
                onChange={(e) => {
                  const months = Number(e.target.value);
                  if (!months || !form.leaseStart) return;
                  patch({ leaseEnd: addMonthsToDateString(form.leaseStart, months) });
                }}
              >
                <option value="">Pick a length…</option>
                {longTermLengths.map((months) => (
                  <option key={months} value={String(months)}>
                    {months} months
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted">The manager offers these lengths; picking one fills the end date from your move-in date.</p>
            </div>
          ) : null}
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
            This room is not available for your selected dates. Choose another room or adjust your move-in dates before
            applying.
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
    const personalFields = resolveListingApplicationFields(applicationConfig, normalizeCustomApplicationFields)
      .filter((field) => field.section === "personal");
    const renderPersonalField = (field: (typeof personalFields)[number]) => {
      if (!field.isStandard) {
        return (
          <div key={field.id} data-application-question-id={field.id}>
            <CustomQuestionField
              field={field}
              value={customFieldAnswerValue(form.customFieldAnswers, field.key)}
              error={errors[customFieldErrorKey(field.key)]}
              onChange={(next) => patch({ customFieldAnswers: upsertCustomFieldAnswer(form.customFieldAnswers, field, next) })}
              getApplicationId={getApplicationId}
              setupTokenRequired={p.photoSetupTokenRequired}
              getSetupToken={p.getPhotoSetupToken}
              readOnly={photosReadOnly || field.filledBy === "manager"}
            />
          </div>
        );
      }
      const formKey = applicationFieldCatalogDef(field.standardKey!)?.wizardFormKeys[0];
      const fieldKey = formKey ?? "";
      const gate = (children: ReactNode) => (
        <WizardFieldGate key={field.id} fieldKey={fieldKey} enabled={showWizardField}>
          <div data-wizard-field={fieldKey} data-application-question-id={field.id} className="space-y-2">
            {children}
          </div>
        </WizardFieldGate>
      );
      switch (fieldKey) {
        case "fullLegalName":
          return gate(<><Label htmlFor="fullLegalName" required={field.required}>{field.label}</Label><Input id="fullLegalName" value={form.fullLegalName} onChange={(e) => patch({ fullLegalName: e.target.value })} placeholder="First and last name" autoComplete="name" className={errors.fullLegalName ? "border-red-400 ring-2 ring-red-100" : ""} /><FieldError msg={errors.fullLegalName} /></>);
        case "dateOfBirth":
          return gate(<><Label htmlFor="dateOfBirth" required={field.required}>{field.label}</Label><DateField id="dateOfBirth" value={form.dateOfBirth} onChange={(next) => patch({ dateOfBirth: next })} className={errors.dateOfBirth ? "border-red-400 ring-2 ring-red-100" : ""} /><FieldError msg={errors.dateOfBirth} /></>);
        case "ssn":
          return gate(<><Label htmlFor="ssn" required={field.required}>{field.label}</Label><Input id="ssn" inputMode="numeric" autoComplete="off" value={form.ssn} onChange={(e) => p.setSsn(e.target.value)} placeholder="###-##-####" className={errors.ssn ? "border-red-400 ring-2 ring-red-100" : ""} /><FieldError msg={errors.ssn} /></>);
        case "driversLicense":
          return gate(<><Label htmlFor="driversLicense" required={field.required}>{field.label}</Label><Input id="driversLicense" value={form.driversLicense} onChange={(e) => patch({ driversLicense: e.target.value })} className={errors.driversLicense ? "border-red-400 ring-2 ring-red-100" : ""} /><FieldError msg={errors.driversLicense} /></>);
        case "phone":
          return gate(<><Label htmlFor="phone" required={field.required}>{field.label}</Label><PhoneNumberField id="phone" value={form.phone} onChange={p.setPhone} inputClassName={errors.phone ? "border-red-400 ring-2 ring-red-100" : ""} /><FieldError msg={errors.phone} /><SmsConsentCheckbox inputId="sms-consent" checked={Boolean(form.smsConsent)} onChange={(next) => patch({ smsConsent: next, smsConsentAt: next ? new Date().toISOString() : undefined })} /></>);
        case "email":
          return gate(<><Label htmlFor="email" required={field.required}>{field.label}</Label><Input id="email" type="email" autoComplete="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} placeholder="you@example.com" readOnly={Boolean(p.emailLocked)} disabled={Boolean(p.emailLocked)} className={errors.email ? "border-red-400 ring-2 ring-red-100" : ""} /><FieldError msg={errors.email} /></>);
        case "idPhotoFront":
          return gate(<><Label>{field.label}</Label><ApplicationPhotoField slot="idFront" label="Front of ID" uploadOnly attachment={form.idPhotoFront} onChange={(next) => patch({ idPhotoFront: next })} getApplicationId={getApplicationId} setupTokenRequired={p.photoSetupTokenRequired} getSetupToken={p.getPhotoSetupToken} readOnly={photosReadOnly} dataAttr="application-id-photo-front" /></>);
        case "idPhotoBack":
          return gate(<><Label>{field.label}</Label><ApplicationPhotoField slot="idBack" label="Back of ID" uploadOnly attachment={form.idPhotoBack} onChange={(next) => patch({ idPhotoBack: next })} getApplicationId={getApplicationId} setupTokenRequired={p.photoSetupTokenRequired} getSetupToken={p.getPhotoSetupToken} readOnly={photosReadOnly} dataAttr="application-id-photo-back" /></>);
        default:
          return null;
      }
    };
    return (
      <div className="space-y-8">
        {autofillBanner}
        <StepIntro>
          Start with how we can reach you, then confirm your identity exactly as it appears on your ID. This section is
          encrypted in transit in production environments.
        </StepIntro>
        <div className="grid gap-4 sm:grid-cols-2" data-application-section="personal">
          {personalFields.map(renderPersonalField)}
        </div>
      </div>
    );
  }

  if (step === 4) {
    const street = standardQuestion("current_address", "currentStreet");
    const landlord = standardQuestion("current_address", "currentLandlordName");
    const dates = standardQuestion("current_address", "currentMoveIn");
    const reason = standardQuestion("current_address", "currentReasonLeaving");
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>Where you live today. Landlord and move dates help us verify your rental history.</StepIntro>
        </div>
        <OrderedConfiguredQuestions fields={sectionQuestions("current_address")} renderCustom={renderCustomQuestion}>
        <WizardFieldGate fieldKey="currentStreet" enabled={showWizardField}>
        <div className="space-y-2">
          <Label htmlFor="currentStreet" required={street?.required}>{street?.label ?? "Street address"}</Label>
          {/*
            The same address search the listing wizard uses, so an applicant
            picks a REAL address instead of typing anything at all — choosing a
            suggestion fills city, state and ZIP from the geocoder rather than
            leaving three free-text boxes to disagree with the street (AXI-168).

            Deliberately NOT a hard block on "must match a suggestion". A
            geocoder misses new builds, rural routes and recent renumbering, and
            refusing those would lock a real applicant out of a rental
            application entirely — a far worse failure than a typo in a field the
            manager can see. This makes the right answer the easy one.
          */}
          <ListingAddressAutocomplete
            value={form.currentStreet}
            onChange={(currentStreet) => patch({ currentStreet })}
            onSelect={(suggestion) => {
              patch({
                currentStreet: suggestion.address || suggestion.label,
                ...(suggestion.city ? { currentCity: suggestion.city } : {}),
                ...(suggestion.state ? { currentState: suggestion.state } : {}),
                ...(suggestion.zip ? { currentZip: suggestion.zip } : {}),
              });
            }}
            placeholder="Start typing your street address…"
            aria-invalid={Boolean(errors.currentStreet)}
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
            <Label htmlFor="currentLandlordName" required={landlord?.required}>{landlord?.label ?? "Current landlord name"}</Label>
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
            <PhoneNumberField
              id="currentLandlordPhone"
              value={form.currentLandlordPhone}
              onChange={p.setLandlordPhone}
              inputClassName={errors.currentLandlordPhone ? "border-red-400 ring-2 ring-red-100" : ""}
            />
            <FieldError msg={errors.currentLandlordPhone} />
          </div>
        </div>
        </WizardFieldGate>
        <WizardFieldGate fieldKey="currentMoveIn" enabled={showWizardField}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="currentMoveIn" required={dates?.required}>{dates?.label ?? "Current move-in date"}</Label>
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
          <Label htmlFor="currentReasonLeaving" required={reason?.required}>{reason?.label ?? "Reason for leaving"}</Label>
          <Textarea
            id="currentReasonLeaving"
            value={form.currentReasonLeaving}
            onChange={(e) => patch({ currentReasonLeaving: e.target.value })}
            placeholder="e.g. relocating for work, lease ending…"
            rows={3}
          />
        </div>
        </WizardFieldGate>

        </OrderedConfiguredQuestions>
      </div>
    );
  }

  if (step === 5) {
    const street = standardQuestion("previous_address", "prevStreet");
    const landlord = standardQuestion("previous_address", "prevLandlordName");
    const dates = standardQuestion("previous_address", "prevMoveIn");
    const reason = standardQuestion("previous_address", "prevReasonLeaving");
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

        <OrderedConfiguredQuestions
          fields={sectionQuestions("previous_address").filter((field) => !form.noPreviousAddress || !field.isStandard)}
          renderCustom={renderCustomQuestion}
        >
            <WizardFieldGate fieldKey="prevStreet" enabled={showWizardField}>
            <div className="space-y-2">
              <Label htmlFor="prevStreet" required={street?.required}>{street?.label ?? "Street address"}</Label>
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
                <Label htmlFor="prevLandlordName" required={landlord?.required}>{landlord?.label ?? "Previous landlord name"}</Label>
                <Input id="prevLandlordName" value={form.prevLandlordName} onChange={(e) => patch({ prevLandlordName: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prevLandlordPhone" optional>
                  Previous landlord phone
                </Label>
                <PhoneNumberField
                  id="prevLandlordPhone"
                  value={form.prevLandlordPhone}
                  onChange={p.setPrevLandlordPhone}
                  inputClassName={errors.prevLandlordPhone ? "border-red-400 ring-2 ring-red-100" : ""}
                />
                <FieldError msg={errors.prevLandlordPhone} />
              </div>
            </div>
            </WizardFieldGate>
            <WizardFieldGate fieldKey="prevMoveIn" enabled={showWizardField}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="prevMoveIn" required={dates?.required}>{dates?.label ?? "Move-in date"}</Label>
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
              <Label htmlFor="prevReasonLeaving" required={reason?.required}>{reason?.label ?? "Reason for leaving"}</Label>
              <Textarea
                id="prevReasonLeaving"
                value={form.prevReasonLeaving}
                onChange={(e) => patch({ prevReasonLeaving: e.target.value })}
                rows={3}
              />
            </div>
            </WizardFieldGate>
        </OrderedConfiguredQuestions>
      </div>
    );
  }

  if (step === 6) {
    const fields = sectionQuestions("employment");
    const renderEmploymentField = (field: ResolvedApplicationField) => {
      if (!field.isStandard) return renderCustomQuestion(field);
      const fieldKey = applicationFieldCatalogDef(field.standardKey!)?.wizardFormKeys[0] ?? "";
      const gate = (content: ReactNode) => (
        <WizardFieldGate key={field.id} fieldKey={fieldKey} enabled={showWizardField}>
          <div data-wizard-field={fieldKey} data-application-question-id={field.id}
            className="space-y-3 rounded-2xl border border-border bg-card p-5 sm:p-6">
            {content}
          </div>
        </WizardFieldGate>
      );
      switch (fieldKey) {
        case "employer":
          return gate(<>
            <Label htmlFor="employer" required={field.required && !form.notEmployed}>{field.label}</Label>
            <Input id="employer" value={form.employer} disabled={form.notEmployed}
              onChange={(e) => patch({ employer: e.target.value })} className={errors.employer ? "border-red-400 ring-2 ring-red-100" : ""} />
            <FieldError msg={errors.employer} />
            <Label htmlFor="employerAddress">Employer address</Label>
            <Input id="employerAddress" value={form.employerAddress} disabled={form.notEmployed}
              onChange={(e) => patch({ employerAddress: e.target.value })} />
          </>);
        case "supervisorName":
          return gate(<>
            <Label htmlFor="supervisorName" required={field.required && !form.notEmployed}>{field.label}</Label>
            <Input id="supervisorName" value={form.supervisorName} disabled={form.notEmployed}
              onChange={(e) => patch({ supervisorName: e.target.value })} />
            <Label htmlFor="supervisorPhone">Supervisor phone</Label>
            <PhoneNumberField id="supervisorPhone" value={form.supervisorPhone} disabled={form.notEmployed}
              onChange={p.setSupervisorPhone} inputClassName={errors.supervisorPhone ? "border-red-400 ring-2 ring-red-100" : ""} />
            <FieldError msg={errors.supervisorPhone} />
          </>);
        case "jobTitle":
          return gate(<>
            <Label htmlFor="jobTitle" required={field.required && !form.notEmployed}>{field.label}</Label>
            <Input id="jobTitle" value={form.jobTitle} disabled={form.notEmployed}
              onChange={(e) => patch({ jobTitle: e.target.value })} />
            <Label htmlFor="employmentStart">Employment start date</Label>
            <DateField id="employmentStart" value={form.employmentStart} disabled={form.notEmployed}
              onChange={(next) => patch({ employmentStart: next })} />
          </>);
        case "monthlyIncome":
          return gate(<>
            <Label htmlFor="monthlyIncome" required={field.required && !form.notEmployed}>{field.label}</Label>
            <Input id="monthlyIncome" inputMode="decimal" value={form.monthlyIncome}
              onChange={(e) => patch({ monthlyIncome: e.target.value })}
              onBlur={() => patch({ monthlyIncome: formatMoneyBlur(form.monthlyIncome) })}
              placeholder="4,200" className={errors.monthlyIncome ? "border-red-400 ring-2 ring-red-100" : ""} />
            <FieldError msg={errors.monthlyIncome} />
            <Label htmlFor="annualIncome">Annual gross income</Label>
            <Input id="annualIncome" inputMode="decimal" value={form.annualIncome}
              onChange={(e) => patch({ annualIncome: e.target.value })}
              onBlur={() => patch({ annualIncome: formatMoneyBlur(form.annualIncome) })}
              placeholder="52,000" className={errors.annualIncome ? "border-red-400 ring-2 ring-red-100" : ""} />
            <FieldError msg={errors.annualIncome} />
          </>);
        case "incomeProofPhotos":
          return gate(<>
            <Label required={field.required}>{field.label}</Label>
            <IncomeProofPhotos attachments={form.incomeProofPhotos}
              onChange={(next) => patch({ incomeProofPhotos: next })}
              getApplicationId={getApplicationId} setupTokenRequired={p.photoSetupTokenRequired}
              getSetupToken={p.getPhotoSetupToken} readOnly={photosReadOnly} />
          </>);
        case "otherIncome":
          return gate(<>
            <Label htmlFor="otherIncome" required={field.required}>{field.label}</Label>
            <Input id="otherIncome" value={form.otherIncome}
              onChange={(e) => patch({ otherIncome: e.target.value })}
              onBlur={() => patch({ otherIncome: formatMoneyBlur(form.otherIncome) })}
              placeholder="Benefits, stipends, trust distributions" className={errors.otherIncome ? "border-red-400 ring-2 ring-red-100" : ""} />
            <FieldError msg={errors.otherIncome} />
          </>);
        default:
          return null;
      }
    };
    return (
      <div className="space-y-6">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4">
          <input type="checkbox" checked={form.notEmployed}
            onChange={(e) => patch({ notEmployed: e.target.checked })} />
          <span className="text-sm font-medium text-foreground">I am not currently employed</span>
        </label>
        {errors._general ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errors._general}</p> : null}
        <div className="space-y-4" data-application-section="employment">
          {fields.map(renderEmploymentField)}
        </div>
      </div>
    );
  }

  if (step === 7) {
    const first = standardQuestion("references", "ref1Name");
    const second = standardQuestion("references", "ref2Name");
    return (
      <div className="space-y-8">
        <div>
          <StepIntro>List people who can speak to your character or employment. Avoid family members when possible.</StepIntro>
        </div>
        <OrderedConfiguredQuestions fields={sectionQuestions("references")} renderCustom={renderCustomQuestion}>
        <WizardFieldGate fieldKey="ref1Name" enabled={showWizardField}>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted/70">Reference 1</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ref1Name" required={first?.required}>{first?.label ?? "Name"}</Label>
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
              <PhoneNumberField
                id="ref1Phone"
                value={form.ref1Phone}
                onChange={p.setRef1Phone}
                inputClassName={errors.ref1Phone ? "border-red-400 ring-2 ring-red-100" : ""}
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
              <Label htmlFor="ref2Name" required={second?.required}>{second?.label ?? "Name"}</Label>
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
              <PhoneNumberField
                id="ref2Phone"
                value={form.ref2Phone}
                onChange={p.setRef2Phone}
                inputClassName={errors.ref2Phone ? "border-red-400 ring-2 ring-red-100" : ""}
              />
              <FieldError msg={errors.ref2Phone} />
            </div>
          </div>
        </div>
        </WizardFieldGate>

        </OrderedConfiguredQuestions>
      </div>
    );
  }

  if (step === 8) {
    const additionalFields = resolveListingApplicationFields(applicationConfig, normalizeCustomApplicationFields)
      .filter((field) => field.section === "additional");
    const renderAdditionalField = (field: (typeof additionalFields)[number]) => {
      if (!field.isStandard) {
        return (
          <div key={field.id} data-application-question-id={field.id}>
            <CustomQuestionField
              field={field}
              value={customFieldAnswerValue(form.customFieldAnswers, field.key)}
              error={errors[customFieldErrorKey(field.key)]}
              onChange={(next) => patch({ customFieldAnswers: upsertCustomFieldAnswer(form.customFieldAnswers, field, next) })}
              getApplicationId={getApplicationId}
              setupTokenRequired={p.photoSetupTokenRequired}
              getSetupToken={p.getPhotoSetupToken}
              readOnly={photosReadOnly || field.filledBy === "manager"}
            />
          </div>
        );
      }
      const fieldKey = applicationFieldCatalogDef(field.standardKey!)?.wizardFormKeys[0] ?? "";
      const gate = (children: ReactNode) => (
        <WizardFieldGate key={field.id} fieldKey={fieldKey} enabled={showWizardField}>
          <div data-wizard-field={fieldKey} data-application-question-id={field.id} className="space-y-3 rounded-xl border border-border bg-accent/30 p-4">
            {children}
          </div>
        </WizardFieldGate>
      );
      if (fieldKey === "occupancyCount") return gate(<><Label htmlFor="occupancyCount" required={field.required}>{field.label}</Label><Select id="occupancyCount" value={form.occupancyCount} onChange={(e) => patch({ occupancyCount: e.target.value })} className={errors.occupancyCount ? "border-red-400 ring-2 ring-red-100" : ""}><option value="">Select</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n}</option>)}</Select>{Number(form.occupancyCount) > 1 ? <p className="rounded-lg border px-3 py-2 text-xs leading-relaxed portal-banner-pending"><span className="font-semibold">Note:</span> More than 1 occupant may increase the total cost. Each additional occupant must submit their own application. Set up a group in step 1 and share your invite link so all applications stay linked.</p> : null}<FieldError msg={errors.occupancyCount} /></>);
      if (fieldKey === "pets") return gate(<><Label htmlFor="pets" optional={!field.required}>{field.label}</Label><Textarea id="pets" value={form.pets} onChange={(e) => patch({ pets: e.target.value })} placeholder="Type, breed, weight, or write “None”" rows={2} /></>);
      const history = fieldKey === "evictionHistory" ? { value: form.evictionHistory, details: form.evictionDetails, detailsKey: "evictionDetails", title: field.label, error: errors.evictionHistory } : fieldKey === "bankruptcyHistory" ? { value: form.bankruptcyHistory, details: form.bankruptcyDetails, detailsKey: "bankruptcyDetails", title: field.label, error: errors.bankruptcyHistory } : fieldKey === "criminalHistory" ? { value: form.criminalHistory, details: form.criminalDetails, detailsKey: "criminalDetails", title: field.label, error: errors.criminalHistory } : null;
      if (!history) return null;
      return gate(<><Label required={field.required}>{history.title}</Label><YesNoPills value={history.value} error={history.error} name={history.title} fieldKey={fieldKey} onChange={(value) => patch(fieldKey === "evictionHistory" ? { evictionHistory: value, evictionDetails: value === "no" ? "" : form.evictionDetails } : fieldKey === "bankruptcyHistory" ? { bankruptcyHistory: value, bankruptcyDetails: value === "no" ? "" : form.bankruptcyDetails } : { criminalHistory: value, criminalDetails: value === "no" ? "" : form.criminalDetails })} />{history.value === "yes" ? <div className="space-y-2"><Label htmlFor={history.detailsKey}>Brief details</Label><Textarea id={history.detailsKey} value={history.details} onChange={(e) => patch(fieldKey === "evictionHistory" ? { evictionDetails: e.target.value } : fieldKey === "bankruptcyHistory" ? { bankruptcyDetails: e.target.value } : { criminalDetails: e.target.value })} rows={3} className={errors[history.detailsKey] ? "border-red-400 ring-2 ring-red-100" : ""} /><FieldError msg={errors[history.detailsKey]} /></div> : null}</>);
    };
    return (
      <div className="space-y-8">
        <StepIntro>These questions are standard for rental screening. Your answers are reviewed in context; answer honestly.</StepIntro>
        <div className="space-y-4" data-application-section="additional">
          {additionalFields.map(renderAdditionalField)}
        </div>
      </div>
    );
  }

  if (step === 9) {
    const credit = standardQuestion("consent", "consentCredit");
    const truth = standardQuestion("consent", "consentTruth");
    const signature = standardQuestion("consent", "digitalSignature");
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
        <OrderedConfiguredQuestions fields={sectionQuestions("consent")} renderCustom={renderCustomQuestion}>
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
          <span className="text-sm font-medium text-foreground">{credit?.label ?? "I authorize a credit and background check."}{credit?.required ? " *" : ""}</span>
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
          <span className="text-sm font-medium text-foreground">{truth?.label ?? "I confirm the information provided is true and complete."}{truth?.required ? " *" : ""}</span>
        </label>
        <FieldError msg={errors.consentTruth} />
        </WizardFieldGate>
        <WizardFieldGate fieldKey="digitalSignature" enabled={showWizardField}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2" data-wizard-field="digitalSignature">
            <Label htmlFor="digitalSignature" required={signature?.required}>{signature?.label ?? "Digital signature (type your full legal name)"}</Label>
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

        </OrderedConfiguredQuestions>
      </div>
    );
  }

  if (step === 10) {
    const prop = getPropertyById(form.propertyId);
    const roomLabel = (id: string) => getRoomChoiceLabel(id);
    const reviewByRoom = isPropertyRentedByRoom(form.propertyId);
    const reviewBundleLabel = form.bundleId.trim()
      ? getBundleChoiceLabel(form.propertyId, form.bundleId, { rentalType: applicationRentalTypeFor(form.rentalType) })
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
              {(() => {
                const reviewQuote = applicantListingQuote(prop.listingSubmission, {
                  roomChoice1: form.roomChoice1,
                  leaseTerm: form.leaseTerm,
                  residentSlot: form.residentSlot,
                });
                if (!reviewQuote) {
                  return (
                    <>
                      <ReviewRow k="Security deposit" v={displayOrDash(prop.listingSubmission.securityDeposit)} />
                      <ReviewRow k="Move-in fee" v={displayOrDash(prop.listingSubmission.moveInFee)} />
                      <ReviewRow k="Payment due at signing" v={displayOrDash(paymentAtSigningPriceLabel(prop.listingSubmission))} />
                      <ReviewRow k="Utilities (estimate, by room)" v={displayOrDash(utilitiesListingEstimateLabel(prop.listingSubmission))} />
                    </>
                  );
                }
                return (
                  <>
                    {reviewQuote.signingLines.map((line) => (
                      <ReviewRow key={line.key} k={line.label} v={formatQuoteMoney(line.amount)} />
                    ))}
                    <ReviewRow k="Payment due at signing" v={formatQuoteMoney(reviewQuote.signingTotal)} />
                    {reviewQuote.isStay ? (
                      reviewQuote.nightlyRate ? (
                        <ReviewRow k="Stay rate" v={`${formatQuoteMoney(reviewQuote.nightlyRate)}/night`} />
                      ) : null
                    ) : (
                      <ReviewRow k="Then each month" v={formatQuoteMoney(reviewQuote.monthlyTotal)} />
                    )}
                  </>
                );
              })()}
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
          {groupCustomFieldAnswersBySection(form.customFieldAnswers).map((group) => (
            <ReviewSection
              key={group.sectionId ?? "other-questions"}
              title={group.title}
              stepTarget={applicationWizardStepForSection(group.sectionId ?? undefined)}
              onEdit={editFromReview}
            >
              {group.answers.map((answer) => (
                <ReviewRow key={answer.key} k={answer.label} v={displayOrDash(formatCustomFieldAnswerDisplay(answer))} />
              ))}
            </ReviewSection>
          ))}
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

        {/* A question tagged to the Review section is asked here — the summary
            above only ECHOES answers, so without this the review step validated
            an answer it never collected. */}
        {stepManagerQuestions}

        <p className="text-center text-xs text-muted">Next: application fee confirmation before final submit.</p>
      </div>
    );
  }

  if (step === 11) {
    const prop = form.propertyId ? getPropertyById(form.propertyId) : undefined;
    // Headline application fee for the summary card, from the gate — which the
    // wizard derives from the SERVER's authoritative fee preview (manager-level
    // setting), never from the listing's grandfathered `applicationFee` text.
    // Any plan-based service fee (card channel only) is itemized inside the
    // inline payment form, so the exact amount charged is always disclosed
    // before the applicant pays — never a surprise here.
    const appFeeLabel = applicationFeeGate.needsFee ? applicationFeeGate.displayLabel : "—";
    const codeWaived = Boolean(form.applicationFeeWaived);
    const managerUserIdForPay = resolvedManagerUserId.trim() || prop?.managerUserId?.trim() || "";
    const feeStillDue = applicationFeeGate.needsFee && !applicationFeeGate.paid;
    return (
      <div className="space-y-6">
        <div>
          <StepIntro>
            The application fee is the only payment collected here — any deposit is billed later, under Payments, after
            you&apos;re approved.
          </StepIntro>
        </div>

        {applicationFeeGate.listingUnavailable ? (
          <div className="rounded-2xl border px-4 py-4 text-sm portal-banner-pending">
            This listing is no longer available. Go back and choose another property, or contact the manager for help.
          </div>
        ) : null}
        {applicationFeeGate.feePreviewFailed ? (
          <div className="rounded-2xl border px-4 py-4 text-sm portal-banner-pending">
            We couldn&apos;t confirm the application fee right now. Check your connection and refresh this page, or contact
            the manager before submitting.
          </div>
        ) : null}

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
        {feeStillDue ? (
          <div className="rounded-2xl border border-border bg-card px-4 py-4 text-sm text-foreground">
            <span className="font-semibold text-foreground">Payment method:</span> Card or Apple Pay
          </div>
        ) : null}
        {feeStillDue ? (
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
              rentalType={applicationRentalTypeFor(form.rentalType)}
              leaseTerm={form.leaseTerm || undefined}
              returnPath={applyReturnPath ?? "/rent/apply"}
            />
          ) : (
            <div className="rounded-2xl border px-4 py-4 text-sm portal-banner-info">
              Pay securely with Apple Pay, Google Pay, or card. Your application submits as soon as the payment is
              confirmed.
            </div>
          )
        ) : null}
      </div>
    );
  }

  return null;
}
