"use client";

/**
 * Pricing, in the order a manager sets it up.
 *
 * 1. **How you get paid** — the rails money arrives on, and who pays card
 *    processing. First, because nothing below matters until money can move.
 *    "PropLane pays" always asks for a processing coverage code; no plan and no
 *    subscription promo can stand in for one.
 * 2. **Applications** — the application fee, the short-term fee, and the
 *    manager's own waiver code. Asked HERE and nowhere else: the Advanced tab
 *    used to ask for the same three again, with a second, unsanitised input.
 * 3. **Each room** — one editable table, a tab per lease type. The top row is
 *    **Every room**: same columns, same inputs; rooms follow it until changed
 *    (grey and dashed = following, ink with a dot = the room's own). Long-term
 *    carries a minimum term. Month-to-month and custom dates are "same as
 *    long-term" until the box is unticked. Short-term is rent per day, rent
 *    per week and a deposit — nothing else, the rate is all-in.
 * 4. **At signing** — what each lease type collects up front, beside the
 *    receipt, which is the same panel it always was.
 *
 * Nothing new is stored. Rent is `room.monthlyRent`; another lease type's own
 * price is `room.termPricing[term]` with ABSENT meaning "same as long-term"
 * (PRP-463); utilities, deposit and pricing mode are the fields they already
 * are; the house defaults are `listing-house-defaults.ts`. This screen is a
 * view over all of it.
 */

import { useEffect, useMemo, useState } from "react";
import { AddRowButton, CardAction, CardFoot, CheckboxOption, ColumnHelp, EditorDone, FactRow, Field, MoneyInput, MoreRows, MultiPick, RecordCard, RowSelectCell, SameAsAllToggle } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ManagerApplicationFeeWaiverCodesModal } from "@/components/portal/pro-application-fee-waiver-codes-modal";
import { Input, Select } from "@/components/ui/input";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import {
  expandFeeScope,
  feeAppliesToLeaseType,
  feeAppliesToRoom,
  listingFeeRowIdForPresetId,
  listingLeaseTypeScopeOptions,
  listingPricingLeaseTabs,
  listingPricingTabToLeaseTerm,
  narrowFeeScope,
  PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX,
} from "@/lib/listing-fee-scope";
import {
  applyListingFeesToSubmission,
  ensureSubmissionListingFees,
  applyPaymentAtSigningCell,
  isListingFeeAmountFilled,
  LISTING_FEE_WIZARD_CADENCE_OPTIONS,
  listingFeeCadence,
  listingFeesForWizard,
  parseRemovedStandardListingFeeRows,
  patchListingFeeCadence,
  type ListingFeeCadence,
  type ListingFeeRow,
  type RemovedStandardListingFeeRowId,
} from "@/lib/listing-fees";
import { SEATTLE_RENT_RULE_NOTE, listingFoldsAllMonthlyFeesIntoRent } from "@/lib/seattle-rent-rule";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { buildListingQuote, isStayLeaseTerm } from "@/lib/listing-quote";
import { LONG_TERM_UTILITIES_PAYMENT_OPTIONS } from "@/lib/listing-utilities-payment";
import {
  applyHouseDefaultsToRooms,
  roomInheritsDefault,
  type ListingHouseDefaultField,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import {
  applyEntireHomeListingPricing,
  emptyCustomFeeRow,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { cn } from "@/lib/utils";

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

/** A room's value on `term` and where it came from. */
function termValue(
  room: ManagerRoomSubmission,
  term: string,
  field: "rent" | "deposit" | "util",
  defaults: ListingHouseDefaults,
): { text: string; src: "own" | "lt" | "def" } {
  const own = room.termPricing?.[term];
  if (!isBase(term)) {
    if (field === "rent" && typeof own?.monthlyRent === "number") return { text: String(own.monthlyRent), src: "own" };
    if (field === "deposit" && (own?.securityDeposit ?? "").trim()) return { text: own!.securityDeposit!, src: "own" };
    if (field === "util" && (own?.utilitiesEstimate ?? "").trim()) return { text: own!.utilitiesEstimate!, src: "own" };
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
  const all = { ...(room.termPricing ?? {}) };
  const entry = { ...(all[term] ?? {}) };
  if (value.trim() === "") delete entry[field];
  else if (field === "monthlyRent") entry.monthlyRent = num(value);
  else entry[field] = value;
  if (Object.keys(entry).length === 0) delete all[term];
  else all[term] = entry;
  return { ...room, termPricing: Object.keys(all).length > 0 ? all : undefined };
}

/**
 * Put ONE of a room's long-term numbers back on the house — the ↺ in that
 * cell. Emptying a cell already re-inherits it, but nothing on the table said
 * so (the captain's "I cant reset some of the information to default"). On
 * another lease tab the same ↺ goes through `writeTerm(…, "")`, which drops
 * that tab's override so the cell follows long-term again.
 */
function resetRoomField(
  room: ManagerRoomSubmission,
  field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit",
): ManagerRoomSubmission {
  if (field === "monthlyRent") return { ...room, monthlyRent: 0 };
  if (field === "utilitiesEstimate") return { ...room, utilitiesEstimate: "" };
  return { ...room, securityDeposit: undefined };
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

const PRICE_HELP = {
  all: "Set once. Every room ticked “Same as all rooms” copies this. Month-to-Month and Short-term start as “same as Long-term”.",
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

/**
 * The add-on fees on ONE room: name · amount · when · ✕, and + Add a fee.
 *
 * A fee scoped to exactly this room is edited here; a fee the house charges
 * on every room is shown so the manager sees the whole picture, but is edited
 * where it lives. Both are the same fee records the house-level section stores.
 */
function RoomFeesRows({ sub, patch, room, term }: { sub: ManagerListingSubmissionV1; patch: Patch; room: ManagerRoomSubmission; term: string }) {
  const rows = useMemo(() => listingFeesForWizard(sub).filter((f) => f.presetId !== "security_deposit"), [sub]);
  const mine = rows.filter((f) => (f.roomIds ?? []).length === 1 && f.roomIds![0] === room.id);
  const shared = rows.filter((f) => !mine.includes(f) && isListingFeeAmountFilled(f.amount ?? "") && feeAppliesToLeaseType(f, term) && feeAppliesToRoom(f, room.id));
  const writeRows = (next: ListingFeeRow[]) => {
    const held = listingFeesForWizard(sub).filter((f) => f.presetId === "security_deposit");
    patch(applyListingFeesToSubmission(sub, [...next, ...held]));
  };
  const write = (id: string, next: Partial<ListingFeeRow>) => writeRows(rows.map((f) => (f.id === id ? { ...f, ...next } : f)));
  const cad = (f: ListingFeeRow) => (listingFeeCadence(f) === "monthly" ? "/mo" : listingFeeCadence(f) === "weekly" ? "/wk" : listingFeeCadence(f) === "daily" ? "/day" : " once");
  return (
    <>
      <FactRow label="Other fees">
        <button
          type="button"
          data-attr="listing-v2-room-fee-add"
          onClick={() => writeRows([...rows, { ...emptyCustomFeeRow(), presetId: "custom", roomIds: [room.id] }])}
          className="text-[13.5px] font-bold text-primary hover:underline"
        >
          + Add a fee
        </button>
      </FactRow>
      {mine.map((fee) => (
        <div key={fee.id} className="grid grid-cols-[minmax(0,1.3fr)_104px_130px_28px] items-center gap-1.5 bg-foreground/[0.025] px-3.5 py-2 pl-7" data-attr="listing-v2-room-fee-row">
          <Input aria-label="Fee name" value={fee.label} placeholder="Parking" onChange={(e) => write(fee.id, { label: e.target.value })} />
          <MoneyInput label={`${fee.label || "Fee"} amount`} value={moneyValue(fee.amount)} placeholder="0" onChange={(v) => write(fee.id, { amount: sanitizeMoneyInput(v) })} />
          <Select aria-label={`How often ${fee.label || "this fee"} is charged`} value={listingFeeCadence(fee)} onChange={(e) => write(fee.id, patchListingFeeCadence(e.target.value as ListingFeeCadence))}>
            {LISTING_FEE_WIZARD_CADENCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
          <button type="button" aria-label={`Remove ${fee.label || "fee"}`} onClick={() => writeRows(rows.filter((f) => f.id !== fee.id))} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground">✕</button>
        </div>
      ))}
      {shared.map((f) => (
        <FactRow key={f.id} sub label={f.label}>
          <span className="text-[13px] text-foreground/70">{usd(num(f.amount ?? ""))}{cad(f)} · all rooms</span>
        </FactRow>
      ))}
    </>
  );
}

function MonthlyCards({
  sub,
  patch,
  term,
  feeScopeTerm,
  defaults,
  onDefault,
  onRoom,
  dimmed,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  term: string;
  /** Lease tab these cards are on — a room's fees respect Applies-to even when rent follows long-term. */
  feeScopeTerm: string;
  defaults: ListingHouseDefaults;
  onDefault: (field: ListingHouseDefaultField, value: string | number) => void;
  onRoom: (id: string, next: ManagerRoomSubmission) => void;
  dimmed: boolean;
}) {
  const rooms = sub.rooms ?? [];
  const base = isBase(term);
  const [open, setOpen] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const values = (room: ManagerRoomSubmission) => ({
    rent: termValue(room, term, "rent", defaults),
    util: termValue(room, term, "util", defaults),
    dep: termValue(room, term, "deposit", defaults),
    modeOwn: base ? !roomInheritsDefault(room, defaults, "pricingMode") : false,
  });
  const sameAsAll = (room: ManagerRoomSubmission) => {
    const v = values(room);
    return !unticked.has(room.id) && v.rent.src !== "own" && v.util.src !== "own" && v.dep.src !== "own" && !v.modeOwn;
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
    if (same) {
      if (base) onRoom(room.id, { ...resetRoomField(resetRoomField(resetRoomField(room, "monthlyRent"), "utilitiesEstimate"), "securityDeposit"), pricingMode: undefined });
      else {
        const all = { ...(room.termPricing ?? {}) };
        delete all[term];
        onRoom(room.id, { ...room, termPricing: Object.keys(all).length > 0 ? all : undefined });
      }
    } else if (base) onRoom(room.id, { ...room, monthlyRent: num(v.rent.text), utilitiesEstimate: moneyValue(v.util.text), securityDeposit: moneyValue(v.dep.text) });
    else onRoom(room.id, writeTerm(writeTerm(writeTerm(room, term, "monthlyRent", v.rent.text), term, "utilitiesEstimate", moneyValue(v.util.text)), term, "securityDeposit", moneyValue(v.dep.text)));
  };
  const listed = (rent: number, util: number, mode: string) => (mode === "flexible" ? `from ${usd(rent)}` : usd(rent + util));
  const untouch = (id: string) => setUnticked((prev) => { if (!prev.has(id)) return prev; const out = new Set(prev); out.delete(id); return out; });
  return (
    <>
      <RecordCard
        every
        title="All rooms"
        help={PRICE_HELP.all}
        dimmed={dimmed}
        dataAttr="listing-v2-price-defaults-card"
        rows={
          <div>
            <FactRow first label={helpRow("Rent /mo", PRICE_HELP.rent)}>
              {base ? (
                <MoneyInput label="Rent for every room" value={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : ""} placeholder="1,100" onChange={(v) => onDefault("monthlyRent", num(sanitizeMoneyInput(v)))} />
              ) : (
                <span className="text-[13.5px] font-semibold text-foreground">{defaults.monthlyRent > 0 ? usd(defaults.monthlyRent) : "—"}</span>
              )}
            </FactRow>
            <FactRow label={helpRow("Utilities /mo", PRICE_HELP.util)}>
              {base ? (
                <MoneyInput label="Utilities for every room" value={moneyValue(defaults.utilitiesEstimate)} placeholder="150" onChange={(v) => onDefault("utilitiesEstimate", sanitizeMoneyInput(v))} />
              ) : (
                <span className="text-[13.5px] font-semibold text-foreground">{moneyValue(defaults.utilitiesEstimate) ? usd(num(defaults.utilitiesEstimate)) : "—"}</span>
              )}
            </FactRow>
            <FactRow label={helpRow("Deposit", PRICE_HELP.dep)}>
              {base ? (
                <MoneyInput label="Deposit for every room" value={moneyValue(defaults.securityDeposit)} placeholder="1,000" onChange={(v) => onDefault("securityDeposit", sanitizeMoneyInput(v))} />
              ) : (
                <span className="text-[13.5px] font-semibold text-foreground">{moneyValue(defaults.securityDeposit) ? usd(num(defaults.securityDeposit)) : "—"}</span>
              )}
            </FactRow>
            <MoreRows dataAttr="listing-v2-price-defaults-more">
              <FactRow label="Listed rent">
                {base ? (
                  <RowSelectCell ariaLabel="Listed rent for every room" value={defaults.pricingMode || "fixed"} options={PRICING_MODE_OPTIONS} onChange={(v) => onDefault("pricingMode", v)} />
                ) : (
                  <span className="text-[13.5px] font-semibold text-foreground">{defaults.pricingMode === "flexible" ? "Flexible" : "Fixed"}</span>
                )}
              </FactRow>
            </MoreRows>
          </div>
        }
      />
      {rooms.map((room, i) => {
        const name = room.name.trim() || `Room ${i + 1}`;
        const rent = termValue(room, term, "rent", defaults);
        const util = termValue(room, term, "util", defaults);
        const dep = termValue(room, term, "deposit", defaults);
        const mode = room.pricingMode ?? defaults.pricingMode ?? "fixed";
        const modeOwn = base ? !roomInheritsDefault(room, defaults, "pricingMode") : false;
        const resetOne = (field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit") =>
          onRoom(room.id, base ? resetRoomField(room, field) : writeTerm(room, term, field, ""));
        const writeOne = (field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit", v: string) => {
          untouch(room.id);
          if (base) onRoom(room.id, field === "monthlyRent" ? { ...room, monthlyRent: num(sanitizeMoneyInput(v)) } : field === "utilitiesEstimate" ? { ...room, utilitiesEstimate: sanitizeMoneyInput(v) } : { ...room, securityDeposit: sanitizeMoneyInput(v) });
          else onRoom(room.id, writeTerm(room, term, field, sanitizeMoneyInput(v)));
        };
        const rentN = num(rent.text), utilN = num(util.text), depN = num(dep.text);
        const summary = [
          rentN > 0 ? usd(rentN) : "Rent not set",
          `+${usd(utilN)} utilities`,
          `${usd(depN)} deposit`,
          `listed ${listed(rentN, utilN, mode)}`,
        ].join(" · ");
        const isOpen = open === room.id;
        return (
          <RecordCard
            key={room.id}
            title={name}
            same={<SameAsAllToggle same={sameAsAll(room)} plural="rooms" noun="room" onChange={(next) => setSameAsAll(room, next)} onReset={() => setSameAsAll(room, true)} dataAttr="listing-v2-price-same-as-all" />}
            summary={summary}
            open={isOpen}
            onToggle={() => setOpen((prev) => (prev === room.id ? null : room.id))}
            toggleLabel={`${name} prices`}
            dimmed={dimmed}
            dataAttr="listing-v2-price-card"
          >
            <FactRow first label="Rent /mo" own={rent.src === "own"} onReset={() => resetOne("monthlyRent")} resetLabel={`Reset rent for ${name} (${term}) to the row above`}>
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
            <MoreRows dataAttr="listing-v2-price-more">
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
              <RoomFeesRows sub={sub} patch={patch} room={room} term={feeScopeTerm} />
            </MoreRows>
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
  defaults,
  onDefault,
  onRoom,
}: {
  sub: ManagerListingSubmissionV1;
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
        title="All rooms"
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
            same={<SameAsAllToggle same={sameAsAll(room)} plural="rooms" noun="room" onChange={(next) => setSameAsAll(room, next)} onReset={() => setSameAsAll(room, true)} dataAttr="listing-v2-stay-same-as-all" />}
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
            <EditorDone onClick={() => setOpen(null)} dataAttr="listing-v2-stay-done" />
          </RecordCard>
        );
      })}
    </>
  );
}

/** The whole place: one rent, one utilities figure, one deposit. */
function WholePlaceCard({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const write = (next: Parameters<typeof applyEntireHomeListingPricing>[1]) => patch(applyEntireHomeListingPricing(sub, next));
  return (
    <Card dataAttr="listing-v2-whole-place-card">
      <FactRow first label="Rent /mo" required>
        <MoneyInput label="Rent for the whole place" value={sub.entireHomeMonthlyRent ? String(sub.entireHomeMonthlyRent) : ""} placeholder="3,200" onChange={(v) => write({ entireHomeMonthlyRent: num(sanitizeMoneyInput(v)) || undefined })} />
      </FactRow>
      <FactRow label="Utilities /mo">
        <MoneyInput label="Utilities for the whole place" value={moneyValue(sub.entireHomeUtilitiesEstimate)} placeholder="180" onChange={(v) => write({ entireHomeUtilitiesEstimate: sanitizeMoneyInput(v) })} />
      </FactRow>
      <FactRow label="Deposit">
        <MoneyInput label="Deposit for the whole place" value={moneyValue(sub.securityDeposit)} placeholder="3,200" onChange={(v) => patch({ securityDeposit: sanitizeMoneyInput(v) })} />
      </FactRow>
      <FactRow label="Utilities are">
        <RowSelectCell
          ariaLabel="How utilities are handled"
          value={sub.entireHomeUtilitiesPaymentModel ?? ""}
          placeholder="Select…"
          options={LONG_TERM_UTILITIES_PAYMENT_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
          onChange={(v) => write({ entireHomeUtilitiesPaymentModel: v as ManagerListingSubmissionV1["entireHomeUtilitiesPaymentModel"] })}
        />
      </FactRow>
      <FactRow label="Partial month">
        <RowSelectCell
          ariaLabel="Prorate a partial month"
          value={sub.entireHomeProrateMethod ?? "auto"}
          options={[
            { value: "auto", label: "Worked out automatically" },
            { value: "daily_rate", label: "Per-day rate" },
          ]}
          onChange={(v) => write({ entireHomeProrateMethod: v as ManagerListingSubmissionV1["entireHomeProrateMethod"] })}
        />
      </FactRow>
      {sub.entireHomeProrateMethod === "daily_rate" ? (
        <>
          <FactRow sub label="Rent /day">
            <MoneyInput label="Prorated rent per day" value={sub.entireHomeDailyRentRate ? String(sub.entireHomeDailyRentRate) : ""} onChange={(v) => write({ entireHomeDailyRentRate: num(sanitizeMoneyInput(v)) || undefined })} />
          </FactRow>
          <FactRow sub label="Utilities /day">
            <MoneyInput label="Prorated utilities per day" value={sub.entireHomeDailyUtilitiesRate ? String(sub.entireHomeDailyUtilitiesRate) : ""} onChange={(v) => write({ entireHomeDailyUtilitiesRate: num(sanitizeMoneyInput(v)) || undefined })} />
          </FactRow>
        </>
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
  const roomRent = (r: ManagerRoomSubmission) => termValue(r, LONG_TERM_LEASE_TERM, "rent", defaults);
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

/* ─────────────────────── fees ─────────────────────── */

function FeeRefundRows({ fee, onChange }: { fee: ListingFeeRow; onChange: (patch: Partial<ListingFeeRow>) => void }) {
  if (fee.presetId === "security_deposit") return null;
  if (listingFeeCadence(fee) !== "one-time") return null;
  const refundable = fee.presetId === "holding_deposit" ? true : Boolean(fee.refundable || fee.creditsTowardSecurity);
  const creditChecked = fee.presetId === "holding_deposit" ? fee.creditsTowardSecurity !== false : Boolean(fee.creditsTowardSecurity);
  return (
    <div className="px-3.5 pb-1">
      {fee.presetId === "holding_deposit" ? (
        <CheckboxOption label="Credits toward the security deposit" checked={creditChecked} onChange={(next) => onChange({ creditsTowardSecurity: next })} />
      ) : (
        <>
          <CheckboxOption label="Refundable" checked={refundable} dataAttr="listing-fee-refundable" onChange={(next) => onChange({ refundable: next, creditsTowardSecurity: next ? fee.creditsTowardSecurity : false })} />
          {refundable ? (
            <CheckboxOption label="Reduces the security deposit by this amount" checked={creditChecked} dataAttr="listing-fee-credit-security" onChange={(next) => onChange({ creditsTowardSecurity: next, refundable: true })} />
          ) : null}
        </>
      )}
    </div>
  );
}

function FeesSection({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const terms = useMemo(() => listingLeaseTypeScopeOptions(sub), [sub]);
  const rooms = sub.rooms ?? [];
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  const seattle = listingFoldsAllMonthlyFeesIntoRent(sub);
  const rows = useMemo(() => listingFeesForWizard(sub).filter((f) => f.presetId !== "security_deposit"), [sub]);
  /* An empty standard slot is a slot the product offers, not a fee this listing charges. */
  const [revealed, setRevealed] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const standardAll = rows.filter((f) => f.presetId && f.presetId !== "custom");
  const standard = standardAll.filter((f) => isListingFeeAmountFilled(f.amount ?? "") || revealed.includes(f.id));
  const unusedStandard = standardAll.filter((f) => !standard.includes(f));
  const custom = rows.filter((f) => !f.presetId || f.presetId === "custom");
  const shown = [...standard, ...custom];

  const writeRows = (next: ListingFeeRow[]) => {
    const held = listingFeesForWizard(sub).filter((f) => f.presetId === "security_deposit");
    patch(applyListingFeesToSubmission(sub, [...next, ...held]));
  };
  const write = (id: string, next: Partial<ListingFeeRow>) => writeRows(rows.map((f) => (f.id === id ? { ...f, ...next } : f)));

  const removeFee = (fee: ListingFeeRow) => {
    setOpen(null);
    if (!fee.presetId || fee.presetId === "custom") {
      writeRows(rows.filter((f) => f.id !== fee.id));
      return;
    }
    const rowId = listingFeeRowIdForPresetId(fee.presetId);
    if (!rowId) return;
    const removed = new Set(parseRemovedStandardListingFeeRows(sub));
    removed.add(rowId as RemovedStandardListingFeeRowId);
    const held = listingFeesForWizard(sub).filter((f) => f.presetId === "security_deposit");
    const nextSub = applyListingFeesToSubmission(sub, [...rows.filter((f) => f.id !== fee.id), ...held]);
    patch(ensureSubmissionListingFees({ ...nextSub, removedStandardListingFeeRows: [...removed] }));
    setRevealed((prev) => prev.filter((id) => id !== fee.id));
  };

  const roomLabel = (r: ManagerRoomSubmission, i: number) => r.name.trim() || `Room ${i + 1}`;
  const summaryFor = (fee: ListingFeeRow) => {
    const amount = isListingFeeAmountFilled(fee.amount ?? "") ? usd(num(fee.amount ?? "")) : "Amount needed";
    const cad = listingFeeCadence(fee);
    const suffix = cad === "monthly" ? "/mo" : cad === "weekly" ? "/wk" : cad === "daily" ? "/day" : " once";
    const leaseTypes = terms.length === 0 ? "Choose lease types above first" : expandFeeScope(fee.leaseTypes, terms).join(", ") || "No lease types";
    const roomScope = wholePlace || rooms.length === 0 ? "" : expandFeeScope(fee.roomIds, rooms.map((r) => r.id)).length === rooms.length ? "All rooms" : `${expandFeeScope(fee.roomIds, rooms.map((r) => r.id)).length} rooms`;
    return [`${amount}${isListingFeeAmountFilled(fee.amount ?? "") ? suffix : ""}`, roomScope, leaseTypes].filter(Boolean).join(" · ");
  };

  return (
    <>
      {shown.length === 0 ? (
        <Card>
          <FactRow first label={<span className="font-medium text-foreground/70">No fees beyond rent, the deposit and utilities</span>}>
            <span />
          </FactRow>
        </Card>
      ) : null}
      {shown.map((fee) => {
        const isCustom = !fee.presetId || fee.presetId === "custom";
        const label = fee.label.trim() || "Fee";
        const selectedRooms = expandFeeScope(fee.roomIds, rooms.map((r) => r.id)).map((id) => rooms.findIndex((r) => r.id === id)).filter((i) => i >= 0).map((i) => roomLabel(rooms[i]!, i));
        return (
          <RecordCard
            key={fee.id}
            title={isCustom ? undefined : fee.label}
            name={isCustom ? fee.label : undefined}
            nameLabel="Fee name"
            namePlaceholder="Parking space"
            onName={isCustom ? (v) => write(fee.id, { label: v }) : undefined}
            summary={summaryFor(fee)}
            open={open === fee.id}
            onToggle={() => setOpen((prev) => (prev === fee.id ? null : fee.id))}
            toggleLabel={label}
            dataAttr="listing-v2-fee-card"
          >
            <FactRow first label="Amount" required>
              <MoneyInput label={`${label} amount`} value={moneyValue(fee.amount)} placeholder="0" onChange={(v) => write(fee.id, { amount: sanitizeMoneyInput(v) })} />
            </FactRow>
            <FactRow label="Charged">
              <RowSelectCell ariaLabel={`How often ${label} is charged`} value={listingFeeCadence(fee)} options={LISTING_FEE_WIZARD_CADENCE_OPTIONS} onChange={(v) => write(fee.id, patchListingFeeCadence(v as ListingFeeCadence))} />
            </FactRow>
            <FactRow label="Lease types">
              {terms.length === 0 ? (
                <span className="text-[13px] font-semibold text-[var(--status-pending-fg)]">Choose lease types above first →</span>
              ) : (
                <MultiPick label={`Lease types for ${label}`} options={terms} selected={expandFeeScope(fee.leaseTypes, terms)} allowOther={false} emptyLabel="None" onChange={(next) => write(fee.id, { leaseTypes: narrowFeeScope(next, terms) })} />
              )}
            </FactRow>
            {wholePlace || rooms.length === 0 ? null : (
              <FactRow label="Rooms">
                <MultiPick label={`Rooms for ${label}`} options={rooms.map(roomLabel)} selected={selectedRooms} allowOther={false} emptyLabel="None" onChange={(next) => write(fee.id, { roomIds: narrowFeeScope(rooms.filter((r, i) => next.includes(roomLabel(r, i))).map((r) => r.id), rooms.map((r) => r.id)) })} />
              </FactRow>
            )}
            <FeeRefundRows fee={fee} onChange={(next) => write(fee.id, next)} />
            <CardFoot>
              <CardAction onClick={() => removeFee(fee)} tone="danger" dataAttr="listing-v2-fee-remove">
                Remove
              </CardAction>
            </CardFoot>
          </RecordCard>
        );
      })}
      <div className="mt-1">
        <RowSelectCell
          ariaLabel="Add a fee"
          value=""
          placeholder="Add a fee…"
          className="w-full"
          options={[...unusedStandard.map((fee) => ({ value: fee.id, label: fee.label })), { value: "__custom", label: "Something else…" }]}
          onChange={(picked) => {
            if (!picked) return;
            if (picked === "__custom") {
              const row = { ...emptyCustomFeeRow(), presetId: "custom" as const };
              writeRows([...rows, row]);
              setOpen(row.id);
            } else {
              setRevealed((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
              setOpen(picked);
            }
          }}
        />
      </div>
      {seattle ? <p className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-foreground">{SEATTLE_RENT_RULE_NOTE}</p> : null}
    </>
  );
}

/* ─────────────────────── due at signing ─────────────────────── */

/**
 * What is collected before move-in, as a tick list with the amounts and the
 * total — the receipt the side panel shows, here where the ticks are made.
 */
function DueAtSigning({ sub, patch, term }: { sub: ManagerListingSubmissionV1; patch: Patch; term: string }) {
  const rentByRoom = sub.listingPlaceCategoryId !== "entire_home";
  const rooms = sub.rooms ?? [];
  const [roomId, setRoomId] = useState<string | null>(null);
  const quoteRoomId = rentByRoom ? (roomId && rooms.some((r) => r.id === roomId) ? roomId : rooms[0]?.id ?? null) : null;
  const leaseTerm = listingPricingTabToLeaseTerm(term);
  const quote = useMemo(() => buildListingQuote(sub, { roomId: quoteRoomId, leaseTerm }), [sub, quoteRoomId, leaseTerm]);
  const toggle = (rawKey: string, on: boolean) => {
    // The quote names the rent line per room; the step sets the LISTING's
    // policy for this lease type, so the tick lands on the shared key.
    const key = rawKey.startsWith(PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX) ? "first_month_rent" : rawKey;
    const next = applyPaymentAtSigningCell(sub, leaseTerm, key, on);
    patch({ paymentAtSigningByLeaseType: next.paymentAtSigningByLeaseType, paymentAtSigningIncludes: next.paymentAtSigningIncludes, customFees: next.customFees });
  };
  const who = rentByRoom ? rooms.find((r) => r.id === quoteRoomId)?.name.trim() || "Room" : "The whole place";
  return (
    <Card dataAttr="listing-v2-due-at-signing">
      {rentByRoom && rooms.length > 1 ? (
        <FactRow first label="Room">
          <RowSelectCell ariaLabel="Room to quote" value={quoteRoomId ?? ""} options={rooms.map((room, i) => ({ value: room.id, label: room.name.trim() || `Room ${i + 1}` }))} onChange={(v) => setRoomId(v || null)} />
        </FactRow>
      ) : null}
      {quote.signingLines.map((line, i) => (
        <div key={line.key} className={cn("flex min-h-[48px] items-center justify-between gap-3 px-3.5 py-1.5", (i > 0 || (rentByRoom && rooms.length > 1)) && "border-t border-border")}>
          <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
            <input type="checkbox" checked={line.dueAtSigning} onChange={(e) => toggle(line.key, e.target.checked)} aria-label={`Collect ${line.label} at signing`} className="h-4 w-4 shrink-0 accent-[var(--pl-blue)]" />
            <span className="truncate text-[14px] font-semibold text-foreground">{line.label}</span>
          </label>
          <span className={cn("shrink-0 text-[13.5px] font-semibold tabular-nums", line.dueAtSigning ? "text-foreground" : "text-foreground/50 line-through")}>{usd(line.amount)}</span>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 rounded-b-2xl border-t border-border bg-[var(--pl-surface-muted)] px-3.5 py-3">
        <span className="text-[14px] font-semibold text-foreground">Due at signing · {who}</span>
        <b className="text-[18px] font-extrabold tabular-nums text-foreground">{usd(quote.signingTotal)}</b>
      </div>
    </Card>
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
  /** "Same as long-term" is true when no room has its own price on this term. */
  const sameAsLongTerm = (term: string) => !rooms.some((r) => r.termPricing?.[term] && Object.keys(r.termPricing[term]!).length > 0);
  const [waiverCodesOpen, setWaiverCodesOpen] = useState(false);
  const [showOwn, setShowOwn] = useState<Record<string, boolean>>({});
  const ownTable = (term: string) => showOwn[term] || !sameAsLongTerm(term);
  const stay = isStayLeaseTerm(activeLeaseTerm);

  /*
   * The application-fee switch. On means the listing charges one; off blanks
   * the fee, the short-term fee and the waiver code so nothing is billed.
   * A listing that already has any of them is on.
   */
  const feeStored = moneyFilled(sub.applicationFee) || moneyFilled(sub.shortTermApplicationFee) || Boolean(sub.applicationFeeWaiverCode);
  const [feeOn, setFeeOn] = useState(feeStored);
  const chargeFee = feeOn || feeStored;

  return (
    <>
      <SectionTitle>How you get paid</SectionTitle>
      <Card dataAttr="listing-v2-payments-card">{payments}</Card>

      <SectionTitle>Applications</SectionTitle>
      <Card dataAttr="listing-v2-applications-card">
        <div className="px-3.5 py-1">
          <CheckboxOption
            label="Charge an application fee"
            checked={chargeFee}
            dataAttr="listing-v2-application-fee-on"
            onChange={(next) => {
              setFeeOn(next);
              if (!next) patch({ applicationFee: "", shortTermApplicationFee: "", applicationFeeWaiverCode: "" });
            }}
          />
        </div>
        {chargeFee ? (
          <div data-attr="listing-v2-application-fee-rows">
            <FactRow label="Application fee">
              <MoneyInput label="Long-term application fee" value={moneyValue(sub.applicationFee)} placeholder="50" onChange={(v) => patch({ applicationFee: sanitizeMoneyInput(v) })} />
            </FactRow>
            <FactRow label="Short-term fee">
              <MoneyInput label="Short-term application fee" value={moneyValue(sub.shortTermApplicationFee ?? "")} placeholder={moneyValue(sub.applicationFee) || "50"} onChange={(v) => patch({ shortTermApplicationFee: sanitizeMoneyInput(v) })} />
            </FactRow>
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
            <FactRow label={<button type="button" data-attr="listing-v2-manage-waiver-codes" onClick={() => setWaiverCodesOpen(true)} className="text-[14px] font-bold text-primary hover:underline">Manage codes →</button>}>
              <span />
            </FactRow>
            <div className="border-t border-border">{applications}</div>
          </div>
        ) : null}
      </Card>

      <SectionTitle>{wholePlace ? "The whole place" : "Each room"}</SectionTitle>
      <Card dataAttr="listing-v2-lease-types-card">{leaseTypesField}</Card>
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
                    // Back to "same as long-term": clear every room's own price on this term.
                    patch({ rooms: rooms.map((r) => { const all = { ...(r.termPricing ?? {}) }; delete all[activeLeaseTerm]; return { ...r, termPricing: Object.keys(all).length ? all : undefined }; }) });
                    setShowOwn((prev) => ({ ...prev, [activeLeaseTerm]: false }));
                  } else {
                    setShowOwn((prev) => ({ ...prev, [activeLeaseTerm]: true }));
                  }
                }}
              />
            </div>
          ) : null}
          {wholePlace ? (
            <WholePlaceCard sub={sub} patch={patch} />
          ) : stay ? (
            <StayCards sub={sub} defaults={defaults} onDefault={onDefault} onRoom={onRoom} />
          ) : (
            <MonthlyCards
              sub={sub}
              patch={patch}
              term={!isBase(activeLeaseTerm) && !ownTable(activeLeaseTerm) ? LONG_TERM_LEASE_TERM : activeLeaseTerm}
              feeScopeTerm={activeLeaseTerm}
              defaults={defaults}
              onDefault={onDefault}
              onRoom={onRoom}
              dimmed={!isBase(activeLeaseTerm) && !ownTable(activeLeaseTerm)}
            />
          )}
        </>
      )}

      {wholePlace ? null : <BundlesSection sub={sub} patch={patch} defaults={defaults} />}

      <SectionTitle>Other fees</SectionTitle>
      <div id="listing-v2-fees" className="scroll-mt-4">
        <FeesSection sub={sub} patch={patch} />
      </div>

      <SectionTitle>At signing</SectionTitle>
      <DueAtSigning sub={sub} patch={patch} term={active} />

      <div className="mt-6">{leaseDocument}</div>
      {/* Mounted only while open: the modal reads `useAppUi` at its top level, so
          rendering it unconditionally drags a provider requirement into every
          tree that renders Pricing — which is a dependency this screen does not
          otherwise have. */}
      {waiverCodesOpen ? <ManagerApplicationFeeWaiverCodesModal open onClose={() => setWaiverCodesOpen(false)} /> : null}
    </>
  );
}
