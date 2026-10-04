import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  applyEntireHomeListingPricing,
  isEntireHomeListing,
  isListingFeeAmountFilled,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import {
  listingOffersCustomLeaseSurcharge,
  listingOffersMonthToMonthSurcharge,
  listingPresetFeeAmount,
  removedStandardListingFeeRowSet,
  type ListingFeePresetId,
} from "@/lib/listing-fees";
import { listingRoomHasRent } from "@/lib/listing-wizard-validation";
import { shortTermNightlyRate } from "@/lib/short-term-stay-pricing";

/** Row ids in the unified Fees table — one toggle per row per term. */
export type ListingFeeRowId =
  | "rent"
  | "applicationFee"
  | "securityDeposit"
  | "moveInFee"
  | "holdingDeposit"
  | "parkingMonthly"
  | "hoaMonthly"
  | "otherMonthlyFees"
  | "monthToMonthSurcharge"
  | "customLeaseSurcharge";

export type ListingStandardFeeRowId = ListingFeeRowId;

/** @deprecated Use ListingFeeRowId */
export type ListingStFeeToggleId = ListingFeeRowId;

export type ListingFeeToggles = Record<ListingFeeRowId, boolean>;

export type ListingStFeeToggles = ListingFeeToggles;
export type ListingLtFeeToggles = ListingFeeToggles;

export const LISTING_STANDARD_FEE_ROWS: readonly {
  id: ListingFeeRowId;
  label: string;
  stField?: keyof ManagerListingSubmissionV1;
  ltField?: keyof ManagerListingSubmissionV1;
  stHint?: string;
  ltHint?: string;
}[] = [
  {
    id: "rent",
    label: "Rent",
    stField: "shortTermDailyCost",
    ltField: "entireHomeMonthlyRent",
    stHint: "nightly → stay total",
    ltHint: "monthly",
  },
  {
    id: "applicationFee",
    label: "Application fee",
    stField: "shortTermApplicationFee",
    ltField: "applicationFee",
  },
  {
    id: "securityDeposit",
    label: "Security deposit",
    stField: "shortTermDeposit",
    ltField: "securityDeposit",
  },
  {
    id: "moveInFee",
    label: "Move-in / cleaning",
    stField: "shortTermMoveInFee",
    ltField: "moveInFee",
  },
  {
    id: "holdingDeposit",
    label: "Holding deposit",
    stField: "shortTermHoldingDeposit",
    ltField: "holdingDeposit",
  },
  {
    id: "parkingMonthly",
    label: "Parking",
    stField: "shortTermParkingMonthly",
    ltField: "parkingMonthly",
  },
  {
    id: "hoaMonthly",
    label: "HOA / community",
    stField: "shortTermHoaMonthly",
    ltField: "hoaMonthly",
  },
  {
    id: "otherMonthlyFees",
    label: "Other monthly fees",
    stField: "shortTermOtherMonthlyFees",
    ltField: "otherMonthlyFees",
  },
  {
    id: "monthToMonthSurcharge",
    label: "Month-to-month surcharge",
    stField: "shortTermMonthToMonthSurcharge",
    ltField: "monthToMonthSurcharge",
  },
  {
    id: "customLeaseSurcharge",
    label: "Custom lease",
    ltField: "customLeaseSurcharge",
    ltHint: "leases not 1st → month-end",
  },
];

function emptyFeeToggles(): ListingFeeToggles {
  return {
    rent: false,
    applicationFee: false,
    securityDeposit: false,
    moveInFee: false,
    holdingDeposit: false,
    parkingMonthly: false,
    hoaMonthly: false,
    otherMonthlyFees: false,
    monthToMonthSurcharge: false,
    customLeaseSurcharge: false,
  };
}

function stripMoneyDisplay(raw: unknown): string {
  return String(raw ?? "")
    .replace(/^\$/, "")
    .replace(/\/mo(nth)?\.?$/i, "")
    .trim();
}

export function listingFeeRowById(id: ListingFeeRowId) {
  return LISTING_STANDARD_FEE_ROWS.find((r) => r.id === id);
}

/** Read the string amount shown in a Fees-table cell. */
export function readListingFeeCellAmount(
  sub: ManagerListingSubmissionV1,
  field: keyof ManagerListingSubmissionV1 | undefined,
): string {
  if (!field) return "";
  if (field === "entireHomeMonthlyRent") {
    const n = sub.entireHomeMonthlyRent;
    return typeof n === "number" && n > 0 ? String(n) : "";
  }
  return stripMoneyDisplay(sub[field]);
}

function ltRentToggleOn(sub: ManagerListingSubmissionV1): boolean {
  if (isEntireHomeListing(sub)) {
    return (sub.entireHomeMonthlyRent ?? 0) > 0;
  }
  return sub.rooms.some(listingRoomHasRent);
}

function stToggleOnForRow(sub: ManagerListingSubmissionV1, rowId: ListingFeeRowId): boolean {
  const row = listingFeeRowById(rowId);
  if (!row?.stField) return false;
  return isListingFeeAmountFilled(readListingFeeCellAmount(sub, row.stField));
}

function ltToggleOnForRow(sub: ManagerListingSubmissionV1, rowId: ListingFeeRowId): boolean {
  if (rowId === "rent") return ltRentToggleOn(sub);
  const row = listingFeeRowById(rowId);
  if (!row?.ltField) return false;
  if (row.ltField === "entireHomeMonthlyRent") {
    return (sub.entireHomeMonthlyRent ?? 0) > 0;
  }
  return isListingFeeAmountFilled(readListingFeeCellAmount(sub, row.ltField));
}

/** Infer ST fee checkboxes from stored submission values (edit/resume). */
export function deriveListingStFeeToggles(sub: ManagerListingSubmissionV1): ListingFeeToggles {
  const toggles = emptyFeeToggles();
  for (const row of LISTING_STANDARD_FEE_ROWS) {
    if (row.stField) toggles[row.id] = stToggleOnForRow(sub, row.id);
  }
  return toggles;
}

/** Infer LT fee checkboxes from stored submission values (edit/resume). */
export function deriveListingLtFeeToggles(sub: ManagerListingSubmissionV1): ListingFeeToggles {
  const toggles = emptyFeeToggles();
  for (const row of LISTING_STANDARD_FEE_ROWS) {
    if (row.ltField || row.id === "rent") toggles[row.id] = ltToggleOnForRow(sub, row.id);
  }
  return toggles;
}

function sharedFeeField(row: (typeof LISTING_STANDARD_FEE_ROWS)[number]): boolean {
  return Boolean(row.stField && row.ltField && row.stField === row.ltField);
}

/**
 * Legacy scalar field → the unified `customFees` preset row it mirrors.
 *
 * `resolveListingFees` merges the two and the ROW wins whenever it holds an amount
 * (`fromFees.amount.trim() ? fromFees.amount : legacyRow.amount`). So a writer that touches
 * only the scalar is overruled: unchecking a fee cleared the field while the row kept its
 * amount, leaving a listing that still advertised — and, once the monthly presets started
 * billing, still charged — a fee whose checkbox read off. Every writer below syncs both.
 *
 * The map is keyed by FIELD rather than row id because the deposit and move-in rows carry a
 * separate short-term preset, and clearing the short-term cell must not clear the long-term
 * fee (or the reverse).
 */
const PRESET_FOR_FEE_FIELD: Partial<Record<keyof ManagerListingSubmissionV1, ListingFeePresetId>> = {
  securityDeposit: "security_deposit",
  moveInFee: "move_in_fee",
  holdingDeposit: "holding_deposit",
  parkingMonthly: "parking_monthly",
  hoaMonthly: "hoa_monthly",
  otherMonthlyFees: "other_monthly",
  monthToMonthSurcharge: "mtm_surcharge",
  customLeaseSurcharge: "custom_lease_surcharge",
  shortTermDailyCost: "short_term_nightly",
  shortTermDeposit: "short_term_deposit",
  shortTermMoveInFee: "short_term_move_in",
};

/** Mirror a scalar fee edit onto its `customFees` preset row, which outranks the scalar. */
function syncPresetFeeRowAmount(
  sub: ManagerListingSubmissionV1,
  field: keyof ManagerListingSubmissionV1,
  amount: string,
): ManagerListingSubmissionV1 {
  const presetId = PRESET_FOR_FEE_FIELD[field];
  if (!presetId) return sub;
  const rows = sub.customFees ?? [];
  if (!rows.some((fee) => (fee as { presetId?: string }).presetId === presetId)) return sub;
  return {
    ...sub,
    customFees: rows.map((fee) =>
      (fee as { presetId?: string }).presetId === presetId ? { ...fee, amount } : fee,
    ),
  };
}

function clearFeeField(
  sub: ManagerListingSubmissionV1,
  field: keyof ManagerListingSubmissionV1,
): ManagerListingSubmissionV1 {
  if (field === "entireHomeMonthlyRent") {
    return applyEntireHomeListingPricing(sub, { entireHomeMonthlyRent: 0 });
  }
  return syncPresetFeeRowAmount({ ...sub, [field]: "" }, field, "");
}

/** Map ST toggle edits onto submission fields. */
export function applyListingStFeeToggle(
  sub: ManagerListingSubmissionV1,
  feeId: ListingFeeRowId,
  enabled: boolean,
  ltToggles?: ListingLtFeeToggles,
): ManagerListingSubmissionV1 {
  const row = listingFeeRowById(feeId);
  if (!row?.stField) return sub;
  if (!enabled) {
    if (sharedFeeField(row) && ltToggles?.[feeId]) return sub;
    return clearFeeField(sub, row.stField);
  }
  return sub;
}

/** Map LT toggle edits onto submission fields. */
export function applyListingLtFeeToggle(
  sub: ManagerListingSubmissionV1,
  feeId: ListingFeeRowId,
  enabled: boolean,
  stToggles?: ListingStFeeToggles,
): ManagerListingSubmissionV1 {
  const row = listingFeeRowById(feeId);
  if (feeId === "rent" && !isEntireHomeListing(sub)) {
    return sub;
  }
  if (!row?.ltField) return sub;
  if (!enabled) {
    if (sharedFeeField(row) && stToggles?.[feeId]) return sub;
    return clearFeeField(sub, row.ltField);
  }
  return sub;
}

export function applyListingLtFeeAmount(
  sub: ManagerListingSubmissionV1,
  field: keyof ManagerListingSubmissionV1,
  sanitizedAmount: string,
): ManagerListingSubmissionV1 {
  if (field === "entireHomeMonthlyRent") {
    const nextRent =
      sanitizedAmount === "" || sanitizedAmount === "."
        ? 0
        : Number.parseFloat(sanitizedAmount);
    return applyEntireHomeListingPricing(sub, {
      entireHomeMonthlyRent: Number.isFinite(nextRent) ? nextRent : 0,
    });
  }
  return syncPresetFeeRowAmount({ ...sub, [field]: sanitizedAmount }, field, sanitizedAmount);
}

export function applyListingStFeeAmount(
  sub: ManagerListingSubmissionV1,
  feeId: ListingFeeRowId,
  sanitizedAmount: string,
): ManagerListingSubmissionV1 {
  const row = listingFeeRowById(feeId);
  if (!row?.stField) return sub;
  return syncPresetFeeRowAmount({ ...sub, [row.stField]: sanitizedAmount }, row.stField, sanitizedAmount);
}

export function applyListingLtFeeAmountForRow(
  sub: ManagerListingSubmissionV1,
  feeId: ListingFeeRowId,
  sanitizedAmount: string,
): ManagerListingSubmissionV1 {
  const row = listingFeeRowById(feeId);
  if (!row?.ltField) return sub;
  return applyListingLtFeeAmount(sub, row.ltField, sanitizedAmount);
}

/** Validation helpers for ST fee toggles → submission fields. */
export function validateListingStFeeToggles(
  sub: ManagerListingSubmissionV1,
  toggles: ListingFeeToggles,
  hasShortTerm: boolean,
): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!hasShortTerm) return errs;
  const removed = removedStandardListingFeeRowSet(sub);

  if (toggles.rent && !removed.has("rent")) {
    if (!(shortTermNightlyRate(sub.shortTermDailyCost) > 0)) {
      errs.shortTermDailyCost = "Enter a nightly rate for short-term stays.";
    }
  }

  for (const row of LISTING_STANDARD_FEE_ROWS) {
    if (!row.stField || row.id === "rent") continue;
    if (removed.has(row.id)) continue;
    if (!toggles[row.id]) continue;
    const raw = String(sub[row.stField] ?? "");
    if (!isListingFeeAmountFilled(raw)) {
      errs[String(row.stField)] = `Enter an amount for ${row.label.toLowerCase()} (0 if none).`;
    }
  }

  return errs;
}

/** Validation helpers for LT fee toggles → submission fields. */
export function validateListingLtFeeToggles(
  sub: ManagerListingSubmissionV1,
  toggles: ListingFeeToggles,
  hasLongTerm: boolean,
  opts: { isEntireHome?: boolean; entireHomeRent?: number } = {},
): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!hasLongTerm) return errs;
  const removed = removedStandardListingFeeRowSet(sub);

  if (toggles.rent && !removed.has("rent")) {
    if (opts.isEntireHome && !((opts.entireHomeRent ?? 0) > 0)) {
      errs.monthlyRent = "Enter the monthly rent for the entire home.";
    }
  }

  for (const row of LISTING_STANDARD_FEE_ROWS) {
    if (!row.ltField || row.id === "rent" || row.ltField === "entireHomeMonthlyRent") continue;
    if (removed.has(row.id)) continue;
    if (!toggles[row.id]) continue;
    const raw = String(sub[row.ltField] ?? "");
    if (!isListingFeeAmountFilled(raw)) {
      errs[String(row.ltField)] = `${row.label} is required — enter 0 if there is no fee.`;
    }
  }

  return errs;
}

/** @deprecated Use validateListingLtFeeToggles with toggle state instead. */
export function listingLtFeeFieldsRequired(_hasLongTerm: boolean): (keyof ManagerListingSubmissionV1)[] {
  return [];
}

// The two lease-length predicates live in listing-fees so the display and lease-document
// readers there can apply the same gate without importing this module (which imports them).
export { listingOffersCustomLeaseSurcharge, listingOffersMonthToMonthSurcharge };

/** Standard fee rows hidden until the matching lease length is offered. */
export function leaseLengthGatedHiddenFeeRowIds(
  sub: Pick<
    ManagerListingSubmissionV1,
    "allowedLeaseTerms" | "leaseTermsBody" | "shortTermRentalsAllowed" | "airbnbRentalsAllowed" | "rolloverToMonthToMonth"
  >,
): ReadonlySet<ListingFeeRowId> {
  const hidden = new Set<ListingFeeRowId>();
  if (!listingOffersMonthToMonthSurcharge(sub)) hidden.add("monthToMonthSurcharge");
  if (!listingOffersCustomLeaseSurcharge(sub)) hidden.add("customLeaseSurcharge");
  return hidden;
}

function feeRowIdForPreset(presetId: ListingFeePresetId): ListingFeeRowId | null {
  switch (presetId) {
    case "security_deposit":
      return "securityDeposit";
    case "move_in_fee":
      return "moveInFee";
    case "holding_deposit":
      return "holdingDeposit";
    case "parking_monthly":
      return "parkingMonthly";
    case "hoa_monthly":
      return "hoaMonthly";
    case "other_monthly":
      return "otherMonthlyFees";
    case "mtm_surcharge":
      return "monthToMonthSurcharge";
    case "custom_lease_surcharge":
      return "customLeaseSurcharge";
    case "short_term_nightly":
      return "rent";
    case "short_term_deposit":
      return "securityDeposit";
    case "short_term_move_in":
      return "moveInFee";
    default:
      return null;
  }
}

/** Bill preset-backed fees only when the wizard checkbox is on (and the row is visible). */
export function listingPresetFeeAmountIfEnabled(
  sub: ManagerListingSubmissionV1,
  presetId: ListingFeePresetId,
): number {
  const rowId = feeRowIdForPreset(presetId);
  if (rowId) {
    if (removedStandardListingFeeRowSet(sub).has(rowId)) return 0;
    if (rowId === "monthToMonthSurcharge" && !listingOffersMonthToMonthSurcharge(sub)) return 0;
    if (rowId === "customLeaseSurcharge" && !listingOffersCustomLeaseSurcharge(sub)) return 0;
    const lt = deriveListingLtFeeToggles(sub);
    const st = deriveListingStFeeToggles(sub);
    const row = listingFeeRowById(rowId);
    const isShortTermPreset = presetId.startsWith("short_term_");
    if (isShortTermPreset) {
      if (!sub.shortTermRentalsAllowed || !st[rowId]) return 0;
    } else if (row?.ltField && !lt[rowId]) {
      return 0;
    }
  }
  return listingPresetFeeAmount(sub, presetId);
}
