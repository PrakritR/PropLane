import type { DemoApplicantRow } from "@/data/demo-portal";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import {
  resolveListingProrationForSlot,
  type ProratedFirstMonthComputeInput,
} from "@/lib/lease-first-period-proration";
import { normalizeManagerListingSubmissionV1, type ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { roomDailyRentPrice } from "@/lib/room-pricing";
import { getPropertyById } from "@/lib/rental-application/data";
import { intraMonthStaySpan } from "@/lib/short-term-stay-pricing";

function roomForApplicant(
  sub: ReturnType<typeof normalizeManagerListingSubmissionV1>,
  applicant: Pick<
    DemoApplicantRow,
    "assignedRoomChoice" | "application" | "manualResidentDetails" | "signedMonthlyRent"
  >,
  unitLabel?: string | null,
): ManagerRoomSubmission | null {
  return (
    resolveSubmissionRoom(sub, {
      roomChoices: [applicant.assignedRoomChoice, applicant.application?.roomChoice1],
      unitLabel: unitLabel ?? applicant.manualResidentDetails?.roomNumber,
      signedMonthlyRent: applicant.signedMonthlyRent,
    }) ?? null
  );
}

/** Proration method and daily rates for a placed resident — mirrors household-charges. */
export function resolveLeaseProrationInputForApplicant(
  applicant: Pick<
    DemoApplicantRow,
    | "assignedPropertyId"
    | "propertyId"
    | "application"
    | "assignedRoomChoice"
    | "manualResidentDetails"
    | "signedMonthlyRent"
  >,
): Pick<ProratedFirstMonthComputeInput, "method" | "dailyRentRate" | "dailyUtilitiesRate" | "utilitiesOnly"> {
  const propertyId =
    applicant.assignedPropertyId?.trim() ||
    applicant.propertyId?.trim() ||
    applicant.application?.propertyId?.trim() ||
    "";
  const prop = propertyId ? getPropertyById(propertyId) : undefined;
  const sub = prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  if (!sub) return {};

  const room = roomForApplicant(sub, applicant, prop?.unitLabel);
  const listingProration = resolveListingProrationForSlot(
    sub,
    room,
    applicant.application?.residentSlot,
    applicant.application?.leaseTerm,
  );
  const prorateMethod = listingProration.method;
  const dailyRentRate = listingProration.dailyRentRate;
  const dailyUtilitiesRate = listingProration.dailyUtilitiesRate;
  const dailyBasisRate = roomDailyRentPrice(room);
  const leaseStart = applicant.application?.leaseStart?.trim() ?? "";
  const leaseEnd = applicant.application?.leaseEnd?.trim() ?? "";
  const endsInsideFirstMonth = intraMonthStaySpan(leaseStart, leaseEnd) !== null;

  return {
    method: prorateMethod,
    dailyRentRate,
    dailyUtilitiesRate,
    utilitiesOnly: (dailyBasisRate ?? 0) > 0 && !endsInsideFirstMonth,
  };
}
