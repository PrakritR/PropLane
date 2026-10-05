"use client";

import { useEffect, useMemo, useState } from "react";
import { LinkedFormsFinishList, type LinkedFormListItem } from "@/components/marketing/linked-forms-finish-list";
import { fetchLinkedFormsForApplication } from "@/lib/linked-form-requests-client";
import { ResidentLifecycleStatusPanel } from "@/components/portal/resident-lifecycle-status-panel";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { useResidentManagerContacts } from "@/hooks/use-resident-manager-contacts";
import { useResidentPortalAxisContext } from "@/hooks/use-resident-portal-axis";
import {
  findApplicationFeeCharge,
  HOUSEHOLD_CHARGES_EVENT,
  isPendingUpfrontMoveInCharge,
  readChargesForResident,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import { residentVisibleCharges } from "@/lib/household-charge-visibility";
import {
  LEASE_PIPELINE_EVENT,
  findLeaseForResidentEmail,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { getPropertyById, getRoomChoiceLabel } from "@/lib/rental-application/data";
import { residentLifecycleInputFromApplicationRow } from "@/lib/resident-lifecycle-journey";
import { sumDueNowCents } from "@/lib/resident-due-now-balance";
import { formatResidentRentLabel } from "@/lib/resident-rent-label";

function longDate(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * One application read as the studio's status screen: the lifecycle input is
 * the application row plus the lease and move-in charges the resident can see,
 * so the six steps move on when the lease is signed and the costs are paid.
 */
export function ResidentApplicationStatusScreen({
  row,
  residentEmail,
  residentUserId,
  basePath,
}: {
  row: DemoApplicantRow;
  residentEmail: string;
  residentUserId: string | null;
  basePath: string;
}) {
  const { residentAxisId, profileManagerId, axisResolved } = useResidentPortalAxisContext();
  const contacts = useResidentManagerContacts();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    void Promise.allSettled([
      syncLeasePipelineFromServer(),
      syncHouseholdChargesFromServer(false, { skipReconcile: true }),
    ]).then(bump);
    window.addEventListener(LEASE_PIPELINE_EVENT, bump);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    return () => {
      window.removeEventListener(LEASE_PIPELINE_EVENT, bump);
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    };
  }, []);

  const view = useMemo(() => {
    void tick;
    const base = residentLifecycleInputFromApplicationRow(row, residentEmail, basePath);
    const leaseRow =
      residentEmail && axisResolved
        ? findLeaseForResidentEmail(residentEmail, { email: residentEmail, residentAxisId, profileManagerId })
        : null;
    const residentSigned = leaseRow?.status === "Manager Signature Pending" || leaseRow?.status === "Fully Signed";
    const countersigned = leaseRow?.status === "Fully Signed";
    const charges = residentEmail ? residentVisibleCharges(readChargesForResident(residentEmail, residentUserId)) : [];
    const moveInDue =
      sumDueNowCents(charges.filter((c) => c.status === "pending" && isPendingUpfrontMoveInCharge(c))) / 100;
    const moveInPaid = residentSigned && moveInDue <= 0;
    const propertyId = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
    const property = propertyId ? getPropertyById(propertyId) : undefined;
    const roomRaw = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
    const roomLabel = roomRaw ? (getRoomChoiceLabel(roomRaw).split(" · ")[0]?.trim() ?? "") : "";
    const homeName = property?.buildingName?.trim() || property?.title?.trim() || row.property?.split("·")[0]?.trim() || "";
    const feeCharge = propertyId
      ? findApplicationFeeCharge(row.email?.trim() || residentEmail, propertyId, row.residentUserId ?? null, row.id)
      : null;
    const feeStatus =
      feeCharge?.status === "paid" ? "Paid" : feeCharge?.status === "failed" ? "Declined" : feeCharge ? "Due" : "";
    return {
      input: {
        ...base,
        residentSignedLease: residentSigned,
        managerCountersigned: countersigned,
        moveInChargesPaid: moveInPaid,
        movedIn: countersigned && moveInPaid,
        moveInTotalLabel: moveInDue > 0 ? `$${moveInDue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : undefined,
        applicationFeeLabel: feeCharge && feeStatus !== "Paid" ? feeCharge.amountLabel : undefined,
      },
      moveIn: longDate(leaseRow?.application?.leaseStart ?? row.application?.leaseStart),
      rent: formatResidentRentLabel(leaseRow?.signedRentLabel) ?? "",
      home: [homeName, roomLabel].filter(Boolean).join(" · "),
      fee: feeCharge ? `${feeCharge.amountLabel} · ${feeStatus}` : "",
    };
  }, [tick, row, residentEmail, residentUserId, basePath, axisResolved, residentAxisId, profileManagerId]);

  const contact = contacts[0];
  const contactValue = [formatSmsPhoneLabel(contact?.phone), contact?.email?.trim()].filter(Boolean).join(" · ");

  return (
    <>
      <ResidentLifecycleStatusPanel
        input={view.input}
        workspaceName={contact?.managerName ?? null}
        summary={[
          { label: "Home", value: view.home },
          { label: "Move-in", value: view.moveIn },
          { label: "Rent", value: view.rent },
          { label: "Application fee", value: view.fee },
          { label: "Contact", value: contactValue },
        ]}
      />
      <ResidentApplicationOwedForms applicationId={row.id} className="mt-4" />
    </>
  );
}

/**
 * "N more forms to finish" for one application: the forms its answers owe (a co-signer form, a linked move-in
 * form), read from the same route the finish screen uses. Draws nothing when nothing is owed.
 */
export function ResidentApplicationOwedForms({ applicationId, className }: { applicationId: string; className?: string }) {
  const [forms, setForms] = useState<readonly LinkedFormListItem[]>([]);
  useEffect(() => {
    const id = applicationId.trim();
    if (!id) return;
    let cancelled = false;
    void fetchLinkedFormsForApplication(id).then((requests) => {
      if (!cancelled) setForms(requests);
    });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);
  return <LinkedFormsFinishList forms={forms} className={className} />;
}
