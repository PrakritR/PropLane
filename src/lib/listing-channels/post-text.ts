/**
 * ONE post-text builder for every listing site.
 *
 * INPUT CONTRACT: `property` must be the output of `publicListingProjection`
 * (`src/lib/public-listings.server.ts`), the same allowlist the public catalog and the Zillow feed
 * read through. A post goes out to the public internet, so it can carry nothing the public listing
 * page does not. The workspace work number and work email arrive separately (resolved by
 * `resolveActiveManagerSendNumber` / `resolveActiveManagerWorkEmail`), never from the stored blob.
 */
import type { MockProperty } from "@/data/types";
import {
  listingSyndicationHasStreetAddress,
  listingSyndicationPhotoUrls,
  monthlyRentDollarsForSyndication,
} from "@/lib/listing-syndication/zillow-feed";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { buildManagerListingUrl } from "@/lib/manager-property-links";
import { listingChannelDef, type ListingChannelId } from "@/lib/listing-channels/registry";
import { listingAttributionLine } from "@/lib/listing-attribution";

export type ListingPostContact = { phone: string | null; email: string | null };

export type ListingHoldReason = "no_street_address" | "no_photo" | "no_work_number";

const HOLD_REASON_COPY: Record<ListingHoldReason, string> = {
  no_street_address: "no street address",
  no_photo: "no photo",
  no_work_number: "set up work number",
};

export const LISTING_HOLD_WORK_NUMBER_PHRASE = "Set up work number";

/** The plain fact a row shows for a held listing, e.g. "Held: no photo". */
export function listingHoldFact(reasons: readonly ListingHoldReason[]): string {
  if (reasons.includes("no_work_number") && reasons.length === 1) return LISTING_HOLD_WORK_NUMBER_PHRASE;
  const parts = reasons.filter((r) => r !== "no_work_number").map((r) => HOLD_REASON_COPY[r]);
  const held = `Held: ${parts.join(" and ")}`;
  return reasons.includes("no_work_number") ? `${held} · ${LISTING_HOLD_WORK_NUMBER_PHRASE}` : held;
}

/**
 * The same fact, split so a surface can render the trailing "Set up work number" phrase as its
 * link. `lead` already excludes that phrase, so a caller never prints it twice.
 */
export function listingHoldFactParts(reasons: readonly ListingHoldReason[]): { lead: string; workNumberLink: boolean } {
  const fact = listingHoldFact(reasons);
  if (!reasons.includes("no_work_number")) return { lead: fact, workNumberLink: false };
  return { lead: fact.slice(0, fact.length - LISTING_HOLD_WORK_NUMBER_PHRASE.length), workNumberLink: true };
}

/**
 * A listing needs a street address and a real, already-uploaded photo before any site sees it
 * (Instagram cannot publish without one). Never a placeholder.
 */
export function listingChannelEligibility(property: MockProperty): ListingHoldReason[] {
  const reasons: ListingHoldReason[] = [];
  if (!listingSyndicationHasStreetAddress(property.address)) reasons.push("no_street_address");
  if (listingSyndicationPhotoUrls(property.listingSubmission).length === 0) reasons.push("no_photo");
  return reasons;
}

export function listingPostPhotoUrls(property: MockProperty): string[] {
  return listingSyndicationPhotoUrls(property.listingSubmission);
}

function clean(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstSentences(text: string, max: number): string {
  const flat = clean(text);
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.slice(0, max - 1).trimEnd()}…`;
}

function trimTo(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function formatPostPrice(dollars: number | null, byRoom: boolean): string {
  if (dollars === null) return "";
  return `${byRoom ? "From " : ""}$${dollars.toLocaleString("en-US")}/mo`;
}

/** The public listing link tagged with the site it is posted on, so a lead can be traced back (`?src=<channelId>`). */
export function taggedListingLink(url: string, channel: ListingChannelId): string {
  const params = new URLSearchParams({ src: channel });
  return `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
}

/** The tagged public link inside a built post ("Details and photos: <link>"), or "" when the text has none. */
export function taggedLinkFromPostText(text: string): string {
  return /Details and photos:\s*(\S+)/.exec(text)?.[1] ?? "";
}

export type ListingPostText =
  | { ok: true; text: string }
  | { ok: false; reason: "no_work_number" };

/**
 * Headline, price, rooms, the first selling points, the public listing link and the work contact.
 * Each channel trims the BODY to its own limit; the link, contact and attribution lines are never cut.
 * `attribution` is resolved by the caller (workspace setting + effective plan, see
 * `src/lib/listing-attribution.server.ts`); this builder stays pure and just obeys it.
 */
export function buildListingPostText(args: {
  property: MockProperty;
  origin: string;
  contact: ListingPostContact;
  channel: ListingChannelId;
  attribution: boolean;
}): ListingPostText {
  const { property, origin, contact, channel, attribution } = args;
  const phone = clean(contact.phone);
  if (!phone) return { ok: false, reason: "no_work_number" };
  const email = clean(contact.email);
  const sub = property.listingSubmission;

  const headline = clean(property.title) || clean(property.buildingName);
  const where = [clean(property.address), clean(property.neighborhood)].filter(Boolean).join(", ");
  const dollars = sub ? monthlyRentDollarsForSyndication(sub) : null;
  const byRoom = Boolean(sub && !isEntireHomeListing(sub));
  const price = formatPostPrice(dollars, byRoom);
  const roomCount = sub?.rooms?.length ?? 0;
  const facts = [
    price,
    property.beds ? `${property.beds} bed` : "",
    property.baths ? `${property.baths} bath` : "",
    roomCount > 1 ? `${roomCount} rooms` : "",
    property.available ? `Available ${clean(property.available)}` : "",
  ].filter(Boolean);
  const factsLine = facts.join(" · ");

  const points = (sub?.quickFacts ?? [])
    .map((f) => [clean(f.label), clean(f.value)].filter(Boolean).join(": "))
    .filter(Boolean)
    .slice(0, 4)
    .map((p) => `• ${p}`);

  const link = taggedListingLink(buildManagerListingUrl(origin, property.id), channel);
  const contactLine = ["Text " + phone, email ? `Email ${email}` : ""].filter(Boolean).join(" · ");
  const contactBlock = [`Details and photos: ${link}`, contactLine].join("\n");
  const attributionBlock = attribution ? listingAttributionLine(origin) : "";
  const tail = [contactBlock, attributionBlock].filter(Boolean).join("\n\n");

  const limit = listingChannelDef(channel)?.textLimit ?? 2000;
  const head = [headline, where, factsLine].filter(Boolean).join("\n");
  const fixed = [head, tail].filter(Boolean).join("\n\n");
  const room = limit - fixed.length - 4 * 2;
  const overview = firstSentences(sub?.houseOverview ?? "", 400);
  const bodyBlocks = [overview, points.join("\n")].filter(Boolean);
  let body = bodyBlocks.join("\n\n");
  if (room <= 0) body = "";
  else if (body.length > room) body = trimTo(body, room);

  const text = [head, body, tail].filter(Boolean).join("\n\n");
  // The fixed parts alone can exceed a tiny limit; hard-cap while keeping the contact line.
  if (text.length <= limit) return { ok: true, text };
  return { ok: true, text: `${trimTo(head, Math.max(0, limit - tail.length - 2))}\n\n${tail}` };
}
