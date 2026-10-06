"use client";

import { FactRow, MoneyInput } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import type { RoomOccupancyPrice } from "@/lib/room-arrangement-pricing";
import { arrangementLabel } from "@/lib/room-arrangement-pricing";
import { formatPlacementMoneyField } from "@/lib/listing-placement-standard-fees";
import { termFeePatch, termFeeText, type RoomFeeTermScope } from "@/lib/room-term-fees";

export type ArrangementFeePatch = Partial<
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

type FeeKind = "leaseFee" | "applicationFee";

/**
 * Per-arrangement lease / application / move-in and surcharges (studio 0929 room pricing).
 *
 * Lease fee and Application fee belong to the step they sit on. Two storage shapes feed the one
 * placement resolver (`listing-placement-standard-fees.ts`):
 *
 *  - `storage="term"` (a room): `row` IS the step's own fees (the room's `termPricing` entry, or
 *    its long-term arrangement row); the box edits `leaseFee` / `applicationFee` as given, and
 *    `inheritedRow` is what an empty box follows (shown greyed until the manager types).
 *  - `storage="stayFields"` (default; the whole-house row has no room to hold a term entry): the
 *    Long-term step edits the shared values, the Short term step edits `shortTermLeaseFee` /
 *    `shortTermApplicationFee` on the same row, and shows the shared value greyed until typed.
 */
export function ArrangementStandardFeeRows({
  count,
  row,
  onPatch,
  showMonthToMonth,
  showCustomStart,
  readOnly = false,
  scope = "long",
  storage = "stayFields",
  inheritedRow,
  templateDefaults,
}: {
  count: number;
  row: RoomOccupancyPrice;
  onPatch: (patch: ArrangementFeePatch) => void;
  showMonthToMonth: boolean;
  showCustomStart: boolean;
  readOnly?: boolean;
  /** Which step this block sits on (labels, and the stored fields when `storage="stayFields"`). */
  scope?: RoomFeeTermScope;
  storage?: "term" | "stayFields";
  /** `storage="term"`: the fees an empty box inherits (the step this one follows). */
  inheritedRow?: Partial<Record<FeeKind, string>>;
  /**
   * The Application fee / Lease fee this step's templates set (the application's and the lease's own fee). An
   * empty box follows it, shown greyed; typing one is this room's override, and Reset clears it again.
   */
  templateDefaults?: Partial<Record<FeeKind, string>>;
}) {
  const per = count > 1 ? " per resident" : "";
  const fieldScope: RoomFeeTermScope = storage === "term" ? "long" : scope;
  const box = (kind: FeeKind) => {
    const text = termFeeText(row, kind, fieldScope);
    const templateDefault = formatPlacementMoneyField(templateDefaults?.[kind] ?? "");
    if (text.value === "" && templateDefault) return { value: "", placeholder: templateDefault, own: false };
    if (text.own && text.value === "" && inheritedRow) {
      const inherited = String(inheritedRow[kind] ?? "").trim();
      if (inherited) return { value: "", placeholder: inherited, own: false };
    }
    return text;
  };
  const hasOverride = (field: { value: string; own: boolean }) => field.own && field.value !== "";
  const lease = box("leaseFee");
  const application = box("applicationFee");
  const stepName = scope === "short" ? "short term" : "long-term";
  return (
    <>
      <FactRow
        label={`Lease fee${per}`}
        own={!readOnly && hasOverride(lease)}
        onReset={() => onPatch(termFeePatch("leaseFee", fieldScope, ""))}
        resetLabel={`Reset ${arrangementLabel(count)} ${stepName} lease fee to the lease's fee`}
        resetTitle="Back to the lease's fee"
      >
        <MoneyInput
          label={`${arrangementLabel(count)} ${stepName} lease fee`}
          value={lease.value}
          placeholder={lease.placeholder}
          inherited={readOnly || !lease.own}
          dataAttr={`arrangement-lease-fee-${scope}`}
          onChange={(v) => onPatch(termFeePatch("leaseFee", fieldScope, v))}
        />
      </FactRow>
      <FactRow
        label={`Application fee${per}`}
        own={!readOnly && hasOverride(application)}
        onReset={() => onPatch(termFeePatch("applicationFee", fieldScope, ""))}
        resetLabel={`Reset ${arrangementLabel(count)} ${stepName} application fee to the application's fee`}
        resetTitle="Back to the application's fee"
      >
        <MoneyInput
          label={`${arrangementLabel(count)} ${stepName} application fee`}
          value={application.value}
          placeholder={application.placeholder}
          inherited={readOnly || !application.own}
          dataAttr={`arrangement-application-fee-${scope}`}
          onChange={(v) => onPatch(termFeePatch("applicationFee", fieldScope, v))}
        />
      </FactRow>
      <FactRow label={`Move-in fee${per}`}>
        <MoneyInput
          label={`${arrangementLabel(count)} move-in fee`}
          value={row.moveInFee ?? ""}
          inherited={readOnly}
          onChange={(v) => onPatch({ moveInFee: v })}
        />
      </FactRow>
      {showMonthToMonth ? (
        <FactRow label="Month-to-month surcharge">
          <MoneyInput
            label={`${arrangementLabel(count)} month-to-month surcharge`}
            value={row.monthToMonthSurcharge ?? ""}
            inherited={readOnly}
            onChange={(v) => onPatch({ monthToMonthSurcharge: v })}
          />
        </FactRow>
      ) : null}
      {showCustomStart ? (
        <FactRow label="Custom start surcharge">
          <MoneyInput
            label={`${arrangementLabel(count)} custom start surcharge`}
            value={row.customStartSurcharge ?? ""}
            inherited={readOnly}
            onChange={(v) => onPatch({ customStartSurcharge: v })}
          />
        </FactRow>
      ) : null}
    </>
  );
}
