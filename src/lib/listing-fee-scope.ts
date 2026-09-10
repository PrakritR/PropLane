/**
 * Fee scope (PRP-463): which lease types and which rooms a listing fee applies to,
 * and which payments are collected at signing PER lease type.
 *
 * Two conventions run through this file, and they are the same one:
 *
 * - **Absent or empty means EVERY item.** A fee with no `leaseTypes` applies to every
 *   lease type; a fee with no `roomIds` applies to every room. That is what every fee
 *   saved before these fields existed meant, so nothing a manager already saved changes,
 *   and it is also what "All rooms" must persist as. Storing the ids instead would freeze
 *   the fee to today's rooms and silently drop it from Room 4 added tomorrow.
 * - **The scope list is stored only when it is a real narrowing.** Selecting every option
 *   writes `undefined`, never the full list, so "all" and "all of the three rooms that
 *   happened to exist" cannot drift apart.
 */

import type { ManagerCustomFeeRow, ManagerListingSubmissionV1, PaymentAtSigningOptionId } from "@/lib/manager-listing-submission";
import { PAYMENT_AT_SIGNING_OPTIONS, resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import { LISTING_LEASE_TERM_OPTION_SET } from "@/lib/rental-application/lease-terms";

/** A fee scope list that is absent, empty, or covers every option means "all". */
export function feeScopeIsAll(scope: readonly string[] | null | undefined): boolean {
  return !Array.isArray(scope) || scope.length === 0;
}

/**
 * Narrow a picked selection into stored form: `undefined` when it covers everything
 * (see the file header), otherwise the picks in `allowed` order so two equal scopes
 * always serialize identically.
 */
export function narrowFeeScope(
  picked: readonly string[],
  allowed: readonly string[],
): string[] | undefined {
  const set = new Set(picked);
  const ordered = allowed.filter((value) => set.has(value));
  if (ordered.length === 0) return undefined;
  if (ordered.length >= allowed.length) return undefined;
  return ordered;
}

/** Expand a stored scope for display: "all" becomes every allowed option. */
export function expandFeeScope(
  scope: readonly string[] | null | undefined,
  allowed: readonly string[],
): string[] {
  if (feeScopeIsAll(scope)) return [...allowed];
  const set = new Set(scope as readonly string[]);
  return allowed.filter((value) => set.has(value));
}

/** Drop scope entries that no longer name a real option (a deleted room, a dropped term). */
export function pruneFeeScope(
  scope: readonly string[] | null | undefined,
  allowed: readonly string[],
): string[] | undefined {
  if (feeScopeIsAll(scope)) return undefined;
  return narrowFeeScope(scope as readonly string[], allowed);
}

/** Does this fee bill on a lease of `leaseTerm`? Unscoped fees bill on every term. */
export function feeAppliesToLeaseType(
  fee: Pick<ManagerCustomFeeRow, "leaseTypes">,
  leaseTerm: string | null | undefined,
): boolean {
  if (feeScopeIsAll(fee.leaseTypes)) return true;
  const term = String(leaseTerm ?? "").trim();
  if (!term) return true;
  return (fee.leaseTypes ?? []).includes(term);
}

/** Does this fee apply to `roomId`? Unscoped fees apply to every room. */
export function feeAppliesToRoom(
  fee: Pick<ManagerCustomFeeRow, "roomIds">,
  roomId: string | null | undefined,
): boolean {
  if (feeScopeIsAll(fee.roomIds)) return true;
  const id = String(roomId ?? "").trim();
  if (!id) return true;
  return (fee.roomIds ?? []).includes(id);
}

/** Lease terms a fee scope may name on this listing. */
export function listingLeaseTypeScopeOptions(
  sub: Pick<
    ManagerListingSubmissionV1,
    "allowedLeaseTerms" | "leaseTermsBody" | "shortTermRentalsAllowed" | "airbnbRentalsAllowed"
  >,
): string[] {
  return resolveAllowedLeaseTerms(sub).filter((term) => LISTING_LEASE_TERM_OPTION_SET.has(term));
}

/* ------------------------------------------------------------------ *
 * Payment at signing, per lease type
 * ------------------------------------------------------------------ */

/** Row keys the signing matrix understands beyond the four standard payment ids. */
export const PAYMENT_AT_SIGNING_FEE_KEY_PREFIX = "fee:";
export const PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX = "room_rent:";

export type PaymentAtSigningRow = {
  /** Stored key — a `PaymentAtSigningOptionId`, `fee:<id>`, or `room_rent:<id>`. */
  key: string;
  label: string;
  kind: "standard" | "fee" | "roomRent";
};

/**
 * Resolved on first call, not at module load. `manager-listing-submission` and this
 * module reference each other, so a top-level `new Set(PAYMENT_AT_SIGNING_OPTIONS…)`
 * here would read that const while it is still in its temporal dead zone whenever the
 * cycle is entered from the other side.
 */
let standardSigningIds: Set<string> | null = null;

export function isStandardPaymentAtSigningKey(key: string): key is PaymentAtSigningOptionId {
  standardSigningIds ??= new Set<string>(PAYMENT_AT_SIGNING_OPTIONS.map((o) => o.id));
  return standardSigningIds.has(key);
}

/**
 * Every row the signing table draws, in display order: the four standard payments, then
 * one row per fee the manager added in Other fees, then one per room when renting by room.
 *
 * The fee rows are DERIVED from the fee list rather than stored, so a fee added in Other
 * fees appears here with nothing to keep in sync, and a removed fee cannot leave a
 * stranded row behind.
 */
export function paymentAtSigningRows(
  sub: Pick<ManagerListingSubmissionV1, "customFees" | "rooms">,
  options?: { includeRoomRent?: boolean },
): PaymentAtSigningRow[] {
  const rows: PaymentAtSigningRow[] = PAYMENT_AT_SIGNING_OPTIONS.map((o) => ({
    key: o.id,
    label: o.label,
    kind: "standard" as const,
  }));

  for (const fee of sub.customFees ?? []) {
    const presetId = (fee as { presetId?: string }).presetId;
    if (presetId && presetId !== "custom") continue;
    // A fee the manager has not named yet still gets its row, so the table visibly grows
    // the moment a fee is added rather than only once it is typed into.
    rows.push({
      key: `${PAYMENT_AT_SIGNING_FEE_KEY_PREFIX}${fee.id}`,
      label: fee.label?.trim() || "Untitled fee",
      kind: "fee",
    });
  }

  if (options?.includeRoomRent) {
    for (const room of sub.rooms ?? []) {
      const name = room.name?.trim() || "Room";
      rows.push({
        key: `${PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX}${room.id}`,
        label: `Room rent (${name})`,
        kind: "roomRent",
      });
    }
  }

  return rows;
}

/**
 * The matrix a listing actually has, with the legacy flat list as the fallback for
 * every lease type. A listing saved before this field existed collected the same
 * payments on every lease type — which is exactly what that fallback reproduces.
 */
export function paymentAtSigningMatrix(
  sub: Pick<
    ManagerListingSubmissionV1,
    | "paymentAtSigningIncludes"
    | "paymentAtSigningByLeaseType"
    | "allowedLeaseTerms"
    | "leaseTermsBody"
    | "shortTermRentalsAllowed"
    | "airbnbRentalsAllowed"
  >,
): Record<string, string[]> {
  const terms = listingLeaseTypeScopeOptions(sub);
  const stored = sub.paymentAtSigningByLeaseType;
  const legacy = (sub.paymentAtSigningIncludes ?? []).map(String);
  const out: Record<string, string[]> = {};
  for (const term of terms) {
    const row = stored?.[term];
    out[term] = Array.isArray(row) ? [...row] : [...legacy];
  }
  return out;
}

/** Is `rowKey` collected at signing on a lease of `leaseTerm`? */
export function isPaymentDueAtSigning(
  sub: Parameters<typeof paymentAtSigningMatrix>[0],
  rowKey: string,
  leaseTerm: string | null | undefined,
): boolean {
  const term = String(leaseTerm ?? "").trim();
  const matrix = paymentAtSigningMatrix(sub);
  if (term && matrix[term]) return matrix[term]!.includes(rowKey);
  // No term named: due at signing if ANY offered lease type collects it, which is what
  // the flat list meant before the matrix existed.
  return Object.values(matrix).some((keys) => keys.includes(rowKey));
}

/** Tick or untick one cell, returning the whole matrix. */
export function setPaymentAtSigningCell(
  matrix: Record<string, string[]>,
  leaseTerm: string,
  rowKey: string,
  on: boolean,
): Record<string, string[]> {
  const current = matrix[leaseTerm] ?? [];
  const has = current.includes(rowKey);
  if (on === has) return matrix;
  return {
    ...matrix,
    [leaseTerm]: on ? [...current, rowKey] : current.filter((k) => k !== rowKey),
  };
}

/**
 * The flat list every existing reader still consumes: the union across lease types,
 * limited to the four standard ids it is typed to hold. Fee and room rows live only in
 * the matrix, so nothing downstream is handed a key it cannot interpret.
 */
export function derivePaymentAtSigningIncludesFromMatrix(
  matrix: Record<string, readonly string[]>,
): PaymentAtSigningOptionId[] {
  const union = new Set<string>();
  for (const keys of Object.values(matrix)) {
    for (const key of keys) union.add(key);
  }
  return PAYMENT_AT_SIGNING_OPTIONS.map((o) => o.id).filter((id) => union.has(id));
}

/** Normalize a stored matrix: known lease terms only, de-duplicated, empty rows dropped. */
export function normalizePaymentAtSigningByLeaseType(
  raw: unknown,
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [term, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!LISTING_LEASE_TERM_OPTION_SET.has(term)) continue;
    if (!Array.isArray(value)) continue;
    const keys = [
      ...new Set(
        value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()),
      ),
    ];
    out[term] = keys;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* ------------------------------------------------------------------ *
 * Standard fee rows
 * ------------------------------------------------------------------ */

/**
 * Preset row backing each standard fee row, so scope stored against a row id can be
 * stamped onto the materialized fee row every downstream reader already consumes.
 *
 * Keys are `ListingFeeRowId`s and values `ListingFeePresetId`s, typed as plain strings
 * on purpose: importing either type here would close a module cycle through
 * `listing-fees` -> `manager-listing-submission` -> back to this file.
 *
 * `applicationFee` is deliberately absent — it has no preset row; the lease document
 * pushes it straight from `sub.applicationFee`, so its scope is read from the map.
 */
export const LISTING_FEE_PRESET_ID_FOR_ROW: Readonly<Record<string, string>> = {
  securityDeposit: "security_deposit",
  moveInFee: "move_in_fee",
  holdingDeposit: "holding_deposit",
  parkingMonthly: "parking_monthly",
  hoaMonthly: "hoa_monthly",
  otherMonthlyFees: "other_monthly",
  monthToMonthSurcharge: "mtm_surcharge",
  customLeaseSurcharge: "custom_lease_surcharge",
};

const LISTING_FEE_ROW_FOR_PRESET_ID: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LISTING_FEE_PRESET_ID_FOR_ROW).map(([rowId, presetId]) => [presetId, rowId]),
);

export function listingFeeRowIdForPresetId(presetId: string | null | undefined): string | undefined {
  if (!presetId) return undefined;
  return LISTING_FEE_ROW_FOR_PRESET_ID[presetId];
}

export type StandardFeeScope = { leaseTypes?: string[]; roomIds?: string[] };

/** Scope stored for one standard fee row; absent means every lease type and every room. */
export function standardFeeScopeFor(
  sub: Pick<ManagerListingSubmissionV1, "standardFeeScopes">,
  rowId: string,
): StandardFeeScope {
  return sub.standardFeeScopes?.[rowId] ?? {};
}

/** Write one standard row's scope, dropping the entry entirely when it narrows nothing. */
export function withStandardFeeScope(
  scopes: Record<string, StandardFeeScope> | undefined,
  rowId: string,
  patch: StandardFeeScope,
): Record<string, StandardFeeScope> | undefined {
  const next: Record<string, StandardFeeScope> = { ...(scopes ?? {}) };
  const merged: StandardFeeScope = { ...(next[rowId] ?? {}), ...patch };
  if (!merged.leaseTypes?.length) delete merged.leaseTypes;
  if (!merged.roomIds?.length) delete merged.roomIds;
  if (Object.keys(merged).length === 0) delete next[rowId];
  else next[rowId] = merged;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Normalize the stored map: known shapes only, blanks dropped, "all" stored as absent. */
export function normalizeStandardFeeScopes(raw: unknown): Record<string, StandardFeeScope> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, StandardFeeScope> = {};
  for (const [rowId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as { leaseTypes?: unknown; roomIds?: unknown };
    const scope: StandardFeeScope = {};
    const leaseTypes = cleanIdList(v.leaseTypes);
    const roomIds = cleanIdList(v.roomIds);
    if (leaseTypes) scope.leaseTypes = leaseTypes;
    if (roomIds) scope.roomIds = roomIds;
    if (Object.keys(scope).length > 0) out[rowId] = scope;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cleanIdList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = [
    ...new Set(
      raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()),
    ),
  ];
  return out.length > 0 ? out : undefined;
}

/**
 * The fees a manager actually charges, offered wherever a fee is added (PRP-463).
 *
 * A blank "Fee name" box asks the manager to remember what PropLane calls things; this
 * offers the list and still allows anything else. Cadence rides along because a daily
 * utilities charge and a one-time key fee are not billed the same way, and getting that
 * wrong is a wrong ledger rather than a wrong label.
 */
export const LISTING_FEE_CHOICES: readonly { label: string; frequency: "one-time" | "monthly" }[] = [
  { label: "Utilities", frequency: "monthly" },
  { label: "Utilities / week", frequency: "monthly" },
  { label: "Utilities / day", frequency: "monthly" },
  { label: "Parking", frequency: "monthly" },
  { label: "Cleaning", frequency: "one-time" },
  { label: "Cleaning / week", frequency: "monthly" },
  { label: "Internet", frequency: "monthly" },
  { label: "Laundry", frequency: "monthly" },
  { label: "Pet rent", frequency: "monthly" },
  { label: "Pet deposit", frequency: "one-time" },
  { label: "Storage", frequency: "monthly" },
  { label: "Key / lock fee", frequency: "one-time" },
  { label: "Move-in fee", frequency: "one-time" },
  { label: "Move-out fee", frequency: "one-time" },
  { label: "Admin fee", frequency: "one-time" },
  { label: "HOA / community", frequency: "monthly" },
  { label: "Amenity fee", frequency: "monthly" },
  { label: "Trash / recycling", frequency: "monthly" },
];
