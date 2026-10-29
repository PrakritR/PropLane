/**
 * Move-in details and room assignment, as the event cards a resident reads in their one conversation
 * (A3, stay chat). Pure and client-safe; the sender is `move-in-details-event.server.ts`.
 *
 * SECURITY: this text is built from the house's Move-in card, and the Move-in card holds secrets (door and gate
 * codes, lockbox, Wi-Fi password). NONE of them is ever written into the text. When the house keeps any, the
 * card says "entry code in the lease packet" and the Open link goes to the resident's own Move-in page, where
 * the existing access rules show them. Every fact line is also checked against the house's secret values
 * (`containsHouseSecret`) and dropped when it matches, so a manager who typed a code into "Parking" or the
 * room name cannot leak it through the card. Same rule as the house printables: a code never travels as text.
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { containsHouseSecret, getHouseInfoValue, houseInfoEntryCodeValues, type HouseInfoV1 } from "@/lib/house-info";
import { formatStayTime, normalizeStayTime } from "@/lib/bookings/stay-times";

export type MoveInDetailsFacts = {
  residentName?: string | null;
  /** The building or house name. */
  propertyLabel?: string | null;
  /** Street address line. */
  addressLine?: string | null;
  /** The resident's room; "Not assigned yet" / "Room TBD" placeholders are dropped. */
  roomLabel?: string | null;
  /** Move-in date as the resolver labels it ("Nov 1, 2026"), or an ISO date. */
  moveInDateLabel?: string | null;
  /** The house's standard check-in time, "HH:MM" wall time; the window is "after <time>". */
  checkInTime?: string | null;
  houseInfo?: HouseInfoV1 | null;
  /** Each room's door code; a secret that lives on the room rather than in `houseInfo`. */
  roomSecrets?: readonly string[] | null;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function firstName(name: string | null | undefined): string {
  return String(name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** "Fri, Nov 1 after 3:00 pm" - the weekday only when the date parses; the window only when a time is known. */
export function moveInWhenLabel(dateLabel: string | null | undefined, checkInTime: string | null | undefined): string {
  const raw = String(dateLabel ?? "").trim();
  let day = "";
  if (raw) {
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : `${raw} 12:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      day = raw;
    } else {
      const month = parsed.toLocaleDateString("en-US", { month: "short" });
      day = `${WEEKDAYS[parsed.getDay()]}, ${month} ${parsed.getDate()}`;
    }
  }
  const time = normalizeStayTime(checkInTime);
  const window = day && time ? ` after ${formatStayTime(time)}` : "";
  return `${day}${window}`.trim();
}

function realRoom(label: string | null | undefined): string {
  const room = String(label ?? "").trim();
  if (!room || /^(not assigned yet|room tbd)$/i.test(room)) return "";
  return room;
}

/** A fact line survives only when it carries none of the house's secrets. */
function safeLine(
  value: string,
  houseInfo: HouseInfoV1 | null | undefined,
  roomSecrets: readonly string[] = [],
): string {
  const line = value.trim();
  return line && !containsHouseSecret(line, houseInfo, roomSecrets) ? line : "";
}

/**
 * Does the house keep an entry CODE (door, gate, lockbox, Wi-Fi password, alarm)? Then the packet holds
 * it. A free-text access note or a staff-only code is not a code the resident is pointed at, so a house
 * with only those never claims an entry code is waiting in the packet (`houseInfoEntryCodeValues`).
 */
export function houseKeepsEntrySecrets(houseInfo: HouseInfoV1 | null | undefined): boolean {
  return houseInfoEntryCodeValues(houseInfo).length > 0;
}

export type MoveInDetailsRendered = {
  subject: string;
  text: string;
  smsText: string;
  /** The card's one muted fact line. */
  cardFact: string;
};

/** The resident's Move-in details copy. `null` when there is no address to arrive at. */
export function renderMoveInDetails(facts: MoveInDetailsFacts): MoveInDetailsRendered | null {
  const info = facts.houseInfo ?? null;
  const secrets = facts.roomSecrets ?? [];
  const address = safeLine(String(facts.addressLine ?? ""), info, secrets);
  const place = safeLine(String(facts.propertyLabel ?? ""), info, secrets);
  const where = address || place;
  if (!where) return null;
  const when = safeLine(moveInWhenLabel(facts.moveInDateLabel, facts.checkInTime), info, secrets);
  const room = safeLine(realRoom(facts.roomLabel), info, secrets);
  const parking = safeLine(info ? getHouseInfoValue(info, "access", "parking") : "", info, secrets);
  const packet = houseKeepsEntrySecrets(info) ? "entry code in the lease packet" : "";
  const first = firstName(facts.residentName);
  const lead = first ? `Hi ${first}, here are your move-in details.` : "Here are your move-in details.";
  const arrive = `${when ? `${when} at ` : "At "}${where}${room ? `, ${room}` : ""}`;
  const text = [
    lead,
    `${arrive}.`,
    packet ? "Your entry code is in the lease packet. Open Move-in in PropLane to see it." : "",
    parking ? `Parking: ${parking}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const cardFact = [when, where, room, packet, parking ? `parking ${parking}` : ""].filter(Boolean).join(" · ");
  return { subject: "Move-in details", text, smsText: text, cardFact };
}

export type RoomAssignedFacts = {
  residentName?: string | null;
  propertyLabel?: string | null;
  roomLabel?: string | null;
  /** The resident already had a room and it changed. */
  changed?: boolean;
  houseInfo?: HouseInfoV1 | null;
  /** Each room's door code; a secret that lives on the room rather than in `houseInfo`. */
  roomSecrets?: readonly string[] | null;
};

/** The resident's Room assigned copy. `null` when the room has no real name. */
export function renderRoomAssigned(facts: RoomAssignedFacts): MoveInDetailsRendered | null {
  const info = facts.houseInfo ?? null;
  const secrets = facts.roomSecrets ?? [];
  const room = safeLine(realRoom(facts.roomLabel), info, secrets);
  if (!room) return null;
  const place = safeLine(String(facts.propertyLabel ?? ""), info, secrets);
  const at = place ? ` at ${place}` : "";
  const text = facts.changed
    ? `Your room${at} is now ${room}.`
    : `You have been assigned ${room}${at}.`;
  return {
    subject: facts.changed ? "Room changed" : "Room assigned",
    text,
    smsText: text,
    cardFact: place,
  };
}

type RoomRow = Pick<DemoApplicantRow, "bucket" | "withdrawnAt" | "assignedRoomChoice">;

/**
 * Did this write set or change the resident's room? Only a manager's explicit assignment counts
 * (`assignedRoomChoice`), never the applicant's own first pick, and only on a live approved row. The same room
 * written again is no transition, so a save that touches nothing about the room says nothing.
 */
export function roomAssignmentTransition(
  previous: RoomRow | null | undefined,
  next: RoomRow,
): { choice: string; changed: boolean } | null {
  if (next.withdrawnAt || next.bucket !== "approved") return null;
  const choice = String(next.assignedRoomChoice ?? "").trim();
  if (!choice) return null;
  const before = String(previous?.assignedRoomChoice ?? "").trim();
  if (before === choice) return null;
  return { choice, changed: Boolean(before) };
}

/** The idempotency key of a room-assignment card: one per residency and room. */
export function roomAssignedEventKey(residencyId: string, roomChoice: string): string {
  return `room_assigned:${residencyId.trim()}:${roomChoice.trim()}`;
}

/** The idempotency key of a move-in details card: one per resident and home, whoever sends it first. */
export function moveInDetailsEventKey(residentKey: string, propertyId: string): string {
  return `move_in_details:${residentKey.trim().toLowerCase()}:${propertyId.trim()}`;
}
