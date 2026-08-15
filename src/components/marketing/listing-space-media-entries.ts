import type {
  ListingBathroomRow,
  ListingRoomRow,
  ListingSharedRow,
} from "@/data/listing-rich-content";
import { listingRoomPriceMetaLine } from "@/data/listing-rich-content";
import type { ListingSpaceMediaEntry } from "@/components/marketing/listing-space-media-browser";

export function roomMediaEntriesFromFloors(
  floorPlans: Array<{ floorLabel: string; rooms: ListingRoomRow[] }>,
): Array<ListingSpaceMediaEntry & { room: ListingRoomRow; floorLabel: string }> {
  return floorPlans.flatMap((f) =>
    f.rooms.map((room) => ({
      id: room.id,
      eyebrow: f.floorLabel,
      title: room.name,
      metaLine: listingRoomPriceMetaLine(room),
      availability: room.availability,
      photoUrls: room.modal.photoUrls,
      videoSrc: room.modal.videoSrc,
      thumbLabel: room.name,
      room,
      floorLabel: f.floorLabel,
    })),
  );
}

export function bathroomMediaEntries(rows: ListingBathroomRow[]): ListingSpaceMediaEntry[] {
  return rows.map((row) => ({
    id: row.id,
    eyebrow: row.modal.eyebrow,
    title: row.name,
    metaLine: row.usedByLabel || (row.detail !== "—" ? row.detail : undefined),
    availability: row.usedByLabel
      ? undefined
      : row.availability !== "—"
        ? row.availability
        : undefined,
    photoUrls: row.modal.photoUrls,
    videoSrc: row.modal.videoSrc,
    thumbLabel: row.name,
  }));
}

export function sharedSpaceMediaEntries(rows: ListingSharedRow[]): ListingSpaceMediaEntry[] {
  return rows.map((row) => ({
    id: row.id,
    eyebrow: row.modal.eyebrow,
    title: row.name,
    metaLine: row.detail,
    availability: row.availability !== "—" ? row.availability : undefined,
    photoUrls: row.modal.photoUrls,
    videoSrc: row.modal.videoSrc,
    thumbLabel: row.name,
  }));
}
