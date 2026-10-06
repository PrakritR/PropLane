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
  /**
   * request_access: the company's real partner contact. These are company-to-company requests the
   * PropLane team sends itself, so only a PropLane admin is ever shown the link (the API withholds it
   * from everyone else); a manager just sees "Coming soon".
   */
  partnerContact?: { kind: "email"; address: string } | { kind: "url"; url: string };
};

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
    id: "craigslist",
    label: "Craigslist",
    group: "one_click",
    textLimit: 5000,
    createUrl: "https://post.craigslist.org/",
  },
  // Request access: partner agreement or API approval first.
  {
    id: "zumper_padmapper",
    label: "Zumper and PadMapper",
    group: "request_access",
    textLimit: 5000,
    partnerContact: { kind: "email", address: "directlistings@zumper.com" },
  },
  {
    id: "apartments_com",
    label: "Apartments.com",
    group: "request_access",
    textLimit: 5000,
    partnerContact: { kind: "email", address: "feeds@apartments.com" },
  },
  {
    id: "apartment_list",
    label: "Apartment List",
    group: "request_access",
    textLimit: 5000,
    partnerContact: { kind: "email", address: "clientservices@apartmentlist.com" },
  },
  {
    id: "furnished_finder",
    label: "Furnished Finder",
    group: "request_access",
    textLimit: 5000,
    partnerContact: { kind: "email", address: "partnerships@furnishedfinder.com" },
  },
  {
    id: "spareroom",
    label: "SpareRoom",
    group: "request_access",
    textLimit: 5000,
    partnerContact: { kind: "email", address: "customerservices@spareroom.com" },
  },
  {
    id: "nextdoor",
    label: "Nextdoor",
    group: "request_access",
    textLimit: 5000,
    partnerContact: { kind: "url", url: "https://forms.gle/i2hHc4A9noKJRBGW9" },
  },
  {
    id: "google_business_profile",
    label: "Google Business Profile",
    group: "request_access",
    textLimit: 1500,
    partnerContact: { kind: "url", url: "https://support.google.com/business/contact/api_default" },
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    group: "request_access",
    textLimit: 3000,
    partnerContact: {
      kind: "url",
      url: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-06",
    },
  },
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

/** The href of a request-access channel's real partner contact (a mail draft or the company's contact page), or null. */
export function partnerContactHref(def: Pick<ListingChannelDef, "label" | "partnerContact">): string | null {
  const contact = def.partnerContact;
  if (!contact) return null;
  if (contact.kind === "url") return contact.url;
  const subject = encodeURIComponent(`Listing partnership: PropLane and ${def.label}`);
  return `mailto:${contact.address}?subject=${subject}`;
}

/** channel id -> partner contact href for every request-access channel; sent only to PropLane admins. */
export function partnerContactHrefs(): Partial<Record<ListingChannelId, string>> {
  const out: Partial<Record<ListingChannelId, string>> = {};
  for (const def of listingChannelsByGroup("request_access")) {
    const href = partnerContactHref(def);
    if (href) out[def.id] = href;
  }
  return out;
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
