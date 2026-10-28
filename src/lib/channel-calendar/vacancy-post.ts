/**
 * The text a manager pastes into a posting (PadSplit, SpareRoom, Facebook, Booking.com's description ...): what is
 * open in one house RIGHT NOW, from the same live label every public reader prints (`publicRoomStatus`), plus the
 * workspace's text number. Pure; the number is handed in from config, never a literal here.
 *
 * Only rooms a renter can fill soon are listed ("Available now", "Available <date>"); a room leased past the
 * 60-day window or closed with no end is left out, exactly as the browse card leaves it out.
 */
import type { PublicRoomStatus } from "@/lib/room-availability";

export type VacancyRoom = { roomId: string; name: string; rentLabel: string; status: PublicRoomStatus };

/** The rooms a posting should advertise, open-now first, then by the date they free. */
export function advertisedVacancy(rooms: readonly VacancyRoom[]): VacancyRoom[] {
  return rooms
    .filter((room) => room.status.kind === "now" || room.status.kind === "soon")
    .sort((a, b) => {
      if (a.status.kind !== b.status.kind) return a.status.kind === "now" ? -1 : 1;
      return (a.status.date ?? "").localeCompare(b.status.date ?? "") || a.name.localeCompare(b.name, "en", { numeric: true });
    });
}

export function buildVacancyPost(input: { houseLabel: string; rooms: readonly VacancyRoom[]; workNumber: string | null }): string {
  const open = advertisedVacancy(input.rooms);
  const lines = open.length === 0
    ? [`${input.houseLabel}: no rooms open right now.`]
    : [
        `${input.houseLabel}: ${open.length} ${open.length === 1 ? "room" : "rooms"} open`,
        ...open.map((room) => `${room.name}${room.rentLabel ? ` · ${room.rentLabel}` : ""} · ${room.status.text}`),
      ];
  if (input.workNumber?.trim()) lines.push(`Text ${input.workNumber.trim()}`);
  return lines.join("\n");
}
