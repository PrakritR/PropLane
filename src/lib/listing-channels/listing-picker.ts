/**
 * The one "which listing?" rule for Listing sites.
 *
 * Pure and client-safe. The Post section of a site's record page and the property-level panel's pop-up
 * both build their dropdown through `listingPickerOptions`, so a house is never named one way in one
 * place and another way in the next (the old picker mixed street addresses with titles, gave no
 * room count, and only revealed a hold after the pick).
 *
 *  - Label: the house name, or the short street address when it has no real name (`propertyRowTitle`),
 *    then " · N rooms".
 *  - Groups: "Ready to post" first, then "Held" with the reason beside the name.
 *  - Drafts are never offered: a draft is not a listing yet.
 */
import type { MockProperty } from "@/data/types";
import { listingHoldFact, listingChannelEligibility, type ListingHoldReason } from "@/lib/listing-channels/post-text";
import { propertyRowTitle } from "@/lib/property-row-summary";

/** What the picker needs to know about one workspace listing. The status route builds this server-side. */
export type ListingPickerSource = {
  id: string;
  /** `manager_property_records.status`; "draft" is dropped. */
  status: string;
  /** The house name, or the short street when it has none (already resolved through `propertyRowTitle`). */
  name: string;
  roomCount: number;
  holdReasons: ListingHoldReason[];
};

export type ListingPickerOption = { value: string; label: string };
export type ListingPickerGroup = { label: string; options: ListingPickerOption[] };

export const LISTING_PICKER_READY_LABEL = "Ready to post";
export const LISTING_PICKER_HELD_LABEL = "Held";

/** "5257 Brooklyn Ave · 10 rooms"; a house with no rooms entered is just its name. */
export function listingPickerLabel(name: string, roomCount: number): string {
  const base = name.trim() || "Untitled listing";
  if (roomCount <= 0) return base;
  return `${base} · ${roomCount} ${roomCount === 1 ? "room" : "rooms"}`;
}

/** "No photo", "No street address and no photo", "Set up work number": the hold fact, sentence-cased, with no "Held:" lead. */
export function listingPickerHoldReason(reasons: readonly ListingHoldReason[]): string {
  const fact = listingHoldFact(reasons).replace(/^Held:\s*/, "");
  return fact.charAt(0).toUpperCase() + fact.slice(1);
}

/** The picker's name for one property (house name, else short street) and its room count. */
export function listingPickerNameOf(property: Pick<MockProperty, "buildingName" | "title" | "address" | "listingSubmission">): { name: string; roomCount: number } {
  return {
    name: propertyRowTitle({ buildingName: property.buildingName || property.title, address: property.address }),
    roomCount: property.listingSubmission?.rooms?.length ?? 0,
  };
}

/** The source row for one stored listing; the label rule lives here so the server and the tests share it. */
export function listingPickerSourceFromProperty(
  property: MockProperty,
  args: { status: string; workNumberSet: boolean },
): ListingPickerSource {
  const holdReasons = listingChannelEligibility(property);
  if (!args.workNumberSet) holdReasons.push("no_work_number");
  return {
    id: property.id,
    status: args.status,
    ...listingPickerNameOf(property),
    holdReasons,
  };
}

function byLabel(a: ListingPickerOption, b: ListingPickerOption): number {
  return a.label.localeCompare(b.label, "en", { sensitivity: "base", numeric: true });
}

/**
 * Ready first, then Held, each sorted by label; drafts excluded; an empty group is left out so the
 * menu never shows a heading with nothing under it. `firstId` is the default pick: the first ready
 * listing, else the first held one, else "".
 */
export function listingPickerOptions(sources: readonly ListingPickerSource[]): {
  groups: ListingPickerGroup[];
  firstId: string;
} {
  const ready: ListingPickerOption[] = [];
  const held: ListingPickerOption[] = [];
  for (const source of sources) {
    if (source.status === "draft") continue;
    const label = listingPickerLabel(source.name, source.roomCount);
    if (source.holdReasons.length === 0) ready.push({ value: source.id, label });
    else held.push({ value: source.id, label: `${label} · ${listingPickerHoldReason(source.holdReasons)}` });
  }
  ready.sort(byLabel);
  held.sort(byLabel);
  const groups: ListingPickerGroup[] = [];
  if (ready.length > 0) groups.push({ label: LISTING_PICKER_READY_LABEL, options: ready });
  if (held.length > 0) groups.push({ label: LISTING_PICKER_HELD_LABEL, options: held });
  return { groups, firstId: ready[0]?.value ?? held[0]?.value ?? "" };
}
