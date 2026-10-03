"use client";

import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  ManagerApplicationReadonlyReview,
  ReviewRow,
  ReviewSection,
} from "@/components/portal/pro-application-readonly-review";
import { getPropertyById, getRoomChoiceLabel, isPropertyRentedByRoom } from "@/lib/rental-application/data";
import { paymentAtSigningPriceLabel, utilitiesListingEstimateLabel } from "@/lib/rental-application/listing-fees-display";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { digitsOnly } from "@/lib/rental-application/masks";
import { applicationFeeLabelForSelection } from "@/lib/application-fee-by-room";
import { applicationRentalTypeFor } from "@/lib/rental-application/lease-terms";

function displayOrDash(v: string | null | undefined) {
  const t = (v ?? "").trim();
  return t ? t : <span className="text-muted">Not provided</span>;
}

/**
 * Grouped application fact cards (studio RR2) — one pencil per card opens the wizard at the owning step.
 */
export function ManagerResidentApplicationFactCards({
  row,
  assignedPropertyId,
  assignedRoomChoice,
  onEditStep,
}: {
  row: DemoApplicantRow;
  assignedPropertyId?: string;
  assignedRoomChoice?: string;
  onEditStep: (step: number) => void;
}) {
  const partial = row.application ?? {};
  const form: RentalWizardFormState = { ...createInitialRentalWizardState(), ...partial };
  const prop = getPropertyById(form.propertyId);
  const listing = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
  const roomLabel = (id: string) => getRoomChoiceLabel(id);
  const monthly = (form.monthlyIncome ?? "").trim();
  const monthlyNum = digitsOnly(monthly);
  const employed = Boolean(form.employer?.trim()) && form.notEmployed !== true;

  const left = (
    <>
      <ReviewSection title="Household" onEdit={() => onEditStep(1)} data-attr="resident-app-card-household">
        <ReviewRow k="Co-signer" v={form.hasCosigner === "yes" ? "Yes" : form.hasCosigner === "no" ? "No" : "—"} />
        <ReviewRow k="Group application" v={form.applyingAsGroup === "yes" ? "Yes" : form.applyingAsGroup === "no" ? "No" : "—"} />
      </ReviewSection>
      {listing ? (
        <ReviewSection title="Housing charges (listing)" onEdit={() => onEditStep(3)} data-attr="resident-app-card-housing">
          <ReviewRow
            k="Application fee"
            v={displayOrDash(
              applicationFeeLabelForSelection(listing, {
                roomChoice1: form.roomChoice1,
                leaseTerm: form.leaseTerm,
                rentalType: applicationRentalTypeFor(form.rentalType),
              }),
            )}
          />
          <ReviewRow k="Security deposit" v={displayOrDash(listing.securityDeposit)} />
          <ReviewRow k="Move-in fee" v={displayOrDash(listing.moveInFee)} />
          <ReviewRow k="Payment due at signing" v={displayOrDash(paymentAtSigningPriceLabel(listing))} />
          <ReviewRow k="Utilities (estimate, by room)" v={displayOrDash(utilitiesListingEstimateLabel(listing))} />
        </ReviewSection>
      ) : null}
      {assignedPropertyId || assignedRoomChoice ? (
        <ReviewSection title="Manager final placement" onEdit={() => onEditStep(3)}>
          <ReviewRow
            k="Assigned property"
            v={displayOrDash(assignedPropertyId ? getPropertyById(assignedPropertyId)?.title : "")}
          />
          <ReviewRow k="Assigned room" v={displayOrDash(roomLabel(assignedRoomChoice ?? ""))} />
        </ReviewSection>
      ) : null}
      <ReviewSection title="Property information" onEdit={() => onEditStep(3)} data-attr="resident-app-card-property">
        <ReviewRow k="Property" v={displayOrDash(prop?.title)} />
        {isPropertyRentedByRoom(form.propertyId) ? (
          <ReviewRow
            k="1st choice room"
            v={displayOrDash(
              roomLabel(form.roomChoice1)
                ? `${roomLabel(form.roomChoice1)}${listing ? "" : ""}`
                : "",
            )}
          />
        ) : (
          <ReviewRow k="Unit (whole-home lease)" v={displayOrDash(roomLabel(form.roomChoice1))} />
        )}
      </ReviewSection>
    </>
  );

  const right = (
    <>
      <ReviewSection title="Employment" onEdit={() => onEditStep(6)} data-attr="resident-app-card-employment">
        <ReviewRow k="Not employed" v={employed ? "No" : form.notEmployed ? "Yes" : "—"} />
        <ReviewRow k="Employer" v={employed ? displayOrDash(form.employer) : displayOrDash("")} />
        <ReviewRow k="Employer address" v={displayOrDash(form.employerAddress)} />
        <ReviewRow k="Supervisor" v={displayOrDash(form.supervisorName)} />
        <ReviewRow k="Job title" v={displayOrDash(form.jobTitle)} />
        <ReviewRow k="Employment start" v={displayOrDash(form.employmentStart)} />
        <ReviewRow k="Monthly income" v={monthlyNum ? `$${Number(monthlyNum).toLocaleString("en-US")}` : displayOrDash("")} />
        <ReviewRow
          k="Annual income"
          v={monthlyNum ? `$${(Number(monthlyNum) * 12).toLocaleString("en-US")}` : displayOrDash("")}
        />
        <ReviewRow k="Other income" v={displayOrDash(form.otherIncome)} />
      </ReviewSection>
      <ReviewSection title="References" onEdit={() => onEditStep(7)} data-attr="resident-app-card-references">
        <ReviewRow
          k="Reference 1"
          v={displayOrDash([form.ref1Name, form.ref1Relationship, form.ref1Phone].filter(Boolean).join(" · "))}
        />
        <ReviewRow
          k="Reference 2"
          v={displayOrDash([form.ref2Name, form.ref2Relationship, form.ref2Phone].filter(Boolean).join(" · "))}
        />
      </ReviewSection>
      <ReviewSection title="Additional details" onEdit={() => onEditStep(8)} data-attr="resident-app-card-additional">
        <ReviewRow k="Occupants" v={displayOrDash(String(form.occupancyCount || 1))} />
      </ReviewSection>
    </>
  );

  const custom = (
    <ManagerApplicationReadonlyReview
      partial={partial}
      applicationId={row.id}
      assignedPropertyId={assignedPropertyId}
      assignedRoomChoice={assignedRoomChoice}
      omitSections={[
        "group",
        "cosigner",
        "placement",
        "housing",
        "property",
        "personal",
        "address",
        "employment",
        "references",
        "additional",
      ]}
      embedded
    />
  );

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1 basis-[320px] space-y-4">{left}</div>
      <div className="min-w-0 flex-1 basis-[320px] space-y-4">{right}</div>
      {custom ? <div className="min-w-0 w-full space-y-4">{custom}</div> : null}
    </div>
  );
}
