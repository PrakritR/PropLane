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
import {
  AIRBNB_LEASE_TERM,
  isLegacyFixedLeaseTerm,
  LONG_TERM_LEASE_TERM,
  LISTING_LEASE_TERM_OPTION_SET,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";

/**
 * Built-in fee slots that may be collected at signing.
 *
 * Declared here as plain ids rather than derived from `LISTING_FEE_PRESETS`
 * because `listing-fees.ts` imports THIS module — importing it back would be a
 * cycle. `tests/unit/listing-at-signing-presets.test.ts` asserts this set stays
 * in step with the preset catalogue, so the two cannot drift apart silently.
 *
 * Excluded on purpose: `security_deposit` and `move_in_fee` (already standard
 * rows, would appear twice), the `short_term_*` slots (priced on the Short-term
 * tab's own grid), and `break_lease_fee` / `holdover_daily` (charged when a
 * lease ends, never at signing).
 */
export const PRESET_IDS_OFFERED_AT_SIGNING: ReadonlySet<string> = new Set([
  "holding_deposit",
  "parking_monthly",
  "hoa_monthly",
  "other_monthly",
  "mtm_surcharge",
  "custom_lease_surcharge",
]);

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

/** Legacy fixed lengths and Long-term are the same rent on the pricing screen. */
function leaseTypeScopeMatches(stored: string, leaseTerm: string): boolean {
  if (stored === leaseTerm) return true;
  if (leaseTerm === LONG_TERM_LEASE_TERM && isLegacyFixedLeaseTerm(stored)) return true;
  if (stored === LONG_TERM_LEASE_TERM && isLegacyFixedLeaseTerm(leaseTerm)) return true;
  return false;
}

/** Does this fee bill on a lease of `leaseTerm`? Unscoped fees bill on every term. */
export function feeAppliesToLeaseType(
  fee: Pick<ManagerCustomFeeRow, "leaseTypes">,
  leaseTerm: string | null | undefined,
): boolean {
  if (feeScopeIsAll(fee.leaseTypes)) return true;
  const term = String(leaseTerm ?? "").trim();
  if (!term) return true;
  return (fee.leaseTypes ?? []).some((stored) => leaseTypeScopeMatches(stored, term));
}

/** Preset fee row scope, when the row exists; absent row means every lease type (legacy). */
export function listingPresetFeeAppliesToLeaseType(
  sub: Pick<ManagerListingSubmissionV1, "customFees">,
  presetId: string,
  leaseTerm: string | null | undefined,
): boolean {
  const row = (sub.customFees ?? []).find((fee) => (fee as { presetId?: string }).presetId === presetId);
  if (!row) return true;
  return feeAppliesToLeaseType(row, leaseTerm);
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

/**
 * Lease-type tabs on Pricing → Rent and deposits.
 *
 * Legacy listings still store 3/6/9/12-Month separately, but every fixed monthly
 * length bills off the same rent, so they collapse onto ONE tab. That tab is
 * labelled "Long-term", not "12-Month": the product stopped offering named
 * lengths, the move-in and move-out dates are the term, and naming a length a
 * manager can no longer pick just confuses them (the captain's "should not
 * specify what lengths are offered"). Tabs follow the canonical display order.
 */
export function listingPricingLeaseTabs(
  sub: Pick<
    ManagerListingSubmissionV1,
    "allowedLeaseTerms" | "leaseTermsBody" | "shortTermRentalsAllowed" | "airbnbRentalsAllowed"
  >,
): string[] {
  const raw = listingLeaseTypeScopeOptions(sub);
  const tabs: string[] = [];
  const hasFixedMonthly = raw.some((t) => isLegacyFixedLeaseTerm(t) || t === LONG_TERM_LEASE_TERM);
  if (hasFixedMonthly) tabs.push(LONG_TERM_LEASE_TERM);
  for (const term of raw) {
    if (isLegacyFixedLeaseTerm(term) || term === LONG_TERM_LEASE_TERM) continue;
    if (!tabs.includes(term)) tabs.push(term);
  }
  return tabs;
}

/** Map a pricing tab to the lease term the room record uses for monthly rent. */
export function listingPricingTabToLeaseTerm(tab: string): string {
  /* "12-Month" was this tab's id before it was renamed; still accepted so any
     persisted or in-flight tab selection keeps resolving. */
  if (tab === "12-Month" || isLegacyFixedLeaseTerm(tab)) return LONG_TERM_LEASE_TERM;
  return tab;
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
  /** The fee this row came from, so a lease type is only offered the fees it charges. */
  scope?: Pick<ManagerCustomFeeRow, "leaseTypes">;
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
  sub: Pick<ManagerListingSubmissionV1, "customFees" | "rooms" | "removedStandardListingFeeRows">,
  options?: { includeRoomRent?: boolean },
): PaymentAtSigningRow[] {
  // Only fees the property ACTUALLY has can be due at signing (PRP-463). A manager who
  // deleted Move-in fee from Other fees should not still be offered it here — the list is
  // the property's fees, not a fixed four. First month rent and utilities are rent, not
  // fees, so they are always on offer.
  const removed = new Set(
    Array.isArray(sub.removedStandardListingFeeRows) ? sub.removedStandardListingFeeRows : [],
  );
  const ROW_FOR_STANDARD: Record<string, string> = {
    security_deposit: "securityDeposit",
    move_in_fee: "moveInFee",
  };
  const rows: PaymentAtSigningRow[] = PAYMENT_AT_SIGNING_OPTIONS.filter((o) => {
    const rowId = ROW_FOR_STANDARD[o.id];
    return !rowId || !removed.has(rowId as never);
  }).map((o) => ({
    key: o.id,
    label: o.label,
    kind: "standard" as const,
  }));

  for (const fee of sub.customFees ?? []) {
    const presetId = (fee as { presetId?: string }).presetId;
    /*
     * Every fee the property actually has can be due at signing — not just the
     * manager's own rows. Parking, HOA, other monthly, holding deposit and the
     * lease surcharges used to be skipped entirely here, so a manager could not
     * say "collect parking up front" and the receipt silently under-counted
     * (the captain's "Due at signing does not include all the fees").
     *
     * Two families stay out, and deliberately:
     *   - security_deposit / move_in_fee already have a standard row above, so
     *     including them again would show the same fee twice.
     *   - the short-term section presets are priced on the Short-term tab's own
     *     grid, which already collects them.
     * Termination fees are charged when a lease ENDS, so they are not offered
     * as something to collect at signing.
     */
    if (presetId && presetId !== "custom" && !PRESET_IDS_OFFERED_AT_SIGNING.has(presetId)) continue;
    // A fee the manager has not named yet still gets its row, so the table visibly grows
    // the moment a fee is added rather than only once it is typed into.
    rows.push({
      key: `${PAYMENT_AT_SIGNING_FEE_KEY_PREFIX}${fee.id}`,
      label: fee.label?.trim() || "Untitled fee",
      kind: "fee",
      scope: { leaseTypes: fee.leaseTypes },
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
/** The listing fields signing inherit needs — matrix plus rooms (absent termPricing = same as long-term). */
export type ListingSigningSource = Pick<
  ManagerListingSubmissionV1,
  | "paymentAtSigningIncludes"
  | "paymentAtSigningByLeaseType"
  | "allowedLeaseTerms"
  | "leaseTermsBody"
  | "shortTermRentalsAllowed"
  | "airbnbRentalsAllowed"
  | "rooms"
  | "listingPlaceCategoryId"
>;

export function paymentAtSigningMatrix(
  sub: Pick<
    ManagerListingSubmissionV1,
    | "paymentAtSigningIncludes"
    | "paymentAtSigningByLeaseType"
    | "allowedLeaseTerms"
    | "leaseTermsBody"
    | "shortTermRentalsAllowed"
    | "airbnbRentalsAllowed"
    | "rooms"
    | "listingPlaceCategoryId"
  >,
): Record<string, string[]> {
  const terms = listingLeaseTypeScopeOptions(sub);
  const stored = sub.paymentAtSigningByLeaseType;
  const legacy = (sub.paymentAtSigningIncludes ?? []).map(String);
  const out: Record<string, string[]> = {};
  /*
   * Same-as-long-term writes the Long-term column even when that lease type is
   * not offered. Keep that column in the matrix so the next read can see it —
   * otherwise a Month-to-Month-only listing ticks the receipt and the quote
   * immediately drops the tick (the write landed on a key this loop never
   * rebuilt).
   */
  const presentedOffered = terms.map((term) =>
    isLegacyFixedLeaseTerm(term) ? LONG_TERM_LEASE_TERM : term,
  );
  const keepLongTermStore =
    !presentedOffered.includes(LONG_TERM_LEASE_TERM) &&
    presentedOffered.some((term) => listingTermFollowsLongTerm(sub, term));
  const termsWithStore = keepLongTermStore ? [LONG_TERM_LEASE_TERM, ...terms] : terms;
  /*
   * Keyed by the term the SCREEN shows, not the one the listing stored.
   *
   * A listing that still holds "12-Month" is presented as Long-term everywhere —
   * the pricing tab, the signing heading, the applicant's dropdown. Keying this
   * by the stored value meant the screen read and wrote `Long-term` while the
   * only row was `12-Month`, so every tick was written and then dropped on the
   * next render and the control sat on "Nothing due at signing" forever.
   * A row already stored under the presented name wins; otherwise a row saved
   * under the retired name is carried onto it, so nothing set before is lost.
   */
  for (const term of termsWithStore) {
    const presented = isLegacyFixedLeaseTerm(term) ? LONG_TERM_LEASE_TERM : term;
    if (out[presented]) continue;
    const row = Array.isArray(stored?.[presented]) ? stored?.[presented] : stored?.[term];
    out[presented] = Array.isArray(row) ? [...row] : [...legacy];
  }
  return out;
}

/**
 * True when this lease type still follows long-term prices — the same rule as
 * the Pricing tab's "Same as long-term" box: no room has its own `termPricing`
 * on that term. Entire-home and stay terms never follow; they have their own
 * price fields.
 */
export function listingTermFollowsLongTerm(
  sub: Pick<ManagerListingSubmissionV1, "rooms" | "listingPlaceCategoryId">,
  leaseTerm: string | null | undefined,
): boolean {
  const term = String(leaseTerm ?? "").trim();
  if (!term || term === LONG_TERM_LEASE_TERM) return false;
  if (term === SHORT_TERM_LEASE_TERM || term === AIRBNB_LEASE_TERM) return false;
  if (sub.listingPlaceCategoryId === "entire_home") return false;
  return !(sub.rooms ?? []).some((room) => {
    const own = room.termPricing?.[term];
    return Boolean(own && Object.keys(own).length > 0);
  });
}

/** The matrix column a signing read or write actually uses. */
export function resolvedSigningLeaseTerm(
  sub: Pick<ManagerListingSubmissionV1, "rooms" | "listingPlaceCategoryId">,
  leaseTerm: string | null | undefined,
): string {
  const term = String(leaseTerm ?? "").trim();
  if (listingTermFollowsLongTerm(sub, term)) return LONG_TERM_LEASE_TERM;
  return term || LONG_TERM_LEASE_TERM;
}

export function roomHasOwnPaymentAtSigning(
  sub: ListingSigningSource,
  roomId: string | null | undefined,
  leaseTerm: string | null | undefined,
): boolean {
  if (!roomId) return false;
  const resolved = resolvedSigningLeaseTerm(sub, leaseTerm);
  const room = (sub.rooms ?? []).find((r) => r.id === roomId);
  return Array.isArray(room?.paymentAtSigningByLeaseType?.[resolved]);
}

function signingKeysInclude(keys: readonly string[], rowKey: string, roomId?: string | null): boolean {
  if (keys.includes(rowKey)) return true;
  if (rowKey.startsWith(PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX) && keys.includes("first_month_rent")) {
    return true;
  }
  if (rowKey === "first_month_rent") {
    if (roomId && keys.includes(`${PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX}${roomId}`)) return true;
    if (!roomId && keys.some((key) => key.startsWith(PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX))) return true;
  }
  return false;
}

/** The stored tick list for one lease type, after same-as-long-term inherit and an optional room override. */
export function paymentAtSigningKeysFor(
  sub: ListingSigningSource,
  leaseTerm: string | null | undefined,
  roomId?: string | null,
): string[] {
  const term = String(leaseTerm ?? "").trim();
  const matrix = paymentAtSigningMatrix(sub);
  if (!term) {
    const union = new Set<string>();
    for (const keys of Object.values(matrix)) {
      for (const key of keys) union.add(key);
    }
    return [...union];
  }
  const resolved = resolvedSigningLeaseTerm(sub, term);
  if (roomId) {
    const room = (sub.rooms ?? []).find((r) => r.id === roomId);
    const own = room?.paymentAtSigningByLeaseType?.[resolved];
    if (Array.isArray(own)) return [...own];
  }
  if (matrix[resolved]) return [...matrix[resolved]!];
  // No column for this lease type — a listing saved before the matrix existed,
  // or a term the listing never offered (a Custom lease). The flat list is
  // what those ticks meant, and it is what the reads fell back to before the
  // per-term resolver existed; an empty answer here zeroed every legacy
  // lease's "Payment Due at Signing".
  return (sub.paymentAtSigningIncludes ?? []).map(String);
}

/** Is `rowKey` collected at signing on a lease of `leaseTerm`? */
export function isPaymentDueAtSigning(
  sub: ListingSigningSource,
  rowKey: string,
  leaseTerm: string | null | undefined,
  roomId?: string | null,
): boolean {
  const term = String(leaseTerm ?? "").trim();
  if (!term) {
    const matrix = paymentAtSigningMatrix(sub);
    return Object.values(matrix).some((keys) => signingKeysInclude(keys, rowKey, roomId));
  }
  return signingKeysInclude(paymentAtSigningKeysFor(sub, term, roomId), rowKey, roomId);
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
