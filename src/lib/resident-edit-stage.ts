import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow, LeaseWorkflowStatus } from "@/lib/lease-pipeline-storage";

export type ResidentEditStage =
  | "applicant"
  | "lease_draft"
  | "lease_sent"
  | "signed"
  | "by_hand"
  | "moved_out";

export const RESIDENT_EDIT_STAGE_LABEL: Record<ResidentEditStage, string> = {
  applicant: "Applicant",
  lease_draft: "Lease draft",
  lease_sent: "Lease sent",
  signed: "Signed lease",
  by_hand: "Added by hand",
  moved_out: "Moved out",
};

const SENT_STATUSES: LeaseWorkflowStatus[] = ["Resident Signature Pending", "Manager Signature Pending"];
const DRAFT_STATUSES: LeaseWorkflowStatus[] = ["Draft", "Manager Review", "Admin Review"];

export type ResidentEditBaseline = {
  name: string;
  email: string;
  phone: string;
  preferredContact: "email" | "sms";
  propertyId: string;
  roomId: string;
  bundleId: string;
  leaseTerm: string;
  moveInDate: string;
  moveOutDate: string;
  rent: string;
  utilities: string;
  moveInFee: string;
  securityDeposit: string;
  otherFeeLabel: string;
  otherFeeAmount: string;
  rentDueDay: string;
  billingStart: string;
  applicationJson: string;
};

export type ResidentEditDiff = {
  contact: string[];
  email: boolean;
  home: string[];
  lease: string[];
  app: boolean;
  any: boolean;
};

export type ResidentEditSaveWillRow = {
  tone: "ok" | "warn" | "none";
  text: string;
};

const CONTACT_KEYS = ["name", "phone", "preferredContact"] as const;
const HOME_KEYS = ["propertyId", "roomId", "bundleId"] as const;
const LEASE_KEYS = [
  "leaseTerm",
  "moveInDate",
  "moveOutDate",
  "rent",
  "utilities",
  "securityDeposit",
  "moveInFee",
  "rentDueDay",
  "otherFeeLabel",
  "otherFeeAmount",
  "billingStart",
] as const;

function norm(value: unknown): string {
  return String(value ?? "").trim();
}

function pickPrimaryLease(rows: LeasePipelineRow[], email: string): LeasePipelineRow | null {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const active = rows.filter(
    (r) => r.residentEmail.trim().toLowerCase() === e && r.status !== "Voided" && !r.voidedAt,
  );
  if (!active.length) return null;
  const signed = active.filter((r) => r.status === "Fully Signed");
  const pool = signed.length ? signed : active;
  return [...pool].sort((a, b) => (b.updatedAtIso ?? "").localeCompare(a.updatedAtIso ?? ""))[0] ?? null;
}

function leaseIsMovedOut(lease: LeasePipelineRow | null, moveOutDate: string, isPastDirectory: boolean): boolean {
  if (isPastDirectory) return true;
  const end = moveOutDate.trim() || lease?.application?.leaseEnd?.trim() || "";
  if (!end) return false;
  const today = new Date().toISOString().slice(0, 10);
  return end < today;
}

function hasPipelineSignatures(lease: LeasePipelineRow): boolean {
  return Boolean(lease.residentSignature || lease.managerSignature || lease.fullySignedAt);
}

export function resolveResidentEditStage(input: {
  row: DemoApplicantRow;
  leaseRows: LeasePipelineRow[];
  directoryStage?: "potential" | "current" | "past";
}): {
  stage: ResidentEditStage;
  label: string;
  lease: LeasePipelineRow | null;
  signedAtIso: string | null;
} {
  const email = input.row.email?.trim() ?? "";
  const lease = pickPrimaryLease(input.leaseRows, email);
  const moveOut =
    input.row.manualResidentDetails?.moveOutDate?.trim() ||
    input.row.application?.leaseEnd?.trim() ||
    "";
  const isPastDirectory = input.directoryStage === "past";
  const movedOut = isPastDirectory || leaseIsMovedOut(lease, moveOut, isPastDirectory);

  let stage: ResidentEditStage = "applicant";
  let signedAtIso: string | null = null;

  if (movedOut) {
    stage = "moved_out";
  } else if (lease) {
    if (DRAFT_STATUSES.includes(lease.status)) stage = "lease_draft";
    else if (SENT_STATUSES.includes(lease.status)) stage = "lease_sent";
    else if (lease.status === "Fully Signed" || lease.bucket === "signed") {
      signedAtIso = lease.fullySignedAt ?? lease.residentSignedAt ?? lease.managerSignedAt ?? null;
      if (input.row.manuallyAdded && (lease.externallySignedLease || !hasPipelineSignatures(lease))) {
        stage = "by_hand";
      } else {
        stage = "signed";
      }
    }
  }

  return { stage, label: RESIDENT_EDIT_STAGE_LABEL[stage], lease, signedAtIso };
}

export function snapshotResidentEditBaseline(form: {
  name: string;
  email: string;
  phone: string;
  preferredContact: "email" | "sms";
  propertyId: string;
  roomId: string;
  bundleId: string;
  leaseTerm: string;
  moveInDate: string;
  moveOutDate: string;
  rent: string;
  utilities: string;
  moveInFee: string;
  securityDeposit: string;
  otherFeeLabel: string;
  otherFeeAmount: string;
  rentDueDay: string;
  billingStart: string;
  application: Record<string, unknown>;
}): ResidentEditBaseline {
  return {
    name: form.name,
    email: form.email,
    phone: form.phone,
    preferredContact: form.preferredContact,
    propertyId: form.propertyId,
    roomId: form.roomId,
    bundleId: form.bundleId,
    leaseTerm: form.leaseTerm,
    moveInDate: form.moveInDate,
    moveOutDate: form.moveOutDate,
    rent: form.rent,
    utilities: form.utilities,
    moveInFee: form.moveInFee,
    securityDeposit: form.securityDeposit,
    otherFeeLabel: form.otherFeeLabel,
    otherFeeAmount: form.otherFeeAmount,
    rentDueDay: form.rentDueDay,
    billingStart: form.billingStart,
    applicationJson: JSON.stringify(form.application ?? {}),
  };
}

export function diffResidentEdit(
  baseline: ResidentEditBaseline,
  form: {
    name: string;
    email: string;
    phone: string;
    preferredContact: "email" | "sms";
    propertyId: string;
    roomId: string;
    bundleId: string;
    leaseTerm: string;
    moveInDate: string;
    moveOutDate: string;
    rent: string;
    utilities: string;
    moveInFee: string;
    securityDeposit: string;
    otherFeeLabel: string;
    otherFeeAmount: string;
    rentDueDay: string;
    billingStart: string;
    application: Record<string, unknown>;
  },
): ResidentEditDiff {
  const differs = (key: keyof ResidentEditBaseline) => norm(baseline[key]) !== norm(form[key as keyof typeof form]);

  const contact: string[] = [];
  for (const k of CONTACT_KEYS) {
    if (differs(k)) contact.push(k);
  }
  const email = norm(baseline.email) !== norm(form.email);
  const home: string[] = [];
  for (const k of HOME_KEYS) {
    if (differs(k)) home.push(k);
  }
  const lease: string[] = [];
  for (const k of LEASE_KEYS) {
    if (differs(k)) lease.push(k);
  }
  const app = baseline.applicationJson !== JSON.stringify(form.application ?? {});

  const any = contact.length > 0 || email || home.length > 0 || lease.length > 0 || app;
  return { contact, email, home, lease, app, any };
}

export function isResidentEditFieldLocked(stage: ResidentEditStage, fieldKey: string): boolean {
  const homeOrLease =
    HOME_KEYS.includes(fieldKey as (typeof HOME_KEYS)[number]) ||
    LEASE_KEYS.includes(fieldKey as (typeof LEASE_KEYS)[number]) ||
    fieldKey === "leaseTerm" ||
    fieldKey === "rent" ||
    fieldKey === "utilities" ||
    fieldKey === "securityDeposit" ||
    fieldKey === "moveInFee" ||
    fieldKey === "moveInDate" ||
    fieldKey === "moveOutDate";

  if (stage === "signed") return homeOrLease;
  if (stage === "moved_out") {
    if (fieldKey === "moveOutDate") return false;
    return homeOrLease || fieldKey.startsWith("application") || fieldKey === "name" || fieldKey === "email";
  }
  return false;
}

export function residentEditLeaseTermsChanged(diff: ResidentEditDiff): boolean {
  return diff.home.length > 0 || diff.lease.length > 0;
}

export function residentEditRequiresVoidConfirm(stage: ResidentEditStage, diff: ResidentEditDiff): boolean {
  return stage === "lease_sent" && residentEditLeaseTermsChanged(diff);
}

export function residentEditSaveWill(
  stage: ResidentEditStage,
  diff: ResidentEditDiff,
  moveOutDate?: string,
): ResidentEditSaveWillRow[] {
  if (!diff.any) return [{ tone: "none", text: "Nothing changed" }];

  const rows: ResidentEditSaveWillRow[] = [];
  const leaseTerms = residentEditLeaseTermsChanged(diff);

  if (diff.contact.length || diff.email) rows.push({ tone: "ok", text: "Resident record updated" });
  if (diff.email) rows.push({ tone: "warn", text: "Charges, rent schedule and lease move to the new email" });

  if (stage === "applicant") {
    if (leaseTerms || diff.app) rows.push({ tone: "ok", text: "Application terms updated" });
    rows.push({ tone: "none", text: "No lease or charges yet" });
  } else {
    if (stage === "lease_draft" && leaseTerms) rows.push({ tone: "ok", text: "Lease draft regenerated" });
    if (stage === "lease_sent" && leaseTerms) {
      rows.push({ tone: "warn", text: "Sent lease voided, new draft to resend" });
    }
    if (stage === "by_hand" && leaseTerms) {
      rows.push({ tone: "ok", text: "Unpaid charges rebuilt · paid kept" });
    }
    if (stage === "moved_out" && diff.lease.includes("moveOutDate")) {
      rows.push({
        tone: "ok",
        text: `Unpaid rent after ${moveOutDate?.trim() || "the new date"} removed`,
      });
    }
    if (diff.app) rows.push({ tone: "ok", text: "Application answers updated" });
    if (stage === "signed") rows.push({ tone: "none", text: "Signed lease untouched" });
  }

  return rows;
}

export type ResidentEditReviewLine = { label: string; before: string; after: string };

const REVIEW_LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  preferredContact: "Contact preference",
  propertyId: "Property",
  roomId: "Room",
  bundleId: "Bundle",
  leaseTerm: "Lease term",
  moveInDate: "Move-in",
  moveOutDate: "Move-out",
  rent: "Rent",
  utilities: "Utilities",
  securityDeposit: "Deposit",
  moveInFee: "Move-in fee",
  rentDueDay: "Rent due day",
  otherFeeLabel: "Other fee",
  otherFeeAmount: "Other fee amount",
  billingStart: "Billing start",
};

export function residentEditReviewLines(
  baseline: ResidentEditBaseline,
  form: ResidentEditBaseline,
): ResidentEditReviewLine[] {
  const lines: ResidentEditReviewLine[] = [];
  const keys = [
    "name",
    "email",
    "phone",
    "preferredContact",
    "propertyId",
    "roomId",
    "bundleId",
    "leaseTerm",
    "moveInDate",
    "moveOutDate",
    "rent",
    "utilities",
    "securityDeposit",
    "moveInFee",
    "rentDueDay",
    "otherFeeLabel",
    "otherFeeAmount",
    "billingStart",
  ] as const;
  for (const key of keys) {
    const before = norm(baseline[key]);
    const after = norm(form[key]);
    if (before !== after) {
      lines.push({ label: REVIEW_LABELS[key] ?? key, before: before || "—", after: after || "—" });
    }
  }
  if (baseline.applicationJson !== form.applicationJson) {
    lines.push({ label: "Application", before: "Previous answers", after: "Updated answers" });
  }
  return lines;
}
