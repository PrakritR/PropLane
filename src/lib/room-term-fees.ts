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

import { listingPricingLeaseTabs } from "@/lib/listing-fee-scope";
import { resolveSubmissionRoom, type SubmissionRoomLookup } from "@/lib/listing-room-resolution";
import {
  isEntireHomeListing,
  roomOfferedLeaseTerms,
  type ManagerBundleRow,
  type ManagerCustomFeeRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import {
  placementFeeOptionsFor,
  placementStandardFeeRaw,
  resolvedMoveInFeeRaw,
  resolvePlacementStandardFees,
} from "@/lib/listing-placement-standard-fees";
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
export function termFeeRaw(row: RoomFeeRow | null | undefined, fee: TermScopedFee, scope: RoomFeeTermScope): string {
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

type FeeRoom = Pick<ManagerRoomSubmission, "occupancyPrices" | "termPricing">;

/**
 * The fees one placement sets for a lease term. Lease / Application / Move-in all come from
 * `listing-placement-standard-fees.ts` -- the ONE resolver (a stay type's own value replaces the
 * house fee, empty inherits) that the quote, the application fee charged, the signing charges and
 * the lease snapshot also read. Only the two start surcharges are read here, off the arrangement row.
 */
export function resolveRoomTermFees(input: {
  sub: ManagerListingSubmissionV1;
  room?: FeeRoom | null;
  leaseTerm?: string | null;
  rentalType?: string | null;
  arrangementCount?: number;
  /** Quote the whole-house row instead of a room's. */
  wholeHouse?: boolean;
  /** A bundle placement: its own entry stands in for a room's. */
  bundle?: Pick<ManagerBundleRow, "termPricing"> | null;
  /** The application the applicant filled in (selector); picks whose template fee sits under the room's. */
  applicationTemplateId?: string | null;
}): ResolvedRoomTermFees {
  const scope = roomFeeTermScope(input.leaseTerm, input.rentalType);
  const room = input.wholeHouse ? null : ((input.room ?? null) as ManagerRoomSubmission | null);
  const opts = placementFeeOptionsFor(input.sub, {
    room,
    wholeHouse: input.wholeHouse,
    leaseTerm: input.leaseTerm,
    rentalType: input.rentalType,
    arrangementCount: input.arrangementCount ?? 1,
    bundle: input.bundle,
    applicationTemplateId: input.applicationTemplateId,
  });
  const fees = resolvePlacementStandardFees(input.sub, opts);
  const row = input.bundle
    ? undefined
    : input.wholeHouse
      ? input.sub.entireHomeArrangementFees
      : roomFeeRow(input.sub, input.room, input.arrangementCount ?? 1);
  return {
    scope,
    applicationFee: fees.applicationFee,
    leaseFee: fees.leaseFee,
    moveInFee: parseMoneyAmount(resolvedMoveInFeeRaw(input.sub, opts)),
    monthToMonthSurcharge: scope === "long" ? money(row?.monthToMonthSurcharge) : 0,
    customStartSurcharge: scope === "long" ? money(row?.customStartSurcharge) : 0,
  };
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
  /** A bundle placement: the bundle's own Lease / Application fee entry stands in for a room's. */
  bundle?: Pick<ManagerBundleRow, "termPricing"> | null;
  /** The application the applicant filled in (selector, never an amount); its template fee sits under the room's. */
  applicationTemplateId?: string | null;
};

/** True when any stored application or lease template carries a fee (so the overlay has something to apply with no room row). */
function hasAnyTemplateFee(sub: ManagerListingSubmissionV1): boolean {
  return (
    (sub.propertyApplicationTemplates ?? []).some((t) => typeof t.feeCentsOverride === "number") ||
    (sub.propertyLeaseTemplates ?? []).some((t) => typeof t.leaseFeeCents === "number")
  );
}

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
 * byte-identical to before. Application fee is overlaid for the document; the
 * application CHARGE reads the same row through `application-fee-by-room.ts`.
 */
export function submissionWithRoomTermFees<T extends ManagerListingSubmissionV1>(
  sub: T,
  room: Pick<ManagerRoomSubmission, "id" | "occupancyPrices" | "termPricing"> | null | undefined,
  ctx: RoomFeeOverlayContext,
): T;
export function submissionWithRoomTermFees<T extends ManagerListingSubmissionV1>(
  sub: T | null | undefined,
  room: Pick<ManagerRoomSubmission, "id" | "occupancyPrices" | "termPricing"> | null | undefined,
  ctx: RoomFeeOverlayContext,
): T | null | undefined;
export function submissionWithRoomTermFees<T extends ManagerListingSubmissionV1>(
  sub: T | null | undefined,
  room: Pick<ManagerRoomSubmission, "id" | "occupancyPrices" | "termPricing"> | null | undefined,
  ctx: RoomFeeOverlayContext,
): T | null | undefined {
  if (!sub || (!room && !ctx.wholeHouse && !ctx.bundle && !hasAnyTemplateFee(sub))) return sub;
  const row = ctx.bundle
    ? undefined
    : ctx.wholeHouse
      ? sub.entireHomeArrangementFees
      : room
        ? roomFeeRow(sub, room, ctx.arrangementCount ?? 1)
        : undefined;
  // A stay type's own fees live on the room's term entry, not the arrangement row, so a room
  // with no row can still carry them. A template fee needs no room at all.
  const hasTemplateFee = hasAnyTemplateFee(sub);
  if (!row && !ctx.bundle && !(room as FeeRoom | null | undefined)?.termPricing && !hasTemplateFee) return sub;
  const feeOwnerId = ctx.bundle ? "bundle" : ctx.wholeHouse ? "whole" : (room?.id ?? "listing");
  const scope = roomFeeTermScope(ctx.leaseTerm, ctx.rentalType);
  let next: ManagerListingSubmissionV1 = sub;
  let changed = false;
  const removed = new Set(sub.removedStandardListingFeeRows ?? []);
  let removedChanged = false;

  if (scope === "long" && row) {
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

  // Application fee and Lease fee come from the ONE placement resolver (the stay type's own value
  // replaces the house fee; empty inherits), the same answer the quote and the charge read.
  const own = placementStandardFeeRaw(
    sub,
    placementFeeOptionsFor(sub, {
      room: ctx.wholeHouse || ctx.bundle ? null : (room as ManagerRoomSubmission | null),
      wholeHouse: ctx.wholeHouse,
      bundle: ctx.bundle,
      leaseTerm: ctx.leaseTerm,
      rentalType: ctx.rentalType,
      arrangementCount: ctx.arrangementCount ?? 1,
      applicationTemplateId: ctx.applicationTemplateId,
    }),
  );
  const appRaw = own.applicationFee ?? "";
  if (appRaw !== "") {
    next = { ...next, applicationFee: appRaw };
    changed = true;
  }

  const leaseFee = money(own.leaseFee ?? "");
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

/** The stored bundle an application names, or null (no id, or an id the listing no longer has). */
function bundleOfLookup(sub: ManagerListingSubmissionV1, bundleId: string | null | undefined): ManagerBundleRow | null {
  const id = bundleId?.trim();
  return id ? (sub.bundles ?? []).find((row) => row.id === id) ?? null : null;
}

/**
 * `submissionWithRoomTermFees` for an application: finds the room the SAME way the charge
 * ledger and the lease document do (`resolveSubmissionRoom`), and reads the whole-house row
 * on an entire-home listing. A bundle placement reads the BUNDLE's own Lease / Application fee
 * (its `termPricing` entry), since a bundle lets several rooms and has no single room row.
 */
export function submissionWithApplicationRoomFees<T extends ManagerListingSubmissionV1>(
  sub: T | null | undefined,
  lookup: SubmissionRoomLookup & { bundleId?: string | null },
  ctx: { leaseTerm?: string | null; rentalType?: string | null; applicationTemplateId?: string | null },
): T | null | undefined {
  if (!sub) return sub;
  if (lookup.bundleId?.trim()) {
    const bundle = bundleOfLookup(sub, lookup.bundleId);
    return bundle ? submissionWithRoomTermFees(sub, null, { ...ctx, bundle }) : sub;
  }
  if (isEntireHomeListing(sub)) return submissionWithRoomTermFees(sub, null, { ...ctx, wholeHouse: true });
  const room = resolveSubmissionRoom(sub, lookup);
  // No resolvable room still bills the template's lease fee (a form's fee needs no room).
  return submissionWithRoomTermFees(sub, room ?? null, ctx);
}

/** The fees the application's room sets for its lease term (what a terms rider prints), or null when the room can't be resolved. */
export function resolveApplicationRoomTermFees(
  sub: ManagerListingSubmissionV1 | null | undefined,
  lookup: SubmissionRoomLookup & { bundleId?: string | null },
  ctx: { leaseTerm?: string | null; rentalType?: string | null; applicationTemplateId?: string | null },
): ResolvedRoomTermFees | null {
  if (!sub) return null;
  if (lookup.bundleId?.trim()) {
    const bundle = bundleOfLookup(sub, lookup.bundleId);
    return bundle ? resolveRoomTermFees({ sub, bundle, ...ctx }) : null;
  }
  if (isEntireHomeListing(sub)) return resolveRoomTermFees({ sub, wholeHouse: true, ...ctx });
  const room = resolveSubmissionRoom(sub, lookup);
  return room ? resolveRoomTermFees({ sub, room, ...ctx }) : null;
}
