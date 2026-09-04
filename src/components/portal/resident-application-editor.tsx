"use client";

import { applicationRentalTypeFor } from "@/lib/rental-application/lease-terms";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { RentalWizardStepBody } from "@/components/marketing/rental-wizard-steps";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  loadPublicExtraListingsFromServer,
  PROPERTY_PIPELINE_EVENT,
} from "@/lib/demo-property-pipeline";
import {
  replaceManagerApplicationRowInCache,
  upsertApplicationRowToServerAwait,
} from "@/lib/manager-applications-storage";
import { mergeApplicationLeaseDatesIntoResidentRow } from "@/lib/resident-lease-billing-sync";
import { normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";
import {
  activeApplicationWizardSteps,
  applicationConfigForVariant,
} from "@/lib/rental-application/application-field-catalog";
import { getPropertyById } from "@/lib/rental-application/data";
import { maskPhoneInput, maskSsnInput } from "@/lib/rental-application/masks";
import {
  computeLeaseEndDate,
  normalizeIsoDateInput,
  shouldAutoComputeLeaseEnd,
} from "@/lib/rental-application/lease-dates";
import { resolveEditGroupId } from "@/lib/rental-application/application-groups";
import { rentalWizardStepTitle, RENTAL_WIZARD_STEP_TITLES } from "@/lib/rental-application/wizard-step-titles";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import type { RentalWizardErrors, RentalWizardFormState } from "@/lib/rental-application/types";
import { countValidationErrors, validateRentalWizardStep } from "@/lib/rental-application/validate";
import {
  RENTAL_WIZARD_STEP_FIELD_ORDER,
  scrollToFirstWizardFieldError,
} from "@/lib/wizard-field-errors";
import {
  activeWizardProgressPct,
  canNavigateToWizardStep,
  nextActiveWizardStep,
  nextWizardMaxReached,
  prevActiveWizardStep,
} from "@/lib/wizard-step-nav";

const EDIT_STEP_META = RENTAL_WIZARD_STEP_TITLES.slice(0, 11).map((title, index) => ({
  n: index + 1,
  title,
}));

const EDIT_STEP_COUNT = EDIT_STEP_META.length;

type Props = {
  row: DemoApplicantRow;
  residentEmail: string;
  onCancel: () => void;
  onSaved: (row: DemoApplicantRow) => void | Promise<void>;
  /** Manager edits keep bucket/stage; resident resubmit moves back to pending. */
  preserveReviewStatus?: boolean;
};

export function ResidentApplicationEditor({ row, residentEmail, onCancel, onSaved, preserveReviewStatus = false }: Props) {
  const { showToast } = useAppUi();
  const [step, setStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState<number>(EDIT_STEP_COUNT);
  const [form, setForm] = useState<RentalWizardFormState>(() => ({
    ...createInitialRentalWizardState(),
    ...(row.application ?? {}),
    email: residentEmail,
  }));
  const [errors, setErrors] = useState<RentalWizardErrors>({});
  const [saving, setSaving] = useState(false);
  const [occupancySyncEpoch] = useState(0);
  const [showAvailabilityWarnings, setShowAvailabilityWarnings] = useState(false);
  const [extrasTick, setExtrasTick] = useState(0);

  useEffect(() => {
    const on = () => setExtrasTick((n) => n + 1);
    void loadPublicExtraListingsFromServer().then(() => on());
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, []);

  const propertyOptions = useMemo(() => {
    const pid = form.propertyId.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
    if (!pid) return [];
    const prop = getPropertyById(pid);
    if (!prop) return [{ value: pid, label: row.property || pid }];
    return [{ value: prop.id, label: prop.title }];
  }, [form.propertyId, row.application?.propertyId, row.property, row.propertyId]);

  const activeSteps = useMemo(() => {
    void extrasTick;
    const pid = form.propertyId.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
    const prop = pid ? getPropertyById(pid) : undefined;
    const listingSub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
    return activeApplicationWizardSteps(
      applicationConfigForVariant(listingSub, applicationRentalTypeFor(form.rentalType)),
      normalizeCustomApplicationFields,
    ).filter((s) => s <= EDIT_STEP_COUNT);
  }, [extrasTick, form.propertyId, form.rentalType, row.application?.propertyId, row.propertyId]);
  const firstActiveStep = activeSteps[0] ?? 1;
  const lastActiveStep = activeSteps[activeSteps.length - 1] ?? EDIT_STEP_COUNT;
  const nextActiveStep = useCallback(
    (from: number) => nextActiveWizardStep(activeSteps, from),
    [activeSteps],
  );
  const prevActiveStep = useCallback(
    (from: number) => prevActiveWizardStep(activeSteps, from),
    [activeSteps],
  );

  const patchForm = useCallback(
    (p: Partial<RentalWizardFormState>) => {
      setForm((f) => {
        const merged: RentalWizardFormState = { ...f, ...p, email: residentEmail };
        if ("leaseStart" in p) merged.leaseStart = normalizeIsoDateInput(p.leaseStart);
        if ("leaseEnd" in p) merged.leaseEnd = p.leaseEnd ? normalizeIsoDateInput(p.leaseEnd) : "";
        if ("leaseTerm" in p && p.leaseTerm === "Month-to-Month") merged.leaseEnd = "";
        const endExplicit = "leaseEnd" in p;
        if (
          !endExplicit &&
          ("leaseTerm" in p || "leaseStart" in p) &&
          shouldAutoComputeLeaseEnd(merged.leaseTerm, merged.rentalType)
        ) {
          const computed = computeLeaseEndDate(merged.leaseStart, merged.leaseTerm);
          if (computed) merged.leaseEnd = computed;
        }
        return merged;
      });
      if (
        Object.keys(p).some((k) =>
          ["propertyId", "roomChoice1", "roomChoice2", "roomChoice3", "rentalType", "leaseTerm", "leaseStart", "leaseEnd"].includes(k),
        )
      ) {
        setShowAvailabilityWarnings(false);
      }
      setErrors((e) => {
        const next = { ...e };
        for (const key of Object.keys(p) as (keyof RentalWizardFormState)[]) {
          delete next[key];
        }
        if ("customFieldAnswers" in p) {
          for (const key of Object.keys(next)) if (key.startsWith("custom:")) delete next[key];
        }
        return next;
      });
    },
    [residentEmail],
  );

  const setPhoneMasked = useCallback((key: keyof RentalWizardFormState, next: string) => {
    setForm((f) => ({ ...f, [key]: maskPhoneInput(String(f[key] ?? ""), next), email: residentEmail }));
    setErrors((e) => ({ ...e, [key]: "" }));
  }, [residentEmail]);

  const setPhone = useCallback((next: string) => setPhoneMasked("phone", next), [setPhoneMasked]);
  const setLandlordPhone = useCallback((next: string) => setPhoneMasked("currentLandlordPhone", next), [setPhoneMasked]);
  const setPrevLandlordPhone = useCallback((next: string) => setPhoneMasked("prevLandlordPhone", next), [setPhoneMasked]);
  const setSupervisorPhone = useCallback((next: string) => setPhoneMasked("supervisorPhone", next), [setPhoneMasked]);
  const setRef1Phone = useCallback((next: string) => setPhoneMasked("ref1Phone", next), [setPhoneMasked]);
  const setRef2Phone = useCallback((next: string) => setPhoneMasked("ref2Phone", next), [setPhoneMasked]);

  const setSsn = useCallback((next: string) => {
    setForm((f) => ({ ...f, ssn: maskSsnInput(next), email: residentEmail }));
    setErrors((e) => ({ ...e, ssn: "" }));
  }, [residentEmail]);

  const goToStep = useCallback(
    (n: number) => {
      if (!canNavigateToWizardStep(n, maxStepReached)) return;
      setStep(n);
      setErrors({});
      if (n === 3) setShowAvailabilityWarnings(false);
    },
    [maxStepReached],
  );

  const editFromReview = useCallback(
    (n: number) => {
      if (!canNavigateToWizardStep(n, maxStepReached)) return;
      setStep(n);
      setErrors({});
      if (n === 3) setShowAvailabilityWarnings(false);
    },
    [maxStepReached],
  );

  const validateCurrentStep = useCallback(() => {
    const e = validateRentalWizardStep(step, form);
    if (countValidationErrors(e) > 0) {
      setErrors(e);
      queueMicrotask(() => scrollToFirstWizardFieldError(RENTAL_WIZARD_STEP_FIELD_ORDER[step] ?? [], e));
      return false;
    }
    return true;
  }, [form, step]);

  const validateAllPrior = useCallback(() => {
    for (let s = 1; s <= 10; s++) {
      const e = validateRentalWizardStep(s, form);
      if (countValidationErrors(e) > 0) {
        setErrors(e);
        setStep(s);
        showToast("Please review the highlighted fields before saving.");
        queueMicrotask(() => scrollToFirstWizardFieldError(RENTAL_WIZARD_STEP_FIELD_ORDER[s] ?? [], e));
        return false;
      }
    }
    return true;
  }, [form, showToast]);

  const handleContinue = useCallback(() => {
    if (step < lastActiveStep) {
      if (!validateCurrentStep()) return;
      const next = nextActiveStep(step);
      setStep(next);
      setMaxStepReached((m) => nextWizardMaxReached(m, next));
      setErrors({});
      return;
    }
    if (!validateAllPrior()) return;
    void (async () => {
      setSaving(true);
      const pid = form.propertyId.trim() || row.propertyId?.trim() || "";
      const prop = pid ? getPropertyById(pid) : undefined;
      const groupId = resolveEditGroupId(form, row.application?.groupId);
      const application = structuredClone({ ...form, email: residentEmail, groupId });
      const updated = mergeApplicationLeaseDatesIntoResidentRow(
        {
          ...row,
          name: form.fullLegalName.trim() || row.name,
          property: prop?.title?.trim() || row.property,
          propertyId: pid || row.propertyId,
          email: residentEmail,
          bucket: preserveReviewStatus ? row.bucket : "pending",
          stage: preserveReviewStatus ? row.stage : row.stage || "Submitted",
          detail: `Updated ${new Date().toLocaleString()}`,
        },
        application,
      );
      const result = await upsertApplicationRowToServerAwait(updated);
      setSaving(false);
      if (!result.ok) {
        showToast(result.error ?? "Could not save application.");
        return;
      }
      replaceManagerApplicationRowInCache(updated);
      showToast("Application saved.");
      await onSaved(updated);
    })();
  }, [form, lastActiveStep, nextActiveStep, onSaved, preserveReviewStatus, residentEmail, row, showToast, step, validateAllPrior, validateCurrentStep]);

  const handleBack = useCallback(() => {
    if (step <= firstActiveStep) {
      onCancel();
      return;
    }
    setStep(prevActiveStep(step));
    setErrors({});
  }, [firstActiveStep, onCancel, prevActiveStep, step]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      setForm({
        ...createInitialRentalWizardState(),
        ...(row.application ?? {}),
        email: residentEmail,
      });
      setStep(1);
      setMaxStepReached(EDIT_STEP_COUNT);
      setErrors({});
    });
  }, [residentEmail, row]);

  const meta = EDIT_STEP_META[step - 1] ?? EDIT_STEP_META[0];
  const applicationFeeGate = { needsFee: false, paid: true, displayLabel: "", amount: 0 };
  const progressPct = activeWizardProgressPct(activeSteps, step);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="border-b border-border pb-5">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted/70">
          {form.rentalType === "short_term" ? "Short-term stay application" : "Rental application"}
        </p>
        <p className="mt-1 text-lg font-bold tracking-tight text-foreground">{rentalWizardStepTitle(step, form)}</p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-accent/30 [html[data-theme=dark]_&]:bg-white/10">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${progressPct}%` }}
            aria-hidden="true"
          />
        </div>
      </div>

      <div className="mt-6">
        <RentalWizardStepBody
          step={step}
          form={form}
          errors={errors}
          mode="editor"
          propertyOptions={propertyOptions}
          propertyLocked={false}
          patch={patchForm}
          applicationFeeGate={applicationFeeGate}
          occupancySyncEpoch={occupancySyncEpoch}
          showAvailabilityWarnings={showAvailabilityWarnings}
          setPhone={setPhone}
          setLandlordPhone={setLandlordPhone}
          setPrevLandlordPhone={setPrevLandlordPhone}
          setSupervisorPhone={setSupervisorPhone}
          setRef1Phone={setRef1Phone}
          setRef2Phone={setRef2Phone}
          setSsn={setSsn}
          goToStep={goToStep}
          editFromReview={editFromReview}
          getApplicationId={() => row.id}
        />
      </div>

      <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        {step > firstActiveStep ? (
          <Button type="button" variant="outline" onClick={handleBack} disabled={saving}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="button" onClick={handleContinue} disabled={saving}>
          {saving ? "Saving…" : step >= lastActiveStep ? "Save application" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
