"use client";

import { FactRow, MoneyInput, MultiPick, RowSelectCell } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import {
  arrangementLabel,
  offeredResidentCountsFor,
  roomPriceForResidentCount,
  type RoomOccupancyPrice,
} from "@/lib/room-arrangement-pricing";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";

function moneyText(n: number | undefined): string {
  return n && n > 0 ? String(n) : "";
}

/**
 * Pricing card body for a shared room: Offered as + one rent set per head-count,
 * with Same as for counts above 1.
 */
export function ArrangementPriceEditor({
  room,
  onRoom,
}: {
  room: ManagerRoomSubmission;
  onRoom: (next: ManagerRoomSubmission) => void;
}) {
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const offered = offeredResidentCountsFor(room);
  const options = Array.from({ length: capacity }, (_, i) => arrangementLabel(i + 1));
  const selected = offered.map(arrangementLabel);

  const writeOffers = (labels: string[]) => {
    const counts = labels
      .map((label) => options.indexOf(label) + 1)
      .filter((n) => n >= 1);
    if (!counts.includes(1)) counts.unshift(1);
    const nextCounts = [...new Set(counts)].sort((a, b) => a - b);
    const prices = (room.occupancyPrices ?? []).filter((row) => nextCounts.includes(row.count));
    onRoom({
      ...room,
      offeredResidentCounts: nextCounts,
      occupancyPrices: prices,
      residentPricing: undefined,
      residentPrices: undefined,
    });
  };

  const rowFor = (count: number): RoomOccupancyPrice =>
    room.occupancyPrices?.find((row) => row.count === count) ?? { count };

  const writeRow = (count: number, patch: Partial<RoomOccupancyPrice>) => {
    const current = offered.map((n) => ({ ...rowFor(n), count: n }));
    const next = current.map((row) => (row.count === count ? { ...row, ...patch, count } : row));
    const resolved = roomPriceForResidentCount(
      { ...room, occupancyPrices: next },
      1,
    );
    onRoom({
      ...room,
      offeredResidentCounts: offered,
      occupancyPrices: next,
      monthlyRent: count === 1 && patch.monthlyRent ? patch.monthlyRent : resolved.monthlyRent || room.monthlyRent,
      residentPricing: undefined,
      residentPrices: undefined,
    });
  };

  return (
    <>
      <FactRow label="Offered as">
        <MultiPick
          label="Offered as"
          options={options}
          selected={selected}
          allowOther={false}
          dataAttr="listing-v2-offered-as"
          onChange={writeOffers}
        />
      </FactRow>
      {offered.map((count) => {
        const row = rowFor(count);
        const resolved = roomPriceForResidentCount({ ...room, occupancyPrices: room.occupancyPrices }, count);
        const own = !row.sameAs;
        const sameOptions = offered
          .filter((n) => n < count)
          .map((n) => ({ value: String(n), label: n === 1 ? "Same as Private" : `Same as Shared by ${n}` }));
        return (
          <div key={count} className="border-t border-border bg-[#eff4ff]/60">
            <FactRow label={arrangementLabel(count)}>
              {count === 1 ? (
                <span className="text-[13px] font-semibold text-muted">Rent per resident</span>
              ) : (
                <RowSelectCell
                  ariaLabel={`Same as for ${arrangementLabel(count)}`}
                  value={row.sameAs ? String(row.sameAs) : "own"}
                  options={[{ value: "own", label: "Different prices" }, ...sameOptions]}
                  onChange={(value) =>
                    writeRow(count, value === "own" ? { sameAs: undefined, monthlyRent: resolved.monthlyRent } : { sameAs: Number(value) })
                  }
                />
              )}
            </FactRow>
            {own ? (
              <>
                <FactRow label="Rent /mo per resident">
                  <MoneyInput
                    label={`${arrangementLabel(count)} rent per resident`}
                    value={moneyText(row.monthlyRent ?? (count === 1 ? room.monthlyRent : resolved.monthlyRent))}
                    dataAttr="listing-v2-arrangement-rent"
                    onChange={(v) => writeRow(count, { sameAs: undefined, monthlyRent: Number(String(v).replace(/[^0-9.]/g, "")) || undefined })}
                  />
                </FactRow>
                <FactRow label="Utilities /mo per resident">
                  <MoneyInput
                    label={`${arrangementLabel(count)} utilities`}
                    value={row.utilitiesEstimate ?? resolved.utilitiesEstimate}
                    onChange={(v) => writeRow(count, { utilitiesEstimate: v })}
                  />
                </FactRow>
                <FactRow label="Deposit per resident">
                  <MoneyInput
                    label={`${arrangementLabel(count)} deposit`}
                    value={row.securityDeposit ?? resolved.securityDeposit}
                    onChange={(v) => writeRow(count, { securityDeposit: v })}
                  />
                </FactRow>
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
