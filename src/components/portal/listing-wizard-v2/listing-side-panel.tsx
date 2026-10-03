"use client";

/**
 * The right-hand panel of the listing workspace — the consequence of whatever
 * the manager is editing on the left.
 *
 * It is a different thing on every step, and never decoration:
 *
 * - **Basics / Review** — the listing card a renter sees.
 * - **Rooms** — that room's card, so "is this room described well enough" is
 *   answerable without leaving the form.
 * - **Bathrooms** — who shares what, per room, which is the question a shared
 *   house is actually judged on.
 * - **Shared spaces** — what the listing claims the house has.
 * - **Pricing** — the move-in receipt, and the only editable panel: its
 *   checkboxes write the per-lease-type signing matrix (Every room) or a
 *   room override, through one shared helper.
 */

import { useMemo, useState } from "react";
import { Image as ImageIcon, ImageOff, Check, AlertTriangle } from "lucide-react";
import { PanelLine, PanelSection, RowSelectCell } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { buildListingQuote, type ListingQuoteStartKind } from "@/lib/listing-quote";
import {
  arrangementSummaryLine,
  offeredResidentCountsFor,
  roomPriceForResidentCount,
} from "@/lib/room-arrangement-pricing";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { applyPaymentAtSigningCell, clearRoomPaymentAtSigning } from "@/lib/listing-fees";
import { roomHasOwnPaymentAtSigning } from "@/lib/listing-fee-scope";
import {
  isEntireHomeListing,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { parseMoneyAmount } from "@/lib/parse-money";
import { deriveRoomAvailability, formatDateKeyShort, legacyMoveInDateAsSpan, manualRangesToSpans, todayDateKey } from "@/lib/room-availability-timeline";

const usd = (n: number) => `$${Math.round(n || 0).toLocaleString("en-US")}`;

/** "a, b and c" — how the listing itself writes a list. */
function sentenceList(items: string[]): string {
  const list = items.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length < 3) return list.join(" and ");
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

function Cover({ photos, label }: { photos: number; label?: string }) {
  return (
    <div
      className={
        photos > 0
          ? "grid h-[112px] place-items-center rounded-xl bg-accent/60 text-muted"
          : "grid h-[112px] place-items-center rounded-xl border border-dashed border-border bg-accent/40 text-muted"
      }
    >
      <div className="flex flex-col items-center gap-1 text-[12.5px] font-semibold">
        {photos > 0 ? <ImageIcon className="h-5 w-5" aria-hidden /> : <ImageOff className="h-5 w-5" aria-hidden />}
        <span>{photos > 0 ? `${photos} ${photos === 1 ? "photo" : "photos"}` : label ?? "No photos yet"}</span>
      </div>
    </div>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5">
      {rows.map(([dt, dd]) => (
        <div key={dt}>
          <dt className="text-[11.5px] text-muted">{dt}</dt>
          <dd className="text-[13px] font-semibold text-foreground">{dd}</dd>
        </div>
      ))}
    </dl>
  );
}

function PanelNote({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-border pt-2.5 text-[12.5px] text-muted">
      <b className="mb-0.5 block text-[12.5px] font-semibold text-foreground">{title}</b>
      {children}
    </div>
  );
}

/* ─────────────────────── the listing itself ─────────────────────── */

export function ListingPreviewPanel({
  sub,
  highlightRoomId = null,
}: {
  sub: ManagerListingSubmissionV1;
  /** Highlights the open room card in the preview (wizard Rooms step). */
  highlightRoomId?: string | null;
}) {
  const rooms = sub.rooms ?? [];
  const photos =
    (sub.housePhotoDataUrls ?? []).length +
    rooms.reduce((n, r) => n + (r.photoDataUrls ?? []).length, 0) +
    (sub.bathrooms ?? []).reduce((n, b) => n + (b.photoDataUrls ?? []).length, 0);
  const priced = rooms.map((r) => r.monthlyRent).filter((n) => n > 0);
  const from = priced.length > 0 ? Math.min(...priced) : 0;
  const residents = rooms.reduce((n, r) => n + (r.occupancyCapacity ?? 1), 0);
  const amenities = (sub.amenitiesText ?? "")
    .split(/[\n,]/)
    .map((line: string) => line.trim())
    .filter(Boolean);

  return (
    <PanelSection title="Listing preview">
      <Cover photos={photos} />
      <p className="mt-2.5 text-[19px] font-extrabold tracking-tight text-foreground pr9-pv-price" data-attr="listing-v2-preview-price">
        {from > 0 ? (
          <>
            From {usd(from)}
            <span className="text-[12.5px] font-medium text-muted"> a month</span>
          </>
        ) : (
          <span className="text-[13px] font-semibold text-[var(--status-pending-fg)]">Price not set</span>
        )}
      </p>
      <h4 className="text-[14.5px] font-bold text-foreground">
        {sub.buildingName?.trim() || sub.address?.trim() || "Untitled listing"}
      </h4>
      <p className="text-[11.5px] text-muted">
        {[sub.address, sub.city, sub.state, sub.zip].filter(Boolean).join(", ")}
      </p>
      <Facts
        rows={[
          ["Rooms", String(rooms.length)],
          ["Bathrooms", String((sub.bathrooms ?? []).length)],
          ["Residents", residents > 0 ? `Up to ${residents}` : "—"],
          ["Available", listingAvailabilityFact(rooms)],
        ]}
      />
      {highlightRoomId ? <span className="sr-only" data-attr="listing-v2-preview-highlight-room">{highlightRoomId}</span> : null}
      {amenities.length > 0 ? (
        <PanelNote title="Amenities">{sentenceList(amenities.slice(0, 8))}</PanelNote>
      ) : null}
    </PanelSection>
  );
}

/* ─────────────────────── one room ─────────────────────── */

export function RoomPreviewPanel({
  sub,
  room,
}: {
  sub: ManagerListingSubmissionV1;
  room: ManagerRoomSubmission | null;
}) {
  if (!room) {
    return (
      <PanelSection title="Applicant view">
        <p className="text-[13px] font-semibold text-foreground/70">No rooms yet</p>
      </PanelSection>
    );
  }
  const photos = (room.photoDataUrls ?? []).length;
  const baths = (sub.bathrooms ?? []).filter((b) => (b.assignedRoomIds ?? []).includes(room.id));
  const access = baths.length === 0 ? "Not assigned" : baths[0]?.accessKindByRoomId?.[room.id] === "ensuite" ? "Private" : "Shared";
  const amenities = (room.roomAmenitiesText ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <PanelSection title={`How ${room.name?.trim() || "this room"} looks`}>
      <Cover photos={photos} />
      <p className="mt-2.5 text-[19px] font-extrabold tracking-tight text-foreground">
        {room.monthlyRent > 0 ? (
          <>
            {usd(room.monthlyRent)}
            <span className="text-[12.5px] font-medium text-muted"> a month</span>
          </>
        ) : (
          <span className="text-[13px] font-semibold text-[var(--status-pending-fg)]">Rent not set</span>
        )}
      </p>
      <h4 className="text-[14.5px] font-bold text-foreground">{room.name?.trim() || "Room"}</h4>
      <Facts
        rows={[
          ["Beds", room.bedCount ? String(room.bedCount) : "Not stated"],
          ["Residents", (room.occupancyCapacity ?? 1) === 1 ? "1 person" : `Up to ${room.occupancyCapacity}`],
          ["Floor", room.floor?.trim() || "—"],
          ["Bathroom", access],
          ...(room.sizeSqft ? ([["Size", `${room.sizeSqft} sq ft`]] as [string, string][]) : []),
          ["Furnishing", room.furnishing?.trim() || "Not stated"],
        ]}
      />
      {amenities.length > 0 ? <PanelNote title="Room amenities">{sentenceList(amenities)}</PanelNote> : null}
    </PanelSection>
  );
}

/* ─────────────────────── bathrooms ─────────────────────── */

export function BathroomCoveragePanel({ sub }: { sub: ManagerListingSubmissionV1 }) {
  const rooms = sub.rooms ?? [];
  const baths = sub.bathrooms ?? [];
  const residents = rooms.reduce((n, r) => n + (r.occupancyCapacity ?? 1), 0);
  return (
    <PanelSection title="Bathroom access by room">
      <p className="text-[13px] text-muted">
        <b className="text-[21px] font-extrabold tabular-nums text-foreground">{residents}</b> residents share{" "}
        <b className="font-extrabold tabular-nums text-foreground">{baths.length}</b>{" "}
        {baths.length === 1 ? "bathroom" : "bathrooms"}
      </p>
      <div className="mt-2.5">
        {rooms.map((room) => {
          const serving = baths.filter((b) => (b.assignedRoomIds ?? []).includes(room.id));
          const shared = serving[0]
            ? (serving[0].assignedRoomIds ?? []).reduce(
                (n, id) => n + ((rooms.find((r) => r.id === id)?.occupancyCapacity ?? 1) || 1),
                0,
              )
            : 0;
          return (
            <div key={room.id} className="flex gap-2.5 border-t border-border py-2.5 first:border-t-0 first:pt-0">
              {serving.length > 0 ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-confirmed-fg)]" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-pending-fg)]" aria-hidden />
              )}
              <div className="min-w-0">
                <b className="block text-[13px] font-semibold text-foreground">{room.name?.trim() || "Room"}</b>
                <span className="text-[12px] text-muted">
                  {serving.length === 0
                    ? "No bathroom assigned"
                    : serving[0]?.accessKindByRoomId?.[room.id] === "ensuite"
                      ? `${serving[0]?.name?.trim() || "Bathroom"}, private`
                      : `${serving[0]?.name?.trim() || "Bathroom"}, shared by ${shared} ${shared === 1 ? "person" : "people"}`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </PanelSection>
  );
}

/* ─────────────────────── shared spaces ─────────────────────── */

export function SharedSpacesPanel({ sub }: { sub: ManagerListingSubmissionV1 }) {
  const spaces = sub.sharedSpaces ?? [];
  return (
    <PanelSection title="Shared spaces on your listing">
      {spaces.length === 0 ? (
        <p className="text-[13px] font-semibold text-foreground/70">No shared spaces yet</p>
      ) : (
        spaces.map((space) => {
          const amenities = (space.amenitiesText ?? "")
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
          return (
            <div key={space.id} className="border-t border-border py-2.5 first:border-t-0 first:pt-0">
              <b className="block text-[13px] font-semibold text-foreground">{space.name?.trim() || "Space"}</b>
              <span className="text-[12px] text-muted">
                {amenities.length > 0 ? sentenceList(amenities) : "No amenities listed"}
              </span>
            </div>
          );
        })
      )}
    </PanelSection>
  );
}

/* ─────────────────────── the receipt ─────────────────────── */

/**
 * What the resident pays, and the only panel that writes.
 *
 * Unticking a line is how a manager says "I'll collect that later", which is
 * exactly the per-lease-type signing matrix — so the checkbox writes it through
 * `applyPaymentAtSigningCell` rather than keeping a second opinion of its own.
 */
export function PricingReceiptPanel({
  sub,
  patch,
  leaseTerm,
  roomId,
  onRoomChange,
  onLeaseTermChange,
  leaseTerms,
  lockLeaseTerm = false,
  plainReceipt = false,
  allowMonthToMonthStart = false,
  allowCustomStart = false,
}: {
  sub: ManagerListingSubmissionV1;
  patch: (next: Partial<ManagerListingSubmissionV1>) => void;
  leaseTerm: string;
  roomId: string | null;
  onRoomChange: (id: string | null) => void;
  onLeaseTermChange: (term: string) => void;
  leaseTerms: string[];
  /** When true, the lease type follows the active pricing tab instead of a separate picker. */
  lockLeaseTerm?: boolean;
  /** Property Pricing — no "Due at signing" heading (C2-R30-9). */
  plainReceipt?: boolean;
  allowMonthToMonthStart?: boolean;
  allowCustomStart?: boolean;
}) {
  const rooms = sub.rooms ?? [];
  const room = roomId ? rooms.find((r) => r.id === roomId) ?? null : null;
  const capacity = normalizeRoomOccupancyCapacity(room?.occupancyCapacity);
  const offered = offeredResidentCountsFor(room);
  const [arrangementPick, setArrangementPick] = useState(offered[0] ?? 1);
  const [residentIndex, setResidentIndex] = useState(0);
  const [startKind, setStartKind] = useState<ListingQuoteStartKind>("std");
  const arrangementCount = offered.includes(arrangementPick) ? arrangementPick : (offered[0] ?? 1);

  const quote = useMemo(
    () =>
      buildListingQuote(sub, {
        roomId,
        leaseTerm,
        arrangementCount: plainReceipt && room ? arrangementCount : undefined,
        residentSlot: plainReceipt && residentIndex > 0 ? residentIndex + 1 : undefined,
        startKind: plainReceipt ? startKind : "std",
      }),
    [sub, roomId, leaseTerm, plainReceipt, room, arrangementCount, residentIndex, startKind],
  );
  const wholePlace = isEntireHomeListing(sub);
  const ownRoomSigning = roomHasOwnPaymentAtSigning(sub, roomId, leaseTerm);

  const toggle = (rowKey: string, on: boolean) => {
    const next = applyPaymentAtSigningCell(sub, leaseTerm, rowKey, on, roomId);
    patch({
      paymentAtSigningByLeaseType: next.paymentAtSigningByLeaseType,
      paymentAtSigningIncludes: next.paymentAtSigningIncludes,
      customFees: next.customFees,
      rooms: next.rooms,
    });
  };

  const resetRoom = () => {
    if (!roomId) return;
    const next = clearRoomPaymentAtSigning(sub, roomId, leaseTerm);
    patch({ rooms: next.rooms });
  };

  const monthlyBreakdown = [
    `Rent ${usd(quote.monthlyRent)}`,
    quote.monthlyUtilities > 0 ? `utilities ${usd(quote.monthlyUtilities)}` : "",
    ...quote.monthlyFees.map((f) => {
      if (f.cadence === "weekly") return `${f.label.toLowerCase()} ${usd(f.amount)}/wk`;
      if (f.cadence === "daily") return `${f.label.toLowerCase()} ${usd(f.amount)}/day`;
      return `${f.label.toLowerCase()} ${usd(f.amount)}`;
    }),
  ]
    .filter(Boolean)
    .join(", ");

  const arrangementSummary =
    plainReceipt && room && capacity > 1
      ? offered
          .map((count) => {
            const price = roomPriceForResidentCount(room, count);
            const money =
              price.monthlyRent > 0 ? `$${price.monthlyRent.toLocaleString("en-US")}` : "—";
            if (quote.isStay) {
              const occRow = room.occupancyPrices?.find((r) => r.count === count);
              const nightly =
                parseMoneyAmount(occRow?.shortTermRent ?? "") ||
                parseMoneyAmount(room.shortTermRent ?? "") ||
                0;
              const nightlyLabel =
                nightly > 0 ? `$${nightly.toLocaleString("en-US")}` : money !== "—" ? money : "—";
              const suffix = count > 1 ? " each/night" : "/night";
              return `${count === 1 ? "Private" : `Shared by ${count}`} ${nightlyLabel}${suffix}`;
            }
            return `${count === 1 ? "Private" : `Shared by ${count}`} ${money}${count > 1 ? " each" : "/mo"}`;
          })
          .join(" · ")
      : arrangementSummaryLine(room);

  const startOptions: { value: ListingQuoteStartKind; label: string }[] = [{ value: "std", label: "Standard start" }];
  if (allowMonthToMonthStart) startOptions.push({ value: "m2m", label: "Month-to-month" });
  if (allowCustomStart) startOptions.push({ value: "cst", label: "Custom start date" });

  const residentOptions = Array.from({ length: arrangementCount }, (_, i) => ({
    value: String(i),
    label: `Resident ${i + 1}`,
  }));

  return (
    <>
      <PanelSection title="What a resident pays">
        {plainReceipt && room && capacity > 1 && offered.length > 1 ? (
          <div className="rp-pv-sel mb-3 flex flex-wrap gap-2">
            <RowSelectCell
              ariaLabel="Arrangement to quote"
              value={String(arrangementCount)}
              options={offered.map((n) => ({ value: String(n), label: n === 1 ? "Private" : `Shared by ${n}` }))}
              onChange={(v) => {
                setArrangementPick(Number(v) || 1);
                setResidentIndex(0);
              }}
            />
            {arrangementCount > 1 && room.residentPricing === "per_resident" ? (
              <RowSelectCell
                ariaLabel="Resident to quote"
                value={String(residentIndex)}
                options={residentOptions}
                onChange={(v) => setResidentIndex(Number(v) || 0)}
              />
            ) : null}
            {leaseTerm === LONG_TERM_LEASE_TERM && startOptions.length > 1 ? (
              <RowSelectCell
                ariaLabel="Start type"
                value={startKind}
                options={startOptions}
                onChange={(v) => setStartKind(v as ListingQuoteStartKind)}
              />
            ) : null}
          </div>
        ) : plainReceipt && leaseTerm === LONG_TERM_LEASE_TERM && startOptions.length > 1 ? (
          <div className="rp-pv-sel mb-3 flex flex-wrap gap-2">
            <RowSelectCell
              ariaLabel="Start type"
              value={startKind}
              options={startOptions}
              onChange={(v) => setStartKind(v as ListingQuoteStartKind)}
            />
          </div>
        ) : null}
        <div className="mb-3 grid grid-cols-2 gap-2">
          {wholePlace ? (
            <span className="flex h-9 items-center text-[12.5px] font-semibold text-foreground">Whole place</span>
          ) : rooms.length === 0 ? (
            <span className="flex h-9 items-center text-[12.5px] font-semibold text-foreground">Every room</span>
          ) : (
            <RowSelectCell
              ariaLabel="Room to quote"
              value={roomId ?? "every"}
              options={[
                { value: "every", label: "Every room" },
                ...rooms.map((room) => ({ value: room.id, label: room.name?.trim() || "Room" })),
              ]}
              onChange={(v) => onRoomChange(!v || v === "every" ? null : v)}
            />
          )}
          {lockLeaseTerm ? (
            <span className="flex h-9 items-center rounded-lg border border-border bg-accent/40 px-2 text-[13px] font-semibold text-foreground">
              {leaseTerm}
            </span>
          ) : (
            <RowSelectCell
              ariaLabel="Lease type to quote"
              value={leaseTerm}
              options={leaseTerms.map((term) => ({ value: term, label: term }))}
              onChange={onLeaseTermChange}
            />
          )}
        </div>
        {ownRoomSigning ? (
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={resetRoom}
              className="text-[12.5px] font-bold text-primary hover:underline"
              aria-label="Reset this room to Every room"
            >
              Reset
            </button>
          </div>
        ) : null}
        {plainReceipt ? null : (
          <p className="pt-1 text-[12px] font-extrabold uppercase tracking-[0.04em] text-foreground">Due at signing</p>
        )}
        {quote.signingLines.map((line) => (
          <PanelLine
            key={line.key}
            label={line.label}
            note={line.note}
            amount={usd(line.amount)}
            muted={plainReceipt ? false : !line.dueAtSigning}
            control={
              plainReceipt
                ? undefined
                : (
                  <input
                    type="checkbox"
                    checked={line.dueAtSigning}
                    onChange={(e) => toggle(line.key, e.target.checked)}
                    aria-label={`Collect ${line.label} at signing`}
                    className="h-[17px] w-[17px] accent-[var(--pl-blue)]"
                  />
                )
            }
          />
        ))}
        <div className="flex items-baseline justify-between pt-2.5">
          <span className="text-[13px] text-foreground">Total at signing</span>
          <b className="text-[24px] font-extrabold tabular-nums tracking-tight text-foreground">
            {usd(quote.signingTotal)}
          </b>
        </div>
        {quote.isStay ? (
          <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-accent/50 p-2.5">
            <span className="text-[13px] font-semibold text-foreground">Stay rate</span>
            <b className="text-[15px] font-extrabold tabular-nums text-foreground">
              {quote.nightlyRate ? `${usd(quote.nightlyRate)}/night` : "Not set"}
            </b>
          </div>
        ) : (
          <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl bg-accent/50 p-2.5">
            <span className="min-w-0">
              <b className="block text-[13px] font-semibold text-foreground">Then each month</b>
              <span className="text-[11.5px] text-muted">{monthlyBreakdown}</span>
            </span>
            <b className="shrink-0 text-[15px] font-extrabold tabular-nums text-foreground">
              {usd(quote.monthlyTotal)}
            </b>
          </div>
        )}
        {quote.applicationFees.length > 0 ? (
          <>
            <p className="mt-3 text-[11.5px] text-muted">Paid when applying</p>
            {quote.applicationFees.map((fee) => (
              <PanelLine key={fee.id} label={fee.label} amount={usd(fee.amount)} />
            ))}
          </>
        ) : null}
        {plainReceipt && arrangementSummary ? (
          <p className="mt-3 text-[12.5px] font-semibold text-muted" data-rp-allarr>
            {arrangementSummary}
          </p>
        ) : null}
      </PanelSection>
    </>
  );
}

function effectiveBundleRow(
  bundle: ManagerBundleRow,
  sub: ManagerListingSubmissionV1,
  leaseTerm: string,
): ManagerBundleRow {
  const copyId = bundle.copyFromBundleIdByTerm?.[leaseTerm];
  if (!copyId) return bundle;
  const src = (sub.bundles ?? []).find((b) => b.id === copyId);
  if (!src) return bundle;
  return {
    ...bundle,
    price: src.price,
    utilitiesEstimate: src.utilitiesEstimate,
    securityDeposit: src.securityDeposit,
    shortTermNightlyRent: src.shortTermNightlyRent,
    termPricing: src.termPricing ? { ...src.termPricing } : bundle.termPricing,
  };
}

function bundleMonthlyRent(bundle: ManagerBundleRow, leaseTerm: string): number {
  if (leaseTerm !== LONG_TERM_LEASE_TERM) {
    const override = bundle.termPricing?.[leaseTerm]?.monthlyRent;
    if (typeof override === "number" && override > 0) return override;
  }
  return parseMoneyAmount(bundle.price ?? "");
}

/** What a resident pays for a bundle or whole-house pricing workspace (C2-PRC3 / replica engPreview). */
export function BundleWholePricingReceiptPanel({
  sub,
  kind,
  bundleId,
  leaseTerm,
  leaseTerms,
  allowMonthToMonthStart = false,
  allowCustomStart = false,
}: {
  sub: ManagerListingSubmissionV1;
  kind: "bundle" | "whole";
  bundleId?: string;
  leaseTerm: string;
  leaseTerms: string[];
  allowMonthToMonthStart?: boolean;
  allowCustomStart?: boolean;
}) {
  const [startKind, setStartKind] = useState<ListingQuoteStartKind>("std");
  const bundle =
    kind === "bundle" && bundleId ? (sub.bundles ?? []).find((b) => b.id === bundleId) ?? null : null;
  const effective = bundle ? effectiveBundleRow(bundle, sub, leaseTerm) : null;
  const isStay = leaseTerm === SHORT_TERM_LEASE_TERM;

  const quote = useMemo(
    () =>
      buildListingQuote(sub, {
        roomId: null,
        leaseTerm,
        startKind,
        useEntireHomeRent: kind === "whole",
      }),
    [sub, leaseTerm, startKind, kind],
  );

  const label =
    kind === "whole"
      ? "Whole house"
      : effective?.label?.trim() || "Bundle";
  const roomCount =
    kind === "bundle" && effective
      ? (effective.includedRoomIds ?? []).filter((id) => sub.rooms.some((r) => r.id === id)).length
      : (sub.rooms ?? []).length;
  const roomsLine =
    kind === "bundle"
      ? roomCount === 0
        ? "No rooms picked"
        : `${roomCount} room${roomCount === 1 ? "" : "s"}`
      : `${roomCount} rooms`;

  const headlineRent =
    kind === "bundle" && effective
      ? isStay
        ? parseMoneyAmount(effective.shortTermNightlyRent ?? "")
        : bundleMonthlyRent(effective, leaseTerm)
      : quote.isStay
        ? quote.nightlyRate ?? 0
        : quote.monthlyRent;

  const startOptions: { value: ListingQuoteStartKind; label: string }[] = [
    { value: "std", label: "Standard start" },
  ];
  if (allowMonthToMonthStart) startOptions.push({ value: "m2m", label: "Month-to-month" });
  if (allowCustomStart) startOptions.push({ value: "cst", label: "Custom start date" });

  const allArr = leaseTerms
    .map((term) => {
      if (kind === "bundle" && effective) {
        if (term === SHORT_TERM_LEASE_TERM) {
          const n = parseMoneyAmount(effective.shortTermNightlyRent ?? "");
          return n > 0 ? `${term} ${usd(n)}/night` : "";
        }
        const row = bundle ? effectiveBundleRow(bundle, sub, term) : effective!;
        const rent = bundleMonthlyRent(row, term);
        return rent > 0 ? `${term} ${usd(rent)}/mo` : "";
      }
      const q = buildListingQuote(sub, {
        roomId: null,
        leaseTerm: term,
        useEntireHomeRent: kind === "whole",
      });
      if (q.isStay && q.nightlyRate) return `${term} ${usd(q.nightlyRate)}/night`;
      if (!q.isStay && q.monthlyRent > 0) return `${term} ${usd(q.monthlyRent)}/mo`;
      return "";
    })
    .filter(Boolean)
    .join(" · ");

  const bundleUtilities =
    kind === "bundle" && effective && !isStay
      ? parseMoneyAmount(
          (leaseTerm !== LONG_TERM_LEASE_TERM
            ? effective.termPricing?.[leaseTerm]?.utilitiesEstimate
            : effective.utilitiesEstimate) ?? "",
        )
      : 0;

  const monthlyLines = quote.isStay
    ? headlineRent > 0
      ? [["Nightly rate", headlineRent]]
      : quote.nightlyRate
        ? [["Nightly rate", quote.nightlyRate]]
        : []
    : [
        headlineRent > 0 ? ["Rent", headlineRent] : null,
        (kind === "bundle" ? bundleUtilities : quote.monthlyUtilities) > 0
          ? ["Utilities", kind === "bundle" ? bundleUtilities : quote.monthlyUtilities]
          : null,
        ...quote.monthlyFees.map((f) => [f.label, f.amount]),
      ].filter(Boolean) as [string, number][];

  const onceLines = quote.signingLines
    .filter((line) => line.amount > 0)
    .map((line) => [line.label, line.amount] as [string, number]);

  return (
    <PanelSection title="What a resident pays">
      {leaseTerm === LONG_TERM_LEASE_TERM && startOptions.length > 1 ? (
        <div className="rp-pv-sel mb-3 flex flex-wrap gap-2">
          <RowSelectCell
            ariaLabel="Start type"
            value={startKind}
            options={startOptions}
            onChange={(v) => setStartKind(v as ListingQuoteStartKind)}
          />
        </div>
      ) : null}
      <div className="mb-3 rounded-xl border border-border bg-card p-3">
        <div className="text-[22px] font-extrabold tabular-nums tracking-tight text-foreground">
          {headlineRent > 0 ? usd(headlineRent) : "—"}
          <span className="ml-1 text-[13px] font-semibold text-muted">
            {isStay ? "a night" : "a month"}
          </span>
        </div>
        <p className="mt-1 text-[12.5px] font-semibold text-muted">
          {label} · {roomsLine} · {leaseTerm}
          {kind === "whole" && !sub.entireHomeOffered && !isEntireHomeListing(sub) ? " · Not offered" : ""}
        </p>
        <div className="mt-3 space-y-1.5">
          {monthlyLines.map(([k, v]) => (
            <PanelLine key={k} label={k} amount={usd(Number(v))} />
          ))}
        </div>
        {onceLines.length > 0 ? (
          <div className="mt-3 space-y-1.5 border-t border-border/60 pt-2">
            {onceLines.map(([k, v]) => (
              <PanelLine key={k} label={k} amount={usd(Number(v))} />
            ))}
          </div>
        ) : null}
      </div>
      {allArr ? (
        <p className="text-[12.5px] font-semibold text-muted" data-rp-allarr>
          {allArr}
        </p>
      ) : null}
    </PanelSection>
  );
}

/**
 * What the listing reads as, across its rooms: "Now" when any room is free
 * today, else the earliest day one opens, else "Not now". Derived from each
 * room's occupied dates — never from a typed string.
 */
function listingAvailabilityFact(rooms: ManagerRoomSubmission[]): string {
  const today = todayDateKey();
  let earliest = "";
  for (const room of rooms) {
    const spans = manualRangesToSpans(room.manualUnavailableRanges);
    const legacy = spans.length === 0 ? legacyMoveInDateAsSpan(room.moveInAvailableDate, today) : null;
    const readout = deriveRoomAvailability(legacy ? [legacy] : spans, today);
    if (!readout.occupiedNow) return "Now";
    if (readout.availableFrom && (!earliest || readout.availableFrom < earliest)) earliest = readout.availableFrom;
  }
  if (rooms.length === 0) return "Now";
  return earliest ? formatDateKeyShort(earliest) : "Not now";
}
