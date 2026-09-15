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
import { Input, Select } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { CellResetButton, ColumnHelp, DefaultsPanel, EditorDone, Field, PanelField, RowMoreButton, SameAsAllTag, SameAsAllToggle } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ManagerApplicationFeeWaiverCodesModal } from "@/components/portal/pro-application-fee-waiver-codes-modal";
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

const MONTHLY_COLUMNS = "22px minmax(128px,1.2fr) 110px 110px 110px 56px";
const STAY_COLUMNS = "22px minmax(128px,1.2fr) 110px 110px 130px 56px";

const PRICING_MODE_OPTIONS = [
  { value: "fixed", label: "Fixed" },
  { value: "flexible", label: "Flexible" },
] as const;

const cell = (inherited: boolean, zero = false) =>
  cn(
    "min-h-[36px] w-full rounded-lg border bg-card px-2 py-1 text-[13px] text-foreground outline-none focus:border-primary",
    inherited ? "border-dashed border-border text-muted" : "border-border",
    /* An explicit $0 reads as deliberate, not as an empty box someone forgot. */
    !inherited && zero ? "border-primary font-semibold text-primary" : "",
  );

/**
 * A money cell: `$` prefix, inherited shows the value as a placeholder in an
 * empty box. With `onReset`, a cell holding its own number carries the ↺ that
 * empties just this field so it follows the row above again.
 */
function MoneyCell({
  value,
  inherited,
  own,
  placeholder,
  label,
  onChange,
  onReset,
  resetLabel,
}: {
  value: string;
  inherited: boolean;
  own: boolean;
  placeholder: string;
  label: string;
  onChange: (raw: string) => void;
  onReset?: () => void;
  resetLabel?: string;
}) {
  const showReset = Boolean(onReset) && !inherited;
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
        className={cn(cell(inherited, num(value) === 0 && moneyFilled(value)), "pl-5 tabular-nums", showReset && "pr-8")}
        title={!inherited && moneyFilled(value) && num(value) === 0 ? "No charge — set deliberately, not inherited" : undefined}
      />
      {own ? <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-white bg-primary" /> : null}
      {showReset ? <CellResetButton label={resetLabel ?? `Reset ${label} to the row above`} onClick={onReset!} className="right-2" /> : null}
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

/* ─────────────────────── the room table ─────────────────────── */

const PRICE_COLUMN_HELP = {
  room: "The same rooms as the Rooms step. Rent is typed here and shown there.",
  rent: "Base monthly rent for this room, before utilities and fees.",
  util: "A flat monthly utilities estimate, billed with rent. Blank means included.",
  dep: "Security deposit, collected at signing.",
  all: "Set once. Every room ticked “Same as all rooms” copies this. Month-to-Month and Short-term start as “same as Long-term”.",
} as const;

const PRICE_EDITOR = "grid gap-x-6 gap-y-4 border-t border-border bg-card px-5 py-4 pl-12 sm:grid-cols-2";

/**
 * The add-on fees on ONE room: name · amount · when · ✕, and + Add a fee.
 *
 * A fee scoped to exactly this room is edited here; a fee the house charges
 * on every room is shown so the manager sees the whole picture, but is edited
 * where it lives. Both are the same fee records the house-level table stores.
 */
function RoomFeesEditor({ sub, patch, room, term }: { sub: ManagerListingSubmissionV1; patch: Patch; room: ManagerRoomSubmission; term: string }) {
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
    <div className="sm:col-span-2">
      <Field label="Other fees on this room" group>
        <div className="grid gap-1.5" data-attr="listing-v2-room-fees">
          {mine.length > 0 ? (
            <div className="grid grid-cols-[minmax(0,1.4fr)_110px_130px_26px] gap-1.5 text-[10.5px] font-extrabold uppercase tracking-wide text-muted">
              <span>Fee</span><span>Amount</span><span>When</span><span />
            </div>
          ) : null}
          {mine.map((fee) => (
            <div key={fee.id} className="grid grid-cols-[minmax(0,1.4fr)_110px_130px_26px] items-center gap-1.5">
              <Input aria-label="Fee name" value={fee.label} placeholder="Parking" onChange={(e) => write(fee.id, { label: e.target.value })} />
              <Input aria-label={`${fee.label || "Fee"} amount`} inputMode="decimal" value={moneyValue(fee.amount)} placeholder="0" onChange={(e) => write(fee.id, { amount: sanitizeMoneyInput(e.target.value) })} />
              <FeeCadenceSelect ariaLabel={`How often ${fee.label || "this fee"} is charged`} value={listingFeeCadence(fee)} onChange={(cadence) => write(fee.id, patchListingFeeCadence(cadence))} />
              <button type="button" aria-label={`Remove ${fee.label || "fee"}`} onClick={() => writeRows(rows.filter((f) => f.id !== fee.id))} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground">✕</button>
            </div>
          ))}
          {shared.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {shared.map((f) => (
                <span key={f.id} className="rounded-full border border-border bg-[var(--pl-surface-muted)] px-2 py-0.5 text-[11.5px] text-muted">
                  {f.label} {usd(num(f.amount ?? ""))}{cad(f)} · all rooms
                </span>
              ))}
            </span>
          ) : null}
          <button
            type="button"
            data-attr="listing-v2-room-fee-add"
            onClick={() => writeRows([...rows, { ...emptyCustomFeeRow(), presetId: "custom", roomIds: [room.id] }])}
            className="justify-self-start text-[12.5px] font-bold text-primary hover:underline"
          >
            + Add a fee
          </button>
        </div>
      </Field>
    </div>
  );
}

function MonthlyTable({
  sub,
  patch,
  term,
  feeScopeTerm,
  defaults,
  onDefault,
  onRoom,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  term: string;
  /** Lease tab this table is on — a room's fees respect Applies-to even when rent follows long-term. */
  feeScopeTerm: string;
  defaults: ListingHouseDefaults;
  onDefault: (field: ListingHouseDefaultField, value: string | number) => void;
  onRoom: (id: string, next: ManagerRoomSubmission) => void;
}) {
  const rooms = sub.rooms ?? [];
  const base = isBase(term);
  const [open, setOpen] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((prev) => (prev === id ? null : id));
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
  const untouch = (id: string) =>
    setUnticked((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  /** Tick: every number on this tab follows the panel again. Untick: nothing moves; the row is its own now. */
  const setSameAsAll = (room: ManagerRoomSubmission, same: boolean) => {
    if (!same) {
      // Freeze what the row shows now as the room's own numbers on this tab.
      setUnticked((prev) => new Set(prev).add(room.id));
      const v = values(room);
      if (base) onRoom(room.id, { ...room, monthlyRent: num(v.rent.text), utilitiesEstimate: moneyValue(v.util.text), securityDeposit: moneyValue(v.dep.text) });
      else onRoom(room.id, writeTerm(writeTerm(writeTerm(room, term, "monthlyRent", v.rent.text), term, "utilitiesEstimate", moneyValue(v.util.text)), term, "securityDeposit", moneyValue(v.dep.text)));
      return;
    }
    untouch(room.id);
    if (base) {
      onRoom(room.id, { ...resetRoomField(resetRoomField(resetRoomField(room, "monthlyRent"), "utilitiesEstimate"), "securityDeposit"), pricingMode: undefined });
    } else {
      const all = { ...(room.termPricing ?? {}) };
      delete all[term];
      onRoom(room.id, { ...room, termPricing: Object.keys(all).length > 0 ? all : undefined });
    }
  };
  const resetAll = () => {
    setUnticked(new Set());
    rooms.forEach((room) => setSameAsAll(room, true));
  };
  const own = (room: ManagerRoomSubmission, field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit") => {
    const v = values(room);
    return field === "monthlyRent" ? v.rent.src === "own" : field === "utilitiesEstimate" ? v.util.src === "own" : v.dep.src === "own";
  };
  const resetOne = (room: ManagerRoomSubmission, field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit") =>
    onRoom(room.id, base ? resetRoomField(room, field) : writeTerm(room, term, field, ""));
  const writeField = (room: ManagerRoomSubmission, field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit", v: string) => {
    untouch(room.id);
    if (base) onRoom(room.id, field === "monthlyRent" ? { ...room, monthlyRent: num(v) } : field === "utilitiesEstimate" ? { ...room, utilitiesEstimate: v } : { ...room, securityDeposit: v });
    else onRoom(room.id, writeTerm(room, term, field, v));
  };
  const money = (room: ManagerRoomSubmission, field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit", label: string) => {
    const v = values(room);
    const cellv = field === "monthlyRent" ? v.rent : field === "utilitiesEstimate" ? v.util : v.dep;
    const ph = field === "monthlyRent" ? "1,100" : field === "utilitiesEstimate" ? "150" : "1,000";
    const word = field === "monthlyRent" ? "rent" : field === "utilitiesEstimate" ? "utilities" : "deposit";
    const name = room.name.trim() || "this room";
    return (
      <MoneyCell
        label={label}
        value={field === "monthlyRent" ? cellv.text : moneyValue(cellv.text)}
        inherited={cellv.src !== "own"}
        own={cellv.src === "own"}
        placeholder={(field === "monthlyRent" ? cellv.text : moneyValue(cellv.text)) || ph}
        onChange={(next) => writeField(room, field, next)}
        onReset={() => resetOne(room, field)}
        resetLabel={`Reset ${word} for ${name} (${term}) to the panel`}
      />
    );
  };
  const tag = (room: ManagerRoomSubmission, field: "monthlyRent" | "utilitiesEstimate" | "securityDeposit") => (
    <SameAsAllTag own={own(room, field)} plural="rooms" noun="room" onReset={() => resetOne(room, field)} />
  );
  return (
    <>
      <DefaultsPanel
        title="All rooms"
        help={PRICE_COLUMN_HELP.all}
        open={open === "defaults"}
        onToggle={() => toggle("defaults")}
        dataAttr="listing-v2-price-defaults"
        resetAll={rooms.length > 0 ? { disabled: !rooms.some((r) => !sameAsAll(r)), onClick: resetAll, dataAttr: "listing-v2-price-reset-all" } : undefined}
        editor={
          <div className={cn(PRICE_EDITOR, "mt-3 rounded-xl border pl-5")} data-attr="listing-v2-price-defaults-editor">
            {base ? (
              <Field label="Listed rent">
                <Select value={defaults.pricingMode || "fixed"} onChange={(e) => onDefault("pricingMode", e.target.value)}>
                  {PRICING_MODE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </Field>
            ) : (
              <p className="text-[12.5px] text-muted sm:col-span-2">Follows long-term.</p>
            )}
            <EditorDone onClick={() => setOpen(null)} dataAttr="listing-v2-price-defaults-done" />
          </div>
        }
      >
        <PanelField label="Rent /mo" help={PRICE_COLUMN_HELP.rent}>
          {base ? (
            <MoneyCell label="Rent for every room" value={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : ""} inherited={false} own={false} placeholder="1,100" onChange={(v) => onDefault("monthlyRent", num(v))} />
          ) : (
            <span className={cell(true)}>{defaults.monthlyRent > 0 ? usd(defaults.monthlyRent) : "—"}</span>
          )}
        </PanelField>
        <PanelField label="Utilities /mo" help={PRICE_COLUMN_HELP.util}>
          {base ? (
            <MoneyCell label="Utilities for every room" value={moneyValue(defaults.utilitiesEstimate)} inherited={false} own={false} placeholder="150" onChange={(v) => onDefault("utilitiesEstimate", v)} />
          ) : (
            <span className={cell(true)}>{moneyValue(defaults.utilitiesEstimate) ? usd(num(defaults.utilitiesEstimate)) : "—"}</span>
          )}
        </PanelField>
        <PanelField label="Deposit" help={PRICE_COLUMN_HELP.dep}>
          {base ? (
            <MoneyCell label="Deposit for every room" value={moneyValue(defaults.securityDeposit)} inherited={false} own={false} placeholder="1,000" onChange={(v) => onDefault("securityDeposit", v)} />
          ) : (
            <span className={cell(true)}>{moneyValue(defaults.securityDeposit) ? usd(num(defaults.securityDeposit)) : "—"}</span>
          )}
        </PanelField>
      </DefaultsPanel>

      <div className="overflow-x-auto rounded-2xl border border-border">
        <div className="min-w-[560px]">
          <div className="grid items-center gap-2 border-b border-border bg-accent/25 px-3 py-2 text-[10.5px] font-extrabold uppercase tracking-wide text-muted" style={{ gridTemplateColumns: MONTHLY_COLUMNS }}>
            <span />
            <span className="flex items-center gap-1">Room <ColumnHelp title="Room" text={PRICE_COLUMN_HELP.room} /></span>
            <span className="flex items-center gap-1">Rent /mo <ColumnHelp title="Rent /mo" text={PRICE_COLUMN_HELP.rent} /></span>
            <span className="flex items-center gap-1">Utilities /mo <ColumnHelp title="Utilities /mo" text={PRICE_COLUMN_HELP.util} /></span>
            <span className="flex items-center gap-1">Deposit <ColumnHelp title="Deposit" text={PRICE_COLUMN_HELP.dep} /></span>
            <span />
          </div>
          {rooms.map((room, i) => {
            const name = room.name.trim() || `Room ${i + 1}`;
            const isOpen = open === room.id;
            const v = values(room);
            return (
              <div key={room.id} className={cn("border-b border-border last:border-b-0", isOpen && "shadow-[inset_3px_0_0_var(--pl-blue)]")}>
                <div className={cn("grid items-center gap-2 px-3 py-2", isOpen && "bg-accent/20")} style={{ gridTemplateColumns: MONTHLY_COLUMNS }} data-attr="listing-v2-price-row">
                  <button type="button" onClick={() => toggle(room.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Open"} ${name}`} className={cn("grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground", isOpen && "text-primary")}>
                    <span aria-hidden className={cn("inline-block transition-transform", isOpen && "rotate-90")}>›</span>
                  </button>
                  <span className="min-w-0 leading-tight">
                    <b className="block truncate text-[13.5px] font-bold text-foreground">{name}</b>
                    <SameAsAllToggle same={sameAsAll(room)} plural="rooms" noun="room" onChange={(next) => setSameAsAll(room, next)} onReset={() => setSameAsAll(room, true)} dataAttr="listing-v2-price-same-as-all" />
                  </span>
                  {money(room, "monthlyRent", `${name} rent on ${term}`)}
                  {money(room, "utilitiesEstimate", `${name} utilities on ${term}`)}
                  {money(room, "securityDeposit", `${name} deposit on ${term}`)}
                  <RowMoreButton open={isOpen} onClick={() => toggle(room.id)} label={name} dataAttr="listing-v2-price-more" />
                </div>
                {isOpen ? (
                  <div className={PRICE_EDITOR} data-attr="listing-v2-price-editor">
                    <Field label="Rent per month" labelAside={tag(room, "monthlyRent")}>{money(room, "monthlyRent", `${name} rent per month`)}</Field>
                    <Field label="Utilities per month" labelAside={tag(room, "utilitiesEstimate")}>{money(room, "utilitiesEstimate", `${name} utilities per month`)}</Field>
                    <Field label="Security deposit" labelAside={tag(room, "securityDeposit")}>{money(room, "securityDeposit", `${name} security deposit`)}</Field>
                    <Field label="Listed rent" labelAside={base ? <SameAsAllTag own={v.modeOwn} plural="rooms" noun="room" onReset={() => onRoom(room.id, { ...room, pricingMode: undefined })} /> : undefined}>
                      <Select value={room.pricingMode ?? defaults.pricingMode ?? "fixed"} disabled={!base} onChange={(e) => onRoom(room.id, { ...room, pricingMode: e.target.value as ManagerRoomSubmission["pricingMode"] })}>
                        {PRICING_MODE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </Select>
                    </Field>
                    <RoomFeesEditor sub={sub} patch={patch} room={room} term={feeScopeTerm} />
                    <EditorDone onClick={() => setOpen(null)} dataAttr="listing-v2-price-done" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </>
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
  const [open, setOpen] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((prev) => (prev === id ? null : id));
  const inh = (room: ManagerRoomSubmission) => ({
    day: roomInheritsDefault(room, defaults, "shortTermRent"),
    week: roomInheritsDefault(room, defaults, "weeklyRentPrice"),
    dep: roomInheritsDefault(room, defaults, "shortTermDeposit"),
  });
  const sameAsAll = (room: ManagerRoomSubmission) => {
    const v = inh(room);
    return !unticked.has(room.id) && v.day && v.week && v.dep;
  };
  const untouch = (id: string) =>
    setUnticked((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const setSameAsAll = (room: ManagerRoomSubmission, same: boolean) => {
    if (!same) {
      // Freeze what the row shows now as the room's own rates.
      setUnticked((prev) => new Set(prev).add(room.id));
      onRoom(room.id, {
        ...room,
        shortTermRent: moneyValue(room.shortTermRent) || moneyValue(defaults.shortTermRent),
        weeklyRentPrice: room.weeklyRentPrice || defaults.weeklyRentPrice || undefined,
        shortTermDeposit: moneyValue(room.shortTermDeposit) || moneyValue(defaults.shortTermDeposit),
      });
      return;
    }
    untouch(room.id);
    onRoom(room.id, { ...room, shortTermRent: "", weeklyRentPrice: undefined, shortTermDeposit: "" });
  };
  const money = (room: ManagerRoomSubmission, field: "shortTermRent" | "weeklyRentPrice" | "shortTermDeposit", label: string) => {
    const v = inh(room);
    const inherited = field === "shortTermRent" ? v.day : field === "weeklyRentPrice" ? v.week : v.dep;
    const value = field === "weeklyRentPrice" ? (room.weeklyRentPrice ? String(room.weeklyRentPrice) : "") : moneyValue(room[field]);
    const ph = field === "shortTermRent" ? moneyValue(defaults.shortTermRent) || "65" : field === "weeklyRentPrice" ? (defaults.weeklyRentPrice > 0 ? String(defaults.weeklyRentPrice) : "395") : moneyValue(defaults.shortTermDeposit) || "500";
    return (
      <MoneyCell
        label={label}
        value={value}
        inherited={inherited}
        own={!inherited}
        placeholder={ph}
        onChange={(next) => {
          untouch(room.id);
          onRoom(room.id, field === "weeklyRentPrice" ? { ...room, weeklyRentPrice: num(next) || undefined } : { ...room, [field]: next });
        }}
        onReset={() => onRoom(room.id, field === "weeklyRentPrice" ? { ...room, weeklyRentPrice: undefined } : { ...room, [field]: "" })}
        resetLabel={`Reset ${label} to the panel`}
      />
    );
  };
  const tag = (room: ManagerRoomSubmission, field: "shortTermRent" | "weeklyRentPrice" | "shortTermDeposit") => {
    const v = inh(room);
    const inherited = field === "shortTermRent" ? v.day : field === "weeklyRentPrice" ? v.week : v.dep;
    return <SameAsAllTag own={!inherited} plural="rooms" noun="room" onReset={() => onRoom(room.id, field === "weeklyRentPrice" ? { ...room, weeklyRentPrice: undefined } : { ...room, [field]: "" })} />;
  };
  return (
    <>
      <DefaultsPanel
        title="All rooms"
        help={PRICE_COLUMN_HELP.all}
        open={open === "defaults"}
        onToggle={() => toggle("defaults")}
        dataAttr="listing-v2-stay-defaults"
        resetAll={rooms.length > 0 ? { disabled: !rooms.some((r) => !sameAsAll(r)), onClick: () => { setUnticked(new Set()); rooms.forEach((r) => setSameAsAll(r, true)); }, dataAttr: "listing-v2-stay-reset-all" } : undefined}
        editor={
          <div className={cn(PRICE_EDITOR, "mt-3 rounded-xl border pl-5")} data-attr="listing-v2-stay-defaults-editor">
            <p className="text-[12.5px] text-muted sm:col-span-2">All-in rates, utilities included.</p>
            <EditorDone onClick={() => setOpen(null)} dataAttr="listing-v2-stay-defaults-done" />
          </div>
        }
      >
        <PanelField label="Rent /day">
          <MoneyCell label="Rent per day for every room" value={moneyValue(defaults.shortTermRent)} inherited={false} own={false} placeholder="65" onChange={(v) => onDefault("shortTermRent", v)} />
        </PanelField>
        <PanelField label="Rent /week">
          <MoneyCell label="Rent per week for every room" value={defaults.weeklyRentPrice > 0 ? String(defaults.weeklyRentPrice) : ""} inherited={false} own={false} placeholder="395" onChange={(v) => onDefault("weeklyRentPrice", num(v))} />
        </PanelField>
        <PanelField label="Deposit for a stay">
          <MoneyCell label="Deposit for a stay, every room" value={moneyValue(defaults.shortTermDeposit)} inherited={false} own={false} placeholder="500" onChange={(v) => onDefault("shortTermDeposit", v)} />
        </PanelField>
      </DefaultsPanel>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <div className="min-w-[560px]">
          <div className="grid items-center gap-2 border-b border-border bg-accent/25 px-3 py-2 text-[10.5px] font-extrabold uppercase tracking-wide text-muted" style={{ gridTemplateColumns: STAY_COLUMNS }}>
            <span /><span>Room</span><span>Rent /day</span><span>Rent /week</span><span>Deposit for a stay</span><span />
          </div>
          {rooms.map((room, i) => {
            const name = room.name.trim() || `Room ${i + 1}`;
            const isOpen = open === room.id;
            return (
              <div key={room.id} className={cn("border-b border-border last:border-b-0", isOpen && "shadow-[inset_3px_0_0_var(--pl-blue)]")}>
                <div className={cn("grid items-center gap-2 px-3 py-2", isOpen && "bg-accent/20")} style={{ gridTemplateColumns: STAY_COLUMNS }} data-attr="listing-v2-stay-row">
                  <button type="button" onClick={() => toggle(room.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Open"} ${name}`} className={cn("grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground", isOpen && "text-primary")}>
                    <span aria-hidden className={cn("inline-block transition-transform", isOpen && "rotate-90")}>›</span>
                  </button>
                  <span className="min-w-0 leading-tight">
                    <b className="block truncate text-[13.5px] font-bold text-foreground">{name}</b>
                    <SameAsAllToggle same={sameAsAll(room)} plural="rooms" noun="room" onChange={(next) => setSameAsAll(room, next)} onReset={() => setSameAsAll(room, true)} dataAttr="listing-v2-stay-same-as-all" />
                  </span>
                  {money(room, "shortTermRent", `${name} rent per day`)}
                  {money(room, "weeklyRentPrice", `${name} rent per week`)}
                  {money(room, "shortTermDeposit", `${name} deposit for a stay`)}
                  <RowMoreButton open={isOpen} onClick={() => toggle(room.id)} label={name} dataAttr="listing-v2-stay-more" />
                </div>
                {isOpen ? (
                  <div className={PRICE_EDITOR} data-attr="listing-v2-stay-editor">
                    <Field label="Rent per day" labelAside={tag(room, "shortTermRent")}>{money(room, "shortTermRent", `${name} rent per day (editor)`)}</Field>
                    <Field label="Rent per week" labelAside={tag(room, "weeklyRentPrice")}>{money(room, "weeklyRentPrice", `${name} rent per week (editor)`)}</Field>
                    <Field label="Deposit for a stay" labelAside={tag(room, "shortTermDeposit")}>{money(room, "shortTermDeposit", `${name} deposit for a stay (editor)`)}</Field>
                    <EditorDone onClick={() => setOpen(null)} dataAttr="listing-v2-stay-done" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </>
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
  const [waiverCodesOpen, setWaiverCodesOpen] = useState(false);
  const [showOwn, setShowOwn] = useState<Record<string, boolean>>({});
  const ownTable = (term: string) => showOwn[term] || !sameAsLongTerm(term);
  const stay = isStayLeaseTerm(activeLeaseTerm);

  return (
    <>
      <section className="mb-8">
        <h3 className="mb-3 text-[14px] font-bold text-foreground">1 · How you get paid</h3>
        {payments}
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-3 text-[14px] font-bold text-foreground">2 · Applications</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Long-term application fee">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-muted">$</span>
              <Input className="pl-6" inputMode="decimal" value={moneyValue(sub.applicationFee)} placeholder="50" onChange={(e) => patch({ applicationFee: sanitizeMoneyInput(e.target.value) })} />
            </div>
          </Field>
          <Field label="Short-term application fee" optional>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-muted">$</span>
              <Input className="pl-6" inputMode="decimal" value={moneyValue(sub.shortTermApplicationFee ?? "")} placeholder={moneyValue(sub.applicationFee) || "50"} onChange={(e) => patch({ shortTermApplicationFee: sanitizeMoneyInput(e.target.value) })} />
            </div>
          </Field>
          <Field label="Waiver code" optional>
            <Input style={{ textTransform: "uppercase" }} value={sub.applicationFeeWaiverCode ?? ""} placeholder="WELCOME50" onChange={(e) => patch({ applicationFeeWaiverCode: e.target.value.toUpperCase().replace(/\s+/g, "") })} />
            {/* The multi-code system (usage caps, expiry, revoke, redemption log)
                already existed and was never mounted anywhere — this is its only
                way in. The single field above stays: it is the quick one-code
                case, and every listing saved before this still reads from it. */}
            <button
              type="button"
              data-attr="listing-v2-manage-waiver-codes"
              onClick={() => setWaiverCodesOpen(true)}
              className="mt-1 text-[12px] font-bold text-primary hover:underline"
            >
              Manage codes
            </button>
          </Field>
        </div>
        <div className="mt-4">{applications}</div>
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-3 text-[14px] font-bold text-foreground">3 · Each room</h3>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div>{leaseTypesField}</div>
          {terms.includes(LONG_TERM_LEASE_TERM) ? (
            <Field label="Long-term minimum">
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
                <span><b>Same as long-term</b></span>
              </label>
            ) : null}

            {stay ? (
              <StayTable sub={sub} defaults={defaults} onDefault={onDefault} onRoom={onRoom} />
            ) : (
              <div className={cn(!isBase(activeLeaseTerm) && !ownTable(activeLeaseTerm) && "pointer-events-none opacity-50")}>
                <MonthlyTable
                  sub={sub}
                  patch={patch}
                  term={!isBase(activeLeaseTerm) && !ownTable(activeLeaseTerm) ? LONG_TERM_LEASE_TERM : activeLeaseTerm}
                  feeScopeTerm={activeLeaseTerm}
                  defaults={defaults}
                  onDefault={onDefault}
                  onRoom={onRoom}
                />
              </div>
            )}
          </>
        )}

        <div id="listing-v2-fees" className="mt-6 scroll-mt-4">
          <h4 className="mb-3 text-[13px] font-bold text-foreground">Other fees</h4>
          <FeesSection sub={sub} patch={patch} />
        </div>
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-3 text-[14px] font-bold text-foreground">4 · At signing</h3>
        <DueAtSigning sub={sub} patch={patch} term={active} />
      </section>

      <section className="border-t border-border pt-6">{leaseDocument}</section>

      {/* Mounted only while open: the modal reads `useAppUi` at its top level, so
          rendering it unconditionally drags a provider requirement into every
          tree that renders Pricing — which is a dependency this screen does not
          otherwise have. */}
      {waiverCodesOpen ? (
        <ManagerApplicationFeeWaiverCodesModal open onClose={() => setWaiverCodesOpen(false)} />
      ) : null}
    </>
  );
}
