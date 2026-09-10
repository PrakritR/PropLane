"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ManagerCustomFeeRow, ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  LISTING_STANDARD_FEE_ROWS,
  type ListingFeeRowId,
  readListingFeeCellAmount,
} from "@/lib/listing-fee-term-toggles";
import { LISTING_FEE_PRESETS, type ListingFeeRow } from "@/lib/listing-fees";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { SEATTLE_RENT_RULE_NOTE } from "@/lib/seattle-rent-rule";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The one remove control used on EVERY deletable item across the Fees UI — standard
 * fee rows, custom fees, room rows, and bundle rows — so the affordance is identical
 * everywhere (mirrors the wizard's LISTING_WIZARD_REMOVE_BTN).
 */
const FEE_REMOVE_BTN =
  "h-9 shrink-0 rounded-lg px-2.5 text-xs border-rose-200 text-rose-800 portal-danger-outline";

/**
 * A room or bundle rendered AS A ROW inside the single Fees table. Clicking the row
 * expands `detail` inline (a full-width row beneath it) — the "dropdown inside the fee
 * table" the design calls for, instead of a card floating above the table.
 */
export type FeeExpandableRow = {
  id: string;
  title: string;
  /** Long-term column summary (e.g. "$1,100/mo · Utilities billed"). */
  summary: ReactNode;
  /** Short-term column summary (only rendered when the short-term column is shown). */
  shortTermSummary?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** Omit to make the row non-removable. */
  onRemove?: () => void;
  hasError?: boolean;
  detail: ReactNode;
  toggleDataAttr?: string;
};

/** A titled section of expandable rows (Rooms, Bundles) that sits inside the one table. */
export type FeeExpandableSection = {
  key: string;
  title: string;
  hint?: string;
  /** Optional controls shown in the section header row (e.g. the bundle add buttons). */
  toolbar?: ReactNode;
  rows: FeeExpandableRow[];
  emptyHint?: ReactNode;
};

/** Fluid, not fixed — a hard `w-` here is what pushed the table's min width to 44rem. */
const FEE_MONEY_INPUT_WIDTH = "w-full min-w-[5.5rem] max-w-[9.5rem]";

/**
 * Fluid like the money input, but with its own floor: the cadence select is the only
 * control here whose text cannot wrap or ellipsize, so without a min width it shrinks
 * inside `FEE_CONTROL_ROW` until "One-time" clips behind the native arrow.
 */
const FEE_CADENCE_SELECT_WIDTH = "w-full min-w-[6rem] max-w-[7.5rem]";

/**
 * Grid columns: fee | amount(s) | lease type(s) | rooms? | remove.
 *
 * The short-term column pair is gone (PRP-463): a fee's TERM is now the lease-type
 * multi-select, and the short-term amount appears inside the amount cell only when the
 * fee is actually scoped to short-term stays. So the table has one amount column whether
 * or not the listing offers short-term, and one more column only when renting by room.
 *
 * Floors are what each cell measures at, not round numbers: the amount cell holds the
 * money input (88px) plus the cadence select (96px) plus `px-3` (24px) and its gap, so
 * 13rem; a scope trigger needs ~9rem before its summary starts truncating; and the remove
 * column stays 7.75rem because `Button` composes its base with a template literal rather
 * than `cn`, so `px-2.5`/`text-xs` lose to the base and the button renders ~96px wide.
 */
function feeGridCols(showRooms: boolean) {
  return showRooms
    ? "grid-cols-[minmax(7rem,1.05fr)_minmax(13rem,1.2fr)_minmax(9rem,0.9fr)_minmax(9rem,0.9fr)_7.75rem]"
    : "grid-cols-[minmax(7rem,1.1fr)_minmax(13rem,1.3fr)_minmax(9rem,1fr)_7.75rem]";
}

/**
 * The table can never be narrower than the sum of its own column floors, and that sum
 * depends on whether the rooms column is drawn: 7 + 13 + 9 + 9 + 7.75 = 45.75rem with it,
 * 7 + 13 + 9 + 7.75 = 36.75rem without.
 */
function feeGridMinWidth(showRooms: boolean) {
  return showRooms ? "min-w-[45.75rem]" : "min-w-[36.75rem]";
}

function feeColSpan(showRooms: boolean) {
  return showRooms ? "col-span-5" : "col-span-4";
}

/** Checkbox immediately left of amount — single horizontal control group. */
const FEE_CONTROL_ROW = "flex flex-nowrap items-center gap-2";

function rowIsRemovable(_id: ListingFeeRowId): boolean {
  return true;
}

function FeeMoneyInput({
  value,
  onChange,
  placeholder = "0",
  disabled,
  invalid,
  ariaLabel,
  dataField,
}: {
  value: string;
  onChange: (sanitized: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel: string;
  dataField?: string;
}) {
  return (
    <div className={cn("relative", FEE_MONEY_INPUT_WIDTH)} data-wizard-field={dataField}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-xs font-medium text-muted">
        $
      </span>
      <Input
        inputMode="decimal"
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          "!min-h-9 h-9 rounded-lg py-1 pl-6 pr-2 text-sm tabular-nums shadow-none",
          invalid && "border-red-500 ring-1 ring-red-500/30",
        )}
        value={value}
        onChange={(e) => onChange(sanitizeMoneyInput(e.target.value))}
        placeholder={placeholder}
      />
    </div>
  );
}

/**
 * Standard rows are backed by fixed submission fields, but the unified migration
 * also materializes each one as a preset-tagged row in `customFees` — which is
 * where a fee's cadence actually lives. This maps a table row to that row so the
 * long-term cadence control can read and write it.
 */
const PRESET_ID_FOR_ROW: Partial<Record<ListingFeeRowId, string>> = {
  securityDeposit: "security_deposit",
  moveInFee: "move_in_fee",
  holdingDeposit: "holding_deposit",
  parkingMonthly: "parking_monthly",
  hoaMonthly: "hoa_monthly",
  otherMonthlyFees: "other_monthly",
  monthToMonthSurcharge: "mtm_surcharge",
  customLeaseSurcharge: "custom_lease_surcharge",
};

function FeeCadenceSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: "one-time" | "monthly";
  onChange: (next: "one-time" | "monthly") => void;
  ariaLabel: string;
}) {
  return (
    <select
      className={cn(
        "h-9 rounded-lg border border-border bg-card px-2 text-xs text-foreground",
        FEE_CADENCE_SELECT_WIDTH,
      )}
      value={value}
      onChange={(e) => onChange(e.target.value === "one-time" ? "one-time" : "monthly")}
      aria-label={ariaLabel}
    >
      <option value="monthly">Monthly</option>
      <option value="one-time">One-time</option>
    </select>
  );
}

/** Which fee a scope control is editing. */
export type FeeScopeTarget =
  | { kind: "standard"; rowId: ListingFeeRowId }
  | { kind: "custom"; index: number };

/**
 * Lease-type and room scope for every fee in the table (PRP-463).
 *
 * The form owns the mapping between a scope selection and what it actually writes —
 * short-term/long-term toggles for a standard row, `leaseTypes`/`roomIds` on a fee row —
 * so this table stays a rendering surface with no knowledge of the submission model.
 */
export type FeeScopeControls = {
  /** Lease types this listing offers, in display order. */
  leaseOptions: string[];
  /** Rooms this listing rents by; empty means the room column is not drawn. */
  roomOptions: { id: string; name: string }[];
  leaseScope: (target: FeeScopeTarget) => string[];
  setLeaseScope: (target: FeeScopeTarget, next: string[]) => void;
  roomScope: (target: FeeScopeTarget) => string[];
  setRoomScope: (target: FeeScopeTarget, next: string[]) => void;
};

/**
 * One scope dropdown. Its face says "All lease types" / "All rooms" when everything is
 * picked rather than listing them, because "all" is the stored meaning — not a list that
 * happens to be complete today (see `listing-fee-scope.ts`).
 */
function FeeScopeSelect({
  label,
  options,
  selected,
  onChange,
  allLabel,
  emptyLabel,
  dataAttr,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
  emptyLabel: string;
  dataAttr?: string;
}) {
  const everything = options.length > 0 && selected.length >= options.length;
  return (
    <CheckboxMultiSelect
      label={label}
      hideLabel
      dataAttr={dataAttr}
      className="w-full"
      options={options}
      selected={selected}
      onChange={onChange}
      emptyLabel={emptyLabel}
      emptyMenuText="Pick lease lengths in Leasing first"
      selectionTriggerLabel={everything ? allLabel : undefined}
    />
  );
}

function FeeScopeCells({
  target,
  scope,
  labelForAria,
  dataAttrBase,
}: {
  target: FeeScopeTarget;
  scope: FeeScopeControls;
  labelForAria: string;
  dataAttrBase: string;
}) {
  const showRooms = scope.roomOptions.length > 0;
  return (
    <>
      <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3">
        <FeeScopeSelect
          label={`Lease types for ${labelForAria}`}
          dataAttr={`${dataAttrBase}-lease-scope`}
          options={scope.leaseOptions.map((t) => ({ value: t, label: t }))}
          selected={scope.leaseScope(target)}
          onChange={(next) => scope.setLeaseScope(target, next)}
          allLabel="All lease types"
          emptyLabel="No lease type"
        />
      </div>
      {showRooms ? (
        <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3">
          <FeeScopeSelect
            label={`Rooms for ${labelForAria}`}
            dataAttr={`${dataAttrBase}-room-scope`}
            options={scope.roomOptions.map((r) => ({ value: r.id, label: r.name }))}
            selected={scope.roomScope(target)}
            onChange={(next) => scope.setRoomScope(target, next)}
            allLabel="All rooms"
            emptyLabel="No room"
          />
        </div>
      ) : null}
    </>
  );
}

function FeeTableHeader({ showRooms }: { showRooms: boolean }) {
  const cell =
    "border-b border-border bg-accent/30 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted";
  return (
    <div className="contents">
      <div className={cell}>
        <span className="font-semibold normal-case tracking-normal text-foreground">Fee</span>
      </div>
      <div className={cell}>Amount</div>
      <div className={cell}>Lease type(s)</div>
      {showRooms ? <div className={cell}>Room(s)</div> : null}
      <div className={cell}>
        <span className="sr-only">Actions</span>
      </div>
    </div>
  );
}

/** Full-width section divider row inside the table. */
function SectionHeaderRow({
  title,
  hint,
  toolbar,
  showRooms,
}: {
  title: string;
  hint?: string;
  toolbar?: ReactNode;
  showRooms: boolean;
}) {
  return (
    <div className={cn(feeColSpan(showRooms), "border-b border-border bg-accent/40 px-3 py-2")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</span>
          {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
        </div>
        {toolbar ? <div className="flex flex-wrap items-center gap-2">{toolbar}</div> : null}
      </div>
    </div>
  );
}

/** One expandable room/bundle row + its inline detail row. */
function ExpandableRows({ row, showRooms }: { row: FeeExpandableRow; showRooms: boolean }) {
  return (
    <>
      <div className={cn("contents", row.hasError && "[&>*]:bg-red-500/5")}>
        <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3">
          <button
            type="button"
            className="flex max-w-full items-center gap-2 text-left"
            onClick={row.onToggle}
            data-attr={row.toggleDataAttr}
            aria-expanded={row.expanded}
          >
            {row.expanded ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
            )}
            <span className={cn("truncate font-medium text-foreground", row.hasError && "text-red-600")}>
              {row.title}
            </span>
          </button>
        </div>
        <div className="flex min-w-0 flex-col justify-center border-b border-border/70 px-3 py-3 text-sm text-muted">
          <span className="truncate">{row.summary}</span>
          {row.shortTermSummary ? (
            <span className="truncate text-xs text-muted">Short-term: {row.shortTermSummary}</span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3 text-xs text-muted">—</div>
        {showRooms ? (
          <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3 text-xs text-muted">—</div>
        ) : null}
        <div className="flex items-center justify-end border-b border-border/70 px-3 py-3">
          {row.onRemove ? (
            <Button
              type="button"
              variant="outline"
              className={FEE_REMOVE_BTN}
              onClick={row.onRemove}
              aria-label={`Remove ${row.title}`}
            >
              Remove
            </Button>
          ) : (
            <span className="text-xs text-muted">—</span>
          )}
        </div>
      </div>
      {row.expanded ? (
        <div className={cn(feeColSpan(showRooms), "border-b border-border/70 bg-accent/10 px-3 py-3")}>
          {row.detail}
        </div>
      ) : null}
    </>
  );
}

export function ListingUnifiedFeesTable({
  sub,
  isEntireHome,
  onStAmount,
  onLtAmount,
  onLtAmountForRow,
  stepFieldErrors,
  customFees,
  onAddCustomFee,
  onRemoveCustomFee,
  onCustomFeeChange,
  onPresetCadenceChange,
  hiddenRowIds,
  removedRowIds,
  onRemoveStandardRow,
  onAddStandardRow,
  expandableSections,
  scope,
  foldsMonthlyFeesIntoRent = false,
}: {
  sub: ManagerListingSubmissionV1;
  isEntireHome: boolean;
  onStAmount: (feeId: ListingFeeRowId, amount: string) => void;
  onLtAmount: (field: keyof ManagerListingSubmissionV1, amount: string) => void;
  onLtAmountForRow: (feeId: ListingFeeRowId, amount: string) => void;
  stepFieldErrors: Record<string, string>;
  customFees: ManagerCustomFeeRow[];
  onAddCustomFee: () => void;
  onRemoveCustomFee: (index: number) => void;
  onCustomFeeChange: (index: number, patch: Partial<ManagerCustomFeeRow>) => void;
  /** Set cadence for a preset fee that has no materialized row yet (new listing). */
  onPresetCadenceChange?: (presetId: string, next: "one-time" | "monthly") => void;
  /** Standard rows hidden entirely for this rental model (e.g. securityDeposit lives per-room). */
  hiddenRowIds?: ReadonlySet<ListingFeeRowId>;
  /** Standard rows the manager deleted this session — hidden but re-addable via + Add fee. */
  removedRowIds: ReadonlySet<ListingFeeRowId>;
  /** Delete a standard fee row: clears its amounts and drops it from the table. */
  onRemoveStandardRow: (feeId: ListingFeeRowId) => void;
  /** Re-add a previously-removed standard fee row from the + Add fee menu. */
  onAddStandardRow: (feeId: ListingFeeRowId) => void;
  /** Rooms / Bundles sections rendered AS ROWS at the top of this one table. */
  expandableSections?: FeeExpandableSection[];
  /** Lease-type and room scope per fee — the two dropdowns that replaced the term columns. */
  scope: FeeScopeControls;
  /**
   * Seattle rent rule: every monthly fee here is added to the rent and disclosed on the
   * lease as part of rent, never billed as its own charge. Shown as a note on the section
   * so the manager knows what the amounts they type will become.
   */
  foldsMonthlyFeesIntoRent?: boolean;
}) {
  // Rent is NEVER an "Other fee" (round 27): it lives in the Rent section above — per room
  // when renting by room, as the whole-place row otherwise — and is re-added there, not here.
  const visibleRows = LISTING_STANDARD_FEE_ROWS.filter(
    (row) => row.id !== "rent" && !hiddenRowIds?.has(row.id) && !removedRowIds.has(row.id),
  );
  const readdableRows = LISTING_STANDARD_FEE_ROWS.filter(
    (row) => row.id !== "rent" && rowIsRemovable(row.id) && removedRowIds.has(row.id) && !hiddenRowIds?.has(row.id),
  );
  const sections = expandableSections ?? [];
  const showRooms = scope.roomOptions.length > 0;
  const shortTermOffered = scope.leaseOptions.includes(SHORT_TERM_LEASE_TERM);

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className={cn("grid text-sm", feeGridMinWidth(showRooms), feeGridCols(showRooms))}>
        <FeeTableHeader showRooms={showRooms} />

        {sections.map((section) => (
          <FeeSectionRows key={section.key} section={section} showRooms={showRooms} />
        ))}

        {sections.length > 0 ? (
          <SectionHeaderRow
            title="Other fees"
            hint={[
              isEntireHome ? "Whole-home rent and shared fees." : "Fees shared across the whole property.",
              foldsMonthlyFeesIntoRent ? SEATTLE_RENT_RULE_NOTE : "",
            ]
              .filter(Boolean)
              .join(" ")}
            showRooms={showRooms}
          />
        ) : null}

        {visibleRows.map((row) => {
          const rowId = row.id;
          const target: FeeScopeTarget = { kind: "standard", rowId };
          const leaseScope = scope.leaseScope(target);
          // The lease-type dropdown IS the term toggle now: an amount cell exists only for
          // a term the fee is actually scoped to, so there is no way to type a price into
          // a term the manager did not pick.
          const stOn = shortTermOffered && leaseScope.includes(SHORT_TERM_LEASE_TERM);
          const ltOn = leaseScope.some((t) => t !== SHORT_TERM_LEASE_TERM);
          const stAmount = row.stField ? readListingFeeCellAmount(sub, row.stField) : "";
          const ltAmount = row.ltField ? readListingFeeCellAmount(sub, row.ltField) : "";
          const rentLtPerRoom = row.id === "rent" && !isEntireHome;
          const ltErr =
            row.ltField && (stepFieldErrors[String(row.ltField)] ||
              (row.id === "rent" && isEntireHome && stepFieldErrors.monthlyRent))
              ? row.id === "rent" && isEntireHome && stepFieldErrors.monthlyRent
                ? stepFieldErrors.monthlyRent
                : stepFieldErrors[String(row.ltField)]
              : "";
          const stErr = row.stField ? stepFieldErrors[String(row.stField)] : "";

          return (
            <div key={row.id} className="contents">
              <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3">
                <div>
                  <div className="font-medium text-foreground">{row.label}</div>
                  {row.stHint || row.ltHint ? (
                    <div className="mt-0.5 text-[11px] leading-tight text-muted">
                      {[row.stHint, row.ltHint].filter(Boolean).join(" · ")}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex min-w-0 flex-col justify-center gap-2 border-b border-border/70 px-3 py-3">
                {!ltOn && !stOn ? <span className="text-xs text-muted">—</span> : null}
                {ltOn && (row.ltField || row.id === "rent") ? (
                  <>
                    <div className={FEE_CONTROL_ROW}>
                      {rentLtPerRoom ? (
                        <span className="shrink-0 text-xs text-muted">Set per room above</span>
                      ) : (
                        <FeeMoneyInput
                          value={ltAmount}
                          onChange={(v) => (row.ltField ? onLtAmount(row.ltField, v) : onLtAmountForRow(rowId, v))}
                          placeholder={row.id === "holdingDeposit" ? "100" : "0"}
                          invalid={Boolean(ltErr)}
                          ariaLabel={`${row.label} amount`}
                          dataField={row.id === "rent" && isEntireHome ? "monthlyRent" : String(row.ltField)}
                        />
                      )}
                      {!rentLtPerRoom
                        ? (() => {
                            const presetId = PRESET_ID_FOR_ROW[rowId];
                            if (!presetId) return null;
                            const idx = customFees.findIndex((f) => (f as ListingFeeRow).presetId === presetId);
                            const presetCadence = LISTING_FEE_PRESETS.find((p) => p.presetId === presetId)?.cadence;
                            const fallback: "one-time" | "monthly" =
                              presetCadence === "monthly" ? "monthly" : "one-time";
                            const current =
                              idx >= 0
                                ? customFees[idx]!.frequency === "one-time"
                                  ? "one-time"
                                  : "monthly"
                                : fallback;
                            return (
                              <FeeCadenceSelect
                                value={current}
                                onChange={(next) =>
                                  idx >= 0
                                    ? onCustomFeeChange(idx, { frequency: next })
                                    : onPresetCadenceChange?.(presetId, next)
                                }
                                ariaLabel={`${row.label} payment frequency`}
                              />
                            );
                          })()
                        : null}
                    </div>
                    {ltErr ? <p className="text-xs font-medium text-red-600">{ltErr}</p> : null}
                  </>
                ) : null}
                {stOn && row.stField ? (
                  <>
                    <div className={FEE_CONTROL_ROW}>
                      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">
                        Short-term
                      </span>
                      <FeeMoneyInput
                        value={stAmount}
                        onChange={(v) => onStAmount(rowId, v)}
                        placeholder={row.id === "rent" ? "85" : "0"}
                        invalid={Boolean(stErr)}
                        ariaLabel={`Short-term ${row.label}`}
                        dataField={String(row.stField)}
                      />
                    </div>
                    {stErr ? <p className="text-xs font-medium text-red-600">{stErr}</p> : null}
                  </>
                ) : null}
              </div>

              <FeeScopeCells
                target={target}
                scope={scope}
                labelForAria={row.label}
                dataAttrBase={`listing-fee-${rowId}`}
              />

              <div className="flex items-center justify-end border-b border-border/70 px-3 py-3">
                {rowIsRemovable(rowId) ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={FEE_REMOVE_BTN}
                    onClick={() => onRemoveStandardRow(rowId)}
                    aria-label={`Remove ${row.label}`}
                  >
                    Remove
                  </Button>
                ) : (
                  <span className="text-xs text-muted">—</span>
                )}
              </div>
            </div>
          );
        })}

        {/* Only genuinely custom rows belong here. Preset-backed rows are already
            rendered above as standard fees, so listing them again duplicated every
            fee once the legacy->unified migration started materializing presets
            into customFees. Indices are captured before filtering because the
            change/remove callbacks address the unfiltered array. */}
        {customFees
          .map((fee, i) => ({ fee, i }))
          .filter(({ fee }) => {
            const presetId = (fee as ListingFeeRow).presetId;
            return !presetId || presetId === "custom";
          })
          .map(({ fee, i }) => {
            const target: FeeScopeTarget = { kind: "custom", index: i };
            const leaseScope = scope.leaseScope(target);
            const stOn = shortTermOffered && leaseScope.includes(SHORT_TERM_LEASE_TERM);
            const ltOn = leaseScope.some((t) => t !== SHORT_TERM_LEASE_TERM);
            return (
              <div key={fee.id} className="contents">
                <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3">
                  <Input
                    className="!min-h-9 h-9 w-full rounded-lg py-1 text-sm shadow-none"
                    value={fee.label}
                    onChange={(e) => onCustomFeeChange(i, { label: e.target.value })}
                    placeholder="Custom fee name"
                    aria-label={`Custom fee ${i + 1} name`}
                  />
                </div>

                <div className="flex min-w-0 flex-col justify-center gap-2 border-b border-border/70 px-3 py-3">
                  {!ltOn && !stOn ? <span className="text-xs text-muted">—</span> : null}
                  {ltOn ? (
                    <div className={FEE_CONTROL_ROW}>
                      <FeeMoneyInput
                        value={fee.amount.replace(/^\$/, "").trim()}
                        onChange={(v) => onCustomFeeChange(i, { amount: v })}
                        ariaLabel={`Custom fee ${i + 1} amount`}
                      />
                      <FeeCadenceSelect
                        value={fee.frequency === "one-time" ? "one-time" : "monthly"}
                        onChange={(next) => onCustomFeeChange(i, { frequency: next })}
                        ariaLabel={`Custom fee ${i + 1} payment frequency`}
                      />
                    </div>
                  ) : null}
                  {stOn ? (
                    <div className={FEE_CONTROL_ROW}>
                      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">
                        Short-term
                      </span>
                      <FeeMoneyInput
                        value={(fee.shortTermAmount ?? "").replace(/^\$/, "").trim()}
                        onChange={(v) => onCustomFeeChange(i, { shortTermAmount: v })}
                        ariaLabel={`Short-term custom fee ${i + 1} amount`}
                      />
                    </div>
                  ) : null}
                </div>

                <FeeScopeCells
                  target={target}
                  scope={scope}
                  labelForAria={fee.label.trim() || `custom fee ${i + 1}`}
                  dataAttrBase={`listing-custom-fee-${i}`}
                />

                <div className="flex items-center justify-end border-b border-border/70 px-3 py-3">
                  <Button
                    type="button"
                    variant="outline"
                    className={FEE_REMOVE_BTN}
                    onClick={() => onRemoveCustomFee(i)}
                    aria-label={`Remove custom fee ${i + 1}`}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        {readdableRows.length > 0 ? (
          <select
            className="h-8 rounded-full border border-border bg-card px-3 text-xs text-foreground"
            value=""
            onChange={(e) => {
              const id = e.target.value as ListingFeeRowId;
              if (id) onAddStandardRow(id);
            }}
            aria-label="Add a fee back to the table"
          >
            <option value="">+ Add fee…</option>
            {readdableRows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="button" variant="outline" className="rounded-full text-xs" onClick={onAddCustomFee}>
          + Add custom fee
        </Button>
      </div>
    </div>
  );
}

/** A Rooms/Bundles section rendered inside the table: a header row then its expandable rows. */
function FeeSectionRows({ section, showRooms }: { section: FeeExpandableSection; showRooms: boolean }) {
  return (
    <>
      <SectionHeaderRow
        title={section.title}
        hint={section.hint}
        toolbar={section.toolbar}
        showRooms={showRooms}
      />
      {section.rows.length === 0 && section.emptyHint ? (
        <div className={cn(feeColSpan(showRooms), "border-b border-border/70 px-3 py-2.5 text-xs text-muted")}>
          {section.emptyHint}
        </div>
      ) : null}
      {section.rows.map((row) => (
        <ExpandableRows key={row.id} row={row} showRooms={showRooms} />
      ))}
    </>
  );
}
