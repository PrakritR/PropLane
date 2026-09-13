"use client";

/**
 * Pricing, in the order money happens.
 *
 * 1. **Before move-in** — the application fee, its waiver code, and who pays
 *    card processing. Three things a resident meets before a lease exists.
 *    "PropLane pays" asks for the promo code PropLane shared (unless the
 *    account already carries a grant); the code is stored on the listing so
 *    checkout re-validates it (`resolveAccountOrListingWaiverGranted`).
 * 2. **Each room** — one editable table, a tab per lease type. The top row is
 *    **Every room**: same columns, same inputs; rooms follow it until changed
 *    (grey and dashed = following, ink with a dot = the room's own). Long-term
 *    carries a minimum term. Month-to-month and custom dates are "same as
 *    long-term" until the box is unticked. Short-term is rent per day, rent
 *    per week and a deposit — nothing else, the rate is all-in.
 * 3. **At signing** — what each lease type collects up front, beside the
 *    receipt, which is the same panel it always was.
 *
 * Nothing new is stored. Rent is `room.monthlyRent`; another lease type's own
 * price is `room.termPricing[term]` with ABSENT meaning "same as long-term"
 * (PRP-463); utilities, deposit and pricing mode are the fields they already
 * are; the house defaults are `listing-house-defaults.ts`. This screen is a
 * view over all of it.
 */

import { useEffect, useMemo, useState } from "react";
import { Input, Select } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Field } from "@/components/portal/listing-wizard-v2/wizard-primitives";
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
  paymentAtSigningRows,
  paymentAtSigningMatrix,
} from "@/lib/listing-fee-scope";
import {
  applyListingFeesToSubmission,
  ensureSubmissionListingFees,
  applyPaymentAtSigningCell,
  isListingFeeAmountFilled,
  LISTING_FEE_WIZARD_CADENCE_OPTIONS,
  listingFeeCadence,
  listingFeeCadenceHint,
  listingFeesForWizard,
  parseRemovedStandardListingFeeRows,
  patchListingFeeCadence,
  type ListingFeeCadence,
  type ListingFeeRow,
  type RemovedStandardListingFeeRowId,
} from "@/lib/listing-fees";
import { SEATTLE_RENT_RULE_NOTE, listingFoldsAllMonthlyFeesIntoRent } from "@/lib/seattle-rent-rule";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { isStayLeaseTerm } from "@/lib/listing-quote";
import {
  applyHouseDefaultsToRooms,
  roomInheritsDefault,
  type ListingHouseDefaultField,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import {
  emptyCustomFeeRow,
  type ManagerCustomFeeRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { cn } from "@/lib/utils";

type Patch = (next: Partial<ManagerListingSubmissionV1>) => void;

const usd = (n: number) => `$${Math.round(n || 0).toLocaleString("en-US")}`;
/** A stored money string, shown blank when it is zero or unset — never "0". */
const moneyValue = (raw: string | undefined) => {
  const text = (raw ?? "").replace(/^\$/, "").trim();
  return text === "0" ? "" : text;
};
const num = (raw: string) => {
  const n = Number(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const MONTHLY_COLUMNS = "minmax(120px,1.2fr) 118px 118px 118px 124px minmax(150px,1.5fr)";
const STAY_COLUMNS = "minmax(120px,1.2fr) 118px 118px 118px minmax(0,1fr)";

const cell = (inherited: boolean) =>
  cn(
    "min-h-[36px] w-full rounded-lg border bg-card px-2 py-1 text-[13px] text-foreground outline-none focus:border-primary",
    inherited ? "border-dashed border-border text-muted" : "border-border",
  );

/** A money cell: `$` prefix, inherited shows the value as a placeholder in an empty box. */
function MoneyCell({
  value,
  inherited,
  own,
  placeholder,
  label,
  onChange,
}: {
  value: string;
  inherited: boolean;
  own: boolean;
  placeholder: string;
  label: string;
  onChange: (raw: string) => void;
}) {
  return (
    <span className="relative min-w-0">
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12.5px] text-muted">$</span>
      <input
        inputMode="decimal"
        aria-label={label}
        /* Inherited is a PLACEHOLDER, not a value: the box is genuinely empty
           until the room is given its own number, which is what "absent" means. */
        value={inherited ? "" : value}
        placeholder={placeholder}
        onChange={(e) => onChange(sanitizeMoneyInput(e.target.value))}
        className={cn(cell(inherited), "pl-5 tabular-nums")}
      />
      {own ? <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-white bg-primary" /> : null}
    </span>
  );
}

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

/* ─────────────────────── the room table ─────────────────────── */

function MonthlyTable({
  sub,
  term,
  feeScopeTerm,
  defaults,
  onDefault,
  onRoom,
  fees,
  onJumpToFees,
}: {
  sub: ManagerListingSubmissionV1;
  term: string;
  /** Lease tab this table is on — fee chips respect Applies-to even when rent follows long-term. */
  feeScopeTerm: string;
  defaults: ListingHouseDefaults;
  onDefault: (field: ListingHouseDefaultField, value: string | number) => void;
  onRoom: (id: string, next: ManagerRoomSubmission) => void;
  fees: ListingFeeRow[];
  onJumpToFees: () => void;
}) {
  const rooms = sub.rooms ?? [];
  const base = isBase(term);
  const feeChips = (roomId: string | null) => {
    const list = fees.filter(
      (f) =>
        isListingFeeAmountFilled(f.amount ?? "") &&
        feeAppliesToLeaseType(f, feeScopeTerm) &&
        (roomId ? feeAppliesToRoom(f, roomId) : true),
    );
    return (
      <span className="flex flex-wrap items-center gap-1">
        {list.map((f) => (
          <span key={f.id} className="rounded-full border border-border bg-[var(--pl-surface-muted)] px-2 py-0.5 text-[11.5px] text-muted">
            {f.label} {usd(num(f.amount ?? ""))}
            {listingFeeCadence(f) === "monthly"
              ? "/mo"
              : listingFeeCadence(f) === "weekly"
                ? "/wk"
                : listingFeeCadence(f) === "daily"
                  ? "/day"
                  : ""}
          </span>
        ))}
        <button type="button" onClick={onJumpToFees} className="text-[12px] font-bold text-primary hover:underline">
          + Add
        </button>
      </span>
    );
  };
  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <div className="min-w-[760px]">
        <div className="grid items-center gap-2 border-b border-border bg-accent/25 px-3 py-2 text-[10.5px] font-extrabold uppercase tracking-wide text-muted" style={{ gridTemplateColumns: MONTHLY_COLUMNS }}>
          <span>Room</span><span>Rent /mo</span><span>Utilities /mo</span><span>Deposit</span><span>Listed rent</span><span>Other fees</span>
        </div>
        {/* Every room — the defaults. On a non-long-term tab it only shows what long-term set. */}
        <div className="grid items-center gap-2 border-b-2 border-primary/25 bg-primary/[0.05] px-3 py-2" style={{ gridTemplateColumns: MONTHLY_COLUMNS }}>
          <span className="min-w-0 leading-tight">
            <b className="block text-[13.5px] font-bold text-foreground">Every room</b>
            <span className="block text-[11.5px] text-muted">{base ? "Rooms follow these" : "Follows long-term"}</span>
          </span>
          {base ? (
            <MoneyCell
              label="Rent for every room"
              value={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : ""}
              inherited={false}
              own={false}
              placeholder="1,100"
              onChange={(v) => onDefault("monthlyRent", num(v))}
            />
          ) : (
            <span className="text-[13px] text-muted">{defaults.monthlyRent > 0 ? usd(defaults.monthlyRent) : "—"}</span>
          )}
          {base ? (
            <MoneyCell label="Utilities for every room" value={moneyValue(defaults.utilitiesEstimate)} inherited={false} own={false} placeholder="150" onChange={(v) => onDefault("utilitiesEstimate", v)} />
          ) : (
            <span className="text-[13px] text-muted">{moneyValue(defaults.utilitiesEstimate) ? usd(num(defaults.utilitiesEstimate)) : "—"}</span>
          )}
          {base ? (
            <MoneyCell label="Deposit for every room" value={moneyValue(defaults.securityDeposit)} inherited={false} own={false} placeholder="1,000" onChange={(v) => onDefault("securityDeposit", v)} />
          ) : (
            <span className="text-[13px] text-muted">{moneyValue(defaults.securityDeposit) ? usd(num(defaults.securityDeposit)) : "—"}</span>
          )}
          {base ? (
            <select aria-label="Listed rent for every room" value={defaults.pricingMode || "fixed"} onChange={(e) => onDefault("pricingMode", e.target.value)} className={cell(false)}>
              <option value="fixed">Fixed</option>
              <option value="flexible">Flexible</option>
            </select>
          ) : (
            <span className="text-[13px] text-muted">{defaults.pricingMode === "flexible" ? "Flexible" : "Fixed"}</span>
          )}
          {feeChips(null)}
        </div>
        {rooms.map((room, i) => {
          const name = room.name.trim() || `Room ${i + 1}`;
          const rent = termValue(room, term, "rent", defaults);
          const util = termValue(room, term, "util", defaults);
          const dep = termValue(room, term, "deposit", defaults);
          const modeOwn = base ? !roomInheritsDefault(room, defaults, "pricingMode") : false;
          return (
            <div key={room.id} className="grid items-center gap-2 border-b border-border px-3 py-2 last:border-b-0" style={{ gridTemplateColumns: MONTHLY_COLUMNS }} data-attr="listing-v2-price-row">
              <span className="min-w-0 leading-tight">
                <b className="block truncate text-[13.5px] font-bold text-foreground">{name}</b>
                <span className="block truncate text-[11.5px] text-muted">{room.floor?.trim()}</span>
              </span>
              <MoneyCell
                label={`${name} rent on ${term}`}
                value={rent.text}
                inherited={rent.src !== "own"}
                own={rent.src === "own" && !base}
                placeholder={rent.text || "1,100"}
                onChange={(v) => onRoom(room.id, base ? { ...room, monthlyRent: num(v) } : writeTerm(room, term, "monthlyRent", v))}
              />
              <MoneyCell
                label={`${name} utilities on ${term}`}
                value={moneyValue(util.text)}
                inherited={util.src !== "own"}
                own={util.src === "own"}
                placeholder={moneyValue(util.text) || "150"}
                onChange={(v) => onRoom(room.id, base ? { ...room, utilitiesEstimate: v } : writeTerm(room, term, "utilitiesEstimate", v))}
              />
              <MoneyCell
                label={`${name} deposit on ${term}`}
                value={moneyValue(dep.text)}
                inherited={dep.src !== "own"}
                own={dep.src === "own"}
                placeholder={moneyValue(dep.text) || "1,000"}
                onChange={(v) => onRoom(room.id, base ? { ...room, securityDeposit: v } : writeTerm(room, term, "securityDeposit", v))}
              />
              <span className="relative min-w-0">
                <select
                  aria-label={`Listed rent for ${name}`}
                  value={room.pricingMode ?? defaults.pricingMode ?? "fixed"}
                  disabled={!base}
                  onChange={(e) => onRoom(room.id, { ...room, pricingMode: e.target.value as ManagerRoomSubmission["pricingMode"] })}
                  className={cn(cell(!modeOwn), "disabled:opacity-70")}
                >
                  <option value="fixed">Fixed</option>
                  <option value="flexible">Flexible</option>
                </select>
                {modeOwn ? <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-white bg-primary" /> : null}
              </span>
              {feeChips(room.id)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StayTable({
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
  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <div className="min-w-[640px]">
        <div className="grid items-center gap-2 border-b border-border bg-accent/25 px-3 py-2 text-[10.5px] font-extrabold uppercase tracking-wide text-muted" style={{ gridTemplateColumns: STAY_COLUMNS }}>
          <span>Room</span><span>Rent /day</span><span>Rent /week</span><span>Deposit</span><span />
        </div>
        <div className="grid items-center gap-2 border-b-2 border-primary/25 bg-primary/[0.05] px-3 py-2" style={{ gridTemplateColumns: STAY_COLUMNS }}>
          <span className="min-w-0 leading-tight">
            <b className="block text-[13.5px] font-bold text-foreground">Every room</b>
            <span className="block text-[11.5px] text-muted">All-in rates, utilities included</span>
          </span>
          <MoneyCell label="Rent per day for every room" value={moneyValue(defaults.shortTermRent)} inherited={false} own={false} placeholder="65" onChange={(v) => onDefault("shortTermRent", v)} />
          <MoneyCell label="Rent per week for every room" value={defaults.weeklyRentPrice > 0 ? String(defaults.weeklyRentPrice) : ""} inherited={false} own={false} placeholder="395" onChange={(v) => onDefault("weeklyRentPrice", num(v))} />
          <MoneyCell label="Deposit for a stay, every room" value={moneyValue(defaults.shortTermDeposit)} inherited={false} own={false} placeholder="500" onChange={(v) => onDefault("shortTermDeposit", v)} />
          <span />
        </div>
        {rooms.map((room, i) => {
          const name = room.name.trim() || `Room ${i + 1}`;
          const dayInh = roomInheritsDefault(room, defaults, "shortTermRent");
          const weekInh = roomInheritsDefault(room, defaults, "weeklyRentPrice");
          const depInh = roomInheritsDefault(room, defaults, "shortTermDeposit");
          const day = moneyValue(room.shortTermRent) || moneyValue(defaults.shortTermRent);
          const week = room.weeklyRentPrice || defaults.weeklyRentPrice;
          return (
            <div key={room.id} className="grid items-center gap-2 border-b border-border px-3 py-2 last:border-b-0" style={{ gridTemplateColumns: STAY_COLUMNS }}>
              <span className="min-w-0 leading-tight">
                <b className="block truncate text-[13.5px] font-bold text-foreground">{name}</b>
                <span className="block truncate text-[11.5px] text-muted">{room.floor?.trim()}</span>
              </span>
              <MoneyCell label={`${name} rent per day`} value={moneyValue(room.shortTermRent)} inherited={dayInh} own={!dayInh} placeholder={moneyValue(defaults.shortTermRent) || "65"} onChange={(v) => onRoom(room.id, { ...room, shortTermRent: v })} />
              <MoneyCell label={`${name} rent per week`} value={room.weeklyRentPrice ? String(room.weeklyRentPrice) : ""} inherited={weekInh} own={!weekInh} placeholder={defaults.weeklyRentPrice > 0 ? String(defaults.weeklyRentPrice) : "395"} onChange={(v) => onRoom(room.id, { ...room, weeklyRentPrice: num(v) || undefined })} />
              <MoneyCell label={`${name} deposit for a stay`} value={moneyValue(room.shortTermDeposit)} inherited={depInh} own={!depInh} placeholder={moneyValue(defaults.shortTermDeposit) || "500"} onChange={(v) => onRoom(room.id, { ...room, shortTermDeposit: v })} />
              <span className="text-[12px] text-muted">
                {day && week ? `A week saves ${usd(num(day) * 7 - week)} over 7 days.` : <span className="text-[var(--status-pending-fg)]">Add a weekly rate</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────── fees ─────────────────────── */

function FeeCadenceSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: ListingFeeCadence;
  onChange: (next: ListingFeeCadence) => void;
  ariaLabel: string;
}) {
  return (
    <Select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value as ListingFeeCadence)}>
      {LISTING_FEE_WIZARD_CADENCE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </Select>
  );
}

function FeeRefundOptions({
  fee,
  onChange,
}: {
  fee: ListingFeeRow;
  onChange: (patch: Partial<ListingFeeRow>) => void;
}) {
  if (fee.presetId === "security_deposit") return null;
  const oneTime = listingFeeCadence(fee) === "one-time";
  if (!oneTime) return null;
  const refundable =
    fee.presetId === "holding_deposit" ? true : Boolean(fee.refundable || fee.creditsTowardSecurity);
  const showCreditToggle = refundable && fee.presetId !== "holding_deposit";
  const creditChecked =
    fee.presetId === "holding_deposit" ? fee.creditsTowardSecurity !== false : Boolean(fee.creditsTowardSecurity);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-foreground">
      {fee.presetId === "holding_deposit" ? (
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--pl-blue)]"
            checked={creditChecked}
            onChange={(e) => onChange({ creditsTowardSecurity: e.target.checked })}
          />
          Credits toward security deposit
        </label>
      ) : (
        <>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--pl-blue)]"
              checked={refundable}
              onChange={(e) => {
                const next = e.target.checked;
                onChange({
                  refundable: next,
                  creditsTowardSecurity: next ? fee.creditsTowardSecurity : false,
                });
              }}
              data-attr="listing-fee-refundable"
            />
            Refundable
          </label>
          {showCreditToggle ? (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[var(--pl-blue)]"
                checked={creditChecked}
                onChange={(e) => onChange({ creditsTowardSecurity: e.target.checked, refundable: true })}
                data-attr="listing-fee-credit-security"
              />
              Reduce security deposit by this amount
            </label>
          ) : null}
        </>
      )}
    </div>
  );
}

function FeesSection({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const terms = useMemo(() => listingLeaseTypeScopeOptions(sub), [sub]);
  const rooms = sub.rooms ?? [];
  const seattle = listingFoldsAllMonthlyFeesIntoRent(sub);
  const rows = useMemo(() => listingFeesForWizard(sub).filter((f) => f.presetId !== "security_deposit"), [sub]);
  /* An empty standard slot is a slot the product offers, not a fee this listing charges. */
  const [revealed, setRevealed] = useState<string[]>([]);
  const standardAll = rows.filter((f) => f.presetId && f.presetId !== "custom");
  const standard = standardAll.filter((f) => isListingFeeAmountFilled(f.amount ?? "") || revealed.includes(f.id));
  const unusedStandard = standardAll.filter((f) => !standard.includes(f));
  const custom = rows.filter((f) => !f.presetId || f.presetId === "custom");

  const writeRows = (next: ListingFeeRow[]) => {
    const held = listingFeesForWizard(sub).filter((f) => f.presetId === "security_deposit");
    patch(applyListingFeesToSubmission(sub, [...next, ...held]));
  };
  const write = (id: string, next: Partial<ListingFeeRow>) => writeRows(rows.map((f) => (f.id === id ? { ...f, ...next } : f)));

  const removeStandardFee = (fee: ListingFeeRow) => {
    const rowId = listingFeeRowIdForPresetId(fee.presetId);
    if (!rowId) return;
    const removed = new Set(parseRemovedStandardListingFeeRows(sub));
    removed.add(rowId as RemovedStandardListingFeeRowId);
    const held = listingFeesForWizard(sub).filter((f) => f.presetId === "security_deposit");
    const nextRows = rows.filter((f) => f.id !== fee.id);
    const nextSub = applyListingFeesToSubmission(sub, [...nextRows, ...held]);
    patch(
      ensureSubmissionListingFees({
        ...nextSub,
        removedStandardListingFeeRows: [...removed],
      }),
    );
    setRevealed((prev) => prev.filter((id) => id !== fee.id));
  };

  const scope = (fee: ListingFeeRow) => (
    <div className="mt-2 grid items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
      <span className="text-[11.5px] font-bold text-muted">Applies to</span>
      <CheckboxMultiSelect hideLabel label={`Lease types for ${fee.label || "this fee"}`} options={terms.map((t) => ({ value: t, label: t }))} selected={expandFeeScope(fee.leaseTypes, terms)} emptyLabel="No lease types" onChange={(next) => write(fee.id, { leaseTypes: narrowFeeScope(next, terms) })} />
      {rooms.length > 0 ? (
        <CheckboxMultiSelect hideLabel label={`Rooms for ${fee.label || "this fee"}`} options={rooms.map((r) => ({ value: r.id, label: r.name?.trim() || "Room" }))} selected={expandFeeScope(fee.roomIds, rooms.map((r) => r.id))} emptyLabel="No rooms" onChange={(next) => write(fee.id, { roomIds: narrowFeeScope(next, rooms.map((r) => r.id)) })} />
      ) : null}
    </div>
  );

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-border">
        {standard.length === 0 && custom.length === 0 ? <p className="px-4 py-3 text-[12.5px] text-muted">No fees beyond rent, the deposit and utilities.</p> : null}
        {standard.map((fee) => (
          <div key={fee.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="grid grid-cols-[minmax(0,1fr)_110px_140px_36px] items-center gap-2.5">
              <span className="min-w-0">
                <b className="block truncate text-[13.5px] font-bold text-foreground">{fee.label}</b>
                <span className="block text-[11.5px] text-muted">{listingFeeCadenceHint(listingFeeCadence(fee))}</span>
              </span>
              <Input
                aria-label={`${fee.label} amount`}
                value={moneyValue(fee.amount)}
                placeholder="0"
                onChange={(e) => write(fee.id, { amount: sanitizeMoneyInput(e.target.value) })}
              />
              <FeeCadenceSelect
                ariaLabel={`How often ${fee.label} is charged`}
                value={listingFeeCadence(fee)}
                onChange={(cadence) => write(fee.id, patchListingFeeCadence(cadence))}
              />
              <button
                type="button"
                aria-label={`Remove ${fee.label}`}
                onClick={() => removeStandardFee(fee)}
                className="justify-self-center text-[13px] text-muted hover:text-foreground"
              >
                ✕
              </button>
            </div>
            {scope(fee)}
            <FeeRefundOptions fee={fee} onChange={(next) => write(fee.id, next)} />
          </div>
        ))}
        {custom.map((fee) => (
          <div key={fee.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="grid grid-cols-[minmax(0,1fr)_110px_140px_36px] items-center gap-2.5">
              <Input aria-label="Fee name" value={fee.label} placeholder="Parking space" onChange={(e) => write(fee.id, { label: e.target.value })} />
              <Input aria-label={`${fee.label || "Fee"} amount`} value={moneyValue(fee.amount)} placeholder="0" onChange={(e) => write(fee.id, { amount: sanitizeMoneyInput(e.target.value) })} />
              <FeeCadenceSelect
                ariaLabel={`How often ${fee.label || "this fee"} is charged`}
                value={listingFeeCadence(fee)}
                onChange={(cadence) => write(fee.id, patchListingFeeCadence(cadence))}
              />
              <button type="button" aria-label={`Remove ${fee.label || "fee"}`} onClick={() => writeRows(rows.filter((f) => f.id !== fee.id))} className="justify-self-center text-[13px] text-muted hover:text-foreground">✕</button>
            </div>
            {scope(fee)}
            <FeeRefundOptions fee={fee} onChange={(next) => write(fee.id, next)} />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select aria-label="Add a fee" value="" className="max-w-[230px]" data-attr="listing-v2-add-fee" onChange={(e) => { const picked = e.target.value; if (!picked) return; if (picked === "__custom") writeRows([...rows, { ...emptyCustomFeeRow(), presetId: "custom" }]); else setRevealed((prev) => (prev.includes(picked) ? prev : [...prev, picked])); }}>
          <option value="">Add a fee…</option>
          {unusedStandard.map((fee) => (<option key={fee.id} value={fee.id}>{fee.label}</option>))}
          <option value="__custom">Something else…</option>
        </Select>
      </div>
      {seattle ? <p className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-[12px] leading-relaxed text-muted">{SEATTLE_RENT_RULE_NOTE}</p> : null}
    </>
  );
}

/* ─────────────────────── due at signing ─────────────────────── */

function DueAtSigning({ sub, patch, term }: { sub: ManagerListingSubmissionV1; patch: Patch; term: string }) {
  const rentByRoom = sub.listingPlaceCategoryId !== "entire_home";
  const allRows = useMemo(() => paymentAtSigningRows(sub, { includeRoomRent: rentByRoom }), [sub, rentByRoom]);
  const matrix = useMemo(() => paymentAtSigningMatrix(sub), [sub]);
  const leaseTerm = listingPricingTabToLeaseTerm(term);
  const rows = useMemo(
    () =>
      allRows.filter((row) => {
        if (row.kind === "fee" && row.scope) return feeAppliesToLeaseType(row.scope, leaseTerm);
        return true;
      }),
    [allRows, leaseTerm],
  );
  const selected = (matrix[leaseTerm] ?? []).filter((key) => rows.some((r) => r.key === key));
  const setCell = (key: string, on: boolean) => {
    const next = applyPaymentAtSigningCell(sub, leaseTerm, key, on);
    patch({ paymentAtSigningByLeaseType: next.paymentAtSigningByLeaseType, paymentAtSigningIncludes: next.paymentAtSigningIncludes, customFees: next.customFees });
  };
  return (
    <div className="max-w-[560px]">
      <CheckboxMultiSelect
        label={`Collected at signing on ${term.toLowerCase()}`}
        options={rows.map((r) => ({ value: r.key, label: r.label }))}
        selected={selected}
        emptyLabel="Nothing due at signing"
        onChange={(next) => {
          for (const row of rows) {
            const on = next.includes(row.key);
            if (on !== selected.includes(row.key)) setCell(row.key, on);
          }
        }}
      />
    </div>
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
  /** The listing's lease-type picker — the same dropdown a room's Leasing section shows. */
  leaseTypesField: React.ReactNode;
  /** Whole-place rent and the rails money arrives on. */
  payments: React.ReactNode;
  applications: React.ReactNode;
  /** Break-lease, holdover, quiet hours — what the lease document says. */
  leaseDocument: React.ReactNode;
  /** Keeps the receipt panel on the same lease type as the active pricing tab. */
  onActiveLeaseTermChange?: (leaseTerm: string) => void;
}) {
  const terms = useMemo(() => listingLeaseTypeScopeOptions(sub), [sub]);
  const tabs = useMemo(() => listingPricingLeaseTabs(sub), [sub]);
  const [tab, setTab] = useState<string | null>(null);
  const active = tab && tabs.includes(tab) ? tab : tabs[0] ?? LONG_TERM_LEASE_TERM;
  const activeLeaseTerm = listingPricingTabToLeaseTerm(active);
  useEffect(() => {
    onActiveLeaseTermChange?.(activeLeaseTerm);
  }, [activeLeaseTerm, onActiveLeaseTermChange]);
  const rooms = sub.rooms ?? [];
  // The deposit is a column of the table, never a chip beside it.
  const fees = useMemo(() => listingFeesForWizard(sub).filter((f) => f.presetId !== "security_deposit"), [sub]);
  const onRoom = (id: string, next: ManagerRoomSubmission) => patch({ rooms: rooms.map((r) => (r.id === id ? next : r)) });
  /** Every room row: write the default and move every room still following that field. */
  const onDefault = (field: ListingHouseDefaultField, value: string | number) => {
    const previous = defaults;
    const next = { ...defaults, [field]: value } as ListingHouseDefaults;
    setDefaults(next);
    patch({
      rooms: applyHouseDefaultsToRooms(rooms, next, {
        onlyFields: [field],
        previousDefaults: previous,
      }),
      houseDefaults: next,
    } as Partial<ManagerListingSubmissionV1>);
  };

  /** "Same as long-term" is true when no room has its own price on this term. */
  const sameAsLongTerm = (term: string) => !rooms.some((r) => r.termPricing?.[term] && Object.keys(r.termPricing[term]!).length > 0);
  const [showOwn, setShowOwn] = useState<Record<string, boolean>>({});
  const ownTable = (term: string) => showOwn[term] || !sameAsLongTerm(term);
  const stay = isStayLeaseTerm(activeLeaseTerm);

  return (
    <>
      <section className="mb-8">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">1 · Before move-in</h3>
        <p className="mb-3 text-[12.5px] text-muted">What an applicant pays to apply, and who covers card processing.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Long-term application fee">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-muted">$</span>
              <Input className="pl-6" inputMode="decimal" value={moneyValue(sub.applicationFee)} placeholder="50" onChange={(e) => patch({ applicationFee: sanitizeMoneyInput(e.target.value) })} />
            </div>
          </Field>
          <Field label="Short-term application fee" optional hint="Uses long-term when blank.">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-muted">$</span>
              <Input className="pl-6" inputMode="decimal" value={moneyValue(sub.shortTermApplicationFee ?? "")} placeholder={moneyValue(sub.applicationFee) || "50"} onChange={(e) => patch({ shortTermApplicationFee: sanitizeMoneyInput(e.target.value) })} />
            </div>
          </Field>
          <Field label="Waiver code" optional hint="Applicants who enter it apply for free.">
            <Input style={{ textTransform: "uppercase" }} value={sub.applicationFeeWaiverCode ?? ""} placeholder="WELCOME50" onChange={(e) => patch({ applicationFeeWaiverCode: e.target.value.toUpperCase().replace(/\s+/g, "") })} />
          </Field>
        </div>
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">2 · Each room</h3>
        <p className="mb-3 text-[12.5px] text-muted">Pick the leases you offer, then price each one. Grey follows the row above it; type in a cell and it becomes that room&apos;s own.</p>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div>{leaseTypesField}</div>
          {terms.includes(LONG_TERM_LEASE_TERM) ? (
            <Field label="Long-term minimum" hint="Applicants can't pick a lease shorter than this.">
              <Select value={String(sub.longTermMinimumMonths ?? 2)} onChange={(e) => patch({ longTermMinimumMonths: Number(e.target.value) || 2 })} data-attr="listing-v2-long-term-minimum">
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>{m} {m === 1 ? "month" : "months"}</option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>

        {tabs.length === 0 ? (
          <p className="rounded-xl border border-border bg-card px-4 py-3 text-[12.5px] text-muted">Choose at least one lease type, and its prices appear here.</p>
        ) : (
          <>
            <div className="mb-3 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
              {tabs.map((t) => {
                const pricingTerm = listingPricingTabToLeaseTerm(t);
                const missing = isStayLeaseTerm(pricingTerm)
                  ? rooms.some((r) => !moneyValue(r.shortTermRent) && !moneyValue(defaults.shortTermRent))
                  : isBase(pricingTerm) && rooms.some((r) => !(r.monthlyRent > 0));
                return (
                  <button key={t} type="button" role="tab" aria-selected={t === active} data-attr={`listing-v2-price-tab-${t}`} onClick={() => setTab(t)} className={cn("-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-[13.5px] font-bold transition", t === active ? "border-primary text-primary" : "border-transparent text-muted hover:text-foreground")}>
                    {t}
                    {missing ? <span className="h-[7px] w-[7px] rounded-full bg-[var(--status-pending-fg)]" aria-label="Some rooms have no price on this lease type" /> : null}
                  </button>
                );
              })}
            </div>

            {!stay && !isBase(activeLeaseTerm) ? (
              <label className="mb-3 flex cursor-pointer items-start gap-2.5 text-[13.5px]">
                <input
                  type="checkbox"
                  checked={!ownTable(activeLeaseTerm)}
                  data-attr={`listing-v2-same-as-long-term-${activeLeaseTerm}`}
                  onChange={(e) => {
                    if (e.target.checked) {
                      // Back to "same as long-term": clear every room's own price on this term.
                      patch({ rooms: rooms.map((r) => { const all = { ...(r.termPricing ?? {}) }; delete all[activeLeaseTerm]; return { ...r, termPricing: Object.keys(all).length > 0 ? all : undefined }; }) });
                      setShowOwn((prev) => ({ ...prev, [activeLeaseTerm]: false }));
                    } else {
                      setShowOwn((prev) => ({ ...prev, [activeLeaseTerm]: true }));
                    }
                  }}
                  className="mt-0.5 h-4 w-4 accent-[var(--pl-blue)]"
                />
                <span><b>Same as long-term</b> <span className="text-muted">— every room charges its long-term rent, utilities and deposit on {active.toLowerCase()}.</span></span>
              </label>
            ) : null}

            {stay ? (
              <StayTable sub={sub} defaults={defaults} onDefault={onDefault} onRoom={onRoom} />
            ) : (
              <div className={cn(!isBase(activeLeaseTerm) && !ownTable(activeLeaseTerm) && "pointer-events-none opacity-50")}>
                <MonthlyTable
                  sub={sub}
                  term={!isBase(activeLeaseTerm) && !ownTable(activeLeaseTerm) ? LONG_TERM_LEASE_TERM : activeLeaseTerm}
                  feeScopeTerm={activeLeaseTerm}
                  defaults={defaults}
                  onDefault={onDefault}
                  onRoom={onRoom}
                  fees={fees}
                  onJumpToFees={() => document.getElementById("listing-v2-fees")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                />
              </div>
            )}
            {stay ? <p className="mt-2 text-[12px] text-muted">That is all a short stay needs — the rate is all-in, so there is no utilities line and no monthly fees.</p> : null}
          </>
        )}

        <div id="listing-v2-fees" className="mt-6 scroll-mt-4">
          <h4 className="mb-1 text-[13px] font-bold text-foreground">Other fees</h4>
          <p className="mb-3 text-[12.5px] text-muted">What each fee costs, when it is charged, and which leases and rooms it reaches.</p>
          <FeesSection sub={sub} patch={patch} />
        </div>
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">3 · At signing</h3>
        <p className="mb-3 text-[12.5px] text-muted">What {active.toLowerCase()} collects before move-in. Anything left out is billed later. The panel on the right shows the total.</p>
        <DueAtSigning sub={sub} patch={patch} term={active} />
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">How you get paid</h3>
        {payments}
      </section>
      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">Applications</h3>
        {applications}
      </section>
      <section className="border-t border-border pt-6">{leaseDocument}</section>
    </>
  );
}
