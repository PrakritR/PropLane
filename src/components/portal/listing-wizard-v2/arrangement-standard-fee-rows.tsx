"use client";

import { FactRow, MoneyInput } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import type { RoomOccupancyPrice } from "@/lib/room-arrangement-pricing";
import { arrangementLabel } from "@/lib/room-arrangement-pricing";

export type ArrangementFeePatch = Partial<
  Pick<
    RoomOccupancyPrice,
    | "leaseFee"
    | "applicationFee"
    | "moveInFee"
    | "monthToMonthSurcharge"
    | "customStartSurcharge"
  >
>;

/** Per-arrangement lease / application / move-in and surcharges (studio 0929 room pricing). */
export function ArrangementStandardFeeRows({
  count,
  row,
  onPatch,
  showMonthToMonth,
  showCustomStart,
  readOnly = false,
}: {
  count: number;
  row: RoomOccupancyPrice;
  onPatch: (patch: ArrangementFeePatch) => void;
  showMonthToMonth: boolean;
  showCustomStart: boolean;
  readOnly?: boolean;
}) {
  const per = count > 1 ? " per resident" : "";
  const title = count > 1 ? "Fees per resident" : "Fees";
  return (
    <>
      <p className="border-t border-border px-4 pt-2.5 text-[12.5px] font-bold text-muted">{title}</p>
      <FactRow label={`Lease fee${per}`}>
        <MoneyInput
          label={`${arrangementLabel(count)} lease fee`}
          value={row.leaseFee ?? ""}
          inherited={readOnly}
          onChange={(v) => onPatch({ leaseFee: v })}
        />
      </FactRow>
      <FactRow label={`Application fee${per}`}>
        <MoneyInput
          label={`${arrangementLabel(count)} application fee`}
          value={row.applicationFee ?? ""}
          inherited={readOnly}
          onChange={(v) => onPatch({ applicationFee: v })}
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
