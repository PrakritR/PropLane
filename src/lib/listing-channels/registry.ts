/**
 * Listing sites: the one registry of every place a listing can be advertised.
 *
 * Pure and client-safe. A channel is exactly one of three kinds:
 *  - `automatic`: PropLane posts for the manager through an official API or feed
 *    (Zillow Rental Network feed, Facebook Page + Instagram through Meta's Graph API).
 *  - `one_click`: the site forbids automated posting, so PropLane builds the post,
 *    copies it and opens the site's own create page; the manager publishes it.
 *  - `request_access`: needs a partner agreement or API approval first.
 *
 * Nothing here scrapes or drives a browser. Availability is data: a channel that is not
 * approved yet is `coming_soon` and nothing posts.
 */

import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";

export type ListingChannelGroup = "automatic" | "one_click" | "request_access";
export type ListingChannelAvailability = "live" | "coming_soon";

export type ListingChannelId =
  | "zillow"
  | "facebook_page"
  | "instagram"
  | "facebook_marketplace"
  | "facebook_groups"
  | "roomster"
  | "roomies"
  | "furnished_finder"
  | "craigslist"
  | "zumper_padmapper"
  | "apartments_com"
  | "apartment_list"
  | "spareroom"
  | "nextdoor"
  | "google_business_profile"
  | "linkedin";

export type ListingChannelDef = {
  id: ListingChannelId;
  label: string;
  group: ListingChannelGroup;
  /**
   * How an automatic channel publishes. `feed`: nothing is pushed, the channel's own crawler reads
   * PropLane's public feed (Zillow). `api`: PropLane calls the channel's API (Meta).
   */
  mode?: "feed" | "api";
  /** True for the channels that go live only once the Meta app is approved. */
  needsMetaApp?: boolean;
  /** Characters the channel accepts in one post; the builder trims the body, never the contact or link lines. */
  textLimit: number;
  /** one_click: the site's own create-listing page. */
  createUrl?: string;
};

/** The one contact address a "Request access" button opens a mail draft to. */
export const LISTING_CHANNEL_REQUEST_EMAIL = PUBLIC_SUPPORT_EMAIL;

export const LISTING_CHANNEL_DEFS: readonly ListingChannelDef[] = [
  // Automatic: official API or feed.
  { id: "zillow", label: "Zillow Rental Network", group: "automatic", mode: "feed", textLimit: 5000 },
  { id: "facebook_page", label: "Facebook Page", group: "automatic", mode: "api", needsMetaApp: true, textLimit: 5000 },
  { id: "instagram", label: "Instagram", group: "automatic", mode: "api", needsMetaApp: true, textLimit: 2200 },
  // One-click: the site forbids automated posting; PropLane pre-fills, the manager publishes.
  {
    id: "facebook_marketplace",
    label: "Facebook Marketplace",
    group: "one_click",
    textLimit: 5000,
    createUrl: "https://www.facebook.com/marketplace/create/rental",
  },
  {
    id: "facebook_groups",
    label: "Facebook Groups",
    group: "one_click",
    textLimit: 5000,
    createUrl: "https://www.facebook.com/groups/feed/",
  },
  { id: "roomster", label: "Roomster", group: "one_click", textLimit: 2000, createUrl: "https://roomster.com/post" },
  { id: "roomies", label: "Roomies", group: "one_click", textLimit: 2000, createUrl: "https://www.roomies.com/post" },
  {
    id: "furnished_finder",
    label: "Furnished Finder",
    group: "one_click",
    textLimit: 2000,
    createUrl: "https://www.furnishedfinder.com/listing",
  },
  {
    id: "craigslist",
    label: "Craigslist",
    group: "one_click",
    textLimit: 5000,
    createUrl: "https://post.craigslist.org/",
  },
  // Request access: partner agreement or API approval first.
  { id: "zumper_padmapper", label: "Zumper and PadMapper", group: "request_access", textLimit: 5000 },
  { id: "apartments_com", label: "Apartments.com", group: "request_access", textLimit: 5000 },
  { id: "apartment_list", label: "Apartment List", group: "request_access", textLimit: 5000 },
  { id: "spareroom", label: "SpareRoom", group: "request_access", textLimit: 5000 },
  { id: "nextdoor", label: "Nextdoor", group: "request_access", textLimit: 5000 },
  { id: "google_business_profile", label: "Google Business Profile", group: "request_access", textLimit: 1500 },
  { id: "linkedin", label: "LinkedIn", group: "request_access", textLimit: 3000 },
];

export type ListingChannel = ListingChannelDef & { availability: ListingChannelAvailability };

type EnvLike = Record<string, string | undefined>;

/**
 * Facebook Page and Instagram post only when the Meta app exists (id + secret) AND is marked live.
 * A development-mode app may set the flag on a dev server to test with its own Page; production leaves
 * it unset until Meta's App Review approves PropLane, so every other manager sees "Coming soon".
 */
export function metaChannelsLive(env: EnvLike = process.env): boolean {
  return Boolean(env.META_APP_ID?.trim() && env.META_APP_SECRET?.trim() && env.META_APP_LIVE?.trim() === "1");
}

/** Meta's OAuth can start whenever the app exists, even before it is marked live. */
export function metaAppConfigured(env: EnvLike = process.env): boolean {
  return Boolean(env.META_APP_ID?.trim() && env.META_APP_SECRET?.trim());
}

export function listingChannelAvailability(def: ListingChannelDef, env: EnvLike = process.env): ListingChannelAvailability {
  if (def.group === "request_access") return "coming_soon";
  if (def.needsMetaApp) return metaChannelsLive(env) ? "live" : "coming_soon";
  return "live";
}

export function listingChannels(env: EnvLike = process.env): ListingChannel[] {
  return LISTING_CHANNEL_DEFS.map((def) => ({ ...def, availability: listingChannelAvailability(def, env) }));
}

export function listingChannelDef(id: string): ListingChannelDef | null {
  return LISTING_CHANNEL_DEFS.find((def) => def.id === id) ?? null;
}

export function isListingChannelId(value: unknown): value is ListingChannelId {
  return typeof value === "string" && LISTING_CHANNEL_DEFS.some((def) => def.id === value);
}

export function listingChannelsByGroup(group: ListingChannelGroup): ListingChannelDef[] {
  return LISTING_CHANNEL_DEFS.filter((def) => def.group === group);
}

/** The channels PropLane itself posts to through an API (the queue only ever touches these). */
export function apiPostingChannelIds(): ListingChannelId[] {
  return LISTING_CHANNEL_DEFS.filter((def) => def.group === "automatic" && def.mode === "api").map((def) => def.id);
}

export function requestAccessMailto(def: Pick<ListingChannelDef, "label">): string {
  const subject = encodeURIComponent(`Request access: ${def.label}`);
  const body = encodeURIComponent(`Please enable ${def.label} listing posting for my PropLane workspace.`);
  return `mailto:${LISTING_CHANNEL_REQUEST_EMAIL}?subject=${subject}&body=${body}`;
}

/** Row states stored in `listing_channel_posts.state`. */
export type ListingChannelPostState = "pending" | "posting" | "posted" | "held" | "failed" | "off" | "posted_by_me";
export type ListingChannelPendingAction = "publish" | "update" | "unpublish";

export type ListingChannelPostRow = {
  propertyId: string;
  channel: ListingChannelId;
  enabled: boolean;
  state: ListingChannelPostState;
  externalId: string | null;
  lastError: string | null;
  postedAt: string | null;
  updatedAt: string | null;
};
