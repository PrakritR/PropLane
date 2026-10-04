/**
 * Lease / application / move-in fees for one placement (room + lease term + arrangement).
 *
 * A stay type's own value replaces the house fee of the same kind — it never stacks a
 * second line. Empty on the stay type inherits the long-term arrangement row, then listing
 * defaults (`listingApplicationFeeRaw`, move-in preset, etc.).
 */

import { parseMoneyAmount } from "@/lib/parse-money";
import { listingApplicationFeeRaw } from "@/lib/listing-application-fee";
import {
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
  type ManagerRoomTermPrice,
} from "@/lib/manager-listing-submission";
import { listingPresetFeeAmountIfEnabled } from "@/lib/listing-fee-term-toggles";
import { templateFeeRaw } from "@/lib/form-template-fees";
import { AIRBNB_LEASE_TERM, LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { RoomOccupancyPrice } from "@/lib/room-arrangement-pricing";

export type PlacementStandardFeeKind = "leaseFee" | "applicationFee" | "moveInFee";

export type PlacementStandardFees = {
  /** The placement's own lease fee; 0 when it has none (there is no house lease fee). */
  leaseFee: number;
  /** The placement's own application fee, else the listing's per-type fee ({@link listingApplicationFeeRaw}). */
  applicationFee: number;
  /** True when the placement itself carries an application fee (what the checkout charges over the account default). */
  applicationFeeExplicit: boolean;
  /** The placement's own move-in amount; 0 unless {@link moveInOverridesHouse}. */
  moveInFee: number;
  /** True when the placement carries its own move-in amount: the house move-in fee is replaced, never added to. */
  moveInOverridesHouse: boolean;
  /** True when the placement carries its own lease-fee amount. */
  leaseFeeExplicit: boolean;
};

export type PlacementFeeOptions = {
  leaseTerm: string;
  room?: ManagerRoomSubmission | null;
  arrangementCount?: number | null;
  entireHomeFees?: ManagerListingSubmissionV1["entireHomeArrangementFees"];
  isStay: boolean;
  /**
   * A bundle placement (an applicant who applied for / was placed on a bundle): its Lease fee and
   * Application fee live in `termPricing[term]`, the entry shape a room's term step uses. Takes the
   * place of `room`; a bundle has no arrangement rows.
   */
  bundle?: Pick<ManagerBundleRow, "termPricing"> | null;
  /**
   * The application the applicant filled in (a selector into the stored templates, never an amount).
   * Picks whose template fee sits under the room override. Absent = the form routed to the lease type.
   */
  applicationTemplateId?: string | null;
  /** A lease chosen outright; else the lease the application maps to, else the one routed to the lease type. */
  leaseTemplateId?: string | null;
};

function readStoredTermFee(
  entry: Partial<Record<PlacementStandardFeeKind, string>> | undefined,
  kind: PlacementStandardFeeKind,
): string | undefined {
  const raw = entry?.[kind];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A stay's own lease / application fee stored on the arrangement row itself
 * (`shortTermLeaseFee` / `shortTermApplicationFee`). This is where an entire-home listing keeps
 * its Short term fees (it has no room, so no `termPricing`), and where rows saved before the
 * per-stay-type `termPricing` entry existed keep theirs.
 */
const STAY_FEE_FIELD_ON_ROW = {
  leaseFee: "shortTermLeaseFee",
  applicationFee: "shortTermApplicationFee",
} as const;

function readStayFeeOnRow(
  row: RoomOccupancyPrice | { leaseFee?: string; applicationFee?: string; moveInFee?: string } | undefined,
  kind: PlacementStandardFeeKind,
): string | undefined {
  if (kind === "moveInFee") return undefined;
  const raw = (row as Record<string, unknown> | undefined)?.[STAY_FEE_FIELD_ON_ROW[kind]];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readArrangementFee(
  row: RoomOccupancyPrice | { leaseFee?: string; applicationFee?: string; moveInFee?: string } | undefined,
  kind: PlacementStandardFeeKind,
): string | undefined {
  const raw = row?.[kind];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Raw money strings for one placement before manager-default fallback on application fee.
 *
 * The chain (captain, Oct 3 2026), per kind:
 *   the placement's OWN value (a room / bundle / whole-house override)
 *   -> the TEMPLATE's fee for that lease type (the application's Application fee, the lease's Lease fee)
 *   -> the long-term / whole-house inheritance a stay already followed
 *   -> (the callers' listing-level / account / legacy fallbacks).
 * A template that sets no fee is skipped, so a property with no template fee resolves exactly as it did.
 */
export function placementStandardFeeRaw(
  sub: ManagerListingSubmissionV1,
  options: PlacementFeeOptions,
): Record<PlacementStandardFeeKind, string | undefined> {
  return placementFeeRawChain(sub, options, true);
}

/** Which level of the chain supplies a kind for one placement: the placement's own value, its template, or neither. */
export function placementFeeLevel(
  sub: ManagerListingSubmissionV1,
  options: PlacementFeeOptions,
  kind: "applicationFee" | "leaseFee",
): "room" | "template" | null {
  if (placementFeeRawChain(sub, options, false)[kind] !== undefined) return "room";
  return placementFeeRawChain(sub, options, true)[kind] !== undefined ? "template" : null;
}

function placementFeeRawChain(
  sub: ManagerListingSubmissionV1,
  options: PlacementFeeOptions,
  includeTemplate: boolean,
): Record<PlacementStandardFeeKind, string | undefined> {
  const leaseTerm = String(options.leaseTerm ?? "").trim() || LONG_TERM_LEASE_TERM;
  const isBase = leaseTerm === LONG_TERM_LEASE_TERM;
  const room = options.room ?? null;
  const count =
    typeof options.arrangementCount === "number" &&
    Number.isInteger(options.arrangementCount) &&
    options.arrangementCount >= 1
      ? options.arrangementCount
      : 1;

  const longTermRow =
    room?.occupancyPrices?.find((row) => row.count === count) ??
    room?.occupancyPrices?.find((row) => row.count === 1);
  const termEntry = !isBase ? room?.termPricing?.[leaseTerm] : undefined;

  // A private room reads the term's own fields; a shared arrangement reads its band of them.
  const fromTerm = (kind: PlacementStandardFeeKind) =>
    count >= 2
      ? readStoredTermFee(termEntry?.arrangementFees?.[String(count)], kind)
      : readStoredTermFee(termEntry, kind);

  const fromLongTermArrangement = (kind: PlacementStandardFeeKind) => readArrangementFee(longTermRow, kind);

  const fromEntireHome = (kind: PlacementStandardFeeKind) =>
    options.entireHomeFees ? readArrangementFee({ count: 1, ...options.entireHomeFees }, kind) : undefined;

  const isStayTerm = leaseTerm === SHORT_TERM_LEASE_TERM || leaseTerm === AIRBNB_LEASE_TERM;
  const fromStayFieldOnRow = (kind: PlacementStandardFeeKind) =>
    isStayTerm
      ? readStayFeeOnRow(longTermRow, kind) ??
        (options.entireHomeFees ? readStayFeeOnRow(options.entireHomeFees as RoomOccupancyPrice, kind) : undefined)
      : undefined;

  const bundle = options.bundle ?? null;
  const fromBundle = (kind: PlacementStandardFeeKind, term: string) =>
    kind === "moveInFee" ? undefined : readStoredTermFee(bundle?.termPricing?.[term], kind);

  const fromTemplate = (kind: PlacementStandardFeeKind): string | undefined =>
    includeTemplate && kind !== "moveInFee"
      ? templateFeeRaw(sub, kind, {
          leaseTerm,
          isStay: options.isStay,
          applicationTemplateId: options.applicationTemplateId,
          leaseTemplateId: options.leaseTemplateId,
        })
      : undefined;

  const resolve = (kind: PlacementStandardFeeKind): string | undefined => {
    if (bundle) {
      return isBase
        ? fromBundle(kind, leaseTerm) ?? fromTemplate(kind)
        : fromBundle(kind, leaseTerm) ?? fromTemplate(kind) ?? fromBundle(kind, LONG_TERM_LEASE_TERM);
    }
    if (isBase) {
      return fromLongTermArrangement(kind) ?? fromEntireHome(kind) ?? fromTemplate(kind);
    }
    return (
      fromTerm(kind) ??
      fromStayFieldOnRow(kind) ??
      fromTemplate(kind) ??
      fromLongTermArrangement(kind) ??
      fromEntireHome(kind)
    );
  };

  return {
    leaseFee: resolve("leaseFee"),
    applicationFee: resolve("applicationFee"),
    moveInFee: resolve("moveInFee"),
  };
}

export function resolvePlacementStandardFees(
  sub: ManagerListingSubmissionV1,
  options: PlacementFeeOptions,
): PlacementStandardFees {
  const raw = placementStandardFeeRaw(sub, options);
  const applicationRaw =
    raw.applicationFee ??
    listingApplicationFeeRaw(sub, options.isStay ? "short_term" : "standard", options.leaseTerm);

  return {
    leaseFee: parseMoneyAmount(raw.leaseFee ?? ""),
    applicationFee: parseMoneyAmount(applicationRaw),
    applicationFeeExplicit: raw.applicationFee !== undefined,
    moveInFee: parseMoneyAmount(raw.moveInFee ?? ""),
    moveInOverridesHouse: raw.moveInFee !== undefined,
    leaseFeeExplicit: raw.leaseFee !== undefined,
  };
}

/**
 * The move-in fee for one placement as a raw money string -- the one answer every move-in
 * consumer (charges at approval/signing, the placement preview, the lease billing snapshot)
 * feeds `savedAmount`. The stay type's own value replaces the house chain (room fee ->
 * listing preset, term toggles honoured); empty inherits it.
 */
export function resolvedMoveInFeeRaw(
  sub: ManagerListingSubmissionV1 | null | undefined,
  options: PlacementFeeOptions,
): string {
  if (!sub) return "";
  const own = placementStandardFeeRaw(sub, options).moveInFee;
  if (own !== undefined) return own;
  const room = options.room ?? null;
  if (options.isStay) {
    const roomStay = (room?.shortTermMoveInFee ?? "").trim();
    if (roomStay) return roomStay;
    return String(
      listingPresetFeeAmountIfEnabled(sub, "short_term_move_in") || parseMoneyAmount(sub.shortTermMoveInFee ?? ""),
    );
  }
  const roomLong = (room?.moveInFee ?? "").trim();
  if (roomLong) return roomLong;
  return String(listingPresetFeeAmountIfEnabled(sub, "move_in_fee") || parseMoneyAmount(sub.moveInFee ?? ""));
}

/**
 * The application fee a placement carries of its own, in cents -- `null` when the stay type
 * typed none (the account's Application system fee then applies, see
 * `effectiveApplicationFeeCents`). An explicit 0 is a real answer: that stay type is free.
 */
export function placementApplicationFeeCents(
  sub: ManagerListingSubmissionV1 | null | undefined,
  options: PlacementFeeOptions,
): number | null {
  if (!sub) return null;
  const raw = placementStandardFeeRaw(sub, options).applicationFee;
  return raw === undefined ? null : Math.round(parseMoneyAmount(raw) * 100);
}

/**
 * The placement options for one selection (room or whole house, lease type, rental type) -- how
 * every consumer (quote, application fee charged, lease document, charge ledger) turns what the
 * applicant chose into the ONE resolver's input, so none of them keeps its own stay / long-term test.
 */
export function placementFeeOptionsFor(
  sub: Pick<ManagerListingSubmissionV1, "entireHomeArrangementFees">,
  input: {
    room?: ManagerRoomSubmission | null;
    wholeHouse?: boolean;
    leaseTerm?: string | null;
    rentalType?: string | null;
    arrangementCount?: number | null;
    /** The bundle the applicant applied for; it takes the place of a room. */
    bundle?: Pick<ManagerBundleRow, "termPricing"> | null;
    applicationTemplateId?: string | null;
    leaseTemplateId?: string | null;
  },
): PlacementFeeOptions {
  const term = String(input.leaseTerm ?? "").trim();
  const isStay =
    input.rentalType === "short_term" ||
    input.rentalType === "airbnb" ||
    term === SHORT_TERM_LEASE_TERM ||
    term === AIRBNB_LEASE_TERM;
  const room = input.room ?? null;
  return {
    leaseTerm: isStay ? stayPlacementLeaseTerm(term) : term || LONG_TERM_LEASE_TERM,
    room,
    arrangementCount: input.arrangementCount ?? null,
    entireHomeFees: !room && input.wholeHouse ? sub.entireHomeArrangementFees : undefined,
    isStay,
    ...(input.bundle ? { bundle: input.bundle } : {}),
    ...(input.applicationTemplateId ? { applicationTemplateId: input.applicationTemplateId } : {}),
    ...(input.leaseTemplateId ? { leaseTemplateId: input.leaseTemplateId } : {}),
  };
}

/** The stay term a short-stay placement is priced under: its own stay lease type, else Short-Term Stay. */
export function stayPlacementLeaseTerm(leaseTerm: string | null | undefined): string {
  const t = String(leaseTerm ?? "").trim();
  return t === AIRBNB_LEASE_TERM ? AIRBNB_LEASE_TERM : SHORT_TERM_LEASE_TERM;
}

/** Long-term private arrangement row — base store for standard fees on a room. */
export function longTermPrivateArrangementRow(room: ManagerRoomSubmission): RoomOccupancyPrice {
  return room.occupancyPrices?.find((r) => r.count === 1) ?? { count: 1 };
}

export function mergeLongTermPrivateArrangementRow(
  room: ManagerRoomSubmission,
  patch: Partial<Pick<RoomOccupancyPrice, PlacementStandardFeeKind | "monthToMonthSurcharge" | "customStartSurcharge">>,
): ManagerRoomSubmission {
  const row = { ...longTermPrivateArrangementRow(room), ...patch, count: 1 as const };
  const rest = (room.occupancyPrices ?? []).filter((r) => r.count !== 1);
  return { ...room, occupancyPrices: [...rest, row] };
}

export function termStandardFeeRow(
  room: ManagerRoomSubmission,
  term: string,
  count = 1,
): Pick<ManagerRoomTermPrice, PlacementStandardFeeKind> {
  const entry = room.termPricing?.[term];
  return (count >= 2 ? entry?.arrangementFees?.[String(count)] : entry) ?? {};
}

const FEE_KINDS = ["leaseFee", "applicationFee", "moveInFee"] as const;

function withoutBlankFees<T extends Partial<Record<PlacementStandardFeeKind, string>>>(fees: T): T {
  const next = { ...fees };
  for (const key of FEE_KINDS) {
    const v = next[key];
    if (typeof v === "string" && v.trim() === "") delete next[key];
  }
  return next;
}

/** Writes one stay type's own fees (private room, or the shared arrangement `count`); blank clears so it inherits. */
export function mergeTermStandardFees<T extends { termPricing?: Record<string, ManagerRoomTermPrice> }>(
  room: T,
  term: string,
  rawPatch: Partial<Record<string, unknown>>,
  count = 1,
): T {
  // Only the three fees, and only the ones actually being written.
  const patch: Partial<Record<PlacementStandardFeeKind, string>> = {};
  for (const key of FEE_KINDS) {
    const v = rawPatch[key];
    if (typeof v === "string") patch[key] = v;
  }
  const current = room.termPricing?.[term] ?? {};
  let entry: ManagerRoomTermPrice;
  if (count >= 2) {
    const band = withoutBlankFees({ ...(current.arrangementFees?.[String(count)] ?? {}), ...patch });
    const bands = { ...(current.arrangementFees ?? {}) };
    if (Object.keys(band).length === 0) delete bands[String(count)];
    else bands[String(count)] = band;
    entry = { ...current };
    if (Object.keys(bands).length === 0) delete entry.arrangementFees;
    else entry.arrangementFees = bands;
  } else {
    entry = withoutBlankFees({ ...current, ...patch });
  }
  const all = { ...(room.termPricing ?? {}) };
  if (Object.keys(entry).length === 0) delete all[term];
  else all[term] = entry;
  return { ...room, termPricing: Object.keys(all).length > 0 ? all : undefined };
}

export function formatPlacementMoneyField(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const n = parseMoneyAmount(trimmed);
  if (!Number.isFinite(n) || n <= 0) return trimmed;
  if (n % 1 === 0) return Math.round(n).toLocaleString("en-US");
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
