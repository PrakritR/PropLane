"use client";

import { useState, type ReactNode } from "react";
import { getBundleChoiceLabel, getPropertyById, getRoomChoiceLabel, isPropertyRentedByRoom } from "@/lib/rental-application/data";
import { paymentAtSigningPriceLabel, utilitiesListingEstimateLabel } from "@/lib/rental-application/listing-fees-display";
import { formatLeaseDateLabel } from "@/lib/rental-application/lease-dates";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import type { RentalCustomFieldAnswer, RentalWizardFormState } from "@/lib/rental-application/types";
import {
  formatCustomFieldAnswerDisplay,
  groupCustomFieldAnswersBySection,
  isFileCustomFieldType,
  parseCustomFieldAttachment,
  parseMultiSelectAnswer,
} from "@/lib/rental-application/custom-fields";
import { digitsOnly } from "@/lib/rental-application/masks";
import { Badge } from "@/components/ui/badge";

function displayOrDash(v: string | null | undefined) {
  const t = (v ?? "").trim();
  return t ? t : <span className="text-muted">Not provided</span>;
}

function maskSsnReview(ssn: string) {
  const d = digitsOnly(ssn);
  if (d.length !== 9) return ssn.trim() || "Not provided";
  return `***-**-${d.slice(5)}`;
}

export function ReviewSection({
  title,
  children,
  "data-attr": dataAttr,
}: {
  title: string;
  children: ReactNode;
  "data-attr"?: string;
}) {
  return (
    // A detail card: bold title on the card itself, then label/value rows. The
    // grey header band and the tinted dl made every card read as a table.
    <section
      className="overflow-hidden rounded-2xl border border-border bg-card"
      data-attr={dataAttr}
    >
      <div className="px-4 pb-1 pt-3.5">
        <h3 className="text-[13.5px] font-bold tracking-tight text-foreground">{title}</h3>
      </div>
      <dl className="divide-y divide-border/60 px-4 pb-1.5 text-sm">{children}</dl>
    </section>
  );
}

export function ReviewRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-[13px] leading-5 text-muted sm:w-40">{k}</dt>
      <dd className="min-w-0 flex-1 break-words text-right text-[13.5px] font-semibold leading-5 text-foreground sm:text-left">{v}</dd>
    </div>
  );
}

/**
 * Manager-review thumbnail for a manager-defined `file`/`photos` question
 * answer. Falls back to a plain file-name chip when there is no application id
 * to build the authorized read URL from, or the attachment does not parse — it
 * must NEVER show a broken image.
 */
function CustomFieldAttachmentThumbnail({
  applicationId,
  fieldKey,
  fileName,
}: {
  applicationId?: string;
  fieldKey: string;
  fileName: string;
}) {
  const [failed, setFailed] = useState(false);
  const label = fileName || "File attached";
  if (!applicationId || failed) {
    return <span className="text-[13.5px] font-semibold text-foreground">{label}</span>;
  }
  const params = new URLSearchParams({ applicationId, slot: "custom", key: fieldKey });
  return (
    <div className="flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/portal/application-photos?${params.toString()}`}
        alt={label}
        onError={() => setFailed(true)}
        className="h-20 w-20 shrink-0 rounded-lg border border-border object-cover [html[data-theme=dark]_&]:border-white/12"
      />
      <span className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">{label}</span>
    </div>
  );
}

/**
 * Manager-review value for one custom question answer, rendered by its
 * snapshotted TYPE rather than as plain text. `formatCustomFieldAnswerDisplay`
 * still owns currency formatting and the plain-text fallback (its output is
 * also printed verbatim by the manager application PDF/HTML builders, so it
 * must never itself change to emit markup).
 */
function CustomAnswerValue({
  answer,
  applicationId,
}: {
  answer: RentalCustomFieldAnswer;
  applicationId?: string;
}) {
  if (answer.type === "yes_no") {
    const value = String(answer.value ?? "").trim();
    if (value !== "yes" && value !== "no") return displayOrDash("");
    return <Badge tone={value === "yes" ? "success" : "neutral"}>{value === "yes" ? "Yes" : "No"}</Badge>;
  }
  if (answer.type === "multi_select") {
    const selections = parseMultiSelectAnswer(answer.value);
    if (selections.length === 0) return displayOrDash("");
    return (
      <div className="flex flex-wrap justify-end gap-1.5 sm:justify-start">
        {selections.map((selection) => (
          <Badge key={selection} tone="neutral">
            {selection}
          </Badge>
        ))}
      </div>
    );
  }
  if (isFileCustomFieldType(answer.type) && parseCustomFieldAttachment(answer.value)) {
    return (
      <CustomFieldAttachmentThumbnail
        applicationId={applicationId}
        fieldKey={answer.key}
        fileName={formatCustomFieldAnswerDisplay(answer)}
      />
    );
  }
  // currency, checkbox, and every other type: plain text, same formatting as before.
  return displayOrDash(formatCustomFieldAnswerDisplay(answer));
}

export function ApplicationManagerPlacementCard({
  assignedPropertyId,
  assignedRoomChoice,
}: {
  assignedPropertyId?: string;
  assignedRoomChoice?: string;
}) {
  if (!assignedPropertyId && !assignedRoomChoice) return null;
  const assignedProperty = assignedPropertyId ? getPropertyById(assignedPropertyId) : undefined;
  return (
    <ReviewSection title="Manager final placement">
      <ReviewRow k="Assigned property" v={displayOrDash(assignedProperty?.title)} />
      <ReviewRow k="Assigned room" v={displayOrDash(getRoomChoiceLabel(assignedRoomChoice ?? ""))} />
    </ReviewSection>
  );
}

export function ApplicationCosignerPlannedCard({ hasCosigner }: { hasCosigner?: string | null }) {
  return (
    <ReviewSection title="Co-signer">
      <ReviewRow
        k="Co-signer planned"
        v={hasCosigner === "yes" ? "Yes" : hasCosigner === "no" ? "No" : "—"}
      />
    </ReviewSection>
  );
}

/** Read-only review matching the rental application “Review” step (step 11). */
export function ManagerApplicationReadonlyReview({
  partial,
  applicationId,
  assignedPropertyId,
  assignedRoomChoice,
  omitSections,
  embedded = false,
}: {
  partial: Partial<RentalWizardFormState>;
  /** Axis application id — required to render a manager-question file/photos thumbnail; text-only fallback without it. */
  applicationId?: string;
  assignedPropertyId?: string;
  assignedRoomChoice?: string;
  /** Hide roster-style sections when the parent already shows household cards above the toggle. */
  omitSections?: Array<
    | "group"
    | "cosigner"
    | "placement"
    | "housing"
    | "property"
    | "personal"
    | "address"
    | "employment"
    | "references"
    | "additional"
    | "custom"
    | "consent"
  >;
  /** When true, sections render without the outer 2-column grid (parent supplies the grid). */
  embedded?: boolean;
}) {
  const form: RentalWizardFormState = { ...createInitialRentalWizardState(), ...partial };
  const omit = new Set(omitSections ?? []);
  const prop = getPropertyById(form.propertyId);
  const roomLabel = (id: string) => getRoomChoiceLabel(id);

  const housingChargesSection = prop?.listingSubmission?.v === 1 ? (
    <ReviewSection title="Housing charges (listing)">
      <ReviewRow k="Application fee" v={displayOrDash(prop.listingSubmission.applicationFee)} />
      <ReviewRow k="Security deposit" v={displayOrDash(prop.listingSubmission.securityDeposit)} />
      <ReviewRow k="Move-in fee" v={displayOrDash(prop.listingSubmission.moveInFee)} />
      <ReviewRow k="Payment due at signing" v={displayOrDash(paymentAtSigningPriceLabel(prop.listingSubmission))} />
      <ReviewRow k="Utilities (estimate, by room)" v={displayOrDash(utilitiesListingEstimateLabel(prop.listingSubmission))} />
    </ReviewSection>
  ) : null;

  const sections = (
    <>
      {!omit.has("housing") ? housingChargesSection : null}
      {!omit.has("placement") && (assignedPropertyId || assignedRoomChoice) ? (
        <ApplicationManagerPlacementCard
          assignedPropertyId={assignedPropertyId}
          assignedRoomChoice={assignedRoomChoice}
        />
      ) : null}
      {!omit.has("group") ? (
      <ReviewSection title="Group application">
        <ReviewRow k="Applying as group" v={form.applyingAsGroup === "yes" ? "Yes" : form.applyingAsGroup === "no" ? "No" : "—"} />
        {form.applyingAsGroup === "yes" ? (
          <>
            <ReviewRow k="Role" v={form.groupRole === "first" ? "First applicant" : form.groupRole === "joining" ? "Joining group" : "—"} />
            {form.groupRole === "first" ? <ReviewRow k="Group size" v={displayOrDash(form.groupSize)} /> : null}
            {form.groupId?.trim() ? <ReviewRow k="PropLane Group ID" v={displayOrDash(form.groupId)} /> : null}
          </>
        ) : null}
      </ReviewSection>
      ) : null}
      {!omit.has("cosigner") ? (
      <ApplicationCosignerPlannedCard hasCosigner={form.hasCosigner} />
      ) : null}
      {!omit.has("property") ? (
      <ReviewSection title="Property information">
        <ReviewRow k="Property" v={displayOrDash(prop?.title)} />
        {form.bundleId.trim() ? (
          <ReviewRow k="Lease bundle" v={displayOrDash(getBundleChoiceLabel(form.propertyId, form.bundleId))} />
        ) : isPropertyRentedByRoom(form.propertyId) ? (
          <>
            <ReviewRow k="1st choice room" v={displayOrDash(roomLabel(form.roomChoice1))} />
            <ReviewRow k="2nd choice room" v={displayOrDash(roomLabel(form.roomChoice2))} />
            <ReviewRow k="3rd choice room" v={displayOrDash(roomLabel(form.roomChoice3))} />
          </>
        ) : (
          <ReviewRow k="Unit (whole-home lease)" v={displayOrDash(roomLabel(form.roomChoice1))} />
        )}
        <ReviewRow k="Lease term" v={displayOrDash(form.leaseTerm)} />
        <ReviewRow k="Lease start" v={displayOrDash(formatLeaseDateLabel(form.leaseStart) || form.leaseStart)} />
        {form.leaseTerm !== "Month-to-Month" ? (
          <ReviewRow k="Lease end" v={displayOrDash(formatLeaseDateLabel(form.leaseEnd) || form.leaseEnd)} />
        ) : null}
      </ReviewSection>
      ) : null}
      {!omit.has("personal") ? (
      <ReviewSection title="Personal information">
        <ReviewRow k="Legal name" v={displayOrDash(form.fullLegalName)} />
        <ReviewRow k="Date of birth" v={displayOrDash(form.dateOfBirth)} />
        <ReviewRow k="SSN" v={maskSsnReview(form.ssn)} />
        <ReviewRow k="ID number" v={displayOrDash(form.driversLicense)} />
        <ReviewRow k="Phone" v={displayOrDash(form.phone)} />
        <ReviewRow k="Email" v={displayOrDash(form.email)} />
      </ReviewSection>
      ) : null}
      {!omit.has("address") ? (
      <ReviewSection title="Address history">
        <ReviewRow
          k="Current address"
          v={displayOrDash(
            [form.currentStreet, [form.currentCity, form.currentState, form.currentZip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
          )}
        />
        <ReviewRow k="Landlord (current)" v={displayOrDash([form.currentLandlordName, form.currentLandlordPhone].filter(Boolean).join(" · "))} />
        <ReviewRow k="Move-in / move-out (current)" v={displayOrDash([form.currentMoveIn, form.currentMoveOut].filter(Boolean).join(" → "))} />
        <ReviewRow k="Reason for leaving (current)" v={displayOrDash(form.currentReasonLeaving)} />
        {form.noPreviousAddress ? (
          <ReviewRow k="Previous address" v="Not provided (none reported)" />
        ) : (
          <>
            <ReviewRow
              k="Previous address"
              v={displayOrDash(
                [form.prevStreet, [form.prevCity, form.prevState, form.prevZip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
              )}
            />
            <ReviewRow k="Landlord (previous)" v={displayOrDash([form.prevLandlordName, form.prevLandlordPhone].filter(Boolean).join(" · "))} />
            <ReviewRow k="Move-in / move-out (previous)" v={displayOrDash([form.prevMoveIn, form.prevMoveOut].filter(Boolean).join(" → "))} />
            <ReviewRow k="Reason for leaving (previous)" v={displayOrDash(form.prevReasonLeaving)} />
          </>
        )}
      </ReviewSection>
      ) : null}
      {!omit.has("employment") ? (
      <ReviewSection title="Employment">
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
      {!omit.has("references") ? (
      <ReviewSection title="References">
        <ReviewRow k="Reference 1" v={displayOrDash(`${form.ref1Name} · ${form.ref1Relationship} · ${form.ref1Phone}`)} />
        <ReviewRow
          k="Reference 2"
          v={form.ref2Name.trim() ? displayOrDash(`${form.ref2Name} · ${form.ref2Relationship} · ${form.ref2Phone}`) : displayOrDash("")}
        />
      </ReviewSection>
      ) : null}
      {!omit.has("additional") ? (
      <ReviewSection title="Additional details">
        <ReviewRow k="Occupants" v={displayOrDash(form.occupancyCount)} />
        <ReviewRow k="Pets" v={displayOrDash(form.pets)} />
        <ReviewRow k="Eviction" v={form.evictionHistory === "yes" ? `Yes: ${form.evictionDetails}` : form.evictionHistory === "no" ? "No" : "—"} />
        <ReviewRow k="Bankruptcy" v={form.bankruptcyHistory === "yes" ? `Yes: ${form.bankruptcyDetails}` : form.bankruptcyHistory === "no" ? "No" : "—"} />
        <ReviewRow k="Criminal history" v={form.criminalHistory === "yes" ? `Yes: ${form.criminalDetails}` : form.criminalHistory === "no" ? "No" : "—"} />
      </ReviewSection>
      ) : null}
      {!omit.has("custom")
        ? groupCustomFieldAnswersBySection(form.customFieldAnswers).map((group) => (
            <ReviewSection key={group.sectionId ?? "other-questions"} title={group.title}>
              {group.answers.map((answer) => (
                <ReviewRow
                  key={answer.key}
                  k={answer.label}
                  v={<CustomAnswerValue answer={answer} applicationId={applicationId} />}
                />
              ))}
            </ReviewSection>
          ))
        : null}
      {!omit.has("consent") ? (
      <ReviewSection title="Consent & signature">
        <ReviewRow k="Credit / background" v={form.consentCredit ? "Authorized" : "Not checked"} />
        <ReviewRow k="Accuracy confirmed" v={form.consentTruth ? "Yes" : "Not checked"} />
        <ReviewRow k="Signature" v={displayOrDash(form.digitalSignature)} />
        <ReviewRow k="Date signed" v={displayOrDash(form.dateSigned)} />
        <ReviewRow k="Application fee acknowledged" v={form.applicationFeeAcknowledged ? "Yes" : "No"} />
      </ReviewSection>
      ) : null}
    </>
  );

  if (embedded) return sections;
  return <div className="xl:columns-2 xl:gap-3 [&>*]:mb-3 [&>*]:break-inside-avoid">{sections}</div>;
}
