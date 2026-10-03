/**
 * Room-level fees by lease term - the ONE place the property Pricing popup, the
 * "What a resident pays" receipt and the generated lease read them.
 *
 * A room (or the whole house) keeps its Lease fee / Application fee / Move-in
 * fee and its two start surcharges on the Private arrangement row
 * (`room.occupancyPrices[count]`, `sub.entireHomeArrangementFees`). Two of them
 * are PER TERM:
 *
 *  - Long-term step      -> `leaseFee`, `applicationFee`
 *  - Short term step     -> `shortTermLeaseFee`, `shortTermApplicationFee`
 *
 * An absent short-term value means the stay pays the shared (long-term) value,
 * so every row saved before the short-term fields existed reads exactly as it
 * did. A typed `0` is a real answer ("free for stays") and wins over it.
 *
 * Nothing here invents a price: a fee nobody set resolves to 0 and prints no
 * line anywhere.
 */

import { listingApplicationFeeRaw } from "@/lib/listing-application-fee";
import { listingPricingLeaseTabs } from "@/lib/listing-fee-scope";
import { resolveSubmissionRoom, type SubmissionRoomLookup } from "@/lib/listing-room-resolution";
import {
  isEntireHomeListing,
  roomOfferedLeaseTerms,
  type ManagerCustomFeeRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { parseMoneyAmount } from "@/lib/parse-money";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import type { RoomOccupancyPrice } from "@/lib/room-arrangement-pricing";

export const MONTH_TO_MONTH_LEASE_TERM = "Month-to-Month";

/** The two term scopes a fee can be set under. A stay (Short term / Airbnb) is "short"; everything else is "long". */
export type RoomFeeTermScope = "long" | "short";

export type RoomFeeRow = Partial<
  Pick<
    RoomOccupancyPrice,
    | "leaseFee"
    | "applicationFee"
    | "moveInFee"
    | "monthToMonthSurcharge"
    | "customStartSurcharge"
    | "shortTermLeaseFee"
    | "shortTermApplicationFee"
  >
>;

export type TermScopedFee = "applicationFee" | "leaseFee";

export function roomFeeTermScope(
  leaseTerm: string | null | undefined,
  rentalType?: string | null,
): RoomFeeTermScope {
  if (rentalType === "short_term" || rentalType === "airbnb") return "short";
  const term = String(leaseTerm ?? "").trim();
  return term === SHORT_TERM_LEASE_TERM || term === AIRBNB_LEASE_TERM ? "short" : "long";
}

const FIELD: Record<TermScopedFee, Record<RoomFeeTermScope, keyof RoomFeeRow>> = {
  applicationFee: { long: "applicationFee", short: "shortTermApplicationFee" },
  leaseFee: { long: "leaseFee", short: "shortTermLeaseFee" },
};

/** The stored field a step edits for this fee. */
export function termFeeField(fee: TermScopedFee, scope: RoomFeeTermScope): keyof RoomFeeRow {
  return FIELD[fee][scope];
}

/**
 * What a step's Application fee / Lease fee box shows. `own` is false while a
 * short-term step is still following the shared value (shown as the inherited
 * placeholder, never written back until the manager types).
 */
export function termFeeText(
  row: RoomFeeRow | null | undefined,
  fee: TermScopedFee,
  scope: RoomFeeTermScope,
): { value: string; placeholder: string; own: boolean } {
  const shared = String(row?.[FIELD[fee].long] ?? "").trim();
  if (scope === "long") return { value: shared, placeholder: "", own: true };
  const own = String(row?.[FIELD[fee].short] ?? "").trim();
  return own !== "" ? { value: own, placeholder: "", own: true } : { value: "", placeholder: shared, own: false };
}

/** The patch a step writes when the manager types in its Application fee / Lease fee box. */
export function termFeePatch(fee: TermScopedFee, scope: RoomFeeTermScope, value: string): RoomFeeRow {
  return { [FIELD[fee][scope]]: value } as RoomFeeRow;
}

/** The effective money string for a term-scoped fee: this term's own value, else (stays only) the shared one. */
function termFeeRaw(row: RoomFeeRow | null | undefined, fee: TermScopedFee, scope: RoomFeeTermScope): string {
  const own = String(row?.[FIELD[fee][scope]] ?? "").trim();
  if (own !== "" || scope === "long") return own;
  return String(row?.[FIELD[fee].long] ?? "").trim();
}

/* ------------------------------------------------------------------ *
 * Which rows the popup shows
 * ------------------------------------------------------------------ */

export type RoomPricingFeeVisibility = {
  /** "Month-to-month surcharge" - only when Month-to-month is offered. */
  monthToMonthSurcharge: boolean;
  /** "Custom start surcharge" - only when Custom is offered. */
  customStartSurcharge: boolean;
  /** "Partial months" - a lease can start mid-month only on Custom. */
  partialMonths: boolean;
};

/** Visibility from an explicit list of offered lease terms. */
export function feeVisibilityForTerms(offered: readonly string[]): RoomPricingFeeVisibility {
  const customStartSurcharge = offered.includes(CUSTOM_LEASE_TERM);
  return {
    monthToMonthSurcharge: offered.includes(MONTH_TO_MONTH_LEASE_TERM),
    customStartSurcharge,
    partialMonths: customStartSurcharge,
  };
}

/** The lease types a room is offered on: its own `offeredLeaseTerms` when set, else the listing's. */
export function roomOfferedTermsForPricing(
  sub: Pick<
    ManagerListingSubmissionV1,
    "allowedLeaseTerms" | "leaseTermsBody" | "shortTermRentalsAllowed" | "airbnbRentalsAllowed"
  >,
  room: Pick<ManagerRoomSubmission, "offeredLeaseTerms"> | null | undefined,
): string[] {
  return roomOfferedLeaseTerms(room, listingPricingLeaseTabs(sub));
}

export function roomPricingFeeVisibility(
  sub: Pick<
    ManagerListingSubmissionV1,
    "allowedLeaseTerms" | "leaseTermsBody" | "shortTermRentalsAllowed" | "airbnbRentalsAllowed"
  >,
  room: Pick<ManagerRoomSubmission, "offeredLeaseTerms"> | null | undefined,
): RoomPricingFeeVisibility {
  return feeVisibilityForTerms(roomOfferedTermsForPricing(sub, room));
}

/* ------------------------------------------------------------------ *
 * The resolver the receipt and the lease both read
 * ------------------------------------------------------------------ */

export type ResolvedRoomTermFees = {
  scope: RoomFeeTermScope;
  applicationFee: number;
  leaseFee: number;
  moveInFee: number;
  monthToMonthSurcharge: number;
  customStartSurcharge: number;
};

function money(raw: string | undefined | null): number {
  const n = parseMoneyAmount(raw ?? "");
  return n > 0 ? n : 0;
}

/** The arrangement row a room's fees live on (Private = count 1), or the whole-house row. */
export function roomFeeRow(
  sub: Pick<ManagerListingSubmissionV1, "entireHomeArrangementFees">,
  room: Pick<ManagerRoomSubmission, "occupancyPrices"> | null | undefined,
  arrangementCount = 1,
): RoomFeeRow | undefined {
  if (!room) return sub.entireHomeArrangementFees;
  return room.occupancyPrices?.find((row) => row.count === arrangementCount);
}

/** Resolve the fees one arrangement row sets for a lease term. The row is whatever the caller already chose (a room's count, or the whole house). */
export function resolveTermFeesFromRow(input: {
  sub: ManagerListingSubmissionV1;
  row: RoomFeeRow | null | undefined;
  leaseTerm?: string | null;
  rentalType?: string | null;
}): ResolvedRoomTermFees {
  const scope = roomFeeTermScope(input.leaseTerm, input.rentalType);
  const { row } = input;
  const appRaw = termFeeRaw(row, "applicationFee", scope);
  const applicationFee = money(
    appRaw !== ""
      ? appRaw
      : listingApplicationFeeRaw(input.sub, scope === "short" ? "short_term" : "standard", input.leaseTerm),
  );
  return {
    scope,
    applicationFee,
    leaseFee: money(termFeeRaw(row, "leaseFee", scope)),
    moveInFee: money(row?.moveInFee),
    monthToMonthSurcharge: scope === "long" ? money(row?.monthToMonthSurcharge) : 0,
    customStartSurcharge: scope === "long" ? money(row?.customStartSurcharge) : 0,
  };
}

export function resolveRoomTermFees(input: {
  sub: ManagerListingSubmissionV1;
  room?: Pick<ManagerRoomSubmission, "occupancyPrices"> | null;
  leaseTerm?: string | null;
  rentalType?: string | null;
  arrangementCount?: number;
  /** Quote the whole-house row instead of a room's. */
  wholeHouse?: boolean;
}): ResolvedRoomTermFees {
  const row = input.wholeHouse
    ? input.sub.entireHomeArrangementFees
    : roomFeeRow(input.sub, input.room, input.arrangementCount ?? 1);
  return resolveTermFeesFromRow({ sub: input.sub, row, leaseTerm: input.leaseTerm, rentalType: input.rentalType });
}

/* ------------------------------------------------------------------ *
 * The lease / ledger overlay
 * ------------------------------------------------------------------ */

export type RoomFeeOverlayContext = {
  leaseTerm?: string | null;
  rentalType?: string | null;
  arrangementCount?: number;
  /** Read the whole-house row (`sub.entireHomeArrangementFees`) instead of a room's. */
  wholeHouse?: boolean;
};

export const ROOM_LEASE_FEE_ID_PREFIX = "room_lease_fee:";
export const ROOM_LEASE_FEE_LABEL = "Lease fee";

function cleanMoneyText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function syncPresetRow(
  sub: ManagerListingSubmissionV1,
  presetId: "mtm_surcharge" | "custom_lease_surcharge",
  amount: string,
): ManagerCustomFeeRow[] | undefined {
  const rows = sub.customFees;
  if (!rows?.some((fee) => (fee as { presetId?: string }).presetId === presetId)) return rows;
  return rows.map((fee) =>
    (fee as { presetId?: string }).presetId === presetId ? { ...fee, amount } : fee,
  );
}

/**
 * The listing as THIS room's tenancy bills it: the room's own surcharges replace
 * the listing preset amounts, and the room's Lease fee for the lease's term is a
 * one-time fee. Everything downstream (lease document, signing total, charge
 * ledger) already reads the listing's fee rows, so overlaying them here keeps the
 * document, the total and the ledger on one set of numbers.
 *
 * Returns the SAME object when the room sets nothing, so an untouched listing is
 * byte-identical to before. Application fee is overlaid for the document only
 * (`applicationFee`); the application charge itself stays the server-resolved
 * system fee (`effectiveApplicationFeeCents`).
 */
export function submissionWithRoomTermFees<T extends ManagerListingSubmissionV1>(
  sub: T,
  room: Pick<ManagerRoomSubmission, "id" | "occupancyPrices"> | null | undefined,
  ctx: RoomFeeOverlayContext,
): T;
export function submissionWithRoomTermFees<T extends ManagerListingSubmissionV1>(
  sub: T | null | undefined,
  room: Pick<ManagerRoomSubmission, "id" | "occupancyPrices"> | null | undefined,
  ctx: RoomFeeOverlayContext,
): T | null | undefined;
export function submissionWithRoomTermFees<T extends ManagerListingSubmissionV1>(
  sub: T | null | undefined,
  room: Pick<ManagerRoomSubmission, "id" | "occupancyPrices"> | null | undefined,
  ctx: RoomFeeOverlayContext,
): T | null | undefined {
  if (!sub || (!room && !ctx.wholeHouse)) return sub;
  const row = ctx.wholeHouse ? sub.entireHomeArrangementFees : roomFeeRow(sub, room, ctx.arrangementCount ?? 1);
  if (!row) return sub;
  const feeOwnerId = ctx.wholeHouse ? "whole" : room!.id;
  const scope = roomFeeTermScope(ctx.leaseTerm, ctx.rentalType);
  let next: ManagerListingSubmissionV1 = sub;
  let changed = false;
  const removed = new Set(sub.removedStandardListingFeeRows ?? []);
  let removedChanged = false;

  if (scope === "long") {
    const mtm = money(row.monthToMonthSurcharge);
    if (mtm > 0) {
      const text = cleanMoneyText(mtm);
      removedChanged = removed.delete("monthToMonthSurcharge") || removedChanged;
      next = { ...next, monthToMonthSurcharge: text, customFees: syncPresetRow(next, "mtm_surcharge", text) };
      changed = true;
    }
    const custom = money(row.customStartSurcharge);
    if (custom > 0) {
      const text = cleanMoneyText(custom);
      removedChanged = removed.delete("customLeaseSurcharge") || removedChanged;
      next = { ...next, customLeaseSurcharge: text, customFees: syncPresetRow(next, "custom_lease_surcharge", text) };
      changed = true;
    }
  }

  const appRaw = termFeeRaw(row, "applicationFee", scope);
  if (appRaw !== "") {
    next = { ...next, applicationFee: appRaw };
    changed = true;
  }

  const leaseFee = money(termFeeRaw(row, "leaseFee", scope));
  if (leaseFee > 0) {
    const text = cleanMoneyText(leaseFee);
    const feeRow: ManagerCustomFeeRow = {
      id: `${ROOM_LEASE_FEE_ID_PREFIX}${feeOwnerId}`,
      label: ROOM_LEASE_FEE_LABEL,
      amount: text,
      // A stay bills the short-term amount (rentalType short_term); a standard tenancy bills `amount`.
      ...(scope === "short" ? { shortTermAmount: text } : {}),
      frequency: "one-time",
    };
    next = {
      ...next,
      customFees: [
        ...(next.customFees ?? []).filter((fee) => !fee.id.startsWith(ROOM_LEASE_FEE_ID_PREFIX)),
        feeRow,
      ],
    };
    changed = true;
  }

  if (!changed) return sub;
  if (removedChanged) {
    next = { ...next, removedStandardListingFeeRows: [...removed] };
  }
  return next as T;
}

/**
 * `submissionWithRoomTermFees` for an application: finds the room the SAME way the charge
 * ledger and the lease document do (`resolveSubmissionRoom`), and reads the whole-house row
 * on an entire-home listing. A bundle lets several rooms, so it overlays nothing.
 */
export function submissionWithApplicationRoomFees<T extends ManagerListingSubmissionV1>(
  sub: T | null | undefined,
  lookup: SubmissionRoomLookup & { bundleId?: string | null },
  ctx: { leaseTerm?: string | null; rentalType?: string | null },
): T | null | undefined {
  if (!sub || lookup.bundleId?.trim()) return sub;
  if (isEntireHomeListing(sub)) return submissionWithRoomTermFees(sub, null, { ...ctx, wholeHouse: true });
  const room = resolveSubmissionRoom(sub, lookup);
  return room ? submissionWithRoomTermFees(sub, room, ctx) : sub;
}

/** The fees the application's room sets for its lease term (what a terms rider prints), or null when the room can't be resolved. */
export function resolveApplicationRoomTermFees(
  sub: ManagerListingSubmissionV1 | null | undefined,
  lookup: SubmissionRoomLookup & { bundleId?: string | null },
  ctx: { leaseTerm?: string | null; rentalType?: string | null },
): ResolvedRoomTermFees | null {
  if (!sub || lookup.bundleId?.trim()) return null;
  if (isEntireHomeListing(sub)) return resolveRoomTermFees({ sub, wholeHouse: true, ...ctx });
  const room = resolveSubmissionRoom(sub, lookup);
  return room ? resolveRoomTermFees({ sub, room, ...ctx }) : null;
}
