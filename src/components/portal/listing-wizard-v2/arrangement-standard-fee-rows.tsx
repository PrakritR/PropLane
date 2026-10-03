"use client";

import { FactRow, MoneyInput } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import type { RoomOccupancyPrice } from "@/lib/room-arrangement-pricing";
import { arrangementLabel } from "@/lib/room-arrangement-pricing";
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

/**
 * Per-arrangement lease / application / move-in and surcharges (studio 0929 room pricing).
 *
 * Lease fee and Application fee belong to the step they sit on: the Long-term step edits
 * the shared values, the Short term step edits its own (`scope="short"`), and a short-term
 * box with no value of its own shows the shared one greyed until the manager types.
 */
export function ArrangementStandardFeeRows({
  count,
  row,
  onPatch,
  showMonthToMonth,
  showCustomStart,
  readOnly = false,
  scope = "long",
}: {
  count: number;
  row: RoomOccupancyPrice;
  onPatch: (patch: ArrangementFeePatch) => void;
  showMonthToMonth: boolean;
  showCustomStart: boolean;
  readOnly?: boolean;
  /** Which step this block sits on - decides which stored Lease fee / Application fee it edits. */
  scope?: RoomFeeTermScope;
}) {
  const per = count > 1 ? " per resident" : "";
  const lease = termFeeText(row, "leaseFee", scope);
  const application = termFeeText(row, "applicationFee", scope);
  const stepName = scope === "short" ? "short term" : "long-term";
  return (
    <>
      <FactRow label={`Lease fee${per}`}>
        <MoneyInput
          label={`${arrangementLabel(count)} ${stepName} lease fee`}
          value={lease.value}
          placeholder={lease.placeholder}
          inherited={readOnly || !lease.own}
          dataAttr={`arrangement-lease-fee-${scope}`}
          onChange={(v) => onPatch(termFeePatch("leaseFee", scope, v))}
        />
      </FactRow>
      <FactRow label={`Application fee${per}`}>
        <MoneyInput
          label={`${arrangementLabel(count)} ${stepName} application fee`}
          value={application.value}
          placeholder={application.placeholder}
          inherited={readOnly || !application.own}
          dataAttr={`arrangement-application-fee-${scope}`}
          onChange={(v) => onPatch(termFeePatch("applicationFee", scope, v))}
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
