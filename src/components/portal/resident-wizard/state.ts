/**
 * Add resident / Add prospect — the form and the pure functions around it.
 *
 * One object replaces the twenty-five `ar*` useStates the old modal carried.
 * `buildManualResidentRow` is that modal's row builder, lifted here unchanged
 * for the inputs it already had and extended to write the application answers
 * the wizard now collects in the applicant's own shape (`RentalWizardFormState`),
 * so the resident's Application tab, screening and lease generation read them
 * with no change.
 *
 * Nothing here touches the DOM or the network; the wizard component owns that.
 */

import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalCustomFieldAnswer, RentalWizardFormState } from "@/lib/rental-application/types";
import { resolveManualResidentAssignment } from "@/lib/rental-application/placement-values";
import { residentLeaseTermToApplicationFields } from "@/lib/resident-manual-lease-terms";
import { resolveResidentOnboardingStage, type ResidentLeaseFiling } from "@/lib/resident-onboarding/resolve-onboarding-stage";
import type { AttachedDocument, MessageDraft } from "@/components/portal/add-workspace/parts";

export type AddPersonKind = "resident" | "prospect";
export type FieldMarkKind = "fromFile" | "check";
export type PaymentRowStatus = "paid" | "due" | "partial";
export type BillingStart = "move_in" | "next_due";
export type LeaseDocumentChoice = "signed" | "draft" | "later";

/** The application answers a manager may fill — the applicant's keys, minus SSN, consent, signature and fee. */
export const MANAGER_APPLICATION_TEXT_KEYS = [
  "dateOfBirth",
  "driversLicense",
  "currentStreet",
  "currentCity",
  "currentState",
  "currentZip",
  "currentLandlordName",
  "currentLandlordPhone",
  "currentMoveIn",
  "currentMoveOut",
  "currentReasonLeaving",
  "prevStreet",
  "prevCity",
  "prevState",
  "prevZip",
  "prevLandlordName",
  "prevLandlordPhone",
  "prevMoveIn",
  "prevMoveOut",
  "prevReasonLeaving",
  "employer",
  "employerAddress",
  "supervisorName",
  "supervisorPhone",
  "jobTitle",
  "monthlyIncome",
  "annualIncome",
  "employmentStart",
  "otherIncome",
  "ref1Name",
  "ref1Relationship",
  "ref1Phone",
  "ref2Name",
  "ref2Relationship",
  "ref2Phone",
  "occupancyCount",
  "pets",
  "evictionHistory",
  "evictionDetails",
  "bankruptcyHistory",
  "bankruptcyDetails",
  "criminalHistory",
  "criminalDetails",
] as const;

export type ManagerApplicationTextKey = (typeof MANAGER_APPLICATION_TEXT_KEYS)[number];
export type ApplicationAnswers = Partial<Record<ManagerApplicationTextKey, string>> & {
  notEmployed?: boolean;
  noPreviousAddress?: boolean;
};

export type PaymentMark = {
  status: PaymentRowStatus;
  /** yyyy-mm-dd */
  paidOn: string;
  method: string;
  /** Partial only — what was actually received. */
  partialAmount?: string;
};

export type AddPersonForm = {
  kind: AddPersonKind;
  // Contact
  name: string;
  email: string;
  phone: string;
  preferredContact: "email" | "sms";
  // Home
  propertyId: string;
  roomId: string;
  bundleId: string;
  // Prospect only
  wantedMoveIn: string;
  budget: string;
  prospectNotes: string;
  // Tour (prospect)
  tourFormat: "in_person" | "virtual" | "none";
  tourDate: string;
  tourStart: string;
  tourDurationMinutes: string;
  tourNotes: string;
  // Application
  application: ApplicationAnswers;
  customAnswers: Record<string, string>;
  vehicles: number;
  // Lease
  leaseTerm: string;
  leaseTermCustomMode: boolean;
  moveInDate: string;
  moveOutDate: string;
  rent: string;
  utilities: string;
  moveInFee: string;
  securityDeposit: string;
  otherFeeLabel: string;
  otherFeeAmount: string;
  rentDueDay: "1" | "15" | "last";
  leaseDocument: LeaseDocumentChoice;
  leaseFile: File | null;
  leaseDataUrl: string;
  leaseFileName: string;
  // Payments
  billingStart: BillingStart;
  paymentMarks: Record<string, PaymentMark>;
  depositPaid: boolean;
  moveInFeePaid: boolean;
  oneTimePaidOn: string;
  oneTimeMethod: string;
  // Documents
  documents: AttachedDocument[];
  // Parse marks — which fields a file filled, until the manager edits them.
  marks: Record<string, FieldMarkKind>;
  // Message
  message: MessageDraft;
  notes: string;
};

export const PAYMENT_METHOD_OPTIONS = [
  { value: "card", label: "Card" },
  { value: "bank", label: "Bank transfer" },
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

export function emptyAddPersonForm(kind: AddPersonKind = "resident"): AddPersonForm {
  return {
    kind,
    name: "",
    email: "",
    phone: "",
    preferredContact: "email",
    propertyId: "",
    roomId: "",
    bundleId: "",
    wantedMoveIn: "",
    budget: "",
    prospectNotes: "",
    tourFormat: "in_person",
    tourDate: "",
    tourStart: "",
    tourDurationMinutes: "30",
    tourNotes: "",
    application: {},
    customAnswers: {},
    vehicles: 0,
    leaseTerm: "",
    leaseTermCustomMode: false,
    moveInDate: "",
    moveOutDate: "",
    rent: "",
    utilities: "",
    moveInFee: "",
    securityDeposit: "",
    otherFeeLabel: "",
    otherFeeAmount: "",
    rentDueDay: "1",
    leaseDocument: "signed",
    leaseFile: null,
    leaseDataUrl: "",
    leaseFileName: "",
    billingStart: "move_in",
    paymentMarks: {},
    depositPaid: true,
    moveInFeePaid: true,
    oneTimePaidOn: "",
    oneTimeMethod: "card",
    documents: [],
    marks: {},
    message: { channels: ["email"], subject: "", body: "" },
    notes: "",
  };
}

/** True once anything has been typed or attached — close asks before discarding. */
export function addPersonFormIsDirty(form: AddPersonForm): boolean {
  const blank = emptyAddPersonForm(form.kind);
  const keys: (keyof AddPersonForm)[] = [
    "name", "email", "phone", "propertyId", "roomId", "bundleId", "wantedMoveIn", "budget", "prospectNotes",
    "tourDate", "tourStart", "tourNotes", "leaseTerm", "moveInDate", "moveOutDate", "rent", "utilities",
    "moveInFee", "securityDeposit", "otherFeeLabel", "otherFeeAmount", "leaseFileName", "notes",
  ];
  if (keys.some((k) => form[k] !== blank[k])) return true;
  if (form.documents.length > 0 || form.vehicles > 0) return true;
  if (Object.values(form.application).some((v) => (typeof v === "string" ? v.trim() : Boolean(v)))) return true;
  if (Object.values(form.customAnswers).some((v) => v.trim())) return true;
  return false;
}

/* ─────────────────────────── the row ─────────────────────────── */

function moneyOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export type BuildRowContext = {
  userId: string | null;
  propertyLabelFor: (propertyId: string) => string | undefined;
  /** Today's timestamp — injectable so the parity test is deterministic. */
  now?: () => Date;
  idSuffix?: () => string;
};

export type BuildRowResult = { ok: true; row: DemoApplicantRow } | { ok: false; error: string };

function leaseFilingFor(form: AddPersonForm): ResidentLeaseFiling {
  const hasPdf = Boolean(form.leaseDataUrl.trim());
  if (!hasPdf) return "none";
  return form.leaseDocument === "draft" ? "draft" : form.leaseDocument === "signed" ? "signed" : "none";
}

/** The application answers, in the applicant's shape. Only what was filled is written. */
export function applicationAnswersForRow(form: AddPersonForm): Partial<RentalWizardFormState> {
  const out: Record<string, unknown> = {};
  for (const key of MANAGER_APPLICATION_TEXT_KEYS) {
    const value = form.application[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  if (form.application.notEmployed) out.notEmployed = true;
  if (form.application.noPreviousAddress) out.noPreviousAddress = true;
  return out as Partial<RentalWizardFormState>;
}

export function customAnswersForRow(
  form: AddPersonForm,
  questions: readonly { key: string; label: string; type: RentalCustomFieldAnswer["type"]; section?: string }[],
): RentalCustomFieldAnswer[] {
  const out: RentalCustomFieldAnswer[] = [];
  for (const q of questions) {
    const value = form.customAnswers[q.key]?.trim();
    if (!value) continue;
    out.push({ key: q.key, label: q.label, type: q.type, section: q.section, value } as RentalCustomFieldAnswer);
  }
  return out;
}

/**
 * Build the application row for a current resident.
 *
 * Identical to the old modal's `buildManualResidentRow` for the fields it had;
 * the application answers, vehicles and preferred contact are the additions.
 */
export function buildManualResidentRow(
  form: AddPersonForm,
  ctx: BuildRowContext,
  customQuestions: readonly { key: string; label: string; type: RentalCustomFieldAnswer["type"]; section?: string }[] = [],
): BuildRowResult {
  if (!form.name.trim()) return { ok: false, error: "Enter the resident's name." };
  if (!form.email.trim()) return { ok: false, error: "Enter the resident's email." };
  const rent = moneyOrNull(form.rent);
  const leaseFields = residentLeaseTermToApplicationFields(form.leaseTerm, form.leaseTermCustomMode, form.propertyId);
  const shortTerm = leaseFields.rentalType === "short_term";
  const airbnb = leaseFields.rentalType === "airbnb";
  if (airbnb) {
    if (!form.moveInDate.trim() || !form.moveOutDate.trim()) return { ok: false, error: "Airbnb stays require move-in and move-out dates." };
    if (form.moveOutDate <= form.moveInDate) return { ok: false, error: "Move-out must be after move-in." };
  }
  const utilities = shortTerm || airbnb ? null : moneyOrNull(form.utilities);
  const moveInFee = moneyOrNull(form.moveInFee);
  const secDeposit = moneyOrNull(form.securityDeposit);
  const now = ctx.now ?? (() => new Date());
  const axisId = `PROPLANE-${(ctx.idSuffix ?? (() => Date.now().toString(36).toUpperCase().slice(-8)))()}`;
  const propLabel = form.propertyId ? (ctx.propertyLabelFor(form.propertyId) ?? form.propertyId) : "—";
  const placement = resolveManualResidentAssignment({ propertyId: form.propertyId, roomId: form.roomId, bundleId: form.bundleId });
  const selectedRoomLabel = placement.placementLabel?.trim() || "";
  const hasUploadedLeasePdf = Boolean(form.leaseDataUrl.trim());
  const signedLeaseUploadedAt = hasUploadedLeasePdf ? now().toISOString() : undefined;
  const leaseFiling = leaseFilingFor(form);
  const onboarding = resolveResidentOnboardingStage({
    name: form.name,
    email: form.email,
    propertyId: form.propertyId,
    roomChoice: placement.assignedRoomChoice,
    monthlyRent: rent ?? null,
    leaseFiling,
  });
  const answers = applicationAnswersForRow(form);
  const custom = customAnswersForRow(form, customQuestions);
  const otherFee = moneyOrNull(form.otherFeeAmount);

  const application =
    leaseFields.leaseTerm
      ? ({
          propertyId: form.propertyId || undefined,
          roomChoice1: placement.assignedRoomChoice,
          bundleId: placement.bundleId,
          leaseTerm: leaseFields.leaseTerm,
          rentalType: leaseFields.rentalType,
          leaseStart: form.moveInDate || undefined,
          leaseEnd: form.moveOutDate || undefined,
          fullLegalName: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
          ...(otherFee && form.otherFeeLabel.trim()
            ? { managerOtherCostLabel: form.otherFeeLabel.trim(), managerOtherCostAmount: String(otherFee) }
            : {}),
          ...answers,
          ...(custom.length ? { customFieldAnswers: custom } : {}),
        } as unknown as DemoApplicantRow["application"])
      : Object.keys(answers).length || custom.length
        ? ({
            propertyId: form.propertyId || undefined,
            fullLegalName: form.name.trim(),
            email: form.email.trim(),
            phone: form.phone.trim() || undefined,
            ...answers,
            ...(custom.length ? { customFieldAnswers: custom } : {}),
          } as unknown as DemoApplicantRow["application"])
        : undefined;

  const row: DemoApplicantRow = {
    id: axisId,
    name: form.name.trim(),
    email: form.email.trim(),
    property: propLabel,
    stage: onboarding.stage,
    bucket: onboarding.bucket,
    detail: "",
    assignedPropertyId: form.propertyId || undefined,
    assignedRoomChoice: placement.assignedRoomChoice,
    signedMonthlyRent: rent ?? undefined,
    managerUserId: ctx.userId ?? undefined,
    manuallyAdded: true,
    manualResidentDetails: {
      phone: form.phone.trim() || undefined,
      moveInDate: form.moveInDate || undefined,
      moveOutDate: form.moveOutDate || undefined,
      monthlyUtilities: utilities ?? undefined,
      moveInFee: moveInFee ?? undefined,
      securityDeposit: secDeposit ?? undefined,
      roomNumber: selectedRoomLabel || undefined,
      leaseTerm: form.leaseTerm.trim() || undefined,
      notes: form.notes.trim() || undefined,
      ...(form.vehicles > 0 ? { vehicles: form.vehicles } : {}),
      ...(form.preferredContact === "sms" ? { preferredContact: "sms" as const } : {}),
      // ONLY an already-signed filing writes these — a draft parked here would
      // execute itself (see resolveResidentOnboardingStage).
      ...(onboarding.externallySignedLease
        ? {
            signedLeaseFileName: form.leaseFileName.trim() || undefined,
            signedLeaseDataUrl: form.leaseDataUrl.trim() || undefined,
            signedLeaseUploadedAt,
            externallySignedLease: true as const,
          }
        : {}),
    },
    application,
  };
  return { ok: true, row };
}

/** A prospect: a pending, manager-added row so they show in Residents › Potential. */
export function buildProspectRow(form: AddPersonForm, ctx: BuildRowContext): BuildRowResult {
  if (!form.name.trim()) return { ok: false, error: "Enter the prospect's name." };
  if (!form.email.trim() && !form.phone.trim()) return { ok: false, error: "Enter an email or a phone so you can reach them." };
  const axisId = `PROPLANE-${(ctx.idSuffix ?? (() => Date.now().toString(36).toUpperCase().slice(-8)))()}`;
  const propLabel = form.propertyId ? (ctx.propertyLabelFor(form.propertyId) ?? form.propertyId) : "—";
  const placement = form.propertyId
    ? resolveManualResidentAssignment({ propertyId: form.propertyId, roomId: form.roomId, bundleId: form.bundleId })
    : { assignedRoomChoice: undefined, bundleId: undefined, placementLabel: undefined };
  const row: DemoApplicantRow = {
    id: axisId,
    name: form.name.trim(),
    email: form.email.trim() || undefined,
    property: propLabel,
    stage: "Prospect",
    bucket: "pending",
    detail: form.prospectNotes.trim(),
    propertyId: form.propertyId || undefined,
    managerUserId: ctx.userId ?? undefined,
    manuallyAdded: true,
    manualResidentDetails: {
      phone: form.phone.trim() || undefined,
      roomNumber: placement.placementLabel?.trim() || undefined,
      notes: form.prospectNotes.trim() || undefined,
      ...(form.preferredContact === "sms" ? { preferredContact: "sms" as const } : {}),
      prospect: {
        ...(form.wantedMoveIn ? { wantedMoveIn: form.wantedMoveIn } : {}),
        ...(form.budget.trim() ? { budget: form.budget.trim() } : {}),
      },
    },
    application: {
      propertyId: form.propertyId || undefined,
      roomChoice1: placement.assignedRoomChoice,
      fullLegalName: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim() || undefined,
    } as unknown as DemoApplicantRow["application"],
  };
  return { ok: true, row };
}

/**
 * An application started by the manager on the applicant's behalf: a pending,
 * in-progress draft carrying whatever the manager filled. The applicant opens
 * the secure link, adds what only they can (SSN if screening needs it,
 * consent, signature) and submits — or the manager keeps it as filled.
 */
export function buildApplicationDraftRow(
  form: AddPersonForm,
  ctx: BuildRowContext,
  customQuestions: readonly { key: string; label: string; type: RentalCustomFieldAnswer["type"]; section?: string }[] = [],
): BuildRowResult {
  if (!form.name.trim()) return { ok: false, error: "Enter the applicant's name." };
  if (!form.email.trim()) return { ok: false, error: "Enter the applicant's email." };
  if (!form.propertyId.trim()) return { ok: false, error: "Pick the property they are applying for." };
  const axisId = `PROPLANE-${(ctx.idSuffix ?? (() => Date.now().toString(36).toUpperCase().slice(-8)))()}`;
  const propLabel = ctx.propertyLabelFor(form.propertyId) ?? form.propertyId;
  const placement = resolveManualResidentAssignment({ propertyId: form.propertyId, roomId: form.roomId, bundleId: form.bundleId });
  const leaseFields = residentLeaseTermToApplicationFields(form.leaseTerm, form.leaseTermCustomMode, form.propertyId);
  const answers = applicationAnswersForRow(form);
  const custom = customAnswersForRow(form, customQuestions);
  const row: DemoApplicantRow = {
    id: axisId,
    name: form.name.trim(),
    email: form.email.trim(),
    property: propLabel,
    stage: "In progress",
    bucket: "pending",
    detail: "Started by you",
    propertyId: form.propertyId,
    managerUserId: ctx.userId ?? undefined,
    manuallyAdded: true,
    manualResidentDetails: {
      phone: form.phone.trim() || undefined,
      roomNumber: placement.placementLabel?.trim() || undefined,
      notes: form.notes.trim() || undefined,
      ...(form.vehicles > 0 ? { vehicles: form.vehicles } : {}),
      ...(form.preferredContact === "sms" ? { preferredContact: "sms" as const } : {}),
    },
    application: {
      propertyId: form.propertyId,
      roomChoice1: placement.assignedRoomChoice,
      bundleId: placement.bundleId,
      ...(leaseFields.leaseTerm ? { leaseTerm: leaseFields.leaseTerm, rentalType: leaseFields.rentalType } : {}),
      leaseStart: form.moveInDate || undefined,
      fullLegalName: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim() || undefined,
      ...answers,
      ...(custom.length ? { customFieldAnswers: custom } : {}),
      wizardStep: 1,
      wizardMaxStepReached: 1,
    } as unknown as DemoApplicantRow["application"],
  };
  return { ok: true, row };
}

/* ─────────────────────────── things to finish ─────────────────────────── */

export type ThingToFinish = { step: string; label: string };

export function thingsToFinish(form: AddPersonForm, mode: "person" | "tour" | "application" = "person"): ThingToFinish[] {
  const out: ThingToFinish[] = [];
  if (mode === "application") {
    if (!form.name.trim()) out.push({ step: "contact", label: "Applicant's name" });
    if (!form.email.trim()) out.push({ step: "contact", label: "Applicant's email" });
    if (!form.propertyId.trim()) out.push({ step: "home", label: "Property they're applying for" });
    return out;
  }
  if (!form.name.trim()) out.push({ step: "contact", label: form.kind === "prospect" ? "Prospect's name" : "Resident's name" });
  if (form.kind === "prospect") {
    if (!form.email.trim() && !form.phone.trim()) out.push({ step: "contact", label: "An email or phone" });
    if (form.tourFormat !== "none" && (!form.tourDate || !form.tourStart)) out.push({ step: "tour", label: "Tour date and time" });
    return out;
  }
  if (!form.email.trim()) out.push({ step: "contact", label: "Resident's email" });
  if (!form.propertyId.trim()) out.push({ step: "home", label: "Property" });
  const leaseFields = residentLeaseTermToApplicationFields(form.leaseTerm, form.leaseTermCustomMode, form.propertyId);
  const airbnb = leaseFields.rentalType === "airbnb";
  if (!form.leaseTerm.trim()) out.push({ step: "lease", label: "Lease term" });
  if (!form.moveInDate.trim()) out.push({ step: "lease", label: "Move-in date" });
  if (airbnb && !form.moveOutDate.trim()) out.push({ step: "lease", label: "Move-out date" });
  if (!airbnb && !form.rent.trim()) out.push({ step: "lease", label: "Monthly rent" });
  if (form.leaseDocument !== "later" && !form.leaseDataUrl.trim()) out.push({ step: "lease", label: form.leaseDocument === "signed" ? "The signed lease PDF" : "The draft lease PDF" });
  return out;
}

/* ─────────────────────────── payment schedule preview ─────────────────────────── */

export type PaymentPreviewRow = {
  monthKey: string;
  label: string;
  /** "Jun 2026 · prorated from Jun 18" */
  detail: string;
  rentAmount: number;
  utilitiesAmount: number;
  otherAmount: number;
  total: number;
  prorated: boolean;
  isCurrent: boolean;
  dueOn: string;
};

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function addMonths(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y!, m! - 1 + n, 1));
}
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthKeyLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** First rent due date for a month, given the "rent due on" pick. */
function dueDateFor(key: string, dueDay: AddPersonForm["rentDueDay"]): string {
  const [y, m] = key.split("-").map(Number);
  const last = new Date(y!, m!, 0).getDate();
  const day = dueDay === "last" ? last : dueDay === "15" ? 15 : 1;
  return `${key}-${String(day).padStart(2, "0")}`;
}

/**
 * The months between move-in and today, with what each one bills — the rows
 * the Payments step lists for the manager to mark paid or due. The first month
 * is prorated by days when the move-in is not the 1st; the generator applies
 * the listing's own proration rule at commit, this is the preview.
 */
export function paymentSchedulePreview(form: AddPersonForm, today = new Date()): PaymentPreviewRow[] {
  const moveIn = form.moveInDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(moveIn)) return [];
  const leaseFields = residentLeaseTermToApplicationFields(form.leaseTerm, form.leaseTermCustomMode, form.propertyId);
  if (leaseFields.rentalType === "airbnb" || leaseFields.rentalType === "short_term") return [];
  const rent = moneyOrNull(form.rent) ?? 0;
  const utilities = moneyOrNull(form.utilities) ?? 0;
  const other = moneyOrNull(form.otherFeeAmount) ?? 0;
  if (rent <= 0 && utilities <= 0) return [];
  const [y, m, d] = moveIn.split("-").map(Number);
  const start = monthKey(new Date(y!, m! - 1, 1));
  const current = monthKey(today);
  if (start > current) return [];
  const endKey = form.moveOutDate && /^\d{4}-\d{2}/.test(form.moveOutDate) ? form.moveOutDate.slice(0, 7) : null;
  const rows: PaymentPreviewRow[] = [];
  let key = start;
  while (key <= current) {
    if (endKey && key > endKey) break;
    const [ky, km] = key.split("-").map(Number);
    const daysInMonth = new Date(ky!, km!, 0).getDate();
    let factor = 1;
    let prorated = false;
    if (key === start && (d ?? 1) > 1) {
      factor = (daysInMonth - (d ?? 1) + 1) / daysInMonth;
      prorated = true;
    }
    const rentAmount = round2(rent * factor);
    const utilitiesAmount = round2(utilities * factor);
    const otherAmount = round2(other * factor);
    rows.push({
      monthKey: key,
      label: monthKeyLabel(key),
      detail: prorated ? `prorated from ${MONTH_NAMES[km! - 1]} ${d}` : [rent > 0 ? "rent" : null, utilities > 0 ? "utilities" : null, other > 0 ? form.otherFeeLabel.trim() || "other" : null].filter(Boolean).join(" + "),
      rentAmount,
      utilitiesAmount,
      otherAmount,
      total: round2(rentAmount + utilitiesAmount + otherAmount),
      prorated,
      isCurrent: key === current,
      dueOn: key === start ? moveIn : dueDateFor(key, form.rentDueDay),
    });
    key = addMonths(key, 1);
  }
  return rows;
}

/** Months that will be recorded as paid when the resident is added. */
export function paidMonths(form: AddPersonForm, rows: PaymentPreviewRow[]): PaymentPreviewRow[] {
  return rows.filter((r) => form.paymentMarks[r.monthKey]?.status === "paid");
}

export function formatMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
