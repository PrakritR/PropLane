/**
 * One line per home for "are there any houses available?" by text.
 *
 * Pure: it formats what `list_live_listings` already read (checked availability, the room's own rent and deposit, the
 * home's canonical listing link) and invents nothing. A room is OPEN only when its availability was VERIFIED and it is
 * free now or from a known date; an unverified room is never listed as open. The link is the one the tool built from
 * `listingPublicPathFor`, never typed here.
 */

export type DigestRoom = {
  name: string;
  monthlyRent: number | null;
  rentBasis?: "monthly" | "daily";
  dailyRentPrice?: number | null;
  currentAvailabilityVerified?: boolean;
  freeNow?: boolean | null;
  /** YYYY-MM-DD */
  freeFrom?: string | null;
  securityDeposit?: string | null;
  furnishing?: string | null;
  residentCapacity?: number | null;
};

export type DigestHome = {
  title: string | null;
  address?: string | null;
  neighborhood?: string | null;
  listingUrl: string;
  petFriendly?: boolean | null;
  rooms: DigestRoom[];
};

export type OpenRoomsDigest = {
  lines: string[];
  /** Open rooms across the homes whose lines are returned - the same population as `homeCount`. */
  openRoomCount: number;
  homeCount: number;
  /** Homes with open rooms that the cap left out, so "and N more homes" is never a guess. */
  moreHomes: number;
  photoOffer: string;
};

export const OPEN_ROOMS_DIGEST_MAX_HOMES = 6;
const PHOTO_OFFER = "Photos of every room are on each listing link; I can text some if you tell me which house.";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function shortDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
}

export function isOpenRoom(room: DigestRoom): boolean {
  if (!room.currentAvailabilityVerified) return false;
  return room.freeNow === true || Boolean(room.freeFrom && shortDate(room.freeFrom));
}

function roomPrice(room: DigestRoom): string | null {
  if (room.rentBasis === "daily" && room.dailyRentPrice && room.dailyRentPrice > 0) return `${money(room.dailyRentPrice)}/night`;
  return room.monthlyRent && room.monthlyRent > 0 ? `${money(room.monthlyRent)}/mo` : null;
}

function roomWhen(room: DigestRoom): string {
  if (room.freeNow === true) return "open now";
  return `from ${shortDate(room.freeFrom ?? "") ?? "a date I will confirm"}`;
}

/** "Room 7 $1,200/mo open now (deposit $500, furnished)". */
export function roomPhrase(room: DigestRoom): string {
  const bits = [room.name.trim() || "Room", roomPrice(room), roomWhen(room)].filter(Boolean).join(" ");
  const facts: string[] = [];
  if (room.securityDeposit?.trim()) facts.push(`deposit ${/^\d/.test(room.securityDeposit.trim()) ? `$${room.securityDeposit.trim()}` : room.securityDeposit.trim()}`);
  if (room.furnishing?.trim()) facts.push(room.furnishing.trim().toLowerCase());
  if (room.residentCapacity && room.residentCapacity > 1) facts.push(`sleeps ${room.residentCapacity}`);
  return facts.length > 0 ? `${bits} (${facts.join(", ")})` : bits;
}

export function buildOpenRoomsDigest(homes: DigestHome[], max = OPEN_ROOMS_DIGEST_MAX_HOMES): OpenRoomsDigest {
  const lines: string[] = [];
  let openRoomCount = 0;
  let moreHomes = 0;
  for (const home of homes) {
    const open = home.rooms.filter(isOpenRoom);
    if (open.length === 0 || !home.listingUrl) continue;
    if (lines.length >= max) {
      moreHomes += 1;
      continue;
    }
    openRoomCount += open.length;
    const place = home.address?.trim() || home.title?.trim() || "A home";
    const where = home.neighborhood?.trim() ? `${place}, ${home.neighborhood.trim()}` : place;
    const pet = home.petFriendly === true ? " Pets welcome." : "";
    lines.push(`${where}: ${open.map(roomPhrase).join("; ")}.${pet} ${home.listingUrl}`);
  }
  return { lines, openRoomCount, homeCount: lines.length, moreHomes, photoOffer: PHOTO_OFFER };
}
