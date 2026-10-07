/**
 * What a Property owner is allowed to read, as an explicit allowlist.
 *
 * Every figure an owner sees is built here from numbers the manager's own
 * reports already compute (`queryProfitability`, `queryOccupancyReport`,
 * `queryOwnerStatement`). Nothing is spread from a source object: a field
 * reaches the owner only if it is named below, so a new column on a manager
 * report can never leak. No resident, applicant, vendor, ledger-line or
 * message field exists in these types. `assertOwnerPayloadRedacted` is what
 * the tests (and any caller that wants a belt-and-braces check) run over the
 * serialized JSON.
 */

export type OwnerUnitRow = {
  /** Room or unit label ("Room 3"). Never a person. */
  unit: string;
  status: "occupied" | "vacant";
  /** Monthly rent in cents, null when the unit has none on record. */
  rentCents: number | null;
  /** YYYY-MM-DD, null when open-ended or vacant. */
  leaseEnd: string | null;
};

export type OwnerMonthRow = {
  /** YYYY-MM */
  month: string;
  rentCollectedCents: number;
  rentDueCents: number;
  otherIncomeCents: number;
  /** Processing fees the manager bore on the month's payments. */
  feesCents: number;
  /** Vendor payouts plus logged expenses: one total, no vendor, no line. */
  repairsServicesCents: number;
  /** Equals the manager's Profitability report net for the same house and month. */
  netCents: number;
};

export type OwnerPropertySummary = {
  propertyId: string;
  label: string;
  units: number;
  occupied: number;
  /** Selected month. */
  rentCollectedCents: number;
  rentDueCents: number;
  netCents: number;
  /** Year to date through the selected month. */
  netYtdCents: number;
  /** Oldest to newest, ending at the selected month. */
  months: OwnerMonthRow[];
  /** Present only on a single-house request. */
  unitRows?: OwnerUnitRow[];
};

export type OwnerChartPoint = { month: string; incomeCents: number; expensesCents: number };

export type OwnerSummary = {
  period: string;
  totals: {
    netMonthCents: number;
    netYtdCents: number;
    rentCollectedCents: number;
    rentDueCents: number;
    units: number;
    occupied: number;
  };
  chart: OwnerChartPoint[];
  properties: OwnerPropertySummary[];
};

export type OwnerStatementRow = {
  /** YYYY-MM */
  month: string;
  houses: number;
  /** Cash collected less expenses paid, from the manager's owner statement. */
  distributionCents: number;
};

export type OwnerStatements = { rows: OwnerStatementRow[] };

export type OwnerDocumentRow = {
  id: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

const FORBIDDEN_KEY = /(^|_|-)(name|email|phone|resident|applicant|tenant|vendor|payee|address|ledger|message|description)(s)?($|_|-)|firstname|lastname|fullname|residentemail|vendorid/i;
// `label` and the property `unit` are the only name-like strings, and they are
// property labels, never people. Keys are matched, not values.
const ALLOWED_KEYS = new Set(["label"]);

/** Every key in a JSON-shaped value, depth first. */
function collectKeys(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.push(key);
      collectKeys(child, into);
    }
  }
}

/** Keys that look like they carry a person, vendor or ledger line. Empty means redacted. */
export function forbiddenOwnerPayloadKeys(payload: unknown): string[] {
  const keys: string[] = [];
  collectKeys(payload, keys);
  return keys.filter((key) => !ALLOWED_KEYS.has(key) && FORBIDDEN_KEY.test(key));
}

export function assertOwnerPayloadRedacted(payload: unknown): void {
  const bad = forbiddenOwnerPayloadKeys(payload);
  if (bad.length > 0) throw new Error(`Owner payload carries forbidden keys: ${[...new Set(bad)].join(", ")}`);
}

/** YYYY-MM of `period`, or null when it is not a real month. */
export function parseOwnerPeriod(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  return value;
}

export function ownerMonthKeys(period: string, count: number): string[] {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const total = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}
