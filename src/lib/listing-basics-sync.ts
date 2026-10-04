/**
 * The Basics step's Bathrooms and Floors counters, kept honest by the lists they summarise.
 *
 * Bedrooms already follow the rooms list. Bathrooms and Floors did not: a listing whose Bathrooms
 * step held three cards still read "1" on Basics, because the counter read a stored id nothing
 * updated when a card was added, and Floors read a stored count while rooms, bathrooms and shared
 * spaces named higher floors. The list is the truth; the stored id is rewritten from it.
 */

import { floorLabelRank, type SharedSpaceKind, SHARED_SPACE_KIND_OPTIONS } from "@/data/manager-listing-presets";
import { bathroomTypeOf } from "@/lib/listing-record-defaults";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** The highest count the Basics bathroom stepper offers ("4+" is its top). */
export const BASICS_MAX_BATHROOMS = 4.5;
/** The most floors the Floors picker offers. */
const MAX_FLOORS = 8;

type SubLike = Pick<ManagerListingSubmissionV1, "bathrooms">;

/**
 * Bathrooms the cards add up to: a full or shower bath is one, a half or quarter bath is a half.
 * `null` when there are no cards, so the stored answer is kept.
 */
export function bathroomCountFromList(sub: SubLike): number | null {
  const baths = sub.bathrooms ?? [];
  if (baths.length === 0) return null;
  const total = baths.reduce((sum, bath) => {
    const type = bathroomTypeOf(bath);
    return sum + (type === "half" || type === "quarter" ? 0.5 : 1);
  }, 0);
  return Math.max(1, total);
}

/** The Basics bathroom id ("1", "1.5" … "4", "4+") for a count. */
export function bathroomIdFromCount(count: number): string {
  if (count >= BASICS_MAX_BATHROOMS) return "4+";
  return String(Math.max(1, Math.round(count * 2) / 2));
}

/** The number the Basics bathroom stepper shows: the cards when there are any, else the stored id. */
export function basicsBathroomCount(sub: SubLike & Pick<ManagerListingSubmissionV1, "listingTotalBathroomsId">): number {
  const fromList = bathroomCountFromList(sub);
  if (fromList != null) return Math.min(BASICS_MAX_BATHROOMS, fromList);
  const id = (sub.listingTotalBathroomsId ?? "").trim();
  if (id === "4+") return BASICS_MAX_BATHROOMS;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? Math.min(BASICS_MAX_BATHROOMS, n) : 1;
}

type FloorSub = Pick<ManagerListingSubmissionV1, "rooms" | "bathrooms" | "sharedSpaces" | "listingStoriesId">;

/** The highest numbered floor any room, bathroom or shared space sits on (0 when none names one). */
export function highestFloorInUse(sub: Pick<FloorSub, "rooms" | "bathrooms" | "sharedSpaces">): number {
  let top = 0;
  const see = (label: string | undefined) => {
    const rank = floorLabelRank(label ?? "");
    if (rank != null && rank > top) top = rank;
  };
  for (const room of sub.rooms ?? []) see(room.floor);
  for (const bath of sub.bathrooms ?? []) see(bath.location);
  for (const space of sub.sharedSpaces ?? []) see(space.location);
  return Math.min(MAX_FLOORS, top);
}

/** The Floors count: the stored one, raised to the highest floor a record already uses. */
export function basicsFloorCount(sub: FloorSub): number {
  if ((sub.listingStoriesId ?? "").trim() === "split") return 2;
  const stored = Number(sub.listingStoriesId);
  const base = Number.isInteger(stored) && stored >= 1 ? Math.min(MAX_FLOORS, stored) : 1;
  return Math.max(base, highestFloorInUse(sub));
}

/** The "(show all amenities)" hint the Other shared-space option used to carry in its label. */
const OPTION_HINT = /\s*\(show all amenities\)\s*$/i;

/** A stored shared-space name without the option hint that once leaked into it. */
export function cleanSharedSpaceName(name: string | undefined): string {
  return (name ?? "").replace(OPTION_HINT, "").trim();
}

/** What a shared space is called on its card: the manager's name, else its type, else "Shared space". */
export function sharedSpaceTitle(space: { name?: string; spaceKind?: SharedSpaceKind }): string {
  const name = cleanSharedSpaceName(space.name);
  const kind = space.spaceKind === "other" ? undefined : space.spaceKind;
  const kindLabel = kind ? SHARED_SPACE_KIND_OPTIONS.find((o) => o.id === kind)?.label : undefined;
  if (name && !(space.spaceKind === "other" && name.toLowerCase() === "other")) return name;
  return kindLabel ?? "Shared space";
}

/**
 * Brings the stored counters and names in line with the lists. Called on edits and saves only,
 * never on open, so a saved listing is not marked unsaved by merely being looked at. Returns the
 * same object when nothing changed.
 */
export function syncListingBasicsFromLists(sub: ManagerListingSubmissionV1): ManagerListingSubmissionV1 {
  let next = sub;
  const baths = bathroomCountFromList(sub);
  if (baths != null) {
    const id = bathroomIdFromCount(baths);
    if (id !== sub.listingTotalBathroomsId) next = { ...next, listingTotalBathroomsId: id };
  }
  const floors = highestFloorInUse(sub);
  const stored = Number(sub.listingStoriesId);
  if (floors > 0 && sub.listingStoriesId !== "split" && !(Number.isInteger(stored) && stored >= floors)) {
    next = { ...next, listingStoriesId: String(floors) };
  }
  const spaces = sub.sharedSpaces ?? [];
  if (spaces.some((space) => OPTION_HINT.test(space.name ?? ""))) {
    next = { ...next, sharedSpaces: spaces.map((space) => (OPTION_HINT.test(space.name ?? "") ? { ...space, name: cleanSharedSpaceName(space.name) } : space)) };
  }
  return next;
}
