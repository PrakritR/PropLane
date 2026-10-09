/**
 * Listing sites: the one registry of every place a listing can be advertised.
 *
 * Pure and client-safe. A channel has exactly one posting mode:
 *  - `feed`: nothing is pushed; the channel's own crawler reads PropLane's public feed (Zillow).
 *  - `api`: PropLane posts through the channel's API once approved (Facebook Page + Instagram via Meta).
 *  - `manual`: the site forbids automated posting, so PropLane builds the post and the manager pastes it.
 *  - `partner_only`: the site takes listings only from partner feeds; there is nothing to post by hand.
 *
 * Nothing here scrapes or drives a browser. Every channel carries a `guide` (sign-up, where to post,
 * cost, account-safety rules) that the Listing sites drawer renders verbatim.
 */

export type ListingChannelPosting = "feed" | "api" | "manual" | "partner_only";
export type ListingChannelAvailability = "live" | "coming_soon" | "partner_only";

export type ListingChannelId =
  | "zillow"
  | "facebook_marketplace"
  | "facebook_groups"
  | "craigslist"
  | "spareroom"
  | "roomies"
  | "roomster"
  | "zumper_padmapper"
  | "apartments_com"
  | "redfin_rent"
  | "apartment_list"
  | "furnished_finder"
  | "nextdoor"
  | "reddit"
  | "facebook_page"
  | "instagram";

export type ListingChannelGuide = {
  /** One paragraph: how this site works and what PropLane does or cannot do for it. */
  how: string;
  signupUrl?: string;
  signupNote: string;
  createUrl?: string;
  createNote: string;
  cost: string;
  /** "Keep the account safe": the site's own posting rules. */
  rules: string[];
};

export type PartnerContact = { kind: "email"; address: string } | { kind: "url"; url: string };

export type ListingChannelDef = {
  id: ListingChannelId;
  label: string;
  posting: ListingChannelPosting;
  /** Row order in Listing sites, by reach. */
  order: number;
  /**
   * How an automatic channel publishes. `feed`: nothing is pushed, the channel's own crawler reads
   * PropLane's public feed (Zillow). `api`: PropLane calls the channel's API (Meta).
   */
  mode?: "feed" | "api";
  /** True for the channels that go live only once the Meta app is approved. */
  needsMetaApp?: boolean;
  /** Characters the channel accepts in one post; the builder trims the body, never the contact or link lines. */
  textLimit: number;
  /** The site's own create-listing page. */
  createUrl?: string;
  /**
   * The company's real partner contact. These are company-to-company requests the PropLane team sends
   * itself, so only a PropLane admin is ever shown the link (the API withholds it from everyone else).
   */
  partnerContact?: PartnerContact;
  guide: ListingChannelGuide;
};

export const LISTING_CHANNEL_DEFS: readonly ListingChannelDef[] = [
  {
    id: "zillow",
    label: "Zillow Rental Network",
    posting: "feed",
    order: 1,
    mode: "feed",
    textLimit: 5000,
    createUrl: "https://www.zillow.com/rental-manager/",
    guide: {
      how: "PropLane publishes a feed that Zillow reads every few hours and shows on Zillow, Trulia and HotPads. Zillow has to approve the feed once; until then post by hand in Rental Manager.",
      signupUrl: "https://www.zillow.com/rental-manager/",
      signupNote: "Free. Sign up with the work email.",
      createUrl: "https://www.zillow.com/rental-manager/",
      createNote: "Add a property, paste the description, upload the photos.",
      cost: "Free",
      rules: ["One listing per unit; renew rather than repost.","Zillow filters phone numbers out of some descriptions; the work number is still in the contact box."],
    },
  },
  {
    id: "facebook_marketplace",
    label: "Facebook Marketplace",
    posting: "manual",
    order: 2,
    textLimit: 5000,
    createUrl: "https://www.facebook.com/marketplace/create/rental",
    guide: {
      how: "Meta allows no automated rental posts. Copy the post, paste it on Marketplace, upload the photos.",
      signupUrl: "https://www.facebook.com/signup",
      signupNote: "Free. A personal Facebook account is enough.",
      createUrl: "https://www.facebook.com/marketplace/create/rental",
      createNote: "Choose Rentals, paste the description, add the photos.",
      cost: "Free",
      rules: ["One ad per unit. Renew the ad from your listings page instead of posting a copy.","Do not put the phone number in the title."],
    },
  },
  {
    id: "facebook_groups",
    label: "Facebook Groups",
    posting: "manual",
    order: 3,
    textLimit: 5000,
    createUrl: "https://www.facebook.com/groups/search/groups/?q=seattle%20housing",
    guide: {
      how: "Student and city housing groups are where most room-by-room renters look. Join the groups once, then paste the post in each.",
      signupUrl: "https://www.facebook.com/signup",
      signupNote: "Free. Same account as Marketplace.",
      createUrl: "https://www.facebook.com/groups/search/groups/?q=seattle%20housing",
      createNote: "Search \"Seattle housing\", \"UW sublets\". Join, read the pinned rules, post.",
      cost: "Free",
      rules: ["Most groups allow one post per unit per week.","Some require a price and photos in the post itself."],
    },
  },
  {
    id: "craigslist",
    label: "Craigslist",
    posting: "manual",
    order: 4,
    textLimit: 5000,
    createUrl: "https://post.craigslist.org/",
    guide: {
      how: "Craigslist forbids posting software, so you paste. It still brings a lot of whole-unit renters.",
      signupUrl: "https://accounts.craigslist.org/login/signup",
      signupNote: "Free. Email verification.",
      createUrl: "https://post.craigslist.org/",
      createNote: "housing offered › rooms & shares (or apts/housing for rent). Paste, add photos.",
      cost: "Free in most cities. A few large metros charge a small fee per apartment ad.",
      rules: ["Never post the same unit twice; use Renew.","Keep the phone number out of the title."],
    },
  },
  {
    id: "spareroom",
    label: "SpareRoom",
    posting: "manual",
    order: 5,
    textLimit: 5000,
    createUrl: "https://www.spareroom.com/",
    partnerContact: { kind: "email", address: "customerservices@spareroom.com" },
    guide: {
      how: "The biggest room-by-room site. Basic ads are free; paste the post and upload photos.",
      signupUrl: "https://www.spareroom.com/",
      signupNote: "Free. Register, then Advertise.",
      createUrl: "https://www.spareroom.com/",
      createNote: "Post an ad › Room(s) for rent. Paste, add photos.",
      cost: "Free basic ad; paid boost optional.",
      rules: ["One ad per room or unit.","Reply inside SpareRoom first; some renters never leave the app."],
    },
  },
  {
    id: "roomies",
    label: "Roomies",
    posting: "manual",
    order: 6,
    textLimit: 2000,
    createUrl: "https://www.roomies.com/post",
    guide: {
      how: "Room-by-room site. Paste the post.",
      signupUrl: "https://www.roomies.com/",
      signupNote: "Free.",
      createUrl: "https://www.roomies.com/post",
      createNote: "Post a room, paste, add photos.",
      cost: "Free",
      rules: ["One ad per room."],
    },
  },
  {
    id: "roomster",
    label: "Roomster",
    posting: "manual",
    order: 7,
    textLimit: 2000,
    createUrl: "https://www.roomster.com/post",
    guide: {
      how: "Room-by-room site. Paste the post.",
      signupUrl: "https://www.roomster.com/",
      signupNote: "Free to list.",
      createUrl: "https://www.roomster.com/post",
      createNote: "Post, paste, add photos.",
      cost: "Free to list",
      rules: ["One ad per room."],
    },
  },
  {
    id: "zumper_padmapper",
    label: "Zumper and PadMapper",
    posting: "manual",
    order: 8,
    textLimit: 5000,
    createUrl: "https://www.zumper.com/manage",
    partnerContact: { kind: "email", address: "directlistings@zumper.com" },
    guide: {
      how: "Posts by hand today in Zumper Manage. A feed partnership (50+ listings) is on the admin list; when it lands this row posts for you.",
      signupUrl: "https://www.zumper.com/manage",
      signupNote: "Free for landlords.",
      createUrl: "https://www.zumper.com/manage",
      createNote: "Add listing, paste, add photos. Shows on Zumper and PadMapper.",
      cost: "Free",
      rules: ["Keep the price current; stale ads drop in search."],
    },
  },
  {
    id: "apartments_com",
    label: "Apartments.com",
    posting: "manual",
    order: 9,
    textLimit: 5000,
    createUrl: "https://www.apartments.com/advertise/",
    partnerContact: { kind: "email", address: "feeds@apartments.com" },
    guide: {
      how: "Posts by hand today. The MITS feed is on the admin list.",
      signupUrl: "https://www.apartments.com/advertise/",
      signupNote: "Free for private landlords.",
      createUrl: "https://www.apartments.com/advertise/",
      createNote: "List your property, paste, add photos.",
      cost: "Free for private landlords",
      rules: ["A verification call is possible on the first listing."],
    },
  },
  {
    id: "redfin_rent",
    label: "Redfin (via Rent.)",
    posting: "manual",
    order: 10,
    textLimit: 5000,
    createUrl: "https://www.rent.com/",
    guide: {
      how: "Redfin shows rentals from the Rent. network, which it owns. List on Rent.com and it appears on Redfin, Rent.com and ApartmentGuide.",
      signupUrl: "https://www.rent.com/",
      signupNote: "List your property, free for landlords.",
      createUrl: "https://www.rent.com/",
      createNote: "Landlord dashboard › Add listing.",
      cost: "Free",
      rules: ["One listing per unit."],
    },
  },
  {
    id: "apartment_list",
    label: "Apartment List",
    posting: "partner_only",
    order: 11,
    textLimit: 5000,
    partnerContact: { kind: "email", address: "clientservices@apartmentlist.com" },
    guide: {
      how: "Apartment List takes listings only from partner feeds. There is nothing to post by hand; PropLane has asked for partner access.",
      signupNote: "",
      createNote: "",
      cost: "",
      rules: [],
    },
  },
  {
    id: "furnished_finder",
    label: "Furnished Finder",
    posting: "manual",
    order: 12,
    textLimit: 5000,
    createUrl: "https://www.furnishedfinder.com/",
    partnerContact: { kind: "email", address: "partnerships@furnishedfinder.com" },
    guide: {
      how: "Furnished, mid-term stays (travel nurses). Paid yearly listing.",
      signupUrl: "https://www.furnishedfinder.com/",
      signupNote: "Paid yearly listing per property.",
      createUrl: "https://www.furnishedfinder.com/",
      createNote: "List your property, paste, add photos.",
      cost: "Paid yearly per property",
      rules: ["Only furnished units."],
    },
  },
  {
    id: "nextdoor",
    label: "Nextdoor",
    posting: "manual",
    order: 13,
    textLimit: 5000,
    createUrl: "https://nextdoor.com/for_sale_and_free/",
    partnerContact: { kind: "url", url: "https://forms.gle/i2hHc4A9noKJRBGW9" },
    guide: {
      how: "Neighbors see it. Address-verified account.",
      signupUrl: "https://nextdoor.com/",
      signupNote: "Free. Verifies your address.",
      createUrl: "https://nextdoor.com/for_sale_and_free/",
      createNote: "For Sale & Free › Housing, paste, add photos.",
      cost: "Free",
      rules: ["One post per unit per neighborhood."],
    },
  },
  {
    id: "reddit",
    label: "Reddit",
    posting: "manual",
    order: 14,
    textLimit: 5000,
    createUrl: "https://www.reddit.com/search/?q=seattle%20housing&type=sr",
    guide: {
      how: "City and campus housing subreddits. Read the sidebar rules first; most need a flair.",
      signupUrl: "https://www.reddit.com/register",
      signupNote: "Free.",
      createUrl: "https://www.reddit.com/search/?q=seattle%20housing&type=sr",
      createNote: "Pick the subreddit, New post, flair \"Housing\", paste.",
      cost: "Free",
      rules: ["Many subreddits limit to one post per week per unit.","Some forbid phone numbers; the link carries the contact."],
    },
  },
  {
    id: "facebook_page",
    label: "Facebook Page",
    posting: "api",
    order: 15,
    mode: "api",
    needsMetaApp: true,
    textLimit: 5000,
    createUrl: "https://www.facebook.com/",
    guide: {
      how: "PropLane will post to your Page for you once Meta approves the app. Until then, paste the post on your Page.",
      signupUrl: "https://www.facebook.com/pages/create",
      signupNote: "Free. Create a business Page.",
      createUrl: "https://www.facebook.com/",
      createNote: "Your Page › Create post, paste, add photos.",
      cost: "Free",
      rules: ["Business Page, not a personal profile."],
    },
  },
  {
    id: "instagram",
    label: "Instagram",
    posting: "api",
    order: 16,
    mode: "api",
    needsMetaApp: true,
    textLimit: 2200,
    createUrl: "https://www.instagram.com/",
    guide: {
      how: "Posts for you once Meta approves the app. Until then, paste the caption on a photo post.",
      signupUrl: "https://www.instagram.com/accounts/emailsignup/",
      signupNote: "Free. Switch to a business account in settings.",
      createUrl: "https://www.instagram.com/",
      createNote: "New post, pick the photos, paste the caption (2,200 max).",
      cost: "Free",
      rules: ["A post needs at least one photo."],
    },
  },
];

/** Dropped from Listing sites; kept so the admin partner kit can still show their contacts. */
export const RETIRED_PARTNER_CONTACTS: Record<string, { label: string; contact: PartnerContact }> = {
  google_business_profile: {
    label: "Google Business Profile",
    contact: { kind: "url", url: "https://support.google.com/business/contact/api_default" },
  },
  linkedin: {
    label: "LinkedIn",
    contact: {
      kind: "url",
      url: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-06",
    },
  },
};

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
  if (def.posting === "partner_only") return "partner_only";
  if (def.posting === "api") return metaChannelsLive(env) ? "live" : "coming_soon";
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

/** Every channel in Listing sites row order (by reach). */
export function listingChannelsOrdered(): ListingChannelDef[] {
  return [...LISTING_CHANNEL_DEFS].sort((a, b) => a.order - b.order);
}

/** The channels PropLane itself posts to through an API (the queue only ever touches these). */
export function apiPostingChannelIds(): ListingChannelId[] {
  return LISTING_CHANNEL_DEFS.filter((def) => def.posting === "api").map((def) => def.id);
}

/** The href of a channel's real partner contact (a mail draft or the company's contact page), or null. */
export function partnerContactHref(def: Pick<ListingChannelDef, "label" | "partnerContact">): string | null {
  const contact = def.partnerContact;
  if (!contact) return null;
  if (contact.kind === "url") return contact.url;
  const subject = encodeURIComponent(`Listing partnership: PropLane and ${def.label}`);
  return `mailto:${contact.address}?subject=${subject}`;
}

/** channel id -> partner contact href for every channel with a partner contact; sent only to PropLane admins. */
export function partnerContactHrefs(): Partial<Record<ListingChannelId, string>> {
  const out: Partial<Record<ListingChannelId, string>> = {};
  for (const def of LISTING_CHANNEL_DEFS) {
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
  /** The ad link the manager pasted on "Mark as posted"; https only, cleared by Undo. */
  postedUrl: string | null;
  updatedAt: string | null;
};
