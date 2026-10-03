import type { DemoApplicantRow } from "@/data/demo-portal";
import { findApplicationFeeCharge } from "@/lib/household-charges";

export type ApplicationFeeStatus = {
  paid: boolean;
  declined: boolean;
  needsPayment: boolean;
};

/** Derive application-fee state from the household charge row (same store as Payments). */
export function applicationFeeStatusForRow(
  row: DemoApplicantRow,
  residentEmail: string,
): ApplicationFeeStatus {
  if (row.manuallyAdded || row.application?.applicationFeeWaived) {
    return { paid: true, declined: false, needsPayment: false };
  }
  const propertyId = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const email = (row.email?.trim() || residentEmail || row.application?.email || "").trim().toLowerCase();
  if (!propertyId || !email.includes("@")) {
    return { paid: false, declined: false, needsPayment: false };
  }
  const charge = findApplicationFeeCharge(email, propertyId, row.residentUserId ?? null, row.id);
  if (!charge) {
    const submitted = row.bucket !== "pending" || Boolean(row.application?.digitalSignature?.trim());
    return { paid: false, declined: false, needsPayment: submitted };
  }
  if (charge.status === "paid") {
    return { paid: true, declined: false, needsPayment: false };
  }
  if (charge.status === "failed") {
    return { paid: false, declined: true, needsPayment: true };
  }
  return { paid: false, declined: false, needsPayment: true };
}

export function aggregateApplicationFeeStatus(
  rows: readonly DemoApplicantRow[],
  residentEmail: string,
): ApplicationFeeStatus {
  if (!rows.length) return { paid: false, declined: false, needsPayment: false };
  let anyDeclined = false;
  let anyNeeds = false;
  let allPaid = true;
  for (const row of rows) {
    const status = applicationFeeStatusForRow(row, residentEmail);
    if (status.declined) anyDeclined = true;
    if (status.needsPayment && !status.paid) anyNeeds = true;
    if (!status.paid && !status.declined) allPaid = false;
    if (status.declined) allPaid = false;
  }
  if (anyDeclined) return { paid: false, declined: true, needsPayment: true };
  if (allPaid && rows.some((r) => applicationFeeStatusForRow(r, residentEmail).paid)) {
    return { paid: true, declined: false, needsPayment: false };
  }
  return { paid: false, declined: false, needsPayment: anyNeeds };
}
