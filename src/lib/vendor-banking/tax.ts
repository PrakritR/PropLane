/**
 * Vendor Finances > Tax info (vendor-banking-1006): the W-9 input contract, the
 * tax-year summary and the 1099 status line. Pure and client-safe. The server
 * route (`/api/vendor/finances/tax`) validates through `validateVendorW9Input`;
 * the plaintext TIN never leaves that request — only the last four digits are
 * ever returned.
 */

export const VENDOR_W9_ENTITY_TYPES = [
  { value: "individual", label: "Individual / sole proprietor" },
  { value: "single_member_llc", label: "Single-member LLC" },
  { value: "llc_c", label: "LLC taxed as C corporation" },
  { value: "llc_s", label: "LLC taxed as S corporation" },
  { value: "llc_p", label: "LLC taxed as partnership" },
  { value: "c_corp", label: "C corporation" },
  { value: "s_corp", label: "S corporation" },
  { value: "partnership", label: "Partnership" },
  { value: "trust_estate", label: "Trust / estate" },
  { value: "other", label: "Other" },
] as const;
export type VendorW9EntityType = (typeof VENDOR_W9_ENTITY_TYPES)[number]["value"];

export function vendorW9EntityLabel(value: string | null | undefined): string {
  return VENDOR_W9_ENTITY_TYPES.find((entry) => entry.value === value)?.label ?? "—";
}

export type VendorW9Input = {
  legalName: string;
  businessName: string | null;
  entityType: VendorW9EntityType;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  zip: string;
  tinType: "ssn" | "ein";
  /** Nine digits, digits only. Null when the vendor is keeping the TIN already on file. */
  tin: string | null;
  attested: true;
};

const US_STATE_RE = /^[A-Za-z]{2}$/;
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
const MAX_TEXT = 200;

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export type VendorW9Validation =
  | { ok: true; value: VendorW9Input }
  | { ok: false; error: string };

/**
 * Validates a W-9 submission. `hasTinOnFile` lets a vendor edit their address
 * without retyping the TIN. Error strings are safe to show — they never echo
 * the TIN back.
 */
export function validateVendorW9Input(body: unknown, opts: { hasTinOnFile: boolean }): VendorW9Validation {
  if (!body || typeof body !== "object") return { ok: false, error: "Send the W-9 details." };
  const raw = body as Record<string, unknown>;
  const legalName = text(raw.legalName);
  if (!legalName) return { ok: false, error: "Enter your legal name." };
  const entityType = text(raw.entityType) as VendorW9EntityType;
  if (!VENDOR_W9_ENTITY_TYPES.some((entry) => entry.value === entityType)) {
    return { ok: false, error: "Choose your entity type." };
  }
  const addressLine1 = text(raw.addressLine1);
  const city = text(raw.city);
  const state = text(raw.state);
  const zip = text(raw.zip, 10);
  if (!addressLine1 || !city) return { ok: false, error: "Enter your street address and city." };
  if (!US_STATE_RE.test(state)) return { ok: false, error: "Enter a two-letter state." };
  if (!ZIP_RE.test(zip)) return { ok: false, error: "Enter a valid ZIP code." };
  const tinType = text(raw.tinType);
  if (tinType !== "ssn" && tinType !== "ein") return { ok: false, error: "Choose SSN or EIN." };

  const tinDigits = typeof raw.tin === "string" ? raw.tin.replace(/[\s-]/g, "") : "";
  let tin: string | null = null;
  if (tinDigits) {
    if (!/^\d{9}$/.test(tinDigits)) return { ok: false, error: "A tax ID is nine digits." };
    tin = tinDigits;
  } else if (!opts.hasTinOnFile) {
    return { ok: false, error: "Enter your tax ID." };
  }
  if (raw.attested !== true) return { ok: false, error: "Confirm the certification to submit your W-9." };

  return {
    ok: true,
    value: {
      legalName,
      businessName: text(raw.businessName) || null,
      entityType,
      addressLine1,
      addressLine2: text(raw.addressLine2) || null,
      city,
      state: state.toUpperCase(),
      zip,
      tinType,
      tin,
      attested: true,
    },
  };
}

/** What the client may see of a stored W-9 — never the ciphertext, never the TIN. */
export type VendorW9Profile = {
  legalName: string | null;
  businessName: string | null;
  entityType: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  tinType: "ssn" | "ein" | null;
  tinLast4: string | null;
  attested: boolean;
  receivedAt: string | null;
};

/** "••-•••4821" for an EIN, "•••-••-4821" for an SSN. */
export function maskTin(tinType: "ssn" | "ein" | null, last4: string | null): string {
  if (!last4) return "—";
  return tinType === "ssn" ? `•••-••-${last4}` : `••-•••${last4}`;
}

/**
 * The IRS 1099-NEC / 1099-MISC reporting threshold: $600 for payments made
 * before 2026, $2,000 for payments made in 2026 and after.
 */
export function threshold1099Cents(taxYear: number): number {
  return taxYear >= 2026 ? 200_000 : 60_000;
}

export type VendorTaxYearSummary = {
  year: number;
  earningsCents: number;
  feesCents: number;
  refundsCents: number;
  /** Earnings less refunds — the amount a 1099 would report. */
  reportableCents: number;
  thresholdCents: number;
  overThreshold: boolean;
};

type TaxLedgerLine = { kind: string; source: string; amountCents: number; createdAt: string };

/** Earnings, fees and refunds per UTC calendar year from the vendor ledger, newest year first. */
export function summarizeVendorTaxYears(lines: TaxLedgerLine[]): VendorTaxYearSummary[] {
  const byYear = new Map<number, { earnings: number; fees: number; refunds: number }>();
  for (const line of lines) {
    const year = Number(line.createdAt.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    const row = byYear.get(year) ?? { earnings: 0, fees: 0, refunds: 0 };
    if (line.kind === "charge") row.earnings += line.amountCents;
    else if (line.kind === "platform_fee") row.fees += Math.abs(line.amountCents);
    else if (line.kind === "refund") row.refunds += Math.abs(line.amountCents);
    else if (line.kind === "adjustment" && line.source === "hold_expiry" && line.amountCents > 0) row.fees -= line.amountCents;
    byYear.set(year, row);
  }
  return [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, row]) => {
      const reportableCents = Math.max(0, row.earnings - row.refunds);
      const thresholdCents = threshold1099Cents(year);
      return {
        year,
        earningsCents: row.earnings,
        feesCents: Math.max(0, row.fees),
        refundsCents: row.refunds,
        reportableCents,
        thresholdCents,
        overThreshold: reportableCents >= thresholdCents,
      };
    });
}

/** The 1099 line for one tax year — a plain statement of what happens, never a promise PropLane cannot keep. */
export function form1099StatusLabel(summary: VendorTaxYearSummary, opts: { hasW9: boolean; currentYear: number }): string {
  const threshold = `$${(summary.thresholdCents / 100).toLocaleString("en-US")}`;
  if (!summary.overThreshold) return `No 1099 needed — under ${threshold}`;
  if (!opts.hasW9) return "Add your W-9 so we can file your 1099";
  if (summary.year >= opts.currentYear) return `We'll file your 1099 for ${summary.year}`;
  return `1099 filed by PropLane in Jan ${summary.year + 1}`;
}
