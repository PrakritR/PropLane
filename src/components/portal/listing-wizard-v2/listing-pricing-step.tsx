"use client";

/**
 * Pricing: every room's price on every lease type, the fees, and what is
 * collected before move-in — on one screen, beside the receipt.
 *
 * It replaces nothing in the data model. Three stores already existed and this
 * is the first surface that shows all three together:
 *
 * - a room's long-term rent is `room.monthlyRent`, and its price on any OTHER
 *   lease type is `room.termPricing[term]`, where ABSENT means "same as
 *   long-term" (PRP-463). The table renders an inherited value greyed, and only
 *   writes an entry when the manager types a different number — so a room can
 *   never end up holding three copies of one rent that then drift apart;
 * - a fee's reach is `leaseTypes` / `roomIds`, where absent means EVERY one, so
 *   "all rooms" is never persisted as a snapshot of today's rooms;
 * - what is collected up front is the per-lease-type signing matrix, written
 *   through the one shared helper the receipt panel also writes through.
 */

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Field } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import {
  expandFeeScope,
  listingLeaseTypeScopeOptions,
  narrowFeeScope,
  paymentAtSigningRows,
  paymentAtSigningMatrix,
} from "@/lib/listing-fee-scope";
import {
  applyListingFeesToSubmission,
  isListingFeeAmountFilled,
  applyPaymentAtSigningCell,
  listingFeeCadence,
  listingFeesForWizard,
  type ListingFeeRow,
} from "@/lib/listing-fees";
import { SEATTLE_RENT_RULE_NOTE, listingFoldsAllMonthlyFeesIntoRent } from "@/lib/seattle-rent-rule";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { isStayLeaseTerm } from "@/lib/listing-quote";
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

/* ─────────────────────── per-term room prices ─────────────────────── */

/** Is `term` the one a room's own fields hold, rather than an override? */
function isBaseTerm(term: string): boolean {
  return term === LONG_TERM_LEASE_TERM;
}

/** The rent this room charges on `term`, and whether that number is its own. */
function rentForTerm(room: ManagerRoomSubmission, term: string): { value: number; inherited: boolean } {
  if (isBaseTerm(term)) return { value: room.monthlyRent || 0, inherited: false };
  const own = room.termPricing?.[term]?.monthlyRent;
  if (typeof own === "number" && Number.isFinite(own)) return { value: own, inherited: false };
  return { value: room.monthlyRent || 0, inherited: true };
}

function depositForTerm(
  room: ManagerRoomSubmission,
  term: string,
  sub: ManagerListingSubmissionV1,
): { value: string; inherited: boolean } {
  if (!isBaseTerm(term)) {
    const own = room.termPricing?.[term]?.securityDeposit;
    if ((own ?? "").trim()) return { value: own ?? "", inherited: false };
  }
  if ((room.securityDeposit ?? "").trim()) return { value: room.securityDeposit ?? "", inherited: !isBaseTerm(term) };
  return { value: sub.securityDeposit ?? "", inherited: true };
}

function utilitiesForTerm(room: ManagerRoomSubmission, term: string): { value: string; inherited: boolean } {
  if (!isBaseTerm(term)) {
    const own = room.termPricing?.[term]?.utilitiesEstimate;
    if ((own ?? "").trim()) return { value: own ?? "", inherited: false };
  }
  return { value: room.utilitiesEstimate ?? "", inherited: !isBaseTerm(term) };
}

/**
 * Write one per-term field, dropping the entry when it matches long-term again.
 *
 * Storing an override equal to the base is how a room quietly acquires three
 * copies of one rent; clearing it back to `undefined` is what "same as
 * long-term" has always meant on the wire.
 */
function writeTermPrice(
  room: ManagerRoomSubmission,
  term: string,
  field: "monthlyRent" | "securityDeposit" | "utilitiesEstimate",
  value: number | string | undefined,
): ManagerRoomSubmission {
  const current = { ...(room.termPricing ?? {}) };
  const entry = { ...(current[term] ?? {}) };
  const empty = value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value));
  if (empty) delete entry[field];
  else if (field === "monthlyRent") entry.monthlyRent = value as number;
  else entry[field] = String(value);
  if (Object.keys(entry).length === 0) delete current[term];
  else current[term] = entry;
  return { ...room, termPricing: Object.keys(current).length > 0 ? current : undefined };
}

/* ─────────────────────── the rent table ─────────────────────── */

function RoomPriceRow({
  room,
  term,
  sub,
  onRoom,
  open,
  onToggle,
}: {
  room: ManagerRoomSubmission;
  term: string;
  sub: ManagerListingSubmissionV1;
  onRoom: (next: ManagerRoomSubmission) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const stay = isStayLeaseTerm(term);
  const rent = rentForTerm(room, term);
  const deposit = depositForTerm(room, term, sub);
  const utilities = utilitiesForTerm(room, term);
  const name = room.name?.trim() || "Room";

  const setRent = (raw: string) => {
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    const value = Number.isFinite(n) && raw.trim() !== "" ? n : undefined;
    if (isBaseTerm(term)) onRoom({ ...room, monthlyRent: value ?? 0 });
    else onRoom(writeTermPrice(room, term, "monthlyRent", value));
  };

  return (
    <div className={cn("border-b border-border last:border-b-0", open && "bg-accent/25 shadow-[inset_3px_0_0_var(--pl-blue)]")}>
      <div className="grid grid-cols-[20px_minmax(0,1.2fr)_120px_minmax(0,0.8fr)_minmax(0,0.9fr)] items-center gap-2.5 px-3.5 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Close" : "Open"} pricing for ${name}`}
          className="grid h-6 w-6 place-items-center text-muted hover:text-foreground"
        >
          <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90 text-primary")} aria-hidden />
        </button>
        <span className="min-w-0">
          <b className="block truncate text-[13.5px] font-bold text-foreground">{name}</b>
          <span className="block truncate text-[11.5px] text-muted">
            {[room.floor?.trim(), room.bedCount ? `${room.bedCount} ${room.bedCount === 1 ? "bed" : "beds"}` : ""]
              .filter(Boolean)
              .join(", ")}
          </span>
        </span>
        {stay ? (
          <Input
            aria-label={`${name} rate per night`}
            value={moneyValue(room.shortTermRent)}
            placeholder="65"
            onChange={(e) => onRoom({ ...room, shortTermRent: sanitizeMoneyInput(e.target.value) })}
          />
        ) : (
          <Input
            aria-label={`${name} monthly rent on ${term}`}
            /* Inherited shows as a PLACEHOLDER, not a value: the box is genuinely
               empty until the manager gives this term its own price, which is
               exactly what an absent termPricing entry means. */
            value={rent.inherited ? "" : rent.value > 0 ? String(rent.value) : ""}
            placeholder={rent.value > 0 ? String(rent.value) : "1,100"}
            onChange={(e) => setRent(e.target.value)}
          />
        )}
        <span className={cn("text-[13px] tabular-nums", deposit.inherited ? "text-muted" : "text-foreground")}>
          {moneyValue(deposit.value) ? usd(Number(deposit.value.replace(/[^0-9.]/g, ""))) : "—"}
        </span>
        <span className={cn("text-[13px]", utilities.inherited ? "text-muted" : "text-foreground")}>
          {moneyValue(utilities.value)
            ? `${usd(Number(utilities.value.replace(/[^0-9.]/g, "")))}/mo`
            : stay
              ? "Included in the rate"
              : "—"}
        </span>
      </div>
      {open ? (
        <div className="grid gap-4 border-t border-border px-3.5 py-4 pl-11 sm:grid-cols-2">
          <Field
            label="Security deposit"
            hint={deposit.inherited ? "Following the listing. Type here to give this room its own." : undefined}
          >
            <Input
              value={deposit.inherited ? "" : moneyValue(deposit.value)}
              placeholder={moneyValue(deposit.value) || "1,100"}
              onChange={(e) => {
                const next = sanitizeMoneyInput(e.target.value);
                if (isBaseTerm(term)) onRoom({ ...room, securityDeposit: next });
                else onRoom(writeTermPrice(room, term, "securityDeposit", next));
              }}
            />
          </Field>
          {stay ? (
            <Field label="Deposit for a stay" optional>
              <Input
                value={moneyValue(room.shortTermDeposit)}
                onChange={(e) => onRoom({ ...room, shortTermDeposit: sanitizeMoneyInput(e.target.value) })}
              />
            </Field>
          ) : (
            <Field
              label="Utilities / month"
              optional
              hint={utilities.inherited ? "Following long-term." : undefined}
            >
              <Input
                value={utilities.inherited ? "" : moneyValue(utilities.value)}
                placeholder={moneyValue(utilities.value) || "80"}
                onChange={(e) => {
                  const next = sanitizeMoneyInput(e.target.value);
                  if (isBaseTerm(term)) onRoom({ ...room, utilitiesEstimate: next });
                  else onRoom(writeTermPrice(room, term, "utilitiesEstimate", next));
                }}
              />
            </Field>
          )}
          {stay ? (
            <Field label="Rate per week" optional hint="A week is a real rate, not seven nights.">
              <Input
                value={room.weeklyRentPrice ? String(room.weeklyRentPrice) : ""}
                inputMode="numeric"
                placeholder="395"
                onChange={(e) =>
                  onRoom({ ...room, weeklyRentPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })
                }
              />
            </Field>
          ) : (
            <Field label="Listed rent is" hint="Flexible invites a counter-offer; nothing bills differently.">
              <Select
                value={room.pricingMode ?? "fixed"}
                onChange={(e) => onRoom({ ...room, pricingMode: e.target.value as ManagerRoomSubmission["pricingMode"] })}
              >
                <option value="fixed">Fixed, price locked</option>
                <option value="flexible">Flexible</option>
              </Select>
            </Field>
          )}
          {!isBaseTerm(term) && !stay ? (
            <div className="sm:col-span-2">
              <button
                type="button"
                onClick={() =>
                  onRoom({
                    ...room,
                    termPricing: (() => {
                      const next = { ...(room.termPricing ?? {}) };
                      delete next[term];
                      return Object.keys(next).length > 0 ? next : undefined;
                    })(),
                  })
                }
                className="text-[12.5px] font-bold text-primary hover:underline"
              >
                Reset this room to its long-term price
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RentAndDeposits({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const terms = useMemo(() => listingLeaseTypeScopeOptions(sub), [sub]);
  const [term, setTerm] = useState<string | null>(null);
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const active = term && terms.includes(term) ? term : terms[0] ?? LONG_TERM_LEASE_TERM;
  const rooms = sub.rooms ?? [];
  const stay = isStayLeaseTerm(active);

  const writeRoom = (next: ManagerRoomSubmission) =>
    patch({ rooms: rooms.map((r) => (r.id === next.id ? next : r)) });

  if (terms.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-3 text-[12.5px] text-muted">
        Choose at least one lease type above, and its prices appear here.
      </p>
    );
  }

  return (
    <>
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {terms.map((t) => {
          const missing = (sub.rooms ?? []).some((room) =>
            isStayLeaseTerm(t) ? !(room.shortTermRent ?? "").trim() : rentForTerm(room, t).value <= 0,
          );
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === active}
              data-attr={`listing-v2-price-tab-${t}`}
              onClick={() => setTerm(t)}
              className={cn(
                "-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-[13.5px] font-bold transition",
                t === active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {t}
              {missing ? (
                <span
                  className="h-[7px] w-[7px] rounded-full bg-[var(--status-pending-fg)]"
                  aria-label="Some rooms have no price on this lease type"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {rooms.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-3 text-[12.5px] text-muted">
          Add a room on the Rooms step and it appears here to be priced.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <div className="min-w-[560px]">
          <div className="grid grid-cols-[20px_minmax(0,1.2fr)_120px_minmax(0,0.8fr)_minmax(0,0.9fr)] items-center gap-2.5 border-b border-border bg-accent/25 px-3.5 py-2 text-[10.5px] font-extrabold uppercase tracking-wide text-muted">
            <span />
            <span>Room</span>
            <span>{stay ? "Per night" : "Monthly rent"}</span>
            <span>Deposit</span>
            <span>{stay ? "Utilities" : "Utilities"}</span>
          </div>
          {rooms.map((room) => (
            <RoomPriceRow
              key={room.id}
              room={room}
              term={active}
              sub={sub}
              onRoom={writeRoom}
              open={openRoomId === room.id}
              onToggle={() => setOpenRoomId((prev) => (prev === room.id ? null : room.id))}
            />
          ))}
          </div>
        </div>
      )}
      <p className="mt-2 text-[12px] text-muted">
        {isBaseTerm(active)
          ? "Type rent straight into the table. Open a room for its deposit and utilities."
          : `Grey means this room charges its long-term price on ${active}. Type a number to change it here only.`}
      </p>
    </>
  );
}

/* ─────────────────────── fees ─────────────────────── */

/**
 * Fees, in two groups, because they are two different things.
 *
 * A STANDARD fee is a slot every listing has — the application fee, the move-in
 * fee, the holding deposit. Its name is not the manager's to change and removing
 * it would mean removing a concept, so it gets an amount and a reach and nothing
 * else. A CUSTOM fee is one the manager invented, so it gets a name and a bin.
 *
 * The security deposit is deliberately absent: it is priced per room in the
 * table above, and a second editable copy here is exactly how a listing ends up
 * quoting two different deposits.
 *
 * Writes go through `applyListingFeesToSubmission`, which keeps the legacy
 * scalar fields (`moveInFee`, `holdingDeposit`, …) in step with the row — every
 * downstream reader still reads those.
 */
function FeesSection({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const terms = useMemo(() => listingLeaseTypeScopeOptions(sub), [sub]);
  const rooms = sub.rooms ?? [];
  const seattle = listingFoldsAllMonthlyFeesIntoRent(sub);

  const rows = useMemo(
    () => listingFeesForWizard(sub).filter((f) => f.presetId !== "security_deposit"),
    [sub],
  );
  /*
   * A standard slot with no amount is not a fee this listing charges — it is a
   * slot the product offers. Rendering all eleven of them at £0 buried the two
   * that were real, so an empty slot stays out of the list until it is picked
   * from "Add a fee" (or already carries an amount).
   */
  const [revealed, setRevealed] = useState<string[]>([]);
  const standardAll = rows.filter((f) => f.presetId && f.presetId !== "custom");
  const standard = standardAll.filter(
    (f) => isListingFeeAmountFilled(f.amount ?? "") || revealed.includes(f.id),
  );
  const unusedStandard = standardAll.filter((f) => !standard.includes(f));
  const custom = rows.filter((f) => !f.presetId || f.presetId === "custom");

  const writeRows = (next: ListingFeeRow[]) => {
    // security_deposit is filtered out of the editor, so put it back untouched.
    const held = listingFeesForWizard(sub).filter((f) => f.presetId === "security_deposit");
    patch(applyListingFeesToSubmission(sub, [...next, ...held]));
  };
  const write = (id: string, next: Partial<ListingFeeRow>) =>
    writeRows(rows.map((f) => (f.id === id ? { ...f, ...next } : f)));

  const scopeControls = (fee: ListingFeeRow) => (
    <div className="mt-2.5 grid items-center gap-2.5 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
      <span className="text-[11.5px] font-bold text-muted">Applies to</span>
      <CheckboxMultiSelect
        hideLabel
        label={`Lease types for ${fee.label || "this fee"}`}
        options={terms.map((t) => ({ value: t, label: t }))}
        selected={expandFeeScope(fee.leaseTypes, terms)}
        emptyLabel="No lease types"
        onChange={(next) => write(fee.id, { leaseTypes: narrowFeeScope(next, terms) })}
      />
      {rooms.length > 0 ? (
        <CheckboxMultiSelect
          hideLabel
          label={`Rooms for ${fee.label || "this fee"}`}
          options={rooms.map((r) => ({ value: r.id, label: r.name?.trim() || "Room" }))}
          selected={expandFeeScope(
            fee.roomIds,
            rooms.map((r) => r.id),
          )}
          emptyLabel="No rooms"
          onChange={(next) =>
            write(fee.id, {
              roomIds: narrowFeeScope(
                next,
                rooms.map((r) => r.id),
              ),
            })
          }
        />
      ) : null}
    </div>
  );

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-border">
        {standard.map((fee) => (
          <div key={fee.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="grid grid-cols-[minmax(0,1fr)_110px_140px] items-center gap-2.5">
              <span className="min-w-0">
                <b className="block truncate text-[13.5px] font-bold text-foreground">{fee.label}</b>
                <span className="block text-[11.5px] text-muted">
                  {listingFeeCadence(fee) === "monthly" ? "Charged every month" : "Charged once"}
                </span>
              </span>
              <Input
                aria-label={`${fee.label} amount`}
                value={moneyValue(fee.amount)}
                placeholder="0"
                onChange={(e) => write(fee.id, { amount: sanitizeMoneyInput(e.target.value) })}
              />
              <span className="text-[12px] text-muted">
                {listingFeeCadence(fee) === "monthly" ? "Every month" : "One-time"}
              </span>
            </div>
            {scopeControls(fee)}
          </div>
        ))}
      </div>

      <p className="mb-2 mt-6 text-[12.5px] font-bold text-foreground">Fees you add yourself</p>
      <div className="overflow-hidden rounded-2xl border border-border">
        {custom.length === 0 ? (
          <p className="px-4 py-4 text-[12.5px] text-muted">
            Nothing beyond the standard fees. Parking, storage and the like go here.
          </p>
        ) : null}
        {custom.map((fee) => (
          <div key={fee.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="grid grid-cols-[minmax(0,1fr)_110px_140px_36px] items-center gap-2.5">
              <Input
                aria-label="Fee name"
                value={fee.label}
                placeholder="Parking space"
                onChange={(e) => write(fee.id, { label: e.target.value })}
              />
              <Input
                aria-label={`${fee.label || "Fee"} amount`}
                value={moneyValue(fee.amount)}
                placeholder="0"
                onChange={(e) => write(fee.id, { amount: sanitizeMoneyInput(e.target.value) })}
              />
              <Select
                aria-label={`How often ${fee.label || "this fee"} is charged`}
                value={fee.frequency ?? "monthly"}
                onChange={(e) => write(fee.id, { frequency: e.target.value as ManagerCustomFeeRow["frequency"] })}
              >
                <option value="monthly">Every month</option>
                <option value="one-time">One-time</option>
              </Select>
              <button
                type="button"
                aria-label={`Remove ${fee.label || "fee"}`}
                onClick={() => writeRows(rows.filter((f) => f.id !== fee.id))}
                className="justify-self-center text-[13px] text-muted hover:text-foreground"
              >
                ✕
              </button>
            </div>
            {scopeControls(fee)}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select
          aria-label="Add a fee"
          value=""
          className="max-w-[230px]"
          data-attr="listing-v2-add-fee"
          onChange={(e) => {
            const picked = e.target.value;
            if (!picked) return;
            if (picked === "__custom") writeRows([...rows, { ...emptyCustomFeeRow(), presetId: "custom" }]);
            else setRevealed((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
          }}
        >
          <option value="">Add a fee…</option>
          {unusedStandard.map((fee) => (
            <option key={fee.id} value={fee.id}>
              {fee.label}
            </option>
          ))}
          <option value="__custom">Something else…</option>
        </Select>
      </div>
      {seattle ? (
        <p className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-[12px] leading-relaxed text-muted">
          {SEATTLE_RENT_RULE_NOTE}
        </p>
      ) : null}
    </>
  );
}

/* ─────────────────────── due at signing ─────────────────────── */

function DueAtSigning({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const terms = useMemo(() => listingLeaseTypeScopeOptions(sub), [sub]);
  const rentByRoom = sub.listingPlaceCategoryId !== "entire_home";
  const rows = useMemo(() => paymentAtSigningRows(sub, { includeRoomRent: rentByRoom }), [sub, rentByRoom]);
  const matrix = useMemo(() => paymentAtSigningMatrix(sub), [sub]);

  const setCell = (term: string, key: string, on: boolean) => {
    const next = applyPaymentAtSigningCell(sub, term, key, on);
    patch({
      paymentAtSigningByLeaseType: next.paymentAtSigningByLeaseType,
      paymentAtSigningIncludes: next.paymentAtSigningIncludes,
      customFees: next.customFees,
    });
  };

  if (terms.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      {terms.map((term) => {
        const selected = (matrix[term] ?? []).filter((key) => rows.some((r) => r.key === key));
        return (
          <div
            key={term}
            className="grid items-center gap-3 border-b border-border px-3.5 py-3 last:border-b-0 sm:grid-cols-[150px_minmax(0,1fr)]"
          >
            <b className="text-[13px] font-bold text-foreground">{term}</b>
            <CheckboxMultiSelect
              hideLabel
              label={`Collected at signing on ${term}`}
              options={rows.map((r) => ({ value: r.key, label: r.label }))}
              selected={selected}
              emptyLabel="Nothing due at signing"
              onChange={(next) => {
                for (const row of rows) {
                  const shouldBeOn = next.includes(row.key);
                  if (shouldBeOn !== selected.includes(row.key)) setCell(term, row.key, shouldBeOn);
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────── the step ─────────────────────── */

export function ListingPricingSections({
  sub,
  patch,
  leaseTypesField,
  payments,
  applications,
  leaseDocument,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  /** The listing's lease-type picker — the same control a room's Leasing section shows. */
  leaseTypesField: React.ReactNode;
  /** Card-fee payer, whole-place rent, and the rails money arrives on. */
  payments: React.ReactNode;
  applications: React.ReactNode;
  /** Break-lease, holdover, quiet hours — what the lease document says. */
  leaseDocument: React.ReactNode;
}) {
  return (
    <>
      <section className="mb-8">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">Leases you offer</h3>
        <p className="mb-3 text-[12.5px] text-muted">
          An applicant chooses from exactly these, and each one gets its own prices below.
        </p>
        {leaseTypesField}
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">Rent and deposits</h3>
        <p className="mb-3 text-[12.5px] text-muted">One row per room, on the lease type you are looking at.</p>
        <RentAndDeposits sub={sub} patch={patch} />
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">Fees</h3>
        <p className="mb-3 text-[12.5px] text-muted">
          What each fee costs, how often it is charged, and which leases and rooms it reaches.
        </p>
        <FeesSection sub={sub} patch={patch} />
      </section>

      <section className="mb-8 border-t border-border pt-6">
        <h3 className="mb-1 text-[14px] font-bold text-foreground">Due at signing</h3>
        <p className="mb-3 text-[12.5px] text-muted">
          What each lease type collects before move-in. Anything left out is billed later.
        </p>
        <DueAtSigning sub={sub} patch={patch} />
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
