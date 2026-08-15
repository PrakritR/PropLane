"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ManagerCustomFeeRow, ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  LISTING_STANDARD_FEE_ROWS,
  type ListingFeeRowId,
  type ListingLtFeeToggles,
  type ListingStFeeToggles,
  readListingFeeCellAmount,
} from "@/lib/listing-fee-term-toggles";
import { LISTING_FEE_PRESETS, type ListingFeeRow } from "@/lib/listing-fees";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
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
 * Grid columns: label | short-term | long-term | remove.
 *
 * The long-term floor is the sum of what its cell actually holds at the narrowest
 * useful size: `px-3` (24px) + checkbox (14px) + gap (8px) + money-input floor (88px)
 * + gap (8px) + cadence-select floor (96px) = 238px ≈ 15rem. Short-term carries no
 * cadence select, so it floors 8.5rem.
 *
 * The remove column floors on what the Remove button MEASURES at, not on
 * `FEE_REMOVE_BTN`: `Button` composes its base with a template literal rather than
 * `cn`, so `px-2.5`/`text-xs` lose to the base `px-5`/`text-sm` and the button renders
 * ~96px wide. Plus the cell's `px-3` (24px) that is 120px, so the track is 7.75rem
 * (124px) — below that the button overflows leftward over the long-term column.
 */
function feeGridCols(showShortTerm: boolean) {
  return showShortTerm
    ? "grid-cols-[minmax(7rem,1.1fr)_minmax(8.5rem,1fr)_minmax(15rem,1.35fr)_7.75rem]"
    : "grid-cols-[minmax(7rem,1.15fr)_minmax(15rem,1.65fr)_7.75rem]";
}

/**
 * The table can never be narrower than the sum of its own column floors, and that sum
 * depends on whether the short-term column is drawn: 7 + 8.5 + 15 + 7.75 = 38.25rem with
 * it, 7 + 15 + 7.75 = 29.75rem without. Deriving it here rather than hard-coding the
 * wider figure keeps a single-term listing from scrolling 8.5rem it does not use.
 */
function feeGridMinWidth(showShortTerm: boolean) {
  return showShortTerm ? "min-w-[38.25rem]" : "min-w-[29.75rem]";
}

function feeColSpan(showShortTerm: boolean) {
  return showShortTerm ? "col-span-4" : "col-span-3";
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

function TermCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="h-3.5 w-3.5 shrink-0 rounded border-border"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
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

function FeeTableHeader({ showShortTerm }: { showShortTerm: boolean }) {
  return (
    <div className="contents">
      <div className="border-b border-border bg-accent/30 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <span className="font-semibold normal-case tracking-normal text-foreground">Rent</span>
      </div>
      {showShortTerm ? (
        <div className="border-b border-border bg-accent/30 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
          Short-term
        </div>
      ) : null}
      <div className="border-b border-border bg-accent/30 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
        Long-term
      </div>
      <div className="border-b border-border bg-accent/30 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
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
  showShortTerm,
}: {
  title: string;
  hint?: string;
  toolbar?: ReactNode;
  showShortTerm: boolean;
}) {
  return (
    <div
      className={cn(
        feeColSpan(showShortTerm),
        "border-b border-border bg-accent/40 px-3 py-2",
      )}
    >
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
function ExpandableRows({
  row,
  showShortTerm,
}: {
  row: FeeExpandableRow;
  showShortTerm: boolean;
}) {
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
        {showShortTerm ? (
          <div className="flex min-w-0 items-center truncate border-b border-border/70 px-3 py-3 text-xs text-muted">
            {row.shortTermSummary ?? "—"}
          </div>
        ) : null}
        <div className="flex min-w-0 items-center truncate border-b border-border/70 px-3 py-3 text-sm text-muted">
          {row.summary}
        </div>
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
        <div className={cn(feeColSpan(showShortTerm), "border-b border-border/70 bg-accent/10 px-3 py-3")}>
          {row.detail}
        </div>
      ) : null}
    </>
  );
}

export function ListingUnifiedFeesTable({
  sub,
  isEntireHome,
  stFeeToggles,
  ltFeeToggles,
  onStToggle,
  onLtToggle,
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
  showShortTerm,
}: {
  sub: ManagerListingSubmissionV1;
  isEntireHome: boolean;
  stFeeToggles: ListingStFeeToggles;
  ltFeeToggles: ListingLtFeeToggles;
  onStToggle: (feeId: ListingFeeRowId, enabled: boolean) => void;
  onLtToggle: (feeId: ListingFeeRowId, enabled: boolean) => void;
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
  /** Show the Short-term column. When false the whole column (header + cells) is gone. */
  showShortTerm: boolean;
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

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className={cn("grid text-sm", feeGridMinWidth(showShortTerm), feeGridCols(showShortTerm))}>
        <FeeTableHeader showShortTerm={showShortTerm} />

        {sections.map((section) => (
          <FeeSectionRows key={section.key} section={section} showShortTerm={showShortTerm} />
        ))}

        {sections.length > 0 ? (
          <SectionHeaderRow
            title="Other fees"
            hint={isEntireHome ? "Whole-home rent and shared fees." : "Fees shared across the whole property."}
            showShortTerm={showShortTerm}
          />
        ) : null}

        {visibleRows.map((row) => {
            const rowId = row.id;
            const stOn = stFeeToggles[rowId];
            const ltOn = ltFeeToggles[rowId];
            const stAmount = row.stField ? readListingFeeCellAmount(sub, row.stField) : "";
            const ltAmount = row.ltField ? readListingFeeCellAmount(sub, row.ltField) : "";
            const rentLtPerRoom = row.id === "rent" && !isEntireHome;

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

                {showShortTerm ? (
                  <div className="flex min-w-0 flex-col justify-center border-b border-border/70 px-3 py-3">
                    {row.stField ? (
                      <>
                        <div className={FEE_CONTROL_ROW}>
                          <TermCheckbox
                            checked={stOn}
                            onChange={(on) => onStToggle(rowId, on)}
                            label={`Apply ${row.label} to short-term`}
                          />
                          {stOn ? (
                            <FeeMoneyInput
                              value={stAmount}
                              onChange={(v) => onStAmount(rowId, v)}
                              placeholder={row.id === "rent" ? "85" : "0"}
                              invalid={Boolean(stepFieldErrors[String(row.stField)])}
                              ariaLabel={`Short-term ${row.label}`}
                              dataField={String(row.stField)}
                            />
                          ) : null}
                        </div>
                        {stepFieldErrors[String(row.stField)] ? (
                          <p className="mt-1 text-xs font-medium text-red-600">{stepFieldErrors[String(row.stField)]}</p>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </div>
                ) : null}

                <div className="flex min-w-0 flex-col justify-center border-b border-border/70 px-3 py-3">
                  {row.ltField || row.id === "rent" ? (
                    <>
                      <div className={FEE_CONTROL_ROW}>
                        <TermCheckbox
                          checked={ltOn}
                          onChange={(on) => onLtToggle(rowId, on)}
                          label={`Apply ${row.label} to long-term`}
                        />
                        {ltOn && !rentLtPerRoom ? (
                          <FeeMoneyInput
                            value={ltAmount}
                            onChange={(v) =>
                              row.ltField ? onLtAmount(row.ltField, v) : onLtAmountForRow(rowId, v)
                            }
                            placeholder={row.id === "holdingDeposit" ? "100" : "0"}
                            invalid={Boolean(
                              row.ltField &&
                                (stepFieldErrors[String(row.ltField)] ||
                                  (row.id === "rent" && isEntireHome && stepFieldErrors.monthlyRent)),
                            )}
                            ariaLabel={`Long-term ${row.label}`}
                            dataField={row.id === "rent" && isEntireHome ? "monthlyRent" : String(row.ltField)}
                          />
                        ) : null}
                        {ltOn && rentLtPerRoom ? (
                          <span className="shrink-0 text-xs text-muted">Set per room above</span>
                        ) : null}
                        {ltOn && !rentLtPerRoom
                          ? (() => {
                              const presetId = PRESET_ID_FOR_ROW[rowId];
                              if (!presetId) return null;
                              const idx = customFees.findIndex(
                                (f) => (f as ListingFeeRow).presetId === presetId,
                              );
                              const presetCadence = LISTING_FEE_PRESETS.find(
                                (p) => p.presetId === presetId,
                              )?.cadence;
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
                      {row.ltField && (stepFieldErrors[String(row.ltField)] || (row.id === "rent" && isEntireHome && stepFieldErrors.monthlyRent)) ? (
                        <p className="mt-1 text-xs font-medium text-red-600">
                          {row.id === "rent" && isEntireHome && stepFieldErrors.monthlyRent
                            ? stepFieldErrors.monthlyRent
                            : stepFieldErrors[String(row.ltField)]}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </div>

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
            .map(({ fee, i }) => (
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

                {showShortTerm ? (
                  <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3">
                    <div className={FEE_CONTROL_ROW}>
                      <TermCheckbox
                        checked={fee.shortTermAmount !== undefined}
                        onChange={(on) =>
                          onCustomFeeChange(i, { shortTermAmount: on ? (fee.shortTermAmount ?? "") : undefined })
                        }
                        label={`Apply custom fee ${i + 1} to short-term`}
                      />
                      {fee.shortTermAmount !== undefined ? (
                        <FeeMoneyInput
                          value={(fee.shortTermAmount ?? "").replace(/^\$/, "").trim()}
                          onChange={(v) => onCustomFeeChange(i, { shortTermAmount: v })}
                          ariaLabel={`Short-term custom fee ${i + 1} amount`}
                        />
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="flex min-w-0 items-center border-b border-border/70 px-3 py-3">
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
                </div>

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
            ))}
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
function FeeSectionRows({
  section,
  showShortTerm,
}: {
  section: FeeExpandableSection;
  showShortTerm: boolean;
}) {
  return (
    <>
      <SectionHeaderRow
        title={section.title}
        hint={section.hint}
        toolbar={section.toolbar}
        showShortTerm={showShortTerm}
      />
      {section.rows.length === 0 && section.emptyHint ? (
        <div className={cn(feeColSpan(showShortTerm), "border-b border-border/70 px-3 py-2.5 text-xs text-muted")}>
          {section.emptyHint}
        </div>
      ) : null}
      {section.rows.map((row) => (
        <ExpandableRows key={row.id} row={row} showShortTerm={showShortTerm} />
      ))}
    </>
  );
}
