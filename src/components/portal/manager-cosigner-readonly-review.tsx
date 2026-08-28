"use client";

import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { ReviewRow, ReviewSection } from "@/components/portal/manager-application-readonly-review";
import { digitsOnly } from "@/lib/rental-application/masks";

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

export function ManagerCosignerReadonlyReview({
  sub,
  onOpenSignerApplication,
}: {
  sub: CosignerSubmission;
  /** Navigate to the primary applicant's application (same layout as the household co-signer link). */
  onOpenSignerApplication?: () => void;
}) {
  const signerName = sub.signerFullName?.trim() || "";

  const addressLine = [sub.address, [sub.city, sub.state, sub.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-3">
      <ReviewSection title="Household" data-attr="cosigner-household-inline-panels">
        <ReviewRow
          k="Signer"
          v={
            signerName && onOpenSignerApplication ? (
              <button
                type="button"
                className="text-left font-medium text-foreground underline-offset-2 hover:underline"
                data-attr="cosigner-signer-application-link"
                onClick={onOpenSignerApplication}
              >
                {signerName}
              </button>
            ) : (
              displayOrDash(sub.signerFullName)
            )
          }
        />
        <ReviewRow
          k="Submitted"
          v={sub.submittedAt ? new Date(sub.submittedAt).toLocaleString() : "—"}
        />
      </ReviewSection>

      <div className="grid gap-3 xl:grid-cols-2">
        <ReviewSection title="Personal information">
          <ReviewRow k="Legal name" v={displayOrDash(sub.fullName)} />
          <ReviewRow k="Date of birth" v={displayOrDash(sub.dob)} />
          <ReviewRow k="SSN" v={maskSsn(sub.ssn)} />
          {sub.dlNumber.trim() ? <ReviewRow k="ID number" v={displayOrDash(sub.dlNumber)} /> : null}
          <ReviewRow k="Phone" v={displayOrDash(sub.phone)} />
          <ReviewRow k="Email" v={displayOrDash(sub.email)} />
        </ReviewSection>

        {addressLine.trim() ? (
          <ReviewSection title="Address history">
            <ReviewRow k="Current address" v={displayOrDash(addressLine)} />
          </ReviewSection>
        ) : null}

        <ReviewSection title="Employment">
          <ReviewRow k="Not employed" v={sub.notEmployed ? "Yes" : "No"} />
          {!sub.notEmployed ? (
            <>
              <ReviewRow k="Employer" v={displayOrDash(sub.employerName)} />
              <ReviewRow k="Employer address" v={displayOrDash(sub.employerAddress)} />
              {[sub.supervisorName, sub.supervisorPhone].some((v) => v.trim()) ? (
                <ReviewRow
                  k="Supervisor"
                  v={displayOrDash([sub.supervisorName, sub.supervisorPhone].filter(Boolean).join(" · "))}
                />
              ) : null}
              <ReviewRow k="Job title" v={displayOrDash(sub.jobTitle)} />
              <ReviewRow k="Employment start" v={displayOrDash(sub.employmentStart)} />
              <ReviewRow k="Monthly income" v={displayOrDash(sub.monthlyIncome)} />
              <ReviewRow k="Annual income" v={displayOrDash(sub.annualIncome)} />
            </>
          ) : null}
          <ReviewRow k="Other income" v={displayOrDash(sub.otherIncome)} />
        </ReviewSection>

        <ReviewSection title="Background">
          <ReviewRow k="Bankruptcy" v={bankruptcyLabel(sub.bankruptcy)} />
          <ReviewRow k="Criminal convictions" v={criminalLabel(sub.criminal)} />
          <ReviewRow k="Credit consent" v={sub.consentCredit ? "Authorized" : "Not checked"} />
        </ReviewSection>

        <ReviewSection title="Signature">
          <ReviewRow k="Signature" v={displayOrDash(sub.signature)} />
          <ReviewRow k="Date signed" v={displayOrDash(sub.dateSigned)} />
        </ReviewSection>
      </div>
    </div>
  );
}
