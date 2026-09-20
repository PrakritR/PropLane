"use client";

/**
 * Pricing, in the order a manager sets it up.
 *
 * 1. **How you get paid** — the rails money arrives on, and who pays card
 *    processing. First, because nothing below matters until money can move.
 *    "PropLane pays" always asks for a processing coverage code; no plan and no
 *    subscription promo can stand in for one.
 * 2. **Each room** — the lease types offered, then the **application fee**
 *    directly under them (one amount, or one per lease type behind a checkbox;
 *    a blank type follows the one amount), then one card per room with a tab
 *    per lease type. The top card is **Default room**: rent, utilities, deposit,
 *    listed rent, and Other fees — no dedicated Move-in fee row. Rooms follow it
 *    until changed (grey and dashed = following, ink with a
 *    dot = the room's own). Month-to-month and custom dates are "same as
 *    long-term" until the box is unticked. Short-term is rent per night, rent
 *    per week — the rate is all-in.
 * 3. **Other fees live on the cards.** Every card — Default room or a room, on
 *    every tab — lists its fees and adds one in place. A fee added on the
 *    Default room is every room's; one added on a room is that room's; the tab
 *    it is added on decides the lease types (the three lease types, or the two
 *    stay types). There is no separate fees section and no More ▾: everything
 *    a card knows is simply listed (the captain, 2026-09-15). A house-wide fee
 *    shows on a room card as an inherited row: ✕ takes that room out of the
 *    fee's `roomIds`, and typing an amount splits a room-only copy off it, with
 *    Reset folding the room back in.
 * 4. **Partial months** — on the lease types that can start mid-month
 *    (long-term, custom dates) every card ends with "Automatic" ticked; unticked,
 *    the card asks for rent, utilities and each monthly fee per day
 *    (`prorateMethod` / `dailyRentRate` / `dailyUtilitiesRate` on the room and
 *    the Default card, `dailyRate` on the fee row). A room follows the Default
 *    card here exactly as it does for rent.
 * 5. **What a resident pays** (side panel) — signing ticks live there: Every
 *    room is house policy; pick a room to override and Reset to follow again.
 *
 * Nothing new is stored besides `applicationFeeByLeaseType` and an optional
 * per-room signing matrix. Rent is `room.monthlyRent`; another lease type's
 * own price is `room.termPricing[term]` with ABSENT meaning "same as
 * long-term" (PRP-463), which also drives signing inherit; fees are the same
 * `customFees` records scoped by `leaseTypes` / `roomIds`; the house defaults
 * are `listing-house-defaults.ts`. This screen is a view over all of it.
 */

import { useEffect, useMemo, useState } from "react";
import { AddRowButton, CardAction, CardFoot, CheckboxOption, ColumnHelp, EditorDone, FactRow, MoneyInput, MultiPick, RecordCard, RowSelectCell, SameAsAllToggle } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { applicationFeeLeaseTypeKey } from "@/lib/listing-application-fee";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import {
  feeAppliesToLeaseType,
  feeAppliesToRoom,
  listingFeeRowIdForPresetId,
  listingLeaseTypeScopeOptions,
  listingPricingLeaseTabs,
  listingPricingTabToLeaseTerm,
  narrowFeeScope,
} from "@/lib/listing-fee-scope";
import {
  applyListingFeesToSubmission,
  ensureSubmissionListingFees,
  seedSigningColumnFromLongTerm,
  feeAppliesToResidentSlot,
  isListingFeeAmountFilled,
  LISTING_FEE_PRESETS,
  listingFeeCadence,
  listingFeesForWizard,
  parseRemovedStandardListingFeeRows,
  patchListingFeeCadence,
  presetListingFeeRow,
  type ListingFeeCadence,
  type ListingFeeRow,
  type RemovedStandardListingFeeRowId,
} from "@/lib/listing-fees";
import { SEATTLE_RENT_RULE_NOTE, listingFoldsAllMonthlyFeesIntoRent } from "@/lib/seattle-rent-rule";
import { AIRBNB_LEASE_TERM, CUSTOM_LEASE_TERM, LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { isStayLeaseTerm } from "@/lib/listing-quote";
import { LONG_TERM_UTILITIES_PAYMENT_OPTIONS } from "@/lib/listing-utilities-payment";
import {
  applyHouseDefaultsToRooms,
  applyHouseTermPricingToRooms,
  clearRoomResidentPricing,
  houseTermPricingForSubmission,
  resetRoomFieldToDefault,
  roomInheritsDefault,
  termPriceFieldText,
  writeRoomTermPrice,
  writeTermPriceEntry,
  type ListingHouseDefaultField,
  type ListingHouseDefaults,
  type ListingHouseTermPricing,
  type ListingTermPriceField,
} from "@/lib/listing-house-defaults";
import {
  applyEntireHomeListingPricing,
  clampRoomResidentPrices,
  emptyCustomFeeRow,
  reconcileRoomResidentPricing,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomResidentPrice,
  type ManagerRoomSubmission,
  type ManagerRoomTermPrice,
  type RoomResidentPriceFallback,
} from "@/lib/manager-listing-submission";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { roomLowestResidentRent, roomPricesPerResident, roomResidentPrices } from "@/lib/room-pricing";
import { cn } from "@/lib/utils";
import { FieldMark } from "@/components/portal/listing-wizard-v2/found-online-card";
import { prefillMarkFor } from "@/lib/listing-prefill/apply";

type Patch = (next: Partial<ManagerListingSubmissionV1>) => void;

const usd = (n: number) => `$${Math.round(n || 0).toLocaleString("en-US")}`;
/**
 * A stored money string, as typed.
 *
 * `"0"` is a real answer — "this room's utilities are included", "no deposit" —
 * and it used to be scrubbed to `""` here, which the inheritance rule then read
 * as "unset" and replaced with the house number. That is why $0 could not be
 * entered anywhere on this screen (PRP-captain 2026-09-13). Absence is now the
 * ONLY way to say "follow the row above": an empty box inherits, any number you
 * type — zero included — is that room's own.
 */
const moneyValue = (raw: string | undefined) => (raw ?? "").replace(/^\$/, "").trim();
/** True when a money string holds a real figure, including an explicit zero. */
const moneyFilled = (raw: string | undefined) => moneyValue(raw).length > 0;
const num = (raw: string) => {
  const n = Number(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const PRICING_MODE_OPTIONS = [
  { value: "fixed", label: "Fixed" },
  { value: "flexible", label: "Flexible" },
] as const;

/* ─────────────────────── per-term reads and writes ─────────────────────── */

const isBase = (term: string) => term === LONG_TERM_LEASE_TERM;

const TERM_FIELD: Record<"rent" | "deposit" | "util", ListingTermPriceField> = {
  rent: "monthlyRent",
  deposit: "securityDeposit",
  util: "utilitiesEstimate",
};

/**
 * A room's value on `term` and where it came from: the room's own number
 * (`own`), the term's Default room (`tdef`), the room's long-term number
 * (`lt`), or the long-term Default room (`def`).
 */
function termValue(
  room: ManagerRoomSubmission,
  term: string,
  field: "rent" | "deposit" | "util",
  defaults: ListingHouseDefaults,
  termDefaults: ListingHouseTermPricing | undefined,
): { text: string; src: "own" | "tdef" | "lt" | "def" } {
  if (!isBase(term)) {
    const own = termPriceFieldText(room.termPricing?.[term], TERM_FIELD[field]);
    const def = termPriceFieldText(termDefaults?.[term], TERM_FIELD[field]);
    if (own) return { text: own, src: def && own === def ? "tdef" : "own" };
    if (def) return { text: def, src: "tdef" };
  }
  if (field === "rent") {
    if (isBase(term) && roomInheritsDefault(room, defaults, "monthlyRent")) {
      return { text: defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : "", src: "def" };
    }
    return { text: room.monthlyRent > 0 ? String(room.monthlyRent) : "", src: isBase(term) ? "own" : "lt" };
  }
  if (field === "deposit") {
    if (isBase(term) && roomInheritsDefault(room, defaults, "securityDeposit")) {
      return { text: moneyValue(defaults.securityDeposit), src: "def" };
    }
    if ((room.securityDeposit ?? "").trim()) return { text: room.securityDeposit!, src: isBase(term) ? "own" : "lt" };
    return { text: defaults.securityDeposit, src: "def" };
  }
  if (isBase(term) && roomInheritsDefault(room, defaults, "utilitiesEstimate")) {
    return { text: defaults.utilitiesEstimate, src: "def" };
  }
  if ((room.utilitiesEstimate ?? "").trim()) return { text: room.utilitiesEstimate, src: isBase(term) ? "own" : "lt" };
  return { text: defaults.utilitiesEstimate, src: "def" };
}

/** Write one per-term field; an empty value clears the override back to "same as long-term". */
function writeTerm(
  room: ManagerRoomSubmission,
  term: string,
  field: "monthlyRent" | "securityDeposit" | "utilitiesEstimate",
  value: string,
): ManagerRoomSubmission {
  return writeRoomTermPrice(room, term, field, value);
}

/**
 * Put ONE of a room's long-term numbers back on the house — the ↺ in that
 * cell and the "Same as default room" tick. The room takes its own COPY of
 * the Default room's number (`resetRoomFieldToDefault`), never a blank: the
 * card draws a blank follower as "$1,050 · Same as default room", but Review,
 * the applicant's room list and the signed lease read the record and saw a
 * room with no rent. On another lease tab the same ↺ goes through
 * `writeTerm(…, "")`, which drops that tab's override so the cell follows
 * long-term again.
 */
function resetRoomField(
  room: ManagerRoomSubmission,
  field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit",
  defaults: ListingHouseDefaults,
): ManagerRoomSubmission {
  return resetRoomFieldToDefault(room, field, defaults);
}

/* ─────────────────────── rent per resident ─────────────────────── */

/** The room's own figures for `term` (long-term when absent), as a resident-row fallback. */
function residentFallbackFor(room: ManagerRoomSubmission, term: string): RoomResidentPriceFallback {
  const entry = isBase(term) ? undefined : room.termPricing?.[term];
  return {
    monthlyRent: entry?.monthlyRent ?? room.monthlyRent,
    utilitiesEstimate: entry?.utilitiesEstimate ?? room.utilitiesEstimate,
    securityDeposit: entry?.securityDeposit ?? room.securityDeposit,
    pricingMode: entry?.pricingMode ?? room.pricingMode,
  };
}

/**
 * Tick "Different rent per resident" on or off, for the room (long-term) or,
 * on another lease tab, that term's own entry.
 *
 * Ticking on prefills every resident from the room's (or term's) current
 * figures (`clampRoomResidentPrices`, the room's own numbers as the fallback).
 * Ticking off folds Resident 1's current figures back onto the room/term
 * before dropping the rows, so the card shows exactly what Resident 1 was
 * paying rather than a stale number from before the tick.
 */
function togglePerResident(room: ManagerRoomSubmission, term: string, on: boolean): ManagerRoomSubmission {
  const residentTerm = isBase(term) ? undefined : term;
  if (!on) {
    const first = roomResidentPrices(room, residentTerm)[0];
    if (isBase(term)) {
      const withFirst = first
        ? { ...room, monthlyRent: first.monthlyRent, utilitiesEstimate: first.utilitiesEstimate ?? room.utilitiesEstimate, securityDeposit: first.securityDeposit ?? room.securityDeposit, pricingMode: first.pricingMode ?? room.pricingMode }
        : room;
      return clearRoomResidentPricing(withFirst);
    }
    const entry = room.termPricing?.[term];
    const nextEntry: ManagerRoomTermPrice | undefined = first
      ? { ...entry, monthlyRent: first.monthlyRent, utilitiesEstimate: first.utilitiesEstimate ?? entry?.utilitiesEstimate, securityDeposit: first.securityDeposit ?? entry?.securityDeposit, pricingMode: first.pricingMode ?? entry?.pricingMode }
      : entry;
    const withFirst = nextEntry ? { ...room, termPricing: { ...(room.termPricing ?? {}), [term]: nextEntry } } : room;
    return clearRoomResidentPricing(withFirst, term);
  }
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const fallback = residentFallbackFor(room, term);
  if (isBase(term)) {
    return reconcileRoomResidentPricing({ ...room, residentPricing: "per_resident", residentPrices: clampRoomResidentPrices(room.residentPrices, capacity, fallback) });
  }
  const entry = room.termPricing?.[term];
  const nextEntry: ManagerRoomTermPrice = { ...entry, residentPricing: "per_resident", residentPrices: clampRoomResidentPrices(entry?.residentPrices, capacity, fallback) };
  return reconcileRoomResidentPricing({ ...room, termPricing: { ...(room.termPricing ?? {}), [term]: nextEntry } });
}

/**
 * Write one field of one resident slot (1-based). Resident 1's figures double
 * as the room's (or term's) own — mirrored onto it so unticking, or the room
 * later dropping to one resident, shows what Resident 1 actually pays rather
 * than a stale base figure from before the tick.
 */
function writeResidentPrice(
  room: ManagerRoomSubmission,
  term: string,
  slot: number,
  fields: Partial<ManagerRoomResidentPrice>,
): ManagerRoomSubmission {
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const fallback = residentFallbackFor(room, term);
  const currentRows = isBase(term) ? room.residentPrices : room.termPricing?.[term]?.residentPrices;
  const rows = (clampRoomResidentPrices(currentRows, capacity, fallback) ?? []).map((row, idx) => (idx === slot - 1 ? { ...row, ...fields } : row));
  const mirror = slot === 1 ? fields : {};
  if (isBase(term)) {
    return reconcileRoomResidentPricing({ ...room, ...mirror, residentPricing: "per_resident", residentPrices: rows });
  }
  const entry = room.termPricing?.[term];
  const nextEntry: ManagerRoomTermPrice = { ...entry, ...mirror, residentPricing: "per_resident", residentPrices: rows };
  return reconcileRoomResidentPricing({ ...room, termPricing: { ...(room.termPricing ?? {}), [term]: nextEntry } });
}

/* ─────────────────────── the room cards ─────────────────────── */

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h3 className="mb-2.5 mt-7 text-[15.5px] font-bold tracking-tight text-foreground first:mt-0">{children}</h3>
);

const Card = ({ children, dataAttr }: { children: React.ReactNode; dataAttr?: string }) => (
  <div className="rounded-2xl border border-border bg-card" data-attr={dataAttr}>
    {children}
  </div>
);

/** "Resident 1", "Resident 2" — the small heading over a per-resident block. */
const ResidentSubHeading = ({ children }: { children: React.ReactNode }) => (
  <div className="border-t border-border bg-foreground/[0.025] px-3.5 pb-1 pt-3 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">{children}</div>
);

const PRICE_HELP = {
  all: "Set once. Every room ticked “Same as default room” copies this. Month-to-Month and Short-term start as “same as Long-term”.",
  rent: "Base monthly rent for this room, before utilities and fees.",
  util: "A flat monthly utilities estimate, billed with rent. Blank means included.",
  dep: "Security deposit, collected at signing.",
} as const;

const helpRow = (title: string, text: string) => (
  <span className="inline-flex items-center gap-1.5">
    {title}
    <ColumnHelp title={title} text={text} />
  </span>
);

/* ─────────────────────── fees, on the card that charges them ─────────────────────── */

const CADENCE_SHORT: Record<ListingFeeCadence, string> = { monthly: "/mo", weekly: "/wk", daily: "/day", nightly: "/night", "one-time": "once" };
const MONTHLY_CADENCES: readonly ListingFeeCadence[] = ["monthly", "weekly", "daily", "one-time"];
const STAY_CADENCES: readonly ListingFeeCadence[] = ["one-time", "daily", "weekly", "monthly"];
/** Presets that never belong on Other fees: deposit has its own row; move-in is not a Default room field; these two are charged when a lease ends. */
const CARD_HIDDEN_PRESETS = new Set<string>(["security_deposit", "move_in_fee", "break_lease_fee", "holdover_daily", "short_term_nightly"]);
const isStayTerm = (term: string) => term === SHORT_TERM_LEASE_TERM || term === AIRBNB_LEASE_TERM;

function MoveInFeeRow({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const amount = moneyValue(
    listingFeesForWizard(sub).find((fee) => fee.presetId === "move_in_fee")?.amount ?? sub.moveInFee,
  );
  return (
    <FactRow label="Move-in fee">
      <MoneyInput
        label="Move-in fee"
        value={amount}
        placeholder="150"
        onChange={(value) => {
          const nextAmount = sanitizeMoneyInput(value);
          const fees = listingFeesForWizard(sub);
          const next = fees.some((fee) => fee.presetId === "move_in_fee")
            ? fees.map((fee) => (fee.presetId === "move_in_fee" ? { ...fee, amount: nextAmount } : fee))
            : [...fees, presetListingFeeRow("move_in_fee", nextAmount)];
          patch(applyListingFeesToSubmission(sub, next));
        }}
        dataAttr="listing-v2-price-move-in-fee"
      />
    </FactRow>
  );
}

/** Fee rows a pricing card can show at all, in the order the catalogue keeps them. */
function cardFeeRows(sub: ManagerListingSubmissionV1): ListingFeeRow[] {
  return listingFeesForWizard(sub).filter((f) => !f.presetId || !CARD_HIDDEN_PRESETS.has(f.presetId));
}

/**
 * The lease types a fee added on this tab is billed on: the stay types from a
 * stay tab, the lease types from a lease tab — stored only when that is a real
 * narrowing of what the listing offers (`narrowFeeScope`).
 */
function feeScopeForTab(sub: ManagerListingSubmissionV1, term: string): string[] | undefined {
  const offered = listingLeaseTypeScopeOptions(sub);
  const stay = isStayTerm(term);
  return narrowFeeScope(offered.filter((t) => isStayTerm(t) === stay), offered);
}

/**
 * The add-on fees on ONE card: name · amount · when · ✕, and + Add a fee.
 *
 * `roomId` null is the Default room (or the whole place): its fees are every
 * room's (no `roomIds`, exactly how "All rooms" was always stored). A room card
 * edits the fees scoped to it alone and lists, read-only, every other fee that
 * reaches it — so the whole picture is on the card but each fee is edited in
 * one place. Standard fees (Holding deposit, Parking, HOA…) are the same
 * records the old fees section held; typing one of their names adopts the
 * preset, so billing and the lease document treat it exactly as before.
 */
/** Write a card's fee rows back, keeping the presets no card lists so a write never drops the deposit. */
function writeCardFeeRows(sub: ManagerListingSubmissionV1, patch: Patch, next: ListingFeeRow[], extra?: Partial<ManagerListingSubmissionV1>) {
  const held = listingFeesForWizard(sub).filter((f) => f.presetId && CARD_HIDDEN_PRESETS.has(f.presetId));
  const nextSub = applyListingFeesToSubmission(sub, [...next, ...held]);
  patch(extra ? ensureSubmissionListingFees({ ...nextSub, ...extra }) : nextSub);
}

function FeeRows({
  sub,
  patch,
  roomId,
  roomName,
  term,
  residentSlot,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  roomId: string | null;
  roomName?: string;
  term: string;
  /**
   * Scopes this card's OWN fees (added here) to one resident slot of a room
   * priced per resident (PLAN-0920-0631) — "Parking" added inside Resident 2's
   * block gets `residentSlots: [2]` and lists there only. A room-wide fee with
   * no `residentSlots` still lists under every resident. Absent means this
   * card is not a resident block (every fee on it applies to the whole room).
   */
  residentSlot?: number;
}) {
  const rows = useMemo(() => cardFeeRows(sub), [sub]);
  const stay = isStayTerm(term);
  const allRoomIds = (sub.rooms ?? []).map((r) => r.id);
  /* A standard slot with no amount is a fee the product offers, not one this listing charges — unless it was just adopted. */
  const [revealed, setRevealed] = useState<string[]>([]);
  const single = (f: ListingFeeRow) => (f.roomIds ?? []).length === 1;
  const onThisCard = (f: ListingFeeRow) => (roomId ? single(f) && f.roomIds![0] === roomId : !single(f));
  const onThisSlot = (f: ListingFeeRow) => residentSlot === undefined || feeAppliesToResidentSlot(f, residentSlot);
  const priced = (f: ListingFeeRow) => !f.presetId || f.presetId === "custom" || isListingFeeAmountFilled(f.amount ?? "") || revealed.includes(f.id);
  const mine = rows.filter((f) => onThisCard(f) && onThisSlot(f) && feeAppliesToLeaseType(f, term) && priced(f));
  const shared = roomId
    ? rows.filter((f) => !mine.includes(f) && isListingFeeAmountFilled(f.amount ?? "") && feeAppliesToLeaseType(f, term) && feeAppliesToRoom(f, roomId))
    : [];
  const writeRows = (next: ListingFeeRow[], extra?: Partial<ManagerListingSubmissionV1>) => writeCardFeeRows(sub, patch, next, extra);
  const write = (id: string, next: Partial<ListingFeeRow>) => writeRows(rows.map((f) => (f.id === id ? { ...f, ...next } : f)));
  /** The rooms a house-wide fee still reaches once this room is taken out of it. */
  const withoutThisRoom = (f: ListingFeeRow) => ((f.roomIds ?? []).length ? f.roomIds! : allRoomIds).filter((id) => id !== roomId);
  const who = roomName ?? "every room";
  /**
   * The name a room-only copy of a house-wide fee carries. A standard fee's
   * own name cannot be reused: `normalizeListingFeeRow` reads a custom row
   * named "Parking" back as THE parking preset, and one preset row exists per
   * listing — so the copy would swallow the shared fee. Such a copy is
   * "Parking – Room 9"; any other name is carried over as it is.
   */
  const splitLabel = (fee: ListingFeeRow) =>
    LISTING_FEE_PRESETS.some((p) => p.defaultLabel.toLowerCase() === fee.label.trim().toLowerCase()) ? `${fee.label.trim()} – ${who}` : fee.label;
  const isSplitName = (own: ListingFeeRow, from: ListingFeeRow) => {
    const a = own.label.trim().toLowerCase();
    const b = from.label.trim().toLowerCase();
    return a === b || a === `${b} – ${who.toLowerCase()}`;
  };
  /**
   * The house-wide fee a room-only row was split off from: same name, priced,
   * on this tab, and no longer reaching this room. Reset folds the room back in.
   */
  const splitOf = (own: ListingFeeRow) =>
    roomId
      ? rows.find((f) => f.id !== own.id && !onThisCard(f) && !feeAppliesToRoom(f, roomId) && isSplitName(own, f) && isListingFeeAmountFilled(f.amount ?? "") && feeAppliesToLeaseType(f, term))
      : undefined;
  const add = () => {
    const row: ListingFeeRow = {
      ...emptyCustomFeeRow(),
      presetId: "custom",
      ...patchListingFeeCadence(stay ? "one-time" : "monthly"),
      leaseTypes: feeScopeForTab(sub, term),
      roomIds: roomId ? [roomId] : undefined,
      residentSlots: residentSlot !== undefined ? [residentSlot] : undefined,
    };
    writeRows([...rows, row]);
  };
  /** Remove a fee everywhere, plus whatever rows ride along with the write. A standard fee's removal is remembered so a resync does not bring it back. */
  const removeEverywhere = (fee: ListingFeeRow, next: ListingFeeRow[]) => {
    if (!fee.presetId || fee.presetId === "custom") return writeRows(next);
    const rowId = listingFeeRowIdForPresetId(fee.presetId);
    const removed = new Set(parseRemovedStandardListingFeeRows(sub));
    if (rowId) removed.add(rowId as RemovedStandardListingFeeRowId);
    setRevealed((prev) => prev.filter((id) => id !== fee.id));
    writeRows(next, { removedStandardListingFeeRows: [...removed] });
  };
  const remove = (fee: ListingFeeRow) => removeEverywhere(fee, rows.filter((f) => f.id !== fee.id));
  /** ✕ on an inherited row: this room alone stops paying the house-wide fee; every other room keeps it. */
  const removeForRoom = (fee: ListingFeeRow) => {
    const ids = withoutThisRoom(fee);
    if (!ids.length) return remove(fee);
    write(fee.id, { roomIds: ids });
  };
  /**
   * Typing on an inherited row splits it: a room-only copy at the typed amount
   * (always `custom` — a preset id may exist once) and the house-wide fee no
   * longer reaching this room. Keyed by the fee it came from, so the box keeps
   * focus while the manager is still typing.
   */
  const split = (fee: ListingFeeRow, amount: string) => {
    const own: ListingFeeRow = {
      ...emptyCustomFeeRow(),
      presetId: "custom",
      label: splitLabel(fee),
      amount,
      ...patchListingFeeCadence(listingFeeCadence(fee)),
      leaseTypes: fee.leaseTypes,
      roomIds: [roomId!],
      refundable: fee.refundable,
      creditsTowardSecurity: fee.creditsTowardSecurity,
      dailyRate: fee.dailyRate,
    };
    const ids = withoutThisRoom(fee);
    if (!ids.length) return removeEverywhere(fee, [...rows.filter((f) => f.id !== fee.id), own]);
    writeRows([...rows.map((f) => (f.id === fee.id ? { ...f, roomIds: ids } : f)), own]);
  };
  /** Reset on a split row: drop the room-only copy and let the house-wide fee reach this room again. */
  const unsplit = (own: ListingFeeRow, from: ListingFeeRow) => {
    const ids = [...(from.roomIds ?? []), roomId!];
    const every = allRoomIds.every((id) => ids.includes(id));
    writeRows(rows.filter((f) => f.id !== own.id).map((f) => (f.id === from.id ? { ...f, roomIds: every ? undefined : ids } : f)));
  };
  /** The standard fees a name can adopt from this tab. */
  const presets = LISTING_FEE_PRESETS.filter((p) => !CARD_HIDDEN_PRESETS.has(p.presetId) && Boolean(p.shortTermOnly) === stay);
  /**
   * Typing a standard fee's name on a custom row turns the row INTO that preset
   * (amount and scope carried over), so "Parking" typed by hand bills as the
   * parking preset always did.
   */
  const rename = (fee: ListingFeeRow, label: string) => {
    const hit = fee.presetId === "custom" ? presets.find((p) => p.defaultLabel.toLowerCase() === label.trim().toLowerCase()) : undefined;
    const slot = hit ? rows.find((f) => f.presetId === hit.presetId) : undefined;
    if (!hit || !slot || (isListingFeeAmountFilled(slot.amount ?? "") && !onThisCard(slot))) return write(fee.id, { label });
    const rowId = listingFeeRowIdForPresetId(hit.presetId);
    const removed = parseRemovedStandardListingFeeRows(sub).filter((id) => id !== rowId);
    setRevealed((prev) => (prev.includes(slot.id) ? prev : [...prev, slot.id]));
    writeRows(
      rows
        .filter((f) => f.id !== fee.id)
        .map((f) => (f.id === slot.id ? { ...f, amount: fee.amount, leaseTypes: fee.leaseTypes, roomIds: fee.roomIds, ...patchListingFeeCadence(listingFeeCadence(fee)) } : f)),
      { removedStandardListingFeeRows: removed },
    );
  };
  const listId = `listing-v2-fee-names-${roomId ?? "all"}-${residentSlot ?? "room"}-${stay ? "stay" : "lease"}`;
  const cadences = stay ? STAY_CADENCES : MONTHLY_CADENCES;
  /* One list, in catalogue order: a split row takes its house-wide fee's key so the amount box survives the swap under the caret. */
  type Listed = { key: string; fee: ListingFeeRow; inherited: boolean; from: ListingFeeRow | undefined };
  const listed = rows.flatMap((fee): Listed[] => {
    if (mine.includes(fee)) {
      const from = splitOf(fee);
      return [{ key: from?.id ?? fee.id, fee, inherited: false, from }];
    }
    if (shared.includes(fee)) return [{ key: fee.id, fee, inherited: true, from: undefined }];
    return [];
  });
  return (
    <>
      <FactRow label="Other fees">
        <button type="button" data-attr={roomId ? "listing-v2-room-fee-add" : "listing-v2-default-fee-add"} onClick={add} className="text-[13.5px] font-bold text-primary hover:underline">
          + Add a fee
        </button>
      </FactRow>
      <datalist id={listId}>
        {presets.map((p) => (
          <option key={p.presetId} value={p.defaultLabel} />
        ))}
      </datalist>
      {listed.map(({ key, fee, inherited, from }) => {
        const name = fee.label || "Fee";
        const isPreset = Boolean(fee.presetId && fee.presetId !== "custom");
        const oneTime = listingFeeCadence(fee) === "one-time";
        const amountLabel = roomId ? `${name} amount for ${who}` : `${name} amount`;
        return (
          <div key={key} className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 border-t border-border bg-foreground/[0.025] px-3.5 py-2 pl-7" data-attr="listing-v2-fee-row" data-inherited={inherited ? "true" : undefined}>
            <input
              aria-label="Fee name"
              list={isPreset || inherited ? undefined : listId}
              value={fee.label}
              readOnly={isPreset || inherited}
              placeholder="Parking"
              onChange={(e) => rename(fee, e.target.value)}
              className={cn(
                "min-h-[36px] min-w-[120px] flex-1 rounded-lg border bg-card px-2.5 text-[13.5px] font-semibold outline-none focus:border-primary",
                isPreset || inherited ? "border-transparent bg-transparent px-0" : "border-border",
                inherited ? "text-muted" : "text-foreground",
              )}
            />
            {from ? (
              <button
                type="button"
                onClick={() => unsplit(fee, from)}
                data-attr="listing-v2-fee-reset"
                aria-label={`Reset ${name} for ${who} to every room`}
                title="Back to the Default card"
                className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-bold text-[var(--status-approved-fg)] hover:underline"
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
                Reset
              </button>
            ) : null}
            <span className="flex items-center gap-1.5">
              {inherited ? (
                <MoneyInput label={amountLabel} value="" inherited placeholder={moneyValue(fee.amount) || "0"} onChange={(v) => split(fee, sanitizeMoneyInput(v))} />
              ) : (
                <MoneyInput label={amountLabel} value={moneyValue(fee.amount)} placeholder="0" onChange={(v) => write(fee.id, { amount: sanitizeMoneyInput(v) })} />
              )}
              <RowSelectCell
                ariaLabel={`How often ${name} is charged${roomId ? ` for ${who}` : ""}`}
                value={listingFeeCadence(fee)}
                options={cadences.map((c) => ({ value: c, label: CADENCE_SHORT[c] }))}
                inherited={inherited}
                disabled={inherited}
                onChange={(v) => write(fee.id, patchListingFeeCadence(v as ListingFeeCadence))}
              />
              {!inherited && oneTime && fee.presetId !== "holding_deposit" ? (
                <label className="flex cursor-pointer items-center gap-1 text-[12px] font-semibold text-foreground/70" title="The resident gets this back">
                  <input type="checkbox" checked={Boolean(fee.refundable || fee.creditsTowardSecurity)} data-attr="listing-fee-refundable" onChange={(e) => write(fee.id, { refundable: e.target.checked, creditsTowardSecurity: e.target.checked ? fee.creditsTowardSecurity : false })} className="h-3.5 w-3.5 accent-[var(--pl-blue)]" />
                  Refundable
                </label>
              ) : null}
              {inherited ? (
                <button type="button" aria-label={`Remove ${name} for ${who}`} data-attr="listing-v2-fee-remove-room" onClick={() => removeForRoom(fee)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground">✕</button>
              ) : (
                <button type="button" aria-label={`Remove ${name}${roomId ? ` for ${who}` : ""}`} data-attr="listing-v2-fee-remove" onClick={() => remove(fee)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground">✕</button>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}

/* ─────────────────────── partial months ─────────────────────── */

/** Only a lease that can start mid-month splits one: long-term and custom dates, never month-to-month or a stay. */
const proratesOnTab = (term: string) => term === LONG_TERM_LEASE_TERM || term === CUSTOM_LEASE_TERM;
/** A month's figure as the per-day placeholder: the calendar split, rounded up. */
const perDay = (monthly: number) => (monthly > 0 ? String(Math.ceil(monthly / 30)) : "");

/** One per-day box: what it shows, what it suggests, and whether it is the card's own or follows the Default card. */
type DayRate = {
  text: string;
  placeholder: string;
  inherited?: boolean;
  own?: boolean;
  onChange: (raw: string) => void;
  onReset?: () => void;
  resetLabel?: string;
};

/**
 * The monthly fees a card bills per day when its partial months are set per
 * day, the same split `FeeRows` draws: the Default card's (and the whole
 * place's) are every fee not scoped to a single room; a room card has the fees
 * scoped to it alone plus, following the Default card, every house-wide fee
 * that still reaches it. A fee at $0 has no day rate.
 */
function dailyFeeRows(sub: ManagerListingSubmissionV1, roomId: string | null, term: string): ListingFeeRow[] {
  return cardFeeRows(sub).filter((f) => {
    if (listingFeeCadence(f) !== "monthly" || !(num(f.amount ?? "") > 0) || !feeAppliesToLeaseType(f, term)) return false;
    const ids = f.roomIds ?? [];
    if (roomId === null) return ids.length !== 1;
    return ids.length === 1 ? ids[0] === roomId : feeAppliesToRoom(f, roomId);
  });
}

/**
 * "Partial months · Automatic" and, unticked, the per-day rows under it: rent,
 * utilities (only while the card's utilities are above $0) and one row per
 * monthly fee. The row follows the Default card on a room the way Rent /mo
 * does: grey while following, Reset once the room has its own answer.
 */
function ProrateRows({
  sub,
  patch,
  term,
  roomId,
  name,
  automatic,
  inherited = false,
  own = false,
  onAutomatic,
  onReset,
  resetLabel,
  rent,
  util,
  dataAttr,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  term: string;
  roomId: string | null;
  /** "every room", the room's name, or "the whole place" — for the boxes' labels. */
  name: string;
  automatic: boolean;
  inherited?: boolean;
  own?: boolean;
  onAutomatic: (next: boolean) => void;
  onReset?: () => void;
  resetLabel?: string;
  rent: DayRate;
  /** Absent while the card's utilities are $0 or blank: there is nothing to split per day. */
  util: DayRate | null;
  dataAttr: string;
}) {
  const rows = useMemo(() => cardFeeRows(sub), [sub]);
  const fees = dailyFeeRows(sub, roomId, term);
  const writeFeeDay = (fee: ListingFeeRow, raw: string) =>
    writeCardFeeRows(sub, patch, rows.map((f) => (f.id === fee.id ? { ...f, dailyRate: num(sanitizeMoneyInput(raw)) || undefined } : f)));
  const dayRow = (label: string, rate: DayRate, attr: string) => (
    <FactRow sub label={label} own={rate.own} onReset={rate.onReset} resetLabel={rate.resetLabel}>
      <MoneyInput label={`${label.replace(" /day", "")} per day for ${name}`} value={rate.text} inherited={rate.inherited} placeholder={rate.placeholder} dataAttr={attr} onChange={rate.onChange} />
    </FactRow>
  );
  return (
    <>
      <FactRow label="Partial months" own={own} onReset={onReset} resetLabel={resetLabel}>
        <label className="flex cursor-pointer items-center gap-2.5 py-1.5">
          <input
            type="checkbox"
            checked={automatic}
            aria-label={`Partial months automatic for ${name}`}
            data-attr={`${dataAttr}-automatic`}
            onChange={(e) => onAutomatic(e.target.checked)}
            className="h-4 w-4 shrink-0 rounded border-border"
          />
          <span className={cn("min-w-0 text-[13px] font-semibold", inherited ? "text-muted" : "text-foreground")}>Automatic</span>
        </label>
      </FactRow>
      {automatic ? null : (
        <>
          {dayRow("Rent /day", rent, `${dataAttr}-rent`)}
          {util ? dayRow("Utilities /day", util, `${dataAttr}-utilities`) : null}
          {fees.map((fee) => {
            const feeName = fee.label || "Fee";
            const shared = roomId !== null && (fee.roomIds ?? []).length !== 1;
            return dayRow(
              `${feeName} /day`,
              { text: fee.dailyRate ? String(fee.dailyRate) : "", placeholder: perDay(num(fee.amount ?? "")), inherited: shared, onChange: (v) => writeFeeDay(fee, v) },
              `${dataAttr}-fee`,
            );
          })}
        </>
      )}
    </>
  );
}

function MonthlyCards({
  sub,
  patch,
  term,
  feeScopeTerm,
  defaults,
  termDefaults,
  onDefault,
  onTermDefault,
  onRoom,
  dimmed,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  term: string;
  /** Lease tab these cards are on — a room's fees respect Applies-to even when rent follows long-term. */
  feeScopeTerm: string;
  defaults: ListingHouseDefaults;
  /** The Default room on every lease type but long-term. */
  termDefaults: ListingHouseTermPricing | undefined;
  onDefault: (field: ListingHouseDefaultField, value: string | number) => void;
  onTermDefault: (term: string, field: ListingTermPriceField, value: string) => void;
  onRoom: (id: string, next: ManagerRoomSubmission) => void;
  dimmed: boolean;
}) {
  const rooms = sub.rooms ?? [];
  const base = isBase(term);
  const [open, setOpen] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  /* Partial months show only where a lease can start mid-month; the fields are the room's long-term ones on every such tab. */
  const prorate = proratesOnTab(feeScopeTerm);
  /* A blank Default method means automatic, so a room set per day is its own even before the card was ever touched. */
  const prorateDefaults: ListingHouseDefaults = { ...defaults, prorateMethod: defaults.prorateMethod || "auto" };
  const prorateOf = (room: ManagerRoomSubmission) => {
    const method = room.prorateMethod || defaults.prorateMethod || "auto";
    const rateOwn = (room.dailyRentRate ?? 0) > 0 && room.dailyRentRate !== defaults.dailyRentRate;
    const utilOwn = (room.dailyUtilitiesRate ?? 0) > 0 && room.dailyUtilitiesRate !== defaults.dailyUtilitiesRate;
    return {
      automatic: method !== "daily_rate",
      own: !roomInheritsDefault(room, prorateDefaults, "prorateMethod"),
      rate: room.dailyRentRate || defaults.dailyRentRate || 0,
      rateOwn,
      utilRate: room.dailyUtilitiesRate || defaults.dailyUtilitiesRate || 0,
      utilOwn,
      any: prorate && (!roomInheritsDefault(room, prorateDefaults, "prorateMethod") || rateOwn || utilOwn),
    };
  };
  /** Copy the Default card's partial-month answer onto the room — method and both rates — never a blank. */
  const resetProrate = (room: ManagerRoomSubmission): ManagerRoomSubmission => ({
    ...resetRoomFieldToDefault(room, "prorateMethod", prorateDefaults),
    dailyRentRate: defaults.dailyRentRate || undefined,
    dailyUtilitiesRate: defaults.dailyUtilitiesRate || undefined,
  });
  const values = (room: ManagerRoomSubmission) => ({
    rent: termValue(room, term, "rent", defaults, termDefaults),
    util: termValue(room, term, "util", defaults, termDefaults),
    dep: termValue(room, term, "deposit", defaults, termDefaults),
    modeOwn: base ? !roomInheritsDefault(room, defaults, "pricingMode") : false,
    prorateOwn: prorateOf(room).any,
  });
  /** The term's Default room, one field: what it holds, and long-term's figure as the placeholder until it holds anything. */
  const termDef = (field: ListingTermPriceField) => termPriceFieldText(termDefaults?.[term], field);
  const ltText = (field: ListingTermPriceField) =>
    field === "monthlyRent" ? (defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : "") : moneyValue(defaults[field]);
  /** What the Default card shows on this tab: its own figure, or long-term's until it has one. */
  const defRent = num(base ? ltText("monthlyRent") : termDef("monthlyRent") || ltText("monthlyRent"));
  const defUtil = num(base ? ltText("utilitiesEstimate") : termDef("utilitiesEstimate") || ltText("utilitiesEstimate"));
  const sameAsAll = (room: ManagerRoomSubmission) => {
    const v = values(room);
    const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
    const perResident = capacity >= 2 && roomPricesPerResident(room, base ? undefined : term);
    return !unticked.has(room.id) && !perResident && v.rent.src !== "own" && v.util.src !== "own" && v.dep.src !== "own" && !v.modeOwn && !v.prorateOwn;
  };
  /** Tick: every number on this tab follows the card again. Untick: freeze what the card shows as the room's own. */
  const setSameAsAll = (room: ManagerRoomSubmission, same: boolean) => {
    setUnticked((prev) => {
      const out = new Set(prev);
      if (same) out.delete(room.id);
      else out.add(room.id);
      return out;
    });
    const v = values(room);
    const p = prorateOf(room);
    /* Partial months ride along only on a tab that shows them. */
    const followProrate = (r: ManagerRoomSubmission) => (prorate ? resetProrate(r) : r);
    const frozenProrate: Partial<ManagerRoomSubmission> = prorate
      ? { prorateMethod: p.automatic ? "auto" : "daily_rate", dailyRentRate: p.rate || undefined, dailyUtilitiesRate: p.utilRate || undefined }
      : {};
    if (same) {
      if (base) onRoom(room.id, followProrate({ ...resetRoomField(resetRoomField(resetRoomField(room, "monthlyRent", defaults), "utilitiesEstimate", defaults), "securityDeposit", defaults), pricingMode: undefined }));
      else {
        const all = { ...(room.termPricing ?? {}) };
        delete all[term];
        onRoom(room.id, followProrate({ ...room, termPricing: Object.keys(all).length > 0 ? all : undefined }));
      }
    } else if (base) onRoom(room.id, { ...room, monthlyRent: num(v.rent.text), utilitiesEstimate: moneyValue(v.util.text), securityDeposit: moneyValue(v.dep.text), ...frozenProrate });
    else onRoom(room.id, { ...writeTerm(writeTerm(writeTerm(room, term, "monthlyRent", v.rent.text), term, "utilitiesEstimate", moneyValue(v.util.text)), term, "securityDeposit", moneyValue(v.dep.text)), ...frozenProrate });
  };
  const listed = (rent: number, util: number, mode: string) => (mode === "flexible" ? `from ${usd(rent)}` : usd(rent + util));
  const untouch = (id: string) => setUnticked((prev) => { if (!prev.has(id)) return prev; const out = new Set(prev); out.delete(id); return out; });
  return (
    <>
      <RecordCard
        every
        title="Default room"
        help={PRICE_HELP.all}
        dimmed={dimmed}
        dataAttr="listing-v2-price-defaults-card"
        rows={
          <div>
            <FactRow first label={<>{helpRow("Rent /mo", PRICE_HELP.rent)} {base ? <FieldMark kind={prefillMarkFor(sub, "houseDefaults")} /> : null}</>}>
              {base ? (
                <MoneyInput label="Rent for every room" value={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : ""} placeholder="1,100" onChange={(v) => onDefault("monthlyRent", num(sanitizeMoneyInput(v)))} />
              ) : (
                <MoneyInput
                  label={`Rent for every room on ${term}`}
                  value={termDef("monthlyRent") || ltText("monthlyRent")}
                  placeholder={ltText("monthlyRent") || "1,100"}
                  onChange={(v) => onTermDefault(term, "monthlyRent", sanitizeMoneyInput(v))}
                  dataAttr="listing-v2-price-term-default-rent"
                />
              )}
            </FactRow>
            <FactRow label={helpRow("Utilities /mo", PRICE_HELP.util)}>
              {base ? (
                <MoneyInput label="Utilities for every room" value={moneyValue(defaults.utilitiesEstimate)} placeholder="150" onChange={(v) => onDefault("utilitiesEstimate", sanitizeMoneyInput(v))} />
              ) : (
                <MoneyInput
                  label={`Utilities for every room on ${term}`}
                  value={termDef("utilitiesEstimate") || ltText("utilitiesEstimate")}
                  placeholder={ltText("utilitiesEstimate") || "150"}
                  onChange={(v) => onTermDefault(term, "utilitiesEstimate", sanitizeMoneyInput(v))}
                  dataAttr="listing-v2-price-term-default-utilities"
                />
              )}
            </FactRow>
            <FactRow label={helpRow("Deposit", PRICE_HELP.dep)}>
              {base ? (
                <MoneyInput label="Deposit for every room" value={moneyValue(defaults.securityDeposit)} placeholder="1,000" onChange={(v) => onDefault("securityDeposit", sanitizeMoneyInput(v))} />
              ) : (
                <MoneyInput
                  label={`Deposit for every room on ${term}`}
                  value={termDef("securityDeposit") || ltText("securityDeposit")}
                  placeholder={ltText("securityDeposit") || "1,000"}
                  onChange={(v) => onTermDefault(term, "securityDeposit", sanitizeMoneyInput(v))}
                  dataAttr="listing-v2-price-term-default-deposit"
                />
              )}
            </FactRow>
            <FactRow label="Listed rent">
              {base ? (
                <RowSelectCell ariaLabel="Listed rent for every room" value={defaults.pricingMode || "fixed"} options={PRICING_MODE_OPTIONS} onChange={(v) => onDefault("pricingMode", v)} />
              ) : (
                <span className="text-[13.5px] font-semibold text-foreground">{defaults.pricingMode === "flexible" ? "Flexible" : "Fixed"}</span>
              )}
            </FactRow>
            <FeeRows sub={sub} patch={patch} roomId={null} term={feeScopeTerm} />
            {prorate ? (
              <ProrateRows
                sub={sub}
                patch={patch}
                term={feeScopeTerm}
                roomId={null}
                name="every room"
                automatic={defaults.prorateMethod !== "daily_rate"}
                onAutomatic={(next) => onDefault("prorateMethod", next ? "auto" : "daily_rate")}
                rent={{
                  text: defaults.dailyRentRate > 0 ? String(defaults.dailyRentRate) : "",
                  placeholder: perDay(defRent) || "35",
                  onChange: (v) => onDefault("dailyRentRate", num(sanitizeMoneyInput(v))),
                }}
                util={
                  defUtil > 0
                    ? {
                        text: defaults.dailyUtilitiesRate > 0 ? String(defaults.dailyUtilitiesRate) : "",
                        placeholder: perDay(defUtil),
                        onChange: (v) => onDefault("dailyUtilitiesRate", num(sanitizeMoneyInput(v))),
                      }
                    : null
                }
                dataAttr="listing-v2-price-prorate-default"
              />
            ) : null}
          </div>
        }
      />
      {rooms.map((room, i) => {
        const name = room.name.trim() || `Room ${i + 1}`;
        const rent = termValue(room, term, "rent", defaults, termDefaults);
        const util = termValue(room, term, "util", defaults, termDefaults);
        const dep = termValue(room, term, "deposit", defaults, termDefaults);
        const mode = room.pricingMode ?? defaults.pricingMode ?? "fixed";
        const modeOwn = base ? !roomInheritsDefault(room, defaults, "pricingMode") : false;
        const resetOne = (field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit") =>
          onRoom(room.id, base ? resetRoomField(room, field, defaults) : writeTerm(room, term, field, ""));
        const writeOne = (field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit", v: string) => {
          untouch(room.id);
          if (base) onRoom(room.id, field === "monthlyRent" ? { ...room, monthlyRent: num(sanitizeMoneyInput(v)) } : field === "utilitiesEstimate" ? { ...room, utilitiesEstimate: sanitizeMoneyInput(v) } : { ...room, securityDeposit: sanitizeMoneyInput(v) });
          else onRoom(room.id, writeTerm(room, term, field, sanitizeMoneyInput(v)));
        };
        const rentN = num(rent.text), utilN = num(util.text), depN = num(dep.text);
        const p = prorateOf(room);
        const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
        const residentTerm = base ? undefined : term;
        const perResidentOn = capacity >= 2 && roomPricesPerResident(room, residentTerm);
        const residentRows = perResidentOn ? roomResidentPrices(room, residentTerm) : [];
        const summary = perResidentOn
          ? (() => {
              const rents = residentRows.map((r) => usd(r.monthlyRent));
              const utilVals = residentRows.map((r) => num(moneyValue(r.utilitiesEstimate)));
              const depVals = residentRows.map((r) => moneyValue(r.securityDeposit));
              const utilSame = utilVals.every((v) => v === utilVals[0]);
              const depSame = depVals.every((v) => v === depVals[0]);
              const lowest = roomLowestResidentRent(room, residentTerm) ?? 0;
              return [
                ...rents,
                utilSame ? `+${usd(utilVals[0] ?? 0)} utilities` : "utilities vary",
                depSame ? `${usd(num(depVals[0] ?? ""))} deposit` : "deposit varies",
                `listed from ${usd(lowest)}`,
              ].join(" · ");
            })()
          : [
              rentN > 0 ? usd(rentN) : "Rent not set",
              `+${usd(utilN)} utilities`,
              `${usd(depN)} deposit`,
              `listed ${listed(rentN, utilN, mode)}`,
              ...(prorate ? [p.automatic ? "partial months automatic" : p.rate > 0 ? `partial months ${usd(p.rate)}/day` : "partial months per day"] : []),
            ].join(" · ");
        const isOpen = open === room.id;
        return (
          <RecordCard
            key={room.id}
            title={name}
            same={<SameAsAllToggle same={sameAsAll(room)} noun="room" onChange={(next) => setSameAsAll(room, next)} onReset={() => setSameAsAll(room, true)} dataAttr="listing-v2-price-same-as-all" />}
            summary={summary}
            open={isOpen}
            onToggle={() => setOpen((prev) => (prev === room.id ? null : room.id))}
            toggleLabel={`${name} prices`}
            dimmed={dimmed}
            dataAttr="listing-v2-price-card"
          >
            {capacity >= 2 ? (
              <FactRow
                first
                label={
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={perResidentOn}
                      data-attr="listing-v2-price-per-resident"
                      onChange={(e) => onRoom(room.id, togglePerResident(room, term, e.target.checked))}
                      className="h-4 w-4 shrink-0 rounded border-border"
                    />
                    <span>Different rent per resident</span>
                  </label>
                }
              >
                <span className="text-[13px] font-semibold text-muted">{`${capacity} residents · set on Rooms`}</span>
              </FactRow>
            ) : null}
            {perResidentOn ? (
              residentRows.map((rp, idx) => {
                const slot = idx + 1;
                return (
                  <div key={slot} data-attr="listing-v2-price-resident-block" data-slot={String(slot)}>
                    <ResidentSubHeading>{`Resident ${slot}`}</ResidentSubHeading>
                    <FactRow label="Rent /mo">
                      <MoneyInput
                        label={`${name} Resident ${slot} rent`}
                        value={rp.monthlyRent > 0 ? String(rp.monthlyRent) : ""}
                        placeholder="1,100"
                        dataAttr={`listing-v2-price-resident-${slot}-rent`}
                        onChange={(v) => onRoom(room.id, writeResidentPrice(room, term, slot, { monthlyRent: num(sanitizeMoneyInput(v)) || 0 }))}
                      />
                    </FactRow>
                    <FactRow label="Utilities /mo">
                      <MoneyInput
                        label={`${name} Resident ${slot} utilities`}
                        value={moneyValue(rp.utilitiesEstimate)}
                        placeholder="150"
                        dataAttr={`listing-v2-price-resident-${slot}-utilities`}
                        onChange={(v) => onRoom(room.id, writeResidentPrice(room, term, slot, { utilitiesEstimate: sanitizeMoneyInput(v) }))}
                      />
                    </FactRow>
                    <FactRow label="Deposit">
                      <MoneyInput
                        label={`${name} Resident ${slot} deposit`}
                        value={moneyValue(rp.securityDeposit)}
                        placeholder="1,000"
                        dataAttr={`listing-v2-price-resident-${slot}-deposit`}
                        onChange={(v) => onRoom(room.id, writeResidentPrice(room, term, slot, { securityDeposit: sanitizeMoneyInput(v) }))}
                      />
                    </FactRow>
                    <FactRow label="Listed rent">
                      <RowSelectCell
                        ariaLabel={`Listed rent for ${name} Resident ${slot}`}
                        value={rp.pricingMode ?? "fixed"}
                        options={PRICING_MODE_OPTIONS}
                        onChange={(v) => onRoom(room.id, writeResidentPrice(room, term, slot, { pricingMode: v as ManagerRoomResidentPrice["pricingMode"] }))}
                      />
                    </FactRow>
                    <FeeRows sub={sub} patch={patch} roomId={room.id} roomName={`${name} Resident ${slot}`} term={feeScopeTerm} residentSlot={slot} />
                  </div>
                );
              })
            ) : (
              <>
                <FactRow first={capacity < 2} label="Rent /mo" own={rent.src === "own"} onReset={() => resetOne("monthlyRent")} resetLabel={`Reset rent for ${name} (${term}) to the row above`}>
                  <MoneyInput
                    label={`${name} rent on ${term}`}
                    value={rent.src === "own" ? rent.text : ""}
                    inherited={rent.src !== "own"}
                    placeholder={rent.text || "1,100"}
                    onChange={(v) => writeOne("monthlyRent", v)}
                  />
                </FactRow>
                <FactRow label="Utilities /mo" own={util.src === "own"} onReset={() => resetOne("utilitiesEstimate")} resetLabel={`Reset utilities for ${name} (${term}) to the row above`}>
                  <MoneyInput
                    label={`${name} utilities on ${term}`}
                    value={util.src === "own" ? moneyValue(util.text) : ""}
                    inherited={util.src !== "own"}
                    placeholder={moneyValue(util.text) || "150"}
                    onChange={(v) => writeOne("utilitiesEstimate", v)}
                  />
                </FactRow>
                <FactRow label="Deposit" own={dep.src === "own"} onReset={() => resetOne("securityDeposit")} resetLabel={`Reset deposit for ${name} (${term}) to the row above`}>
                  <MoneyInput
                    label={`${name} deposit on ${term}`}
                    value={dep.src === "own" ? moneyValue(dep.text) : ""}
                    inherited={dep.src !== "own"}
                    placeholder={moneyValue(dep.text) || "1,000"}
                    onChange={(v) => writeOne("securityDeposit", v)}
                  />
                </FactRow>
                <FactRow label="Listed rent" own={modeOwn} onReset={() => onRoom(room.id, { ...room, pricingMode: undefined })} resetLabel={`Reset listed rent for ${name} to every room`}>
                    {base ? (
                      <RowSelectCell
                        ariaLabel={`Listed rent for ${name}`}
                        value={mode}
                        options={PRICING_MODE_OPTIONS}
                        inherited={!modeOwn}
                        onChange={(v) => onRoom(room.id, { ...room, pricingMode: v as ManagerRoomSubmission["pricingMode"] })}
                      />
                    ) : (
                      <span className="text-[13.5px] font-semibold text-foreground">{listed(rentN, utilN, mode)}</span>
                    )}
                </FactRow>
                <FeeRows sub={sub} patch={patch} roomId={room.id} roomName={name} term={feeScopeTerm} />
              </>
            )}
            {prorate ? (
              <ProrateRows
                sub={sub}
                patch={patch}
                term={feeScopeTerm}
                roomId={room.id}
                name={name}
                automatic={p.automatic}
                inherited={!p.own}
                own={p.own}
                onAutomatic={(next) => {
                  untouch(room.id);
                  onRoom(room.id, { ...room, prorateMethod: next ? "auto" : "daily_rate" });
                }}
                onReset={() => onRoom(room.id, resetProrate(room))}
                resetLabel={`Reset partial months for ${name} to the row above`}
                rent={{
                  text: p.rateOwn ? String(room.dailyRentRate) : "",
                  inherited: !p.rateOwn,
                  own: p.rateOwn,
                  placeholder: (defaults.dailyRentRate > 0 ? String(defaults.dailyRentRate) : perDay(rentN)) || "35",
                  onChange: (v) => {
                    untouch(room.id);
                    onRoom(room.id, { ...room, dailyRentRate: num(sanitizeMoneyInput(v)) || undefined });
                  },
                  onReset: () => onRoom(room.id, { ...room, dailyRentRate: defaults.dailyRentRate || undefined }),
                  resetLabel: `Reset rent per day for ${name} to the row above`,
                }}
                util={
                  utilN > 0
                    ? {
                        text: p.utilOwn ? String(room.dailyUtilitiesRate) : "",
                        inherited: !p.utilOwn,
                        own: p.utilOwn,
                        placeholder: defaults.dailyUtilitiesRate > 0 ? String(defaults.dailyUtilitiesRate) : perDay(utilN),
                        onChange: (v) => {
                          untouch(room.id);
                          onRoom(room.id, { ...room, dailyUtilitiesRate: num(sanitizeMoneyInput(v)) || undefined });
                        },
                        onReset: () => onRoom(room.id, { ...room, dailyUtilitiesRate: defaults.dailyUtilitiesRate || undefined }),
                        resetLabel: `Reset utilities per day for ${name} to the row above`,
                      }
                    : null
                }
                dataAttr="listing-v2-price-prorate-room"
              />
            ) : null}
            <EditorDone onClick={() => setOpen(null)} dataAttr="listing-v2-price-done" />
          </RecordCard>
        );
      })}
    </>
  );
}

/** Short stays: rent per night and per week only. A stay deposit is a fee, added under Other fees. */
function StayCards({
  sub,
  patch,
  term,
  defaults,
  onDefault,
  onRoom,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  /** The stay tab these cards are on — a fee added here is billed on the stay types. */
  term: string;
  defaults: ListingHouseDefaults;
  onDefault: (field: ListingHouseDefaultField, value: string | number) => void;
  onRoom: (id: string, next: ManagerRoomSubmission) => void;
}) {
  const rooms = sub.rooms ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const inh = (room: ManagerRoomSubmission) => ({ night: roomInheritsDefault(room, defaults, "shortTermRent"), week: roomInheritsDefault(room, defaults, "weeklyRentPrice") });
  const sameAsAll = (room: ManagerRoomSubmission) => {
    const v = inh(room);
    return !unticked.has(room.id) && v.night && v.week;
  };
  const setSameAsAll = (room: ManagerRoomSubmission, same: boolean) => {
    setUnticked((prev) => {
      const out = new Set(prev);
      if (same) out.delete(room.id);
      else out.add(room.id);
      return out;
    });
    if (same) onRoom(room.id, { ...room, shortTermRent: "", weeklyRentPrice: undefined });
    else onRoom(room.id, { ...room, shortTermRent: moneyValue(room.shortTermRent) || moneyValue(defaults.shortTermRent), weeklyRentPrice: room.weeklyRentPrice || defaults.weeklyRentPrice || undefined });
  };
  const untouch = (id: string) => setUnticked((prev) => { if (!prev.has(id)) return prev; const out = new Set(prev); out.delete(id); return out; });
  return (
    <>
      <RecordCard
        every
        title="Default room"
        help={PRICE_HELP.all}
        dataAttr="listing-v2-stay-defaults-card"
        rows={
          <div>
            <FactRow first label="Rent /night">
              <MoneyInput label="Rent per night for every room" value={moneyValue(defaults.shortTermRent)} placeholder="65" onChange={(v) => onDefault("shortTermRent", sanitizeMoneyInput(v))} />
            </FactRow>
            <FactRow label="Rent /week">
              <MoneyInput label="Rent per week for every room" value={defaults.weeklyRentPrice > 0 ? String(defaults.weeklyRentPrice) : ""} placeholder="395" onChange={(v) => onDefault("weeklyRentPrice", num(sanitizeMoneyInput(v)))} />
            </FactRow>
            <FeeRows sub={sub} patch={patch} roomId={null} term={term} />
          </div>
        }
      />
      {rooms.map((room, i) => {
        const name = room.name.trim() || `Room ${i + 1}`;
        const nightInh = roomInheritsDefault(room, defaults, "shortTermRent");
        const weekInh = roomInheritsDefault(room, defaults, "weeklyRentPrice");
        const night = moneyValue(room.shortTermRent) || moneyValue(defaults.shortTermRent);
        const week = room.weeklyRentPrice || defaults.weeklyRentPrice;
        const isOpen = open === room.id;
        return (
          <RecordCard
            key={room.id}
            title={name}
            same={<SameAsAllToggle same={sameAsAll(room)} noun="room" onChange={(next) => setSameAsAll(room, next)} onReset={() => setSameAsAll(room, true)} dataAttr="listing-v2-stay-same-as-all" />}
            summary={[night ? `${usd(num(night))}/night` : "Nightly rate not set", week ? `${usd(week)}/week` : "Weekly rate not set"].join(" · ")}
            open={isOpen}
            onToggle={() => setOpen((prev) => (prev === room.id ? null : room.id))}
            toggleLabel={`${name} stay prices`}
            dataAttr="listing-v2-stay-card"
          >
            <FactRow first label="Rent /night" own={!nightInh} onReset={() => onRoom(room.id, { ...room, shortTermRent: "" })} resetLabel={`Reset nightly rent for ${name} to every room`}>
              <MoneyInput label={`${name} rent per night`} value={nightInh ? "" : moneyValue(room.shortTermRent)} inherited={nightInh} placeholder={moneyValue(defaults.shortTermRent) || "65"} onChange={(v) => { untouch(room.id); onRoom(room.id, { ...room, shortTermRent: sanitizeMoneyInput(v) }); }} />
            </FactRow>
            <FactRow label="Rent /week" own={!weekInh} onReset={() => onRoom(room.id, { ...room, weeklyRentPrice: undefined })} resetLabel={`Reset weekly rent for ${name} to every room`}>
              <MoneyInput label={`${name} rent per week`} value={weekInh ? "" : room.weeklyRentPrice ? String(room.weeklyRentPrice) : ""} inherited={weekInh} placeholder={defaults.weeklyRentPrice > 0 ? String(defaults.weeklyRentPrice) : "395"} onChange={(v) => { untouch(room.id); onRoom(room.id, { ...room, weeklyRentPrice: num(sanitizeMoneyInput(v)) || undefined }); }} />
            </FactRow>
            <FeeRows sub={sub} patch={patch} roomId={room.id} roomName={name} term={term} />
            <EditorDone onClick={() => setOpen(null)} dataAttr="listing-v2-stay-done" />
          </RecordCard>
        );
      })}
    </>
  );
}

/** The whole place: one rent, one utilities figure, one deposit. */
function WholePlaceCard({ sub, patch, term }: { sub: ManagerListingSubmissionV1; patch: Patch; term: string }) {
  const write = (next: Parameters<typeof applyEntireHomeListingPricing>[1]) => patch(applyEntireHomeListingPricing(sub, next));
  return (
    <Card dataAttr="listing-v2-whole-place-card">
      <FactRow first label={<>Rent /mo <FieldMark kind={prefillMarkFor(sub, "entireHomeMonthlyRent")} /></>} required>
        <MoneyInput label="Rent for the whole place" value={sub.entireHomeMonthlyRent ? String(sub.entireHomeMonthlyRent) : ""} placeholder="3,200" onChange={(v) => write({ entireHomeMonthlyRent: num(sanitizeMoneyInput(v)) || undefined })} />
      </FactRow>
      <FactRow label="Utilities /mo">
        <MoneyInput label="Utilities for the whole place" value={moneyValue(sub.entireHomeUtilitiesEstimate)} placeholder="180" onChange={(v) => write({ entireHomeUtilitiesEstimate: sanitizeMoneyInput(v) })} />
      </FactRow>
      <FactRow label="Deposit">
        <MoneyInput label="Deposit for the whole place" value={moneyValue(sub.securityDeposit)} placeholder="3,200" onChange={(v) => patch({ securityDeposit: sanitizeMoneyInput(v) })} />
      </FactRow>
      <MoveInFeeRow sub={sub} patch={patch} />
      <FactRow label="Utilities are">
        <RowSelectCell
          ariaLabel="How utilities are handled"
          value={sub.entireHomeUtilitiesPaymentModel ?? ""}
          placeholder="Select…"
          options={LONG_TERM_UTILITIES_PAYMENT_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
          onChange={(v) => write({ entireHomeUtilitiesPaymentModel: v as ManagerListingSubmissionV1["entireHomeUtilitiesPaymentModel"] })}
        />
      </FactRow>
      <FeeRows sub={sub} patch={patch} roomId={null} term={term} />
      {proratesOnTab(term) ? (
        <ProrateRows
          sub={sub}
          patch={patch}
          term={term}
          roomId={null}
          name="the whole place"
          automatic={sub.entireHomeProrateMethod !== "daily_rate"}
          onAutomatic={(next) => write({ entireHomeProrateMethod: next ? "auto" : "daily_rate" })}
          rent={{
            text: sub.entireHomeDailyRentRate ? String(sub.entireHomeDailyRentRate) : "",
            placeholder: perDay(sub.entireHomeMonthlyRent ?? 0) || "35",
            onChange: (v) => write({ entireHomeDailyRentRate: num(sanitizeMoneyInput(v)) || undefined }),
          }}
          util={
            num(moneyValue(sub.entireHomeUtilitiesEstimate)) > 0
              ? {
                  text: sub.entireHomeDailyUtilitiesRate ? String(sub.entireHomeDailyUtilitiesRate) : "",
                  placeholder: perDay(num(moneyValue(sub.entireHomeUtilitiesEstimate))),
                  onChange: (v) => write({ entireHomeDailyUtilitiesRate: num(sanitizeMoneyInput(v)) || undefined }),
                }
              : null
          }
          dataAttr="listing-v2-price-prorate-whole"
        />
      ) : null}
    </Card>
  );
}

/* ─────────────────────── bundles ─────────────────────── */

/**
 * Several rooms rented together for one price.
 *
 * A bundle is the listing's own {@link ManagerBundleRow}: a label, the rooms
 * in it, one rent and one deposit. The card says what a renter saves against
 * the rooms' own rents so a bundle that costs MORE than its parts is visible
 * before it is published.
 */
function BundlesSection({ sub, patch, defaults }: { sub: ManagerListingSubmissionV1; patch: Patch; defaults: ListingHouseDefaults }) {
  const rooms = sub.rooms ?? [];
  const bundles = sub.bundles ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const roomLabel = (r: ManagerRoomSubmission, i: number) => r.name.trim() || `Room ${i + 1}`;
  const roomRent = (r: ManagerRoomSubmission) => termValue(r, LONG_TERM_LEASE_TERM, "rent", defaults, undefined);
  const write = (id: string, next: Partial<ManagerBundleRow>) => patch({ bundles: bundles.map((b) => (b.id === id ? { ...b, ...next } : b)) });
  const remove = (id: string) => {
    patch({ bundles: bundles.filter((b) => b.id !== id) });
    setOpen(null);
  };
  return (
    <>
      <SectionTitle>Bundles</SectionTitle>
      {bundles.length === 0 ? (
        <Card>
          <FactRow first label={<span className="font-medium text-foreground/70">No bundles — every room rents on its own</span>}>
            <span />
          </FactRow>
        </Card>
      ) : null}
      {bundles.map((b, i) => {
        const ids = (b.includedRoomIds ?? []).filter((id) => rooms.some((r) => r.id === id));
        const names = rooms.filter((r) => ids.includes(r.id)).map((r) => roomLabel(r, rooms.indexOf(r)));
        const separately = rooms.filter((r) => ids.includes(r.id)).reduce((n, r) => n + num(roomRent(r).text), 0);
        const rent = num(moneyValue(b.price));
        const saves = separately - rent;
        const label = b.label.trim() || `Bundle ${i + 1}`;
        const summary = [
          names.length ? names.join(" + ") : "Pick rooms",
          rent > 0 ? `${usd(rent)}/mo` : "Rent not set",
          rent > 0 && separately > 0 ? (saves > 0 ? `saves ${usd(saves)} vs separately` : saves < 0 ? "more than separately" : "same as separately") : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <RecordCard
            key={b.id}
            name={b.label}
            nameLabel={`Name for bundle ${i + 1}`}
            namePlaceholder={`Bundle ${i + 1}`}
            onName={(v) => write(b.id, { label: v })}
            summary={summary}
            open={open === b.id}
            onToggle={() => setOpen((prev) => (prev === b.id ? null : b.id))}
            toggleLabel={label}
            dataAttr="listing-v2-bundle-card"
          >
            <FactRow first label="Rooms in the bundle">
              <MultiPick
                label={`Rooms in ${label}`}
                options={rooms.map(roomLabel)}
                selected={names}
                allowOther={false}
                emptyLabel="Pick rooms…"
                onChange={(next) => write(b.id, { includedRoomIds: rooms.filter((r, ri) => next.includes(roomLabel(r, ri))).map((r) => r.id), roomsLine: "" })}
              />
            </FactRow>
            <FactRow label="Rent /mo">
              <MoneyInput label={`${label} rent`} value={moneyValue(b.price)} placeholder="2,000" onChange={(v) => write(b.id, { price: sanitizeMoneyInput(v) })} />
            </FactRow>
            <FactRow label="Deposit">
              <MoneyInput label={`${label} deposit`} value={moneyValue(b.securityDeposit)} placeholder="1,500" onChange={(v) => write(b.id, { securityDeposit: sanitizeMoneyInput(v) })} />
            </FactRow>
            <FactRow label="Separately">
              <span className="text-[13.5px] font-semibold text-foreground/70">{separately > 0 ? `${usd(separately)}/mo` : "—"}</span>
            </FactRow>
            <CardFoot>
              <CardAction onClick={() => remove(b.id)} tone="danger" dataAttr="listing-v2-bundle-remove">
                Remove
              </CardAction>
            </CardFoot>
          </RecordCard>
        );
      })}
      <AddRowButton
        label="Add bundle"
        dataAttr="listing-v2-add-bundle"
        onClick={() => {
          const id = `bundle-${Date.now()}`;
          patch({ bundles: [...bundles, { id, label: "", price: "", strikethrough: "", promo: "", roomsLine: "", includedRoomIds: [] }] });
          setOpen(id);
        }}
      />
    </>
  );
}

/* ─────────────────────── the step ─────────────────────── */

export function ListingPricingSections({
  sub,
  patch,
  defaults,
  setDefaults,
  leaseTypesField,
  payments,
  applications,
  leaseDocument,
  onActiveLeaseTermChange,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  defaults: ListingHouseDefaults;
  setDefaults: (next: ListingHouseDefaults) => void;
  /** The listing's lease-type picker and the long-term lengths / minimum rows. */
  leaseTypesField: React.ReactNode;
  /** The rails money arrives on. */
  payments: React.ReactNode;
  applications: React.ReactNode;
  /** Break-lease, holdover, quiet hours — what the lease document says. */
  leaseDocument: React.ReactNode;
  /** Keeps the receipt panel on the same lease type as the active pricing tab. */
  onActiveLeaseTermChange?: (leaseTerm: string) => void;
}) {
  const tabs = useMemo(() => listingPricingLeaseTabs(sub), [sub]);
  const [tab, setTab] = useState<string | null>(null);
  const active = tab && tabs.includes(tab) ? tab : tabs[0] ?? LONG_TERM_LEASE_TERM;
  const activeLeaseTerm = listingPricingTabToLeaseTerm(active);
  useEffect(() => {
    onActiveLeaseTermChange?.(activeLeaseTerm);
  }, [activeLeaseTerm, onActiveLeaseTermChange]);
  const rooms = sub.rooms ?? [];
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  const onRoom = (id: string, next: ManagerRoomSubmission) => patch({ rooms: rooms.map((r) => (r.id === id ? next : r)) });
  /** Every room card: write the default and move every room still following that field. */
  const onDefault = (field: ListingHouseDefaultField, value: string | number) => {
    const previous = defaults;
    const next = { ...defaults, [field]: value } as ListingHouseDefaults;
    setDefaults(next);
    patch({
      rooms: applyHouseDefaultsToRooms(rooms, next, { onlyFields: [field], previousDefaults: previous }),
      houseDefaults: next,
    } as Partial<ManagerListingSubmissionV1>);
  };
  /**
   * The Default room on every lease type but long-term. Held like `defaults`:
   * read once from the listing (or inferred from its rooms), then written
   * through `onTermDefault`, which also moves every room still following it.
   */
  const [termDefaults, setTermDefaults] = useState<ListingHouseTermPricing | undefined>(() => houseTermPricingForSubmission(sub));
  const onTermDefault = (term: string, field: ListingTermPriceField, value: string) => {
    const previous = termDefaults;
    const next = writeTermPriceEntry(termDefaults, term, field, value);
    setTermDefaults(next);
    patch({ rooms: applyHouseTermPricingToRooms(rooms, term, field, next, previous), houseTermPricing: next });
  };
  /** "Same as long-term" is true when neither the Default room nor any room has its own price on this term. */
  const sameAsLongTerm = (term: string) =>
    !(termDefaults?.[term] && Object.keys(termDefaults[term]!).length > 0) &&
    !rooms.some((r) => r.termPricing?.[term] && Object.keys(r.termPricing[term]!).length > 0);
  const [showOwn, setShowOwn] = useState<Record<string, boolean>>({});
  const ownTable = (term: string) => showOwn[term] || !sameAsLongTerm(term);
  const stay = isStayLeaseTerm(activeLeaseTerm);

  /*
   * The application-fee switch. On means the listing charges one; off blanks
   * the one amount, every per-type amount, the legacy short-term fee and the
   * waiver code so nothing is billed. A listing that already has any of them is on.
   */
  const perType = sub.applicationFeeByLeaseType ?? {};
  const legacyStay = moneyValue(sub.shortTermApplicationFee);
  const feeStored = moneyFilled(sub.applicationFee) || Boolean(legacyStay) || Object.keys(perType).length > 0 || Boolean(sub.applicationFeeWaiverCode);
  const [feeOn, setFeeOn] = useState(feeStored);
  const chargeFee = feeOn || feeStored;
  /*
   * "Different application fee per lease type": one row per offered type. A
   * blank row FOLLOWS the one amount (dashed, placeholder), exactly as a room
   * follows the Default room — so "$50 everywhere, $25 for short stays" is one
   * tick and one number. Unticking clears every per-type amount.
   */
  const splitStored = Object.keys(perType).length > 0 || Boolean(legacyStay);
  const [splitOn, setSplitOn] = useState(splitStored);
  const split = splitOn || splitStored;
  /** A lease type's own fee: its map entry, or the legacy short-term fee for the stay row. */
  const ownFee = (term: string) => perType[term] ?? (term === SHORT_TERM_LEASE_TERM ? legacyStay : "") ?? "";
  const writeFee = (term: string, raw: string) => {
    const v = sanitizeMoneyInput(raw);
    const next = { ...perType };
    if (v.trim() === "") delete next[term];
    else next[term] = v;
    patch({
      applicationFeeByLeaseType: Object.keys(next).length ? next : undefined,
      // Older readers still look here for a stay; keep them agreeing with the row.
      ...(term === SHORT_TERM_LEASE_TERM ? { shortTermApplicationFee: v } : {}),
    });
  };
  const feeTerms = tabs.map(applicationFeeLeaseTypeKey);
  const termLabel = (term: string) => (term === "Month-to-Month" ? "Month to month" : term === SHORT_TERM_LEASE_TERM ? "Short-term" : term);

  const applicationsCard = (
    <>
      <SectionTitle>Applications</SectionTitle>
      <Card dataAttr="listing-v2-applications-card">
        <div className="px-3.5 py-1">
          <CheckboxOption
            label="Charge an application fee"
            checked={chargeFee}
            dataAttr="listing-v2-application-fee-on"
            onChange={(next) => {
              setFeeOn(next);
              if (!next) {
                setSplitOn(false);
                patch({ applicationFee: "", shortTermApplicationFee: "", applicationFeeByLeaseType: undefined, applicationFeeWaiverCode: "" });
              }
            }}
          />
        </div>
        {chargeFee ? (
          <div data-attr="listing-v2-application-fee-rows">
            <FactRow label={split ? "Application fee (default)" : "Application fee"}>
              <MoneyInput label="Application fee" value={moneyValue(sub.applicationFee)} placeholder="50" onChange={(v) => patch({ applicationFee: sanitizeMoneyInput(v) })} />
            </FactRow>
            {feeTerms.length > 1 ? (
              <div className="border-t border-border px-3.5 py-1">
                <CheckboxOption
                  label="Different application fee per lease type"
                  checked={split}
                  dataAttr="listing-v2-application-fee-split"
                  onChange={(next) => {
                    setSplitOn(next);
                    if (!next) patch({ applicationFeeByLeaseType: undefined, shortTermApplicationFee: "" });
                  }}
                />
              </div>
            ) : null}
            {split
              ? feeTerms.map((term) => {
                  const own = ownFee(term);
                  return (
                    <FactRow key={term} sub label={termLabel(term)} own={own !== ""} onReset={() => writeFee(term, "")} resetLabel={`Reset ${termLabel(term)} application fee to the amount above`}>
                      <MoneyInput
                        label={`${termLabel(term)} application fee`}
                        value={own}
                        inherited={own === ""}
                        placeholder={moneyValue(sub.applicationFee) || "50"}
                        dataAttr={`listing-v2-application-fee-${term}`}
                        onChange={(v) => writeFee(term, v)}
                      />
                    </FactRow>
                  );
                })
              : null}
            <FactRow label="Waiver code">
              <input
                aria-label="Waiver code"
                style={{ textTransform: "uppercase" }}
                value={sub.applicationFeeWaiverCode ?? ""}
                placeholder="WELCOME50"
                onChange={(e) => patch({ applicationFeeWaiverCode: e.target.value.toUpperCase() })}
                className="min-h-[36px] w-[150px] rounded-lg border border-border bg-card px-2.5 text-[13.5px] font-semibold text-foreground outline-none focus:border-primary"
              />
            </FactRow>
            <div className="border-t border-border">{applications}</div>
          </div>
        ) : null}
      </Card>
    </>
  );
  const seattle = listingFoldsAllMonthlyFeesIntoRent(sub);

  return (
    <>
      <SectionTitle>How you get paid</SectionTitle>
      <Card dataAttr="listing-v2-payments-card">{payments}</Card>

      <SectionTitle>{wholePlace ? "The whole place" : "Each room"}</SectionTitle>
      <Card dataAttr="listing-v2-lease-types-card">{leaseTypesField}</Card>
      {applicationsCard}
      {tabs.length === 0 ? (
        <Card>
          <FactRow first label={<span className="font-medium text-foreground/70">Choose at least one lease type</span>}>
            <span />
          </FactRow>
        </Card>
      ) : (
        <>
          <div className="mb-3 mt-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
            {tabs.map((t) => {
              const pricingTerm = listingPricingTabToLeaseTerm(t);
              const missing = wholePlace
                ? isBase(pricingTerm) && !(sub.entireHomeMonthlyRent && sub.entireHomeMonthlyRent > 0)
                : isStayLeaseTerm(pricingTerm)
                  ? rooms.some((r) => !moneyValue(r.shortTermRent) && !moneyValue(defaults.shortTermRent))
                  : isBase(pricingTerm) && rooms.some((r) => !(r.monthlyRent > 0));
              return (
                <button key={t} type="button" role="tab" aria-selected={t === active} data-attr={`listing-v2-price-tab-${t}`} onClick={() => setTab(t)} className={cn("-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] font-bold", t === active ? "border-primary text-primary" : "border-transparent text-foreground/70 hover:text-foreground")}>
                  {t}
                  {missing ? <span className="h-[7px] w-[7px] rounded-full bg-[var(--status-pending-fg)]" aria-label="Some rooms have no price on this lease type" /> : null}
                </button>
              );
            })}
          </div>
          {!stay && !isBase(activeLeaseTerm) && !wholePlace ? (
            <div className="mb-2 px-1">
              <CheckboxOption
                label="Same as long-term"
                checked={!ownTable(activeLeaseTerm)}
                dataAttr={`listing-v2-same-as-long-term-${activeLeaseTerm}`}
                onChange={(next) => {
                  if (next) {
                    // Back to "same as long-term": clear the term's Default room and every room's own price on it.
                    const block = { ...(termDefaults ?? {}) };
                    delete block[activeLeaseTerm];
                    const nextBlock = Object.keys(block).length ? block : undefined;
                    setTermDefaults(nextBlock);
                    patch({
                      rooms: rooms.map((r) => { const all = { ...(r.termPricing ?? {}) }; delete all[activeLeaseTerm]; return { ...r, termPricing: Object.keys(all).length ? all : undefined }; }),
                      houseTermPricing: nextBlock,
                    });
                    setShowOwn((prev) => ({ ...prev, [activeLeaseTerm]: false }));
                  } else {
                    const seeded = seedSigningColumnFromLongTerm(sub, activeLeaseTerm);
                    patch({
                      paymentAtSigningByLeaseType: seeded.paymentAtSigningByLeaseType,
                      paymentAtSigningIncludes: seeded.paymentAtSigningIncludes,
                    });
                    setShowOwn((prev) => ({ ...prev, [activeLeaseTerm]: true }));
                  }
                }}
              />
            </div>
          ) : null}
          {wholePlace ? (
            <WholePlaceCard sub={sub} patch={patch} term={activeLeaseTerm} />
          ) : stay ? (
            <StayCards sub={sub} patch={patch} term={activeLeaseTerm} defaults={defaults} onDefault={onDefault} onRoom={onRoom} />
          ) : (
            <MonthlyCards
              sub={sub}
              patch={patch}
              term={activeLeaseTerm}
              feeScopeTerm={activeLeaseTerm}
              defaults={defaults}
              termDefaults={termDefaults}
              onDefault={onDefault}
              onTermDefault={onTermDefault}
              onRoom={onRoom}
              dimmed={false}
            />
          )}
        </>
      )}

      {seattle ? <p id="listing-v2-fees" className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-foreground">{SEATTLE_RENT_RULE_NOTE}</p> : null}

      {wholePlace ? null : <BundlesSection sub={sub} patch={patch} defaults={defaults} />}

      <div className="mt-6">{leaseDocument}</div>
    </>
  );
}
