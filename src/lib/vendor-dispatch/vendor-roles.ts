/**
 * Vendor roles on the roster row (vendor-dispatch-1018, portal side).
 *
 * `manager_vendor_records.row_data` carries the dispatch fields next to the
 * legacy `trade` / `trades` labels ("Plumbing"). The dispatch taxonomy is
 * `VENDOR_TRADES` (`trades.ts`); a role is one of its ids, never a label.
 * Pure: the vendors route normalizes every row through here on read and write,
 * so a stored value outside the taxonomy never reaches the rule editor.
 */
import {
  VENDOR_TRADES,
  tradeDefinition,
  type TradeDefinition,
  type VendorTrade,
} from "@/lib/vendor-dispatch/trades";

export type VendorPayModel = TradeDefinition["defaultPayModel"];

export const VENDOR_PAY_MODELS: readonly { id: VendorPayModel; label: string }[] = [
  { id: "flat", label: "Flat" },
  { id: "hourly", label: "Per hour" },
  { id: "per_room", label: "Per room" },
  { id: "quote", label: "Quote first" },
];

const PAY_MODEL_IDS = new Set<string>(VENDOR_PAY_MODELS.map((model) => model.id));
const TRADE_IDS = new Set<string>(VENDOR_TRADES.map((trade) => trade.id));

export const VENDOR_TRADE_OPTIONS_DISPATCH: readonly { value: VendorTrade; label: string }[] = VENDOR_TRADES.map(
  (trade) => ({ value: trade.id, label: trade.label }),
);

export function vendorPayModelLabel(model: string | null | undefined): string {
  return VENDOR_PAY_MODELS.find((entry) => entry.id === model)?.label ?? "";
}

/** The dispatch fields a roster row may carry. */
export type VendorDispatchFields = {
  /** Roles the vendor takes dispatch jobs for (ids from `VENDOR_TRADES`). */
  dispatchTrades?: VendorTrade[];
  /** Where they work, as the manager writes it ("Capitol Hill, Ballard"). */
  serviceArea?: string;
  /** Their usual rate in cents, read with `dispatchPayModel`. */
  dispatchRateCents?: number;
  dispatchPayModel?: VendorPayModel;
  /** ISO date (yyyy-mm-dd). Shares `ManagerVendorRow.insuranceExpiresAt`. */
  insuranceExpiresAt?: string;
  licenseNumber?: string;
  /** Absent = available. Only an explicit `false` takes the vendor out of dispatch. */
  dispatchAvailable?: boolean;
};

const MAX_RATE_CENTS = 10_000_000;

export function isVendorTrade(value: unknown): value is VendorTrade {
  return typeof value === "string" && TRADE_IDS.has(value);
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim().slice(0, max);
  return text || undefined;
}

export function normalizeIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return undefined;
  return text;
}

/**
 * Strip a row's dispatch fields to the allowed shape. Every key comes back
 * (undefined when invalid) so a spread over the row overwrites a bad stored
 * value instead of leaving it behind.
 */
export function normalizeVendorDispatchFields(row: Record<string, unknown>): {
  [K in keyof VendorDispatchFields]-?: VendorDispatchFields[K] | undefined;
} {
  const trades = Array.isArray(row.dispatchTrades)
    ? [...new Set(row.dispatchTrades.filter(isVendorTrade))].slice(0, VENDOR_TRADES.length)
    : [];
  const rate = row.dispatchRateCents;
  const rateCents =
    typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= MAX_RATE_CENTS ? Math.round(rate) : undefined;
  const payModel =
    typeof row.dispatchPayModel === "string" && PAY_MODEL_IDS.has(row.dispatchPayModel)
      ? (row.dispatchPayModel as VendorPayModel)
      : undefined;
  return {
    dispatchTrades: trades.length > 0 ? trades : undefined,
    serviceArea: cleanText(row.serviceArea, 120),
    dispatchRateCents: rateCents,
    dispatchPayModel: payModel,
    insuranceExpiresAt: normalizeIsoDate(row.insuranceExpiresAt),
    licenseNumber: cleanText(row.licenseNumber, 60),
    dispatchAvailable: row.dispatchAvailable === false ? false : row.dispatchAvailable === true ? true : undefined,
  };
}

/** Legacy roster labels onto dispatch roles, so rows saved before roles existed still filter and rank. */
const LEGACY_TRADE_LABEL_TO_ROLE: Record<string, VendorTrade> = {
  "general maintenance": "handyman",
  plumbing: "plumber",
  electrical: "electrician",
  hvac: "hvac",
  "appliance repair": "appliance",
  landscaping: "landscaping",
  cleaning: "cleaner",
  "pest control": "pest",
  other: "general",
};

/** The roles a roster row takes: its dispatch roles, else its legacy trade labels mapped. */
export function vendorDispatchRoles(row: {
  dispatchTrades?: readonly string[] | null;
  trades?: readonly string[] | null;
  trade?: string | null;
}): VendorTrade[] {
  const explicit = (row.dispatchTrades ?? []).filter(isVendorTrade);
  if (explicit.length > 0) return [...new Set(explicit)];
  const labels = row.trades?.length ? row.trades : row.trade ? [row.trade] : [];
  const mapped = labels
    .map((label) => LEGACY_TRADE_LABEL_TO_ROLE[label.trim().toLowerCase()])
    .filter((role): role is VendorTrade => Boolean(role));
  return [...new Set(mapped)];
}

export function vendorRoleLabels(roles: readonly string[]): string[] {
  return roles.map((role) => tradeDefinition(role)?.label ?? "").filter(Boolean);
}

/** True when a vendor is in dispatch: not switched off, and holds the role (or no role is asked for). */
export function vendorTakesRole(
  row: Parameters<typeof vendorDispatchRoles>[0] & { dispatchAvailable?: boolean; active?: boolean },
  role: string | null | undefined,
): boolean {
  if (row.active === false || row.dispatchAvailable === false) return false;
  if (!role) return true;
  return vendorDispatchRoles(row).includes(role as VendorTrade);
}

/** Dollars-and-cents text for a cents amount; empty when null. */
export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

/** Parse a dollars input to whole cents; null when empty or not a non-negative number. */
export function dollarsInputToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0 || value > MAX_RATE_CENTS / 100) return null;
  return Math.round(value * 100);
}
