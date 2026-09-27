"use client";

import { FactRow, MoneyInput, MultiPick, RowSelectCell } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import {
  arrangementLabel,
  offeredResidentCountsFor,
  roomPriceForResidentCount,
  type RoomOccupancyPrice,
} from "@/lib/room-arrangement-pricing";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { FeeRows, ProrateRows, perDay, type Patch } from "@/components/portal/listing-wizard-v2/listing-pricing-step";

function moneyText(n: number | undefined): string {
  return n && n > 0 ? String(n) : "";
}

function moneyFromInput(v: string): number | undefined {
  return Number(String(v).replace(/[^0-9.]/g, "")) || undefined;
}

/**
 * Pricing card body for a shared room: Offered as + one rent set per head-count,
 * with Same as for counts above 1.
 *
 * N082: every "Different prices" arrangement (Shared by 2, Shared by 3, …) also
 * gets its own Other fees and Partial months, exactly like the room's Private
 * (count 1) row already does at the bottom of the room card in
 * `listing-pricing-step.tsx` — this component renders ONLY the counts >= 2,
 * since count 1's fees/prorate stay on that existing room-level block
 * unchanged (`arrangementCount={1}` there, `arrangementCount={count}` here —
 * see `FeeRows`' own doc for how the two never collide). A "Same as N"
 * arrangement has no fee/prorate rows of its own: it inherits N's, same as it
 * inherits N's rent.
 */
export function ArrangementPriceEditor({
  room,
  onRoom,
  sub,
  patch,
  term,
  prorate,
}: {
  room: ManagerRoomSubmission;
  onRoom: (next: ManagerRoomSubmission) => void;
  /** The whole submission, for the per-arrangement Other fees / Partial months blocks (`FeeRows`/`ProrateRows` read and write the listing's shared `customFees` list, not just this room). */
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  /** The fee-scope term for this tab (long-term/month-to-month/custom dates) — same value the room card's own Other fees/Partial months already use. */
  term: string;
  /** Whether this lease type can start mid-month, so Partial months applies at all (`proratesOnTab(term)` at the call site). */
  prorate: boolean;
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

  const writeRow = (count: number, rowPatch: Partial<RoomOccupancyPrice>) => {
    const current = offered.map((n) => ({ ...rowFor(n), count: n }));
    const next = current.map((row) => (row.count === count ? { ...row, ...rowPatch, count } : row));
    const resolved = roomPriceForResidentCount(
      { ...room, occupancyPrices: next },
      1,
    );
    onRoom({
      ...room,
      offeredResidentCounts: offered,
      occupancyPrices: next,
      monthlyRent: count === 1 && rowPatch.monthlyRent ? rowPatch.monthlyRent : resolved.monthlyRent || room.monthlyRent,
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
        const name = arrangementLabel(count);
        const automatic = (row.prorateMethod ?? resolved.prorateMethod) !== "daily_rate";
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
                {count > 1 ? (
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
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
