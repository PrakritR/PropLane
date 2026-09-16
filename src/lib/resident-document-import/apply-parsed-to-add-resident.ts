import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";

/** Normalize parsed dates for `<input type="date">`. */
export function normalizeParsedDateForInput(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function stripMoney(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const n = Number.parseFloat(value.replace(/[^0-9.]+/g, ""));
  return Number.isFinite(n) ? String(n) : value.replace(/^\$/, "");
}

export type AddResidentParsedApplyInput = {
  fields: Record<string, string>;
  parse?: ParsedResidentDocument | null;
  leaseTermPresetValues?: string[];
};

export type AddResidentParsedApplyResult = {
  name?: string;
  email?: string;
  phone?: string;
  propertyId?: string;
  roomId?: string;
  leaseTerm?: string;
  leaseTermCustomMode?: boolean;
  moveInDate?: string;
  moveOutDate?: string;
  rent?: string;
  utilities?: string;
  moveInFee?: string;
  securityDeposit?: string;
};

/** Map merged PDF parse fields onto the manager Add resident form shape. */
export function mapParsedFieldsToAddResidentForm(
  input: AddResidentParsedApplyInput,
): AddResidentParsedApplyResult {
  const { fields, parse, leaseTermPresetValues = [] } = input;
  const out: AddResidentParsedApplyResult = {};

  if (fields.tenantName?.trim()) out.name = fields.tenantName.trim();
  if (fields.tenantEmail?.trim()) out.email = fields.tenantEmail.trim();
  if (fields.tenantPhone?.trim()) out.phone = fields.tenantPhone.trim();

  const propertyId = parse?.propertyMatch?.propertyId?.trim() || fields.propertyId?.trim();
  if (propertyId) out.propertyId = propertyId;
  const roomId = parse?.propertyMatch?.roomId?.trim() || fields.roomId?.trim();
  if (roomId) out.roomId = roomId;

  const leaseTerm = fields.leaseTerm?.trim();
  if (leaseTerm) {
    if (leaseTermPresetValues.includes(leaseTerm)) {
      out.leaseTerm = leaseTerm;
      out.leaseTermCustomMode = false;
    } else {
      out.leaseTerm = leaseTerm;
      out.leaseTermCustomMode = true;
    }
  }

  const moveIn = normalizeParsedDateForInput(fields.leaseStart);
  if (moveIn) out.moveInDate = moveIn;
  const moveOut = normalizeParsedDateForInput(fields.leaseEnd);
  if (moveOut) out.moveOutDate = moveOut;

  const rent = stripMoney(fields.monthlyRent);
  if (rent) out.rent = rent;
  const utilities = stripMoney(fields.monthlyUtilities);
  if (utilities) out.utilities = utilities;
  const moveInFee = stripMoney(fields.moveInFee);
  if (moveInFee) out.moveInFee = moveInFee;
  const deposit = stripMoney(fields.securityDeposit);
  if (deposit) out.securityDeposit = deposit;

  return out;
}

/* ─────────────────────────── wizard fill with marks ─────────────────────────── */

import {
  APPLICANT_DOCUMENT_FIELD_KEYS,
  type ApplicantDocumentFieldKey,
  type ParsedFieldConfidence,
} from "@/lib/resident-document-import/types";

export type ParsedFillMark = "fromFile" | "check";

export type ParsedApplicationFill = {
  /** Applicant answers, keyed by the applicant wizard's own form keys. */
  answers: Partial<Record<ApplicantDocumentFieldKey, string>>;
  /** One mark per filled key: "check" when the parser was not confident. */
  marks: Record<string, ParsedFillMark>;
};

const DATE_KEYS: readonly ApplicantDocumentFieldKey[] = ["dateOfBirth", "currentMoveIn", "currentMoveOut", "prevMoveIn", "prevMoveOut"];
const MONEY_KEYS: readonly ApplicantDocumentFieldKey[] = ["monthlyIncome", "annualIncome", "otherIncome"];
const YES_NO_KEYS: readonly ApplicantDocumentFieldKey[] = ["evictionHistory", "bankruptcyHistory", "criminalHistory"];

function normalizeYesNo(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "yes" || v === "y" || v === "true") return "Yes";
  if (v === "no" || v === "n" || v === "false" || v === "none") return "No";
  return undefined;
}

/**
 * Map the parsed application fields onto the Application step, marking each
 * one. A low-confidence value is still filled — the manager sees it with an
 * amber "check" mark instead of a blue "from file" — so the review is one
 * glance rather than a hunt through the PDF.
 */
export function mapParsedFieldsToApplicationAnswers(
  fields: readonly { key: string; value: string; confidence: ParsedFieldConfidence }[],
): ParsedApplicationFill {
  const answers: Partial<Record<ApplicantDocumentFieldKey, string>> = {};
  const marks: Record<string, ParsedFillMark> = {};
  const allowed = new Set<string>(APPLICANT_DOCUMENT_FIELD_KEYS);
  for (const f of fields) {
    if (!allowed.has(f.key)) continue;
    const key = f.key as ApplicantDocumentFieldKey;
    let value: string | undefined = f.value.trim();
    if (!value) continue;
    if (DATE_KEYS.includes(key)) value = normalizeParsedDateForInput(value) || value;
    else if (MONEY_KEYS.includes(key)) value = value.replace(/[^\d.]/g, "") || value;
    else if (YES_NO_KEYS.includes(key)) value = normalizeYesNo(value);
    if (!value) continue;
    answers[key] = value;
    marks[key] = f.confidence === "low" ? "check" : "fromFile";
  }
  return { answers, marks };
}

/**
 * Default-only fill: a parsed value lands only where the manager has typed
 * nothing. What they typed always wins — the same rule address prefill follows
 * on a listing.
 */
export function fillOnlyBlank<T extends Record<string, unknown>>(
  current: T,
  incoming: Partial<T>,
  isBlank: (value: unknown) => boolean = (v) => v == null || (typeof v === "string" && !v.trim()),
): { next: T; filledKeys: string[] } {
  const next: Record<string, unknown> = { ...current };
  const filledKeys: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null || (typeof value === "string" && !value.trim())) continue;
    if (!isBlank(current[key])) continue;
    next[key] = value;
    filledKeys.push(key);
  }
  return { next: next as T, filledKeys };
}
