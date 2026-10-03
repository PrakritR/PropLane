/**
 * The Send lease screen's four terms — Start, End, Rent, Deposit — and the
 * read-only Payments schedule under them.
 *
 * Nothing here does money arithmetic of its own. The terms are read from the
 * same placement resolver the ledger bills from (`resolvePlacementValuesForRow`),
 * and every figure in the schedule comes from `buildLeaseBillingSnapshot`, the
 * resolver the lease document itself is rendered from. The schedule is
 * recomputed from the SAVED application after each edit, so it can never show
 * a figure the ledger would not create.
 *
 * For an uploaded PDF the same four terms are compared against what the PDF
 * says (`UploadedLeaseParse.fields`): a term the two disagree on shows both
 * values and the manager taps the right one.
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import {
  normalizeLeaseDate,
  normalizeLeaseMoney,
  resolvedFieldValue,
  type UploadedLeaseFieldKey,
  type UploadedLeaseParse,
} from "@/lib/uploaded-lease-extraction";
import { resolvePlacementValuesForRow } from "@/lib/rental-application/placement-values";
import { parseMoneyAmount } from "@/lib/parse-money";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

export type LeaseSendTerms = {
  /** ISO day, "2026-12-01". */
  start: string;
  end: string;
  /** Dollars as typed, "1750" or "1750.50". */
  rent: string;
  deposit: string;
};

type TermsApplicant = Pick<
  DemoApplicantRow,
  "application" | "assignedPropertyId" | "assignedRoomChoice" | "propertyId" | "property" | "signedMonthlyRent"
>;

function plainMoney(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** The terms the application currently carries, exactly as the ledger would bill them. */
export function leaseSendTermsFor(applicant: TermsApplicant): LeaseSendTerms {
  const placement = resolvePlacementValuesForRow(applicant);
  return {
    start: placement.leaseStart,
    end: placement.leaseEnd,
    rent: plainMoney(placement.signedMonthlyRent),
    deposit: placement.securityDeposit > 0 ? plainMoney(placement.securityDeposit) : "0",
  };
}

export type LeaseSendTermsCheck = { ok: true } | { ok: false; field: keyof LeaseSendTerms; message: string };

export function validateLeaseSendTerms(terms: LeaseSendTerms): LeaseSendTermsCheck {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(terms.start)) return { ok: false, field: "start", message: "Pick a start date." };
  if (terms.end && !/^\d{4}-\d{2}-\d{2}$/.test(terms.end)) return { ok: false, field: "end", message: "Pick an end date." };
  if (terms.end && terms.end < terms.start) return { ok: false, field: "end", message: "The end date is before the start." };
  if (!(parseMoneyAmount(terms.rent) > 0)) return { ok: false, field: "rent", message: "Enter the monthly rent." };
  if (terms.deposit.trim() && !(parseMoneyAmount(terms.deposit) >= 0)) {
    return { ok: false, field: "deposit", message: "Enter the deposit, or 0." };
  }
  return { ok: true };
}

/** The application fields the four terms live in. */
export function leaseSendTermsPatch(terms: LeaseSendTerms): Partial<RentalWizardFormState> {
  return {
    leaseStart: terms.start,
    leaseEnd: terms.end,
    managerRentOverride: String(parseMoneyAmount(terms.rent)),
    managerSecurityDepositOverride: String(Math.max(0, parseMoneyAmount(terms.deposit || "0"))),
  };
}

export function leaseSendTermsEqual(a: LeaseSendTerms, b: LeaseSendTerms): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    parseMoneyAmount(a.rent) === parseMoneyAmount(b.rent) &&
    parseMoneyAmount(a.deposit || "0") === parseMoneyAmount(b.deposit || "0")
  );
}

/* ───────────────────────────── payments schedule ───────────────────────────── */

export type LeaseSendScheduleRow = {
  key: "deposit" | "move_in_fee" | "first_month" | "utilities" | "monthly_rent";
  label: string;
  amount: number;
};

function monthDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The first of the month after `iso` — when the recurring rent begins. Empty when `iso` is not a day. */
export function firstOfNextMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return "";
  const next = new Date(Date.UTC(y, m, 1, 12));
  return next.toISOString().slice(0, 10);
}

/**
 * Deposit · First month (prorated) · Monthly rent from Dec 1 — each amount read off the
 * billing snapshot the lease document is rendered from. A row whose amount is zero is
 * left out rather than shown as $0.
 */
export function leaseSendSchedule(
  applicant: Parameters<typeof buildLeaseBillingSnapshot>[0],
  managerUserId: string | null,
): LeaseSendScheduleRow[] {
  const snap = buildLeaseBillingSnapshot(applicant, managerUserId);
  const start = applicant.application?.leaseStart?.trim() ?? "";
  const end = applicant.application?.leaseEnd?.trim() ?? "";
  const out: LeaseSendScheduleRow[] = [];
  if (snap.securityDeposit > 0) out.push({ key: "deposit", label: "Deposit", amount: snap.securityDeposit });
  if (snap.moveInFee > 0) out.push({ key: "move_in_fee", label: "Move-in fee", amount: snap.moveInFee });
  const prorated = snap.firstPeriodRentDue ?? snap.proratedRent ?? 0;
  if (prorated > 0) {
    out.push({ key: "first_month", label: "First month (prorated)", amount: prorated });
  } else if (snap.monthlyRent > 0) {
    out.push({ key: "first_month", label: "First month", amount: snap.monthlyRent });
  }
  if (snap.proratedUtilities && snap.proratedUtilities > 0) {
    out.push({ key: "utilities", label: "Utilities (prorated)", amount: snap.proratedUtilities });
  }
  const nextFirst = firstOfNextMonth(start);
  if (snap.monthlyRent > 0 && nextFirst && (!end || nextFirst <= end)) {
    out.push({ key: "monthly_rent", label: `Monthly rent from ${monthDay(nextFirst)}`, amount: snap.monthlyRent });
  }
  return out;
}

/* ─────────────────────────── uploaded PDF vs the record ─────────────────────────── */

export type PdfTermKey = "leaseStart" | "leaseEnd" | "monthlyRent" | "securityDeposit";

export type PdfTermRow = {
  key: PdfTermKey;
  label: string;
  /** What the PDF says, or null when the PDF states nothing readable for this term. */
  pdfValue: string | null;
  /** The value the record carries, as typed in the terms card. */
  recordValue: string;
  /** The PDF states it AND it disagrees with the record. */
  differs: boolean;
};

const PDF_TERM_LABELS: Record<PdfTermKey, string> = {
  leaseStart: "Start",
  leaseEnd: "End",
  monthlyRent: "Rent",
  securityDeposit: "Deposit",
};

const PDF_TERM_TO_TERMS: Record<PdfTermKey, keyof LeaseSendTerms> = {
  leaseStart: "start",
  leaseEnd: "end",
  monthlyRent: "rent",
  securityDeposit: "deposit",
};

function pdfFieldValue(parse: UploadedLeaseParse, key: UploadedLeaseFieldKey): string | null {
  const field = parse.fields.find((f) => f.key === key);
  if (!field) return null;
  const { value } = resolvedFieldValue(field, parse.review);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (field.status !== "extracted" && !parse.review.overrides?.[key]) return null;
  return trimmed;
}

function normalizedTerm(key: PdfTermKey, raw: string): string | null {
  return key === "leaseStart" || key === "leaseEnd" ? normalizeLeaseDate(raw) : normalizeLeaseMoney(raw);
}

/** The four terms side by side: what the PDF says against what the record carries. */
export function pdfTermRows(parse: UploadedLeaseParse | null | undefined, record: LeaseSendTerms): PdfTermRow[] {
  const keys: PdfTermKey[] = ["leaseStart", "leaseEnd", "monthlyRent", "securityDeposit"];
  return keys.map((key) => {
    const recordValue = record[PDF_TERM_TO_TERMS[key]];
    const pdfValue = parse && parse.status === "parsed" ? pdfFieldValue(parse, key) : null;
    let differs = false;
    if (pdfValue != null && recordValue.trim()) {
      const a = normalizedTerm(key, pdfValue);
      const b = normalizedTerm(key, recordValue) ?? (key === "monthlyRent" || key === "securityDeposit" ? normalizeLeaseMoney(`$${recordValue}`) : null);
      // Only a comparison both sides can state in a comparable form counts — the same rule
      // `leaseDocumentMismatches` follows, so a term the PDF merely words differently is not a conflict.
      differs = a != null && b != null && a !== b;
    }
    return { key, label: PDF_TERM_LABELS[key], pdfValue, recordValue, differs };
  });
}

/** The PDF's value for a term as a value the terms card holds (ISO day, plain dollars); null when unreadable. */
export function termValueFromPdf(key: PdfTermKey, pdfValue: string): string | null {
  if (key === "leaseStart" || key === "leaseEnd") return normalizeLeaseDate(pdfValue);
  const money = normalizeLeaseMoney(pdfValue);
  return money ? plainMoney(Number(money)) : null;
}

/** A record value written the way a human override of the PDF's reading is stored. */
export function overrideTextForTerm(key: PdfTermKey, recordValue: string): string {
  if (key === "leaseStart" || key === "leaseEnd") return recordValue;
  const amount = parseMoneyAmount(recordValue);
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type PdfTermPick = "pdf" | "record";

/**
 * What tapping resolves to. A PDF pick moves the record to the PDF's value; a record pick
 * keeps the record and stores it as the manager's own reading of that term on the PDF
 * (`review.overrides`) — the same "values a human typed" channel the import review uses.
 */
export function resolvePdfTermPicks(
  rows: PdfTermRow[],
  picks: Partial<Record<PdfTermKey, PdfTermPick>>,
  record: LeaseSendTerms,
): { terms: LeaseSendTerms; overrides: Partial<Record<UploadedLeaseFieldKey, string>>; unresolved: PdfTermKey[] } {
  const terms: LeaseSendTerms = { ...record };
  const overrides: Partial<Record<UploadedLeaseFieldKey, string>> = {};
  const unresolved: PdfTermKey[] = [];
  for (const row of rows) {
    if (!row.differs) continue;
    const pick = picks[row.key];
    if (!pick) {
      unresolved.push(row.key);
      continue;
    }
    if (pick === "pdf" && row.pdfValue != null) {
      const next = termValueFromPdf(row.key, row.pdfValue);
      if (next) terms[PDF_TERM_TO_TERMS[row.key]] = next;
    } else if (pick === "record") {
      overrides[row.key] = overrideTextForTerm(row.key, row.recordValue);
    }
  }
  return { terms, overrides, unresolved };
}
