"use client";

import type { Dispatch, SetStateAction } from "react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { clearCosignerDraft, loadCosignerDraft, saveCosignerDraft } from "@/lib/rental-application/drafts";
import { todayISO } from "@/lib/rental-application/state";
import {
  validateDateRequired,
  validateEmail,
  validateFullName,
  validateMoney,
  validatePhone10,
  validateRequired,
  validateSsn,
} from "./apply-validation";
import { ApplyFieldRow } from "./apply-field-row";
import { submitCosignerToServerAwait } from "@/lib/cosigner-submissions-storage";
import { fetchCosignerSignerLinkPreview } from "@/lib/rental-application/cosigner-signer-link-client";
import { nextWizardMaxReached, activeWizardProgressPct } from "@/lib/wizard-step-nav";
import {
  COSIGNER_STEP_FIELD_ORDER,
  scrollToFirstWizardFieldError,
} from "@/lib/wizard-field-errors";

const COSIGNER_ACTIVE_STEPS = [1, 2, 3, 4, 5] as const;

export type CosignerApplicationKind = "long-term" | "short-term";

export function cosignerApplicationEyebrow(_kind?: CosignerApplicationKind): string {
  return "Co-signer application";
}

const COSIGNER_STEP_META = [
  { n: 1, title: "Link to signer" },
  { n: 2, title: "Personal information" },
  { n: 3, title: "Employment" },
  { n: 4, title: "Background & consent" },
  { n: 5, title: "Signature" },
] as const;

type CosignerFields = {
  signerAppId: string;
  signerFullName: string;
  fullName: string;
  email: string;
  phone: string;
  dob: string;
  dlNumber: string;
  ssn: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  notEmployed: boolean;
  employerName: string;
  employerAddress: string;
  supervisorName: string;
  supervisorPhone: string;
  jobTitle: string;
  monthlyIncome: string;
  annualIncome: string;
  employmentStart: string;
  otherIncome: string;
  bankruptcy: string;
  criminal: string;
  consentCredit: boolean;
  signature: string;
  dateSigned: string;
};

function emptyCosigner(): CosignerFields {
  return {
    signerAppId: "",
    signerFullName: "",
    fullName: "",
    email: "",
    phone: "",
    dob: "",
    dlNumber: "",
    ssn: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    notEmployed: false,
    employerName: "",
    employerAddress: "",
    supervisorName: "",
    supervisorPhone: "",
    jobTitle: "",
    monthlyIncome: "",
    annualIncome: "",
    employmentStart: "",
    otherIncome: "",
    bankruptcy: "",
    criminal: "",
    consentCredit: false,
    signature: "",
    dateSigned: todayISO(),
  };
}

function patchField(setF: Dispatch<SetStateAction<CosignerFields>>, key: keyof CosignerFields, value: string | boolean) {
  setF((prev) => ({ ...prev, [key]: value } as CosignerFields));
}

const errRing = "border-red-500 ring-2 ring-red-100";

export function CosignerApplyFlow({
  onBack,
  onDone,
  previewMode = false,
  embedded = false,
  showToast,
  applicationKind = "long-term",
  initialSignerAppId = "",
  initialSignerFullName = "",
}: {
  onBack: () => void;
  /** Called from the success screen when the user finishes (e.g. navigate back to the main application). */
  onDone?: () => void;
  /** Manager template preview — no draft persistence or server submit. */
  previewMode?: boolean;
  embedded?: boolean;
  showToast?: (message: string) => void;
  applicationKind?: CosignerApplicationKind;
  /** Prefill from a resident-portal invite link (`?signerAppId=`). */
  initialSignerAppId?: string;
  initialSignerFullName?: string;
}) {
  const [step, setStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [f, setF] = useState<CosignerFields>(() => {
    const base = (() => {
      if (previewMode) return emptyCosigner();
      const draft = loadCosignerDraft<CosignerFields>();
      return draft ? { ...emptyCosigner(), ...draft } : emptyCosigner();
    })();
    return {
      ...base,
      signerAppId: base.signerAppId.trim() || initialSignerAppId.trim(),
      signerFullName: base.signerFullName.trim() || initialSignerFullName.trim(),
    };
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [draftReady] = useState(true);
  const [signerPreviewLoading, setSignerPreviewLoading] = useState(Boolean(initialSignerAppId.trim()));
  const [signerLinkError, setSignerLinkError] = useState<string | null>(null);
  const [postSubmit, setPostSubmit] = useState<{
    linkedAxisId: string;
    linkedSignerName: string;
    cosignerName: string;
    syncError?: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!draftReady || previewMode) return;
    saveCosignerDraft(f);
  }, [draftReady, f, previewMode]);

  useEffect(() => {
    if (previewMode) return;
    const signerAppId = initialSignerAppId.trim() || f.signerAppId.trim();
    if (!signerAppId || signerAppId.length < 4) {
      setSignerPreviewLoading(false);
      setSignerLinkError(null);
      return;
    }
    let cancelled = false;
    setSignerPreviewLoading(true);
    void fetchCosignerSignerLinkPreview(signerAppId).then((preview) => {
      if (cancelled) return;
      setSignerPreviewLoading(false);
      if (!preview.ok) {
        setSignerLinkError(preview.message);
        return;
      }
      setSignerLinkError(null);
      setF((prev) => {
        const nextSignerAppId = prev.signerAppId.trim() || preview.signerAppId;
        const nextSignerName = prev.signerFullName.trim() || preview.signerFullName?.trim() || "";
        if (prev.signerAppId === nextSignerAppId && prev.signerFullName === nextSignerName) return prev;
        return {
          ...prev,
          signerAppId: nextSignerAppId,
          signerFullName: nextSignerName,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [draftReady, f.signerAppId, initialSignerAppId, previewMode]);

  const clearError = (key: string) => {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const progress = useMemo(
    () => activeWizardProgressPct(COSIGNER_ACTIVE_STEPS, step),
    [step],
  );

  const stepTitle = COSIGNER_STEP_META[step - 1]?.title ?? "Co-signer form";
  const eyebrow = cosignerApplicationEyebrow(applicationKind);

  const validateStep1 = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (signerLinkError) {
      errs.signerAppId = signerLinkError;
    }
    const id = f.signerAppId.trim();
    const name = f.signerFullName.trim();
    if (!id && !name) {
      const msg = "Enter an application ID or the signer’s full name.";
      errs.signerAppId = msg;
      errs.signerFullName = msg;
    } else {
      if (name) {
        const r = validateFullName(name);
        if (!r.ok) errs.signerFullName = r.message;
      }
      if (id && id.length < 4) errs.signerAppId = "Application ID looks too short.";
    }
    setFieldErrors(errs);
    return errs;
  };

  const validateStep2 = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    const n = validateFullName(f.fullName);
    if (!n.ok) errs.fullName = n.message;
    const e = validateEmail(f.email);
    if (!e.ok) errs.email = e.message;
    const ph = validatePhone10(f.phone);
    if (!ph.ok) errs.phone = ph.message;
    const dob = validateDateRequired(f.dob, "Date of birth");
    if (!dob.ok) errs.dob = dob.message;
    const ssn = validateSsn(f.ssn);
    if (!ssn.ok) errs.ssn = ssn.message;
    setFieldErrors(errs);
    return errs;
  };

  const validateStep3 = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (f.notEmployed) {
      const o = validateMoney(f.otherIncome, "Other / non-employment income");
      if (!o.ok) errs.otherIncome = o.message;
      setFieldErrors(errs);
      return errs;
    }
    const en = validateRequired(f.employerName, "Employer name");
    if (!en.ok) errs.employerName = en.message;
    const jt = validateRequired(f.jobTitle, "Job title");
    if (!jt.ok) errs.jobTitle = jt.message;
    const mi = validateMoney(f.monthlyIncome, "Monthly income");
    if (!mi.ok) errs.monthlyIncome = mi.message;
    setFieldErrors(errs);
    return errs;
  };

  const validateStep4 = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!f.bankruptcy) errs.bankruptcy = "Select a bankruptcy history option.";
    if (!f.criminal) errs.criminal = "Select a criminal convictions option.";
    if (!f.consentCredit) errs.consentCredit = "Consent for credit and background check is required.";
    setFieldErrors(errs);
    return errs;
  };

  const validateStep5 = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    const sig = validateFullName(f.signature);
    if (!sig.ok) {
      errs.signature = sig.message === "Name is required." ? "Co-signer signature is required." : sig.message;
    }
    const d = validateDateRequired(f.dateSigned, "Date signed");
    if (!d.ok) errs.dateSigned = d.message;
    setFieldErrors(errs);
    return errs;
  };

  const handleContinue = async () => {
    if (signerLinkError) {
      setFieldErrors({ signerAppId: signerLinkError });
      return;
    }
    if (step === 1) {
      if (signerPreviewLoading) return;
      const errs1 = validateStep1();
      if (Object.keys(errs1).length > 0) {
        queueMicrotask(() => scrollToFirstWizardFieldError(COSIGNER_STEP_FIELD_ORDER[1] ?? [], errs1));
        return;
      }
      const signerAppId = f.signerAppId.trim();
      if (signerAppId.length >= 4) {
        const preview = await fetchCosignerSignerLinkPreview(signerAppId);
        if (!preview.ok) {
          setSignerLinkError(preview.message);
          setFieldErrors({ signerAppId: preview.message });
          queueMicrotask(() =>
            scrollToFirstWizardFieldError(COSIGNER_STEP_FIELD_ORDER[1] ?? [], { signerAppId: preview.message }),
          );
          return;
        }
        setSignerLinkError(null);
      }
    }
    if (step === 2) {
      const errs2 = validateStep2();
      if (Object.keys(errs2).length > 0) {
        queueMicrotask(() => scrollToFirstWizardFieldError(COSIGNER_STEP_FIELD_ORDER[2] ?? [], errs2));
        return;
      }
    }
    if (step === 3) {
      const errs3 = validateStep3();
      if (Object.keys(errs3).length > 0) {
        queueMicrotask(() => scrollToFirstWizardFieldError(COSIGNER_STEP_FIELD_ORDER[3] ?? [], errs3));
        return;
      }
    }
    if (step === 4) {
      const errs4 = validateStep4();
      if (Object.keys(errs4).length > 0) {
        queueMicrotask(() => scrollToFirstWizardFieldError(COSIGNER_STEP_FIELD_ORDER[4] ?? [], errs4));
        return;
      }
    }
    if (step === 5) {
      const errs5 = validateStep5();
      if (Object.keys(errs5).length > 0) {
        queueMicrotask(() => scrollToFirstWizardFieldError(COSIGNER_STEP_FIELD_ORDER[5] ?? [], errs5));
        return;
      }
      const linkedAxisId = f.signerAppId.trim();
      const linkedSignerName = f.signerFullName.trim();
      const cosignerName = f.fullName.trim();
      if (previewMode) {
        showToast?.("Preview only — co-signers submit from the shared apply link.");
        return;
      }
      if (linkedAxisId.length >= 4) {
        const preview = await fetchCosignerSignerLinkPreview(linkedAxisId);
        if (!preview.ok) {
          setSignerLinkError(preview.message);
          setFieldErrors({ submit: preview.message });
          return;
        }
      }
      if (submitting) return;
      setSubmitting(true);
      const submission = { ...f, signerAppId: linkedAxisId, submittedAt: new Date().toISOString() };
      const sync = await submitCosignerToServerAwait(submission);
      setSubmitting(false);
      if (!sync.ok) {
        setFieldErrors({ submit: sync.error ?? "Could not save co-signer form." });
        return;
      }
      clearCosignerDraft();
      setF(emptyCosigner());
      setStep(1);
      setMaxStepReached(1);
      setFieldErrors({});
      setPostSubmit({ linkedAxisId, linkedSignerName, cosignerName });
      return;
    }
    setFieldErrors({});
    const next = step + 1;
    setStep(next);
    setMaxStepReached((m) => nextWizardMaxReached(m, next));
  };

  const handleBack = () => {
    setFieldErrors({});
    if (step <= 1) onBack();
    else setStep((s) => s - 1);
  };

  const err = (key: keyof CosignerFields | string) => (fieldErrors[key] ? errRing : "");

  const resetAfterSuccess = () => {
    setPostSubmit(null);
    setF(emptyCosigner());
    setStep(1);
    setMaxStepReached(1);
    setFieldErrors({});
  };

  if (postSubmit) {
    const displayAxis = postSubmit.linkedAxisId ? normalizeApplicationAxisId(postSubmit.linkedAxisId) : "";
    return (
      <div
        className="mt-8 rounded-3xl border p-6 portal-banner-success shadow-[0_24px_80px_-32px_rgba(15,23,42,0.18)] sm:p-9 md:p-11"
        style={{ boxShadow: "0 24px 80px -32px rgba(15,23,42,0.18), 0 1px 0 rgba(255,255,255,0.9) inset" }}
      >
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-800/80">Co-signer form received</p>
        <h2 className="mt-2 text-xl font-bold tracking-tight text-foreground sm:text-2xl">Thank you, you&apos;re all set</h2>
        <p className="mt-3 text-sm leading-relaxed text-foreground">
          Your co-signer details are on file and linked to the primary application. The property manager can review everything under{" "}
          <strong className="text-foreground">Property Portal → Applications</strong> on the primary applicant&apos;s record. The
          primary applicant does not need to resubmit.
        </p>
        <div className="mt-6 space-y-4 rounded-2xl border border-border bg-card px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Linked primary application</p>
          {displayAxis ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted/70">Application ID</p>
              <p className="mt-1 font-mono text-lg font-bold tracking-tight text-foreground sm:text-xl">{displayAxis}</p>
            </div>
          ) : postSubmit.linkedSignerName ? (
            <p className="text-sm font-medium text-foreground">
              Signer name: <span className="text-foreground">{postSubmit.linkedSignerName}</span>
            </p>
          ) : (
            <p className="text-sm text-muted">Linked using the primary applicant&apos;s application ID or signer name from step 1.</p>
          )}
          {postSubmit.cosignerName ? (
            <p className="border-t border-border pt-3 text-sm text-foreground">
              Co-signer: <span className="font-semibold text-foreground">{postSubmit.cosignerName}</span>
            </p>
          ) : null}
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button
            type="button"
            variant="outline"
            className="min-h-[48px] px-8"
            onClick={() => {
              resetAfterSuccess();
            }}
          >
            Submit another co-signer
          </Button>
          <Button
            type="button"
            className="min-h-[48px] px-8"
            onClick={() => {
              resetAfterSuccess();
              onDone?.();
            }}
          >
            Back to rental application
          </Button>
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          <Link href="/rent/apply" className="font-semibold text-primary underline-offset-4 hover:underline">
            Main application home
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div
      className={
        embedded
          ? "rental-wizard-cosigner"
          : "mt-8 rounded-3xl border border-border bg-card p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.18)] sm:p-9 md:p-11"
      }
      style={
        embedded
          ? undefined
          : { boxShadow: "0 24px 80px -32px rgba(15,23,42,0.18), 0 1px 0 rgba(255,255,255,0.9) inset" }
      }
    >
      <div className="rental-wizard-step-header border-b border-border pb-4 sm:pb-6">
        <p className="rental-wizard-step-eyebrow text-[10px] font-bold uppercase tracking-[0.18em] text-muted/70 sm:text-[11px]">
          {eyebrow}
        </p>
        <p className="rental-wizard-step-title mt-1 text-lg font-bold tracking-tight text-foreground sm:text-xl">
          {stepTitle}
        </p>
        <div className="rental-wizard-progress mt-3 h-1.5 overflow-hidden rounded-full bg-accent/30 sm:mt-4 sm:h-2 [html[data-theme=dark]_&]:bg-white/10">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%` }}
            aria-hidden="true"
          />
        </div>
      </div>

      <div className="rental-wizard-step-content pt-5 sm:pt-8">
        {step === 1 ? (
          <>
            <div className="divide-y divide-slate-100">
              {signerPreviewLoading ? (
                <p className="pb-3 text-xs text-muted">Checking invite link…</p>
              ) : null}
              {signerLinkError ? (
                <p className="pb-3 text-sm font-medium text-red-600">{signerLinkError}</p>
              ) : null}
              <Field fieldKey="signerAppId" label="Signer Application ID" optional hint="Recommended if you have their application ID." error={fieldErrors.signerAppId}>
                <Input
                  value={f.signerAppId}
                  onChange={(e) => {
                    patchField(setF, "signerAppId", e.target.value);
                    clearError("signerAppId");
                  }}
                  placeholder="PROPLANE-XXXXXXXX"
                  className={err("signerAppId")}
                />
              </Field>
              <Field fieldKey="signerFullName" label="Signer Full Name" optional hint="Use this when you do not have the application ID." error={fieldErrors.signerFullName}>
                <Input
                  value={f.signerFullName}
                  onChange={(e) => {
                    patchField(setF, "signerFullName", e.target.value);
                    clearError("signerFullName");
                  }}
                  placeholder="First Last"
                  className={err("signerFullName")}
                />
              </Field>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="divide-y divide-slate-100">
              <Field fieldKey="fullName" label="Full name" hint="First and last name required." error={fieldErrors.fullName}>
                <Input
                  value={f.fullName}
                  onChange={(e) => {
                    patchField(setF, "fullName", e.target.value);
                    clearError("fullName");
                  }}
                  className={err("fullName")}
                />
              </Field>
              <Field fieldKey="email" label="Email" error={fieldErrors.email}>
                <Input
                  type="email"
                  value={f.email}
                  onChange={(e) => {
                    patchField(setF, "email", e.target.value);
                    clearError("email");
                  }}
                  className={err("email")}
                />
              </Field>
              <Field fieldKey="phone" label="Phone number" hint="10 digits" error={fieldErrors.phone}>
                <Input
                  type="tel"
                  value={f.phone}
                  onChange={(e) => {
                    patchField(setF, "phone", e.target.value);
                    clearError("phone");
                  }}
                  placeholder="(206) 555-0100"
                  className={err("phone")}
                />
              </Field>
              <Field fieldKey="dob" label="Date of birth" error={fieldErrors.dob}>
                <Input
                  type="date"
                  value={f.dob}
                  onChange={(e) => {
                    patchField(setF, "dob", e.target.value);
                    clearError("dob");
                  }}
                  className={err("dob")}
                />
              </Field>
              <Field fieldKey="ssn" label="Social Security #" hint="9 digits: ###-##-####" error={fieldErrors.ssn}>
                <Input
                  value={f.ssn}
                  onChange={(e) => {
                    patchField(setF, "ssn", e.target.value);
                    clearError("ssn");
                  }}
                  placeholder="123-45-6789"
                  className={err("ssn")}
                />
              </Field>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div className="divide-y divide-slate-100">
              <ApplyFieldRow label="Not employed" optional hint="Check if you are not currently working.">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={f.notEmployed}
                    onChange={(e) => {
                      patchField(setF, "notEmployed", e.target.checked);
                      setFieldErrors({});
                    }}
                    className="h-4 w-4 rounded border-border text-primary"
                  />
                  I am not currently employed
                </label>
              </ApplyFieldRow>

            {f.notEmployed ? (
                <Field
                  fieldKey="otherIncome"
                  label="Other / non-employment income ($)"
                  hint="e.g. rental income, investments, disability"
                  error={fieldErrors.otherIncome}
                >
                  <Input
                    value={f.otherIncome}
                    onChange={(e) => {
                      patchField(setF, "otherIncome", e.target.value);
                      clearError("otherIncome");
                    }}
                    placeholder="0"
                    className={err("otherIncome")}
                  />
                </Field>
            ) : (
              <>
                <Field fieldKey="employerName" label="Employer name" error={fieldErrors.employerName}>
                    <Input
                      value={f.employerName}
                      onChange={(e) => {
                        patchField(setF, "employerName", e.target.value);
                        clearError("employerName");
                      }}
                      className={err("employerName")}
                    />
                  </Field>
                  <Field fieldKey="jobTitle" label="Job title" error={fieldErrors.jobTitle}>
                    <Input
                      value={f.jobTitle}
                      onChange={(e) => {
                        patchField(setF, "jobTitle", e.target.value);
                        clearError("jobTitle");
                      }}
                      className={err("jobTitle")}
                    />
                  </Field>
                <Field fieldKey="monthlyIncome" label="Monthly income ($)" error={fieldErrors.monthlyIncome}>
                    <Input
                      value={f.monthlyIncome}
                      onChange={(e) => {
                        patchField(setF, "monthlyIncome", e.target.value);
                        clearError("monthlyIncome");
                      }}
                      placeholder="0"
                      className={err("monthlyIncome")}
                    />
                  </Field>
              </>
            )}
            </div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <div className="divide-y divide-slate-100">
              <Field fieldKey="bankruptcy" label="Bankruptcy history" error={fieldErrors.bankruptcy}>
                <Select
                  value={f.bankruptcy}
                  onChange={(e) => {
                    patchField(setF, "bankruptcy", e.target.value);
                    clearError("bankruptcy");
                  }}
                  className={err("bankruptcy")}
                >
                  <option value="">Select…</option>
                  <option value="never">Never filed</option>
                  <option value="past_discharged">Past bankruptcy (discharged)</option>
                  <option value="current">Current / active</option>
                </Select>
              </Field>
              <Field fieldKey="criminal" label="Criminal convictions" error={fieldErrors.criminal}>
                <Select
                  value={f.criminal}
                  onChange={(e) => {
                    patchField(setF, "criminal", e.target.value);
                    clearError("criminal");
                  }}
                  className={err("criminal")}
                >
                  <option value="">Select…</option>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </Select>
              </Field>
              <ApplyFieldRow
                fieldKey="consentCredit"
                label="Consent for credit and background check"
                error={fieldErrors.consentCredit}
                className="rounded-xl border border-border bg-accent/30 px-3 sm:grid-cols-1"
              >
                <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={f.consentCredit}
                    onChange={(e) => {
                      patchField(setF, "consentCredit", e.target.checked);
                      clearError("consentCredit");
                    }}
                    className="mt-0.5 h-4 w-4 rounded border-border text-primary"
                  />
                  I consent to a credit and background check.
                </label>
              </ApplyFieldRow>
            </div>
          </>
        ) : null}

        {step === 5 ? (
          <>
            <div className="divide-y divide-slate-100">
              <Field fieldKey="signature" label="Co-Signer Signature" error={fieldErrors.signature}>
                <Input
                  value={f.signature}
                  onChange={(e) => {
                    patchField(setF, "signature", e.target.value);
                    clearError("signature");
                  }}
                  placeholder="Type your full legal name"
                  className={err("signature")}
                />
              </Field>
              <Field fieldKey="dateSigned" label="Date signed" error={fieldErrors.dateSigned}>
                <Input
                  type="date"
                  value={f.dateSigned}
                  onChange={(e) => {
                    patchField(setF, "dateSigned", e.target.value);
                    clearError("dateSigned");
                  }}
                  className={err("dateSigned")}
                />
              </Field>
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-10 flex flex-col-reverse gap-3 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="outline" className="w-full min-h-[48px] sm:w-auto sm:min-w-[120px]" onClick={handleBack}>
          Back
        </Button>
        <Button
          type="button"
          className="w-full min-h-[48px] sm:w-auto sm:min-w-[200px]"
          onClick={handleContinue}
          disabled={submitting || (step === 1 && (signerPreviewLoading || Boolean(signerLinkError)))}
        >
          {submitting ? "Submitting…" : step === 5 ? "Submit co-signer form" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
  className = "",
  optional = false,
  fieldKey,
}: {
  label: string;
  hint?: string;
  /** Inline validation message shown under the control */
  error?: string;
  children: React.ReactNode;
  className?: string;
  /** When false, shows a blue asterisk like the signer application mockups */
  optional?: boolean;
  fieldKey?: string;
}) {
  return (
    <ApplyFieldRow label={label} hint={hint} error={error} optional={optional} className={className} fieldKey={fieldKey}>
      {children}
    </ApplyFieldRow>
  );
}
