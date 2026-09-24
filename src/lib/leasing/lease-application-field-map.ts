/**
 * Allowlisted bidirectional map between lease intake answers and rental
 * application wizard fields (PLAN-0924-1421). Never copies SSN, IDs, income,
 * or other screening-only answers.
 */
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { parseRoomChoiceValue, roomChoiceValue } from "@/lib/rental-application/data";

/** Minimal lease-first intake stored on `LeasePipelineRow.leaseIntake`. */
export type LeaseIntakeAnswers = {
  fullLegalName?: string;
  email?: string;
  phone?: string;
  /** Desired move-in / lease start (ISO or display date string). */
  leaseStart?: string;
  /** Lease term label as stored on applications (e.g. "Long-term", "12-Month"). */
  leaseTerm?: string;
  /** Term length in months when the resident picks a numeric duration. */
  termMonths?: number | null;
  propertyId?: string;
  listingRoomId?: string;
  /** Full room-choice token (`propertyId::listingRoomId`). */
  roomChoice?: string;
};

/** Shared fields that flow both directions — application key is the source of truth name. */
export const LEASE_APPLICATION_SHARED_FIELD_KEYS = [
  "fullLegalName",
  "email",
  "phone",
  "leaseStart",
  "leaseTerm",
  "propertyId",
  "roomChoice1",
] as const satisfies readonly (keyof RentalWizardFormState)[];

export type LeaseApplicationSharedFieldKey = (typeof LEASE_APPLICATION_SHARED_FIELD_KEYS)[number];

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function termMonthsToLeaseTerm(months: number | null | undefined): string {
  if (months == null || !Number.isFinite(months)) return "";
  const m = Math.round(months);
  if (m === 3) return "3-Month";
  if (m === 6) return "6-Month";
  if (m === 9) return "9-Month";
  if (m === 12) return "12-Month";
  if (m === 1) return "Month-to-Month";
  return m > 0 ? "Long-term" : "";
}

function leaseTermToTermMonths(term: string): number | null {
  const t = term.trim();
  if (t === "3-Month") return 3;
  if (t === "6-Month") return 6;
  if (t === "9-Month") return 9;
  if (t === "12-Month") return 12;
  if (t === "Month-to-Month") return 1;
  return null;
}

function resolveRoomChoice(intake: LeaseIntakeAnswers): string {
  const existing = trimStr(intake.roomChoice);
  if (existing) return existing;
  const propertyId = trimStr(intake.propertyId);
  const listingRoomId = trimStr(intake.listingRoomId);
  if (propertyId && listingRoomId) return roomChoiceValue(propertyId, listingRoomId);
  return "";
}

/** Normalize raw row_data.leaseIntake into a typed allowlisted object. */
export function normalizeLeaseIntakeAnswers(raw: unknown): LeaseIntakeAnswers | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: LeaseIntakeAnswers = {};
  const fullLegalName = trimStr(r.fullLegalName);
  const email = trimStr(r.email).toLowerCase();
  const phone = trimStr(r.phone);
  const leaseStart = trimStr(r.leaseStart);
  const leaseTerm = trimStr(r.leaseTerm);
  const propertyId = trimStr(r.propertyId);
  const listingRoomId = trimStr(r.listingRoomId);
  const roomChoice = trimStr(r.roomChoice);
  let termMonths: number | null = null;
  if (typeof r.termMonths === "number" && Number.isFinite(r.termMonths)) {
    termMonths = Math.round(r.termMonths);
  } else if (leaseTerm) {
    termMonths = leaseTermToTermMonths(leaseTerm);
  }
  if (fullLegalName) out.fullLegalName = fullLegalName;
  if (email) out.email = email;
  if (phone) out.phone = phone;
  if (leaseStart) out.leaseStart = leaseStart;
  if (leaseTerm) out.leaseTerm = leaseTerm;
  else if (termMonths != null) out.leaseTerm = termMonthsToLeaseTerm(termMonths);
  if (termMonths != null) out.termMonths = termMonths;
  if (propertyId) out.propertyId = propertyId;
  if (listingRoomId) out.listingRoomId = listingRoomId;
  if (roomChoice) out.roomChoice = roomChoice;
  return Object.keys(out).length > 0 ? out : null;
}

/** Application ← lease intake (lease-first → later application). */
export function applicationFieldsFromLeaseIntake(
  intake: LeaseIntakeAnswers | null | undefined,
): Partial<RentalWizardFormState> {
  if (!intake) return {};
  const out: Partial<RentalWizardFormState> = {};
  const fullLegalName = trimStr(intake.fullLegalName);
  const email = trimStr(intake.email).toLowerCase();
  const phone = trimStr(intake.phone);
  const leaseStart = trimStr(intake.leaseStart);
  const leaseTerm =
    trimStr(intake.leaseTerm) || termMonthsToLeaseTerm(intake.termMonths ?? null);
  const propertyId = trimStr(intake.propertyId);
  const roomChoice1 = resolveRoomChoice(intake);
  if (fullLegalName) out.fullLegalName = fullLegalName;
  if (email) out.email = email;
  if (phone) out.phone = phone;
  if (leaseStart) out.leaseStart = leaseStart;
  if (leaseTerm) out.leaseTerm = leaseTerm;
  if (propertyId) out.propertyId = propertyId;
  if (roomChoice1) out.roomChoice1 = roomChoice1;
  return out;
}

/** Lease intake ← application (application-first → lease draft). */
export function leaseIntakeFromApplication(
  application: Partial<RentalWizardFormState> | null | undefined,
): LeaseIntakeAnswers {
  if (!application) return {};
  const out: LeaseIntakeAnswers = {};
  const fullLegalName = trimStr(application.fullLegalName);
  const email = trimStr(application.email).toLowerCase();
  const phone = trimStr(application.phone);
  const leaseStart = trimStr(application.leaseStart);
  const leaseTerm = trimStr(application.leaseTerm);
  const propertyId = trimStr(application.propertyId);
  const roomChoice1 = trimStr(application.roomChoice1);
  if (fullLegalName) out.fullLegalName = fullLegalName;
  if (email) out.email = email;
  if (phone) out.phone = phone;
  if (leaseStart) out.leaseStart = leaseStart;
  if (leaseTerm) {
    out.leaseTerm = leaseTerm;
    out.termMonths = leaseTermToTermMonths(leaseTerm);
  }
  if (propertyId) out.propertyId = propertyId;
  if (roomChoice1) {
    out.roomChoice = roomChoice1;
    const parsed = parseRoomChoiceValue(roomChoice1);
    if (parsed.propertyId && !out.propertyId) out.propertyId = parsed.propertyId;
    if (parsed.listingRoomId) out.listingRoomId = parsed.listingRoomId;
  }
  return out;
}

/**
 * Prefer explicit `leaseIntake`, else derive from the lease row's mirrored
 * `application` snapshot and identity columns.
 */
export function applicationFieldsFromLeaseRow(row: {
  leaseIntake?: LeaseIntakeAnswers | null;
  application?: Partial<RentalWizardFormState> | null;
  residentName?: string | null;
  residentEmail?: string | null;
  roomChoice?: string | null;
  propertyId?: string | null;
}): Partial<RentalWizardFormState> {
  const fromIntake = applicationFieldsFromLeaseIntake(row.leaseIntake ?? undefined);
  if (Object.keys(fromIntake).length > 0) {
    return {
      ...fromIntake,
      fullLegalName: fromIntake.fullLegalName || trimStr(row.residentName) || undefined,
      email: fromIntake.email || trimStr(row.residentEmail).toLowerCase() || undefined,
      propertyId: fromIntake.propertyId || trimStr(row.propertyId) || undefined,
      roomChoice1: fromIntake.roomChoice1 || trimStr(row.roomChoice) || undefined,
    };
  }
  const fromApp = leaseIntakeFromApplication(row.application ?? undefined);
  const base = applicationFieldsFromLeaseIntake({
    ...fromApp,
    fullLegalName: fromApp.fullLegalName || trimStr(row.residentName) || undefined,
    email: fromApp.email || trimStr(row.residentEmail).toLowerCase() || undefined,
    propertyId: fromApp.propertyId || trimStr(row.propertyId) || undefined,
    roomChoice: fromApp.roomChoice || trimStr(row.roomChoice) || undefined,
  });
  return base;
}

/** Merge allowlisted lease→application fields into a wizard state without overwriting filled answers. */
export function mergeLeaseAutofillIntoApplication(
  current: RentalWizardFormState,
  fromLease: Partial<RentalWizardFormState>,
): RentalWizardFormState {
  const next = { ...current };
  for (const key of LEASE_APPLICATION_SHARED_FIELD_KEYS) {
    const incoming = fromLease[key];
    if (typeof incoming !== "string" || !incoming.trim()) continue;
    const existing = next[key];
    if (typeof existing === "string" && existing.trim()) continue;
    (next as Record<string, unknown>)[key] = incoming.trim();
  }
  return next;
}

/** Merge allowlisted application→lease fields onto an existing lease application snapshot. */
export function mergeApplicationAutofillIntoLeaseApp(
  existingLeaseApp: Partial<RentalWizardFormState> | undefined,
  fromApplication: Partial<RentalWizardFormState>,
): Partial<RentalWizardFormState> {
  const next: Partial<RentalWizardFormState> = { ...(existingLeaseApp ?? {}) };
  for (const key of LEASE_APPLICATION_SHARED_FIELD_KEYS) {
    const incoming = fromApplication[key];
    if (typeof incoming !== "string" || !incoming.trim()) continue;
    (next as Record<string, unknown>)[key] = incoming.trim();
  }
  return next;
}
