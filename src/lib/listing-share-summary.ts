import type { MockProperty } from "@/data/types";
import { isEntireHomeListing, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { monthlyRentListingLabel } from "@/lib/rental-application/listing-fees-display";
import { formatMoneyAmountsInLabel, roomMonthlyEquivalentLabel } from "@/lib/room-pricing";

export type ListingShareSummary = {
  title: string;
  detailLines: string[];
};

type ListingShareSummaryOptions = {
  roomChoice?: string;
  roomId?: string;
};

/** Short bullet-style facts for prospect emails (no long amenity lists). */
export function buildListingShareSummary(
  property: MockProperty,
  options?: ListingShareSummaryOptions,
): ListingShareSummary {
  const title = (property.title || property.buildingName || property.address).trim() || "Listing";
  const lines: string[] = [];

  const addressLine = [property.address?.trim(), property.neighborhood?.trim()].filter(Boolean).join(" · ");
  if (addressLine) lines.push(addressLine);

  let suppressPropertyRent = false;
  let roomLine: string | null = null;
  const sub = property.listingSubmission;
  if (sub?.v) {
    const normalized = normalizeManagerListingSubmissionV1(sub);
    if (!isEntireHomeListing(normalized)) {
      const rooms = normalized.rooms.filter((r) => r.name.trim());
      const selectedRoomId = options?.roomId?.trim();
      const selectedRoom = selectedRoomId ? rooms.find((r) => r.id === selectedRoomId) : undefined;
      const selectedRoomLabel = options?.roomChoice?.trim();
      if (selectedRoomLabel || selectedRoom) suppressPropertyRent = true;
      const room = selectedRoom ?? (selectedRoomLabel ? rooms.find((r) => r.name.trim() === selectedRoomLabel) : undefined);
      if (room) {
        const roomRent = roomMonthlyEquivalentLabel(room);
        roomLine = `${room.name.trim()}${roomRent ? ` · ${roomRent}` : ""}`;
      } else if (selectedRoomLabel) {
        roomLine = selectedRoomLabel;
      } else {
        const roomCount = rooms.length;
        if (roomCount > 0) roomLine = `${roomCount} room${roomCount === 1 ? "" : "s"} available`;
      }
    }
  }

  const rent = formatMoneyAmountsInLabel(property.rentLabel?.trim() || monthlyRentListingLabel(property.listingSubmission));
  if (rent && rent !== "—" && !suppressPropertyRent) lines.push(`Rent: ${rent}`);

  if (property.beds > 0 || property.baths > 0) {
    const bedBath = [
      property.beds > 0 ? `${property.beds} bed${property.beds === 1 ? "" : "s"}` : null,
      property.baths > 0 ? `${property.baths} bath${property.baths === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (bedBath) lines.push(bedBath);
  }

  if (roomLine) lines.push(roomLine);

  const available = property.available?.trim();
  if (available && available !== "—") lines.push(`Available: ${available}`);

  lines.push(property.petFriendly ? "Pets welcome" : "No pets");

  const tagline = property.tagline?.trim();
  if (tagline && tagline.length <= 140) lines.push(tagline);

  return { title, detailLines: lines };
}
