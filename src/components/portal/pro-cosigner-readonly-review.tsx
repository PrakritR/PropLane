"use client";

import { isWizardFormFieldEnabled, resolveListingApplicationFields, type ApplicationConfigSlice } from "@/lib/rental-application/application-field-catalog";
import { normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";
import { parseMultiSelectAnswer } from "@/lib/rental-application/custom-fields";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import {
  ManagerApplicationReadonlyReview,
  ReviewRow,
  ReviewSection,
} from "@/components/portal/pro-application-readonly-review";
import { applicationHasGroup } from "@/lib/rental-application/application-groups";
import { digitsOnly } from "@/lib/rental-application/masks";

const SIGNER_LISTING_OMIT_SECTIONS = [
  "placement",
  "group",
  "cosigner",
  "personal",
  "address",
  "employment",
  "references",
  "additional",
  "custom",
  "consent",
] as const;

function displayOrDash(v: string | null | undefined) {
  const t = (v ?? "").trim();
  return t ? t : <span className="text-muted">Not provided</span>;
}

function maskSsn(ssn: string) {
  const d = digitsOnly(ssn);
  if (d.length !== 9) return ssn.trim() || "Not provided";
  return `***-**-${d.slice(5)}`;
}

function bankruptcyLabel(value: string | undefined): string {
  if (value === "never") return "Never filed";
  if (value === "past_discharged") return "Past (discharged)";
  if (value === "current") return "Current / active";
  return "—";
}

function criminalLabel(value: string | undefined): string {
  if (value === "no") return "No";
  if (value === "yes") return "Yes";
  return "—";
}

function groupApplicationLabel(signerRow: DemoApplicantRow | undefined): string {
  const applying = signerRow?.application?.applyingAsGroup;
  if (applying === "yes") return "Yes";
  if (applying === "no") return "No";
  if (signerRow?.application && applicationHasGroup(signerRow.application)) return "Yes";
  return "—";
}

export function ManagerCosignerReadonlyReview({
  sub,
  signerRow,
  onOpenSignerApplication,
  questionConfig,
}: {
  sub: CosignerSubmission;
  /** Omitted for manager review; helpers use the submitted published version (null hides unknown questions). */
  questionConfig?: ApplicationConfigSlice | null;
  /** Primary applicant row — supplies listing/property cards beside the household panel. */
  signerRow?: DemoApplicantRow;
  /** Navigate to the primary applicant's application (same layout as the household co-signer link). */
  onOpenSignerApplication?: () => void;
}) {
  const show = (key: string) => questionConfig === undefined || (questionConfig ? isWizardFormFieldEnabled(questionConfig, key) : ["fullLegalName", "email"].includes(key));
  const anyShown = (...keys: string[]) => keys.some(show);
  const customQuestions = questionConfig ? resolveListingApplicationFields(questionConfig, normalizeCustomApplicationFields).filter((question) => !question.isStandard) : [];
  const signerName = sub.signerFullName?.trim() || signerRow?.name?.trim() || "";
  const signerEmail = signerRow?.email?.trim() || "";

  const addressLine = [sub.address, [sub.city, sub.state, sub.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="xl:columns-2 xl:gap-3 [&>*]:mb-3 [&>*]:break-inside-avoid" data-attr="cosigner-readonly-review">
      <ReviewSection title="Household" data-attr="cosigner-household-inline-panels">
        <ReviewRow
          k="Signer"
          v={
            signerName && onOpenSignerApplication ? (
              <button
                type="button"
                className="block w-full max-w-full text-left text-sm font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                data-attr="cosigner-signer-application-link"
                onClick={onOpenSignerApplication}
              >
                <span className="truncate">{signerName}</span>
                {signerEmail ? <span className="mt-0.5 block text-xs text-muted">{signerEmail}</span> : null}
              </button>
            ) : (
              displayOrDash(sub.signerFullName)
            )
          }
        />
        {questionConfig === undefined || signerRow ? <ReviewRow k="Group application" v={groupApplicationLabel(signerRow)} /> : null}
      </ReviewSection>

      {signerRow?.application ? (
        <ManagerApplicationReadonlyReview
          partial={signerRow.application}
          applicationId={signerRow.id}
          assignedPropertyId={signerRow.assignedPropertyId}
          assignedRoomChoice={signerRow.assignedRoomChoice}
          omitSections={[...SIGNER_LISTING_OMIT_SECTIONS]}
          embedded
        />
      ) : null}

      {anyShown("fullLegalName", "dateOfBirth", "ssn", "driversLicense", "phone", "email") ? (
      <ReviewSection title="Personal information">
        {show("fullLegalName") ? <ReviewRow k="Legal name" v={displayOrDash(sub.fullName)} /> : null}
        {show("dateOfBirth") ? <ReviewRow k="Date of birth" v={displayOrDash(sub.dob)} /> : null}
        {show("ssn") ? <ReviewRow k="SSN" v={maskSsn(sub.ssn)} /> : null}
        {show("driversLicense") && sub.dlNumber.trim() ? <ReviewRow k="ID number" v={displayOrDash(sub.dlNumber)} /> : null}
        {show("phone") ? <ReviewRow k="Phone" v={displayOrDash(sub.phone)} /> : null}
        {show("email") ? <ReviewRow k="Email" v={displayOrDash(sub.email)} /> : null}
      </ReviewSection>
      ) : null}

      {anyShown("currentStreet", "currentCity", "currentState", "currentZip") && addressLine.trim() ? (
        <ReviewSection title="Address history">
          <ReviewRow k="Current address" v={displayOrDash(addressLine)} />
        </ReviewSection>
      ) : null}

      {anyShown("employer", "employerAddress", "supervisorName", "supervisorPhone", "jobTitle", "employmentStart", "monthlyIncome", "annualIncome", "otherIncome") ? (
      <ReviewSection title="Employment">
        {questionConfig === undefined || anyShown("employer", "jobTitle", "monthlyIncome", "otherIncome") ? <ReviewRow k="Not employed" v={sub.notEmployed ? "Yes" : "No"} /> : null}
        {!sub.notEmployed ? (
          <>
            {show("employer") ? <ReviewRow k="Employer" v={displayOrDash(sub.employerName)} /> : null}
            {show("employerAddress") ? <ReviewRow k="Employer address" v={displayOrDash(sub.employerAddress)} /> : null}
            {anyShown("supervisorName", "supervisorPhone") && [sub.supervisorName, sub.supervisorPhone].some((v) => v.trim()) ? (
              <ReviewRow
                k="Supervisor"
                v={displayOrDash([sub.supervisorName, sub.supervisorPhone].filter(Boolean).join(" · "))}
              />
            ) : null}
            {show("jobTitle") ? <ReviewRow k="Job title" v={displayOrDash(sub.jobTitle)} /> : null}
            {show("employmentStart") ? <ReviewRow k="Employment start" v={displayOrDash(sub.employmentStart)} /> : null}
            {show("monthlyIncome") ? <ReviewRow k="Monthly income" v={displayOrDash(sub.monthlyIncome)} /> : null}
            {show("annualIncome") ? <ReviewRow k="Annual income" v={displayOrDash(sub.annualIncome)} /> : null}
          </>
        ) : null}
        {show("otherIncome") ? <ReviewRow k="Other income" v={displayOrDash(sub.otherIncome)} /> : null}
      </ReviewSection>
      ) : null}

      {anyShown("bankruptcyHistory", "criminalHistory", "consentCredit") ? (
      <ReviewSection title="Background">
        {show("bankruptcyHistory") ? <ReviewRow k="Bankruptcy" v={bankruptcyLabel(sub.bankruptcy)} /> : null}
        {show("criminalHistory") ? <ReviewRow k="Criminal convictions" v={criminalLabel(sub.criminal)} /> : null}
        {show("consentCredit") ? <ReviewRow k="Credit consent" v={sub.consentCredit ? "Authorized" : "Not checked"} /> : null}
      </ReviewSection>
      ) : null}

      {anyShown("digitalSignature", "dateSigned") ? (
      <ReviewSection title="Signature">
        {show("digitalSignature") ? <ReviewRow k="Signature" v={displayOrDash(sub.signature)} /> : null}
        {show("dateSigned") ? <ReviewRow k="Date signed" v={displayOrDash(sub.dateSigned)} /> : null}
      </ReviewSection>
      ) : null}
      {customQuestions.length ? <ReviewSection title="Additional answers">
        {customQuestions.map((question) => {
          const value = sub.customFieldAnswers?.find((answer) => answer.key === question.key)?.value ?? "";
          return <ReviewRow key={question.key} k={question.label} v={displayOrDash(question.type === "multi_select" ? parseMultiSelectAnswer(value).join(", ") : value)} />;
        })}
      </ReviewSection> : null}
    </div>
  );
}
