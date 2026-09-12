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
 *   checkboxes write the same per-lease-type signing matrix the signing table
 *   writes, through one shared helper.
 */

import { useMemo } from "react";
import { Image as ImageIcon, ImageOff, Check, AlertTriangle } from "lucide-react";
import { PanelLine, PanelSection } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { buildListingQuote } from "@/lib/listing-quote";
import { applyPaymentAtSigningCell } from "@/lib/listing-fees";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";

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

export function ListingPreviewPanel({ sub }: { sub: ManagerListingSubmissionV1 }) {
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
      <p className="mt-2.5 text-[19px] font-extrabold tracking-tight text-foreground">
        {from > 0 ? (
          <>
            From {usd(from)}
            <span className="text-[12.5px] font-medium text-muted"> a month</span>
          </>
        ) : (
          <span className="text-[13px] font-semibold text-[var(--status-pending-fg)]">Rent not set</span>
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
          ["Available", rooms.find((r) => r.moveInAvailableDate)?.moveInAvailableDate || "Now"],
        ]}
      />
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
        <p className="text-[12.5px] text-muted">Add a room to see how it appears on your listing.</p>
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
        <p className="text-[12.5px] text-muted">Spaces you add show up here the way applicants see them.</p>
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
}: {
  sub: ManagerListingSubmissionV1;
  patch: (next: Partial<ManagerListingSubmissionV1>) => void;
  leaseTerm: string;
  roomId: string | null;
  onRoomChange: (id: string | null) => void;
  onLeaseTermChange: (term: string) => void;
  leaseTerms: string[];
}) {
  const quote = useMemo(() => buildListingQuote(sub, { roomId, leaseTerm }), [sub, roomId, leaseTerm]);
  const rooms = sub.rooms ?? [];

  const toggle = (rowKey: string, on: boolean) => {
    const next = applyPaymentAtSigningCell(sub, leaseTerm, rowKey, on);
    patch({
      paymentAtSigningByLeaseType: next.paymentAtSigningByLeaseType,
      paymentAtSigningIncludes: next.paymentAtSigningIncludes,
      customFees: next.customFees,
    });
  };

  const monthlyBreakdown = [
    `Rent ${usd(quote.monthlyRent)}`,
    quote.monthlyUtilities > 0 ? `utilities ${usd(quote.monthlyUtilities)}` : "",
    ...quote.monthlyFees.map((f) => `${f.label.toLowerCase()} ${usd(f.amount)}`),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <>
      <PanelSection title="What a resident pays">
        <div className="mb-3 grid grid-cols-2 gap-2">
          {rooms.length > 0 ? (
            <select
              aria-label="Room to quote"
              value={roomId ?? ""}
              onChange={(e) => onRoomChange(e.target.value || null)}
              className="h-9 w-full rounded-lg border border-border bg-card px-2 text-[13px] text-foreground"
            >
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name?.trim() || "Room"}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[12.5px] text-muted">Whole place</span>
          )}
          <select
            aria-label="Lease type to quote"
            value={leaseTerm}
            onChange={(e) => onLeaseTermChange(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-card px-2 text-[13px] text-foreground"
          >
            {leaseTerms.map((term) => (
              <option key={term} value={term}>
                {term}
              </option>
            ))}
          </select>
        </div>
        <p className="mb-1 text-[11.5px] text-muted">Due at signing. Untick anything you collect later.</p>
        {quote.signingLines.map((line) => (
          <PanelLine
            key={line.key}
            label={line.label}
            note={line.note}
            amount={usd(line.amount)}
            muted={!line.dueAtSigning}
            control={
              <input
                type="checkbox"
                checked={line.dueAtSigning}
                onChange={(e) => toggle(line.key, e.target.checked)}
                aria-label={`Collect ${line.label} at signing`}
                className="h-[17px] w-[17px] accent-[var(--pl-blue)]"
              />
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
      </PanelSection>
    </>
  );
}
