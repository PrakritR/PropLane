/**
 * The shared-room terms of a lease: the bed and the rent, who else is on the lease, and the
 * clauses about sharing a room.
 *
 * A lease in a room that holds two or more residents names the resident's own space ("Bed A in
 * Room 8"), the rent for that bed, and adds the shared-room and roommate clauses — Your space ·
 * Rent · Roommates on this lease (or Separate lease) · Shared spaces and roommates · If a
 * roommate leaves. One structure (`SharedRoomClause[]`) feeds the generated document (HTML
 * appended before the signature block), the "Shared room addendum" shown beside an uploaded
 * PDF, and the tests, so the three can never say different things.
 *
 * Pure: the caller (the lease generation context) resolves the room, the bed and the
 * roommates from the application store; nothing here reads storage.
 */
import { bedLabelForSlot } from "@/lib/shared-room-display";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { formatRoomPriceAmount, roomResidentPriceForSlot } from "@/lib/room-pricing";

export type SharedRoomResident = {
  name: string;
  /** Bed number (1 = Bed A), when the application holds one. */
  slot: number | null;
  /** A rent the manager set for this resident, in dollars; the bed's listed rent applies when absent. */
  rentOverride?: number | null;
};

export type SharedRoomLeaseTerms = {
  roomName: string;
  propertyAddress: string;
  capacity: number;
  /** This lease's own resident first; on a joint lease, every roommate after. */
  residents: Array<{ name: string; bedLabel: string; rentLabel: string }>;
  /** One lease for all the roommates (`sharedRoomLeaseKind: "joint"`). */
  joint: boolean;
};

export type SharedRoomClause = { id: string; title: string; body: string };

function rentLabelFor(
  room: Pick<ManagerRoomSubmission, "monthlyRent" | "occupancyCapacity" | "residentPricing" | "residentPrices" | "termPricing">,
  resident: SharedRoomResident,
  term: string | null | undefined,
): string {
  const override = Number(resident.rentOverride ?? 0);
  const slotPrice =
    resident.slot != null ? roomResidentPriceForSlot(room as never, resident.slot, term)?.monthlyRent : undefined;
  const amount = override > 0 ? override : slotPrice && slotPrice > 0 ? slotPrice : room.monthlyRent > 0 ? room.monthlyRent : 0;
  return amount > 0 ? `${formatRoomPriceAmount(amount)} per month` : "the agreed rent";
}

/**
 * The shared-room terms for one lease, or null when its room holds a single resident. `residents`
 * is this lease's resident first, then (for a joint lease) every roommate on it.
 */
export function sharedRoomLeaseTerms(input: {
  room: ManagerRoomSubmission | null | undefined;
  propertyAddress: string;
  term?: string | null;
  residents: SharedRoomResident[];
}): SharedRoomLeaseTerms | null {
  const { room } = input;
  if (!room) return null;
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  if (capacity < 2 || input.residents.length === 0) return null;
  const joint = room.sharedRoomLeaseKind === "joint" && input.residents.length > 1;
  const residents = (joint ? input.residents : input.residents.slice(0, 1)).map((r) => ({
    name: r.name.trim() || "Resident",
    bedLabel: r.slot != null ? bedLabelForSlot(r.slot) : "a bed",
    rentLabel: rentLabelFor(room, r, input.term),
  }));
  return { roomName: room.name?.trim() || "the room", propertyAddress: input.propertyAddress.trim(), capacity, residents, joint };
}

/** The clauses, in the order the lease prints them. */
export function sharedRoomClauses(terms: SharedRoomLeaseTerms): SharedRoomClause[] {
  const me = terms.residents[0]!;
  const place = terms.propertyAddress ? ` at ${terms.propertyAddress}` : "";
  const clauses: SharedRoomClause[] = [
    {
      id: "space",
      title: "Your space",
      body: `Resident has the right to use ${me.bedLabel} in ${terms.roomName}${place} (a shared room with up to ${terms.capacity} residents), together with the shared areas of the home.`,
    },
    { id: "rent", title: "Rent", body: `Rent for ${me.bedLabel} is ${me.rentLabel}.` },
  ];
  if (terms.joint) {
    clauses.push({
      id: "roommates",
      title: "Roommates on this lease",
      body: `This one lease covers every roommate named here, and each roommate signs it: ${terms.residents
        .map((r) => `${r.name} (${r.bedLabel}, ${r.rentLabel})`)
        .join("; ")}. Each roommate pays their own rent.`,
    });
  } else {
    clauses.push({
      id: "separate",
      title: "Separate lease",
      body: `This lease covers ${me.bedLabel} only. Each other resident of the room signs and pays under their own lease.`,
    });
  }
  clauses.push(
    {
      id: "shared",
      title: "Shared spaces and roommates",
      body: "Residents of the room keep shared areas clean, follow the house rules on quiet hours, and give the other residents notice of overnight guests.",
    },
    {
      id: "leaves",
      title: "If a roommate leaves",
      body: "A resident moving out ends only their own bed. The manager may offer the open bed to a new resident.",
    },
  );
  return clauses;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Marks the block so a regenerated or re-tailored document never carries it twice. */
export const SHARED_ROOM_CLAUSES_MARKER = 'data-axis-shared-room="1"';

export function sharedRoomClausesHtml(terms: SharedRoomLeaseTerms): string {
  const body = sharedRoomClauses(terms)
    .map((c) => `<p><strong>${escapeHtml(c.title)}.</strong> ${escapeHtml(c.body)}</p>`)
    .join("\n");
  return `<section ${SHARED_ROOM_CLAUSES_MARKER}>\n<h2>Shared room terms</h2>\n${body}\n</section>`;
}

/**
 * The generated document with the shared-room terms before its closing tag (or at the end of a
 * fragment). Already carrying them, or no shared-room terms, returns the document unchanged.
 */
export function withSharedRoomClauses(html: string, terms: SharedRoomLeaseTerms | null | undefined): string {
  if (!terms || html.includes(SHARED_ROOM_CLAUSES_MARKER)) return html;
  const block = sharedRoomClausesHtml(terms);
  const close = html.search(/<\/body>/i);
  return close >= 0 ? `${html.slice(0, close)}${block}\n${html.slice(close)}` : `${html}\n${block}`;
}
