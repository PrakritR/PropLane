"use client";

import { ArrangementStandardFeeRows } from "@/components/portal/listing-wizard-v2/arrangement-standard-fee-rows";
import { FactRow, MoneyInput, MultiPick, RowSelectCell } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import {
  arrangementLabel,
  offeredResidentCountsFor,
  roomPriceForResidentCount,
  type RoomOccupancyPrice,
} from "@/lib/room-arrangement-pricing";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import {
  FeeRows,
  ProrateRows,
  perDay,
  type Patch,
} from "@/components/portal/listing-wizard-v2/listing-pricing-step";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import {
  longTermPrivateArrangementRow,
  mergeTermStandardFees,
  termStandardFeeRow,
} from "@/lib/listing-placement-standard-fees";

const PRICING_MODE_OPTIONS = [
  { value: "fixed", label: "Fixed" },
  { value: "flexible", label: "Flexible" },
];

function moneyText(n: number | undefined): string {
  return n && n > 0 ? String(n) : "";
}

function moneyFromInput(v: string): number | undefined {
  return Number(String(v).replace(/[^0-9.]/g, "")) || undefined;
}

function usd(n: number): string {
  return `$${Math.round(n || 0).toLocaleString("en-US")}`;
}

/**
 * Pricing card body for a shared room: Offered as + one rent set per head-count,
 * with Same as for counts above 1.
 */
export function ArrangementPriceEditor({
  room,
  onRoom,
  sub,
  patch,
  term,
  prorate,
  showCustomStartSurcharge = false,
  showResidentsCapacity = false,
  stayMode = false,
}: {
  room: ManagerRoomSubmission;
  onRoom: (next: ManagerRoomSubmission) => void;
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  term: string;
  prorate: boolean;
  showCustomStartSurcharge?: boolean;
  showResidentsCapacity?: boolean;
  /** Short-term property pricing — nightly rate and deposit per arrangement band. */
  stayMode?: boolean;
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

  const mergeRows = (count: number, rowPatch: Partial<RoomOccupancyPrice>): RoomOccupancyPrice[] => {
    const byCount = new Map<number, RoomOccupancyPrice>();
    for (const n of offered) byCount.set(n, { ...rowFor(n), count: n });
    byCount.set(count, { ...byCount.get(count)!, ...rowPatch, count });
    return [...byCount.values()].sort((a, b) => a.count - b.count);
  };

  const writeRow = (count: number, rowPatch: Partial<RoomOccupancyPrice>) => {
    const next = mergeRows(count, rowPatch);
    const resolved = roomPriceForResidentCount({ ...room, occupancyPrices: next }, 1);
    onRoom({
      ...room,
      offeredResidentCounts: offered,
      occupancyPrices: next,
      monthlyRent: count === 1 && rowPatch.monthlyRent ? rowPatch.monthlyRent : resolved.monthlyRent || room.monthlyRent,
      residentPricing: undefined,
      residentPrices: undefined,
    });
  };

  // Long-term fees live on the arrangement row; every other stay type keeps its OWN fees
  // (a stay type's value replaces the house one, empty inherits) on the room's term entry.
  const feeTerm = term || (stayMode ? SHORT_TERM_LEASE_TERM : LONG_TERM_LEASE_TERM);
  const feesOnTerm = stayMode || feeTerm !== LONG_TERM_LEASE_TERM;
  const feeRowFor = (count: number, row: RoomOccupancyPrice): RoomOccupancyPrice =>
    feesOnTerm ? { count, ...termStandardFeeRow(room, feeTerm, count) } : row;
  const writeFees = (count: number, feePatch: Partial<RoomOccupancyPrice>) => {
    if (!feesOnTerm) {
      writeRow(count, feePatch);
      return;
    }
    onRoom(mergeTermStandardFees(room, feeTerm, feePatch, count));
  };

  const renderOwnBand = (count: number, row: RoomOccupancyPrice, resolved: ReturnType<typeof roomPriceForResidentCount>) => {
    const name = arrangementLabel(count);
    if (stayMode) {
      const nightly =
        row.shortTermRent?.trim() ||
        (count === 1 ? String(room.shortTermRent ?? "").trim() : "") ||
        "";
      const deposit = row.securityDeposit ?? resolved.securityDeposit ?? room.securityDeposit ?? "";
      return (
        <>
          <FactRow label="Nightly rate per resident">
            <MoneyInput
              label={`${name} nightly rate`}
              value={nightly}
              onChange={(v) => writeRow(count, { shortTermRent: v, sameAs: undefined })}
            />
          </FactRow>
          <FactRow label="Deposit per resident">
            <MoneyInput
              label={`${name} deposit`}
              value={deposit}
              onChange={(v) => writeRow(count, { securityDeposit: v })}
            />
          </FactRow>
          <FeeRows
            sub={sub}
            patch={patch}
            roomId={room.id}
            roomName={name}
            term={term || SHORT_TERM_LEASE_TERM}
            arrangementCount={count}
          />
          <ArrangementStandardFeeRows
            count={count}
            row={feeRowFor(count, row)}
            onPatch={(feePatch) => writeFees(count, feePatch)}
            showCustomStart={false}
            scope="short"
            storage="term"
            inheritedRow={longTermPrivateArrangementRow(room)}
          />
        </>
      );
    }
    const automatic = (row.prorateMethod ?? resolved.prorateMethod) !== "daily_rate";
    const splitMode = count > 1 && row.wholeRoomMonthlyRent != null && row.wholeRoomMonthlyRent > 0;
    const eachPays =
      splitMode && count > 1 ? Math.floor((row.wholeRoomMonthlyRent ?? 0) / count) : resolved.monthlyRent;

    const rentShape = splitMode ? "split" : "own";

    return (
      <>
        {count > 1 ? (
          <FactRow label="Rent shape">
            <RowSelectCell
              ariaLabel={`Rent shape for ${name}`}
              value={rentShape}
              options={[
                { value: "own", label: "Same price for each resident" },
                { value: "split", label: "Whole room price, split evenly" },
              ]}
              onChange={(value) => {
                if (value === "split") {
                  const total = (row.wholeRoomMonthlyRent ?? (row.monthlyRent ?? resolved.monthlyRent) * count) || 0;
                  writeRow(count, {
                    wholeRoomMonthlyRent: total > 0 ? total : undefined,
                    monthlyRent: total > 0 ? Math.floor(total / count) : undefined,
                  });
                  return;
                }
                writeRow(count, { wholeRoomMonthlyRent: undefined });
              }}
            />
          </FactRow>
        ) : null}
        {splitMode ? (
          <>
            <FactRow label="Whole room rent /mo">
              <MoneyInput
                label={`${name} whole room rent`}
                value={moneyText(row.wholeRoomMonthlyRent)}
                dataAttr="listing-v2-arrangement-whole-rent"
                onChange={(v) => {
                  const total = Number(String(v).replace(/[^0-9.]/g, "")) || 0;
                  writeRow(count, {
                    wholeRoomMonthlyRent: total || undefined,
                    monthlyRent: total > 0 ? Math.floor(total / count) : undefined,
                  });
                }}
              />
            </FactRow>
            <FactRow label="Each resident pays">
              <span className="text-[13px] font-semibold text-foreground" data-rp-each={count}>
                {eachPays > 0 ? `${usd(eachPays)}/mo` : "—"}
              </span>
            </FactRow>
          </>
        ) : (
          <FactRow label="Rent /mo per resident">
            <MoneyInput
              label={`${name} rent per resident`}
              value={moneyText(row.monthlyRent ?? (count === 1 ? room.monthlyRent : resolved.monthlyRent))}
              dataAttr="listing-v2-arrangement-rent"
              onChange={(v) =>
                writeRow(count, {
                  sameAs: undefined,
                  wholeRoomMonthlyRent: undefined,
                  monthlyRent: Number(String(v).replace(/[^0-9.]/g, "")) || undefined,
                })
              }
            />
          </FactRow>
        )}
        <FactRow label="Utilities /mo per resident">
          <MoneyInput
            label={`${name} utilities`}
            value={row.utilitiesEstimate ?? resolved.utilitiesEstimate}
            onChange={(v) => writeRow(count, { utilitiesEstimate: v })}
          />
        </FactRow>
        <FactRow label="Deposit per resident">
          <MoneyInput
            label={`${name} deposit`}
            value={row.securityDeposit ?? resolved.securityDeposit}
            onChange={(v) => writeRow(count, { securityDeposit: v })}
          />
        </FactRow>
        <FactRow label="Listed rent">
          <RowSelectCell
            ariaLabel={`Listed rent for ${name}`}
            value={row.pricingMode ?? room.pricingMode ?? "fixed"}
            options={PRICING_MODE_OPTIONS}
            onChange={(v) => writeRow(count, { pricingMode: v as "fixed" | "flexible" })}
          />
        </FactRow>
        {count > 1 || capacity < 2 ? (
          <>
            <FeeRows
              sub={sub}
              patch={patch}
              roomId={room.id}
              roomName={name}
              term={term}
              arrangementCount={count}
            />
            {prorate ? (
              <ProrateRows
                sub={sub}
                patch={patch}
                term={term}
                roomId={room.id}
                name={name}
                automatic={automatic}
                onAutomatic={(next) => writeRow(count, { prorateMethod: next ? "auto" : "daily_rate" })}
                rent={{
                  text: row.dailyRentRate ? String(row.dailyRentRate) : "",
                  placeholder: perDay(resolved.monthlyRent) || "35",
                  onChange: (v) => writeRow(count, { dailyRentRate: moneyFromInput(v) }),
                }}
                util={
                  Number(resolved.utilitiesEstimate.replace(/[^0-9.]/g, "")) > 0
                    ? {
                        text: row.dailyUtilitiesRate ? String(row.dailyUtilitiesRate) : "",
                        placeholder: perDay(Number(resolved.utilitiesEstimate.replace(/[^0-9.]/g, "")) || 0),
                        onChange: (v) => writeRow(count, { dailyUtilitiesRate: moneyFromInput(v) }),
                      }
                    : null
                }
                arrangementCount={count}
                dataAttr={`listing-v2-price-prorate-arrangement-${count}`}
              />
            ) : null}
          </>
        ) : null}
        <ArrangementStandardFeeRows
          count={count}
          row={feeRowFor(count, row)}
          onPatch={(feePatch) => writeFees(count, feePatch)}
          showCustomStart={showCustomStartSurcharge && term === "Long-term"}
        />
      </>
    );
  };

  return (
    <>
      {showResidentsCapacity && capacity > 1 ? (
        <FactRow label="Residents">
          <span className="text-[13px] font-semibold text-muted">{capacity} · set on Rooms</span>
        </FactRow>
      ) : null}
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
                    writeRow(
                      count,
                      value === "own"
                        ? { sameAs: undefined, monthlyRent: resolved.monthlyRent }
                        : { sameAs: Number(value) },
                    )
                  }
                />
              )}
            </FactRow>
            {own ? renderOwnBand(count, row, resolved) : null}
          </div>
        );
      })}
    </>
  );
}
