import type { PlatformSource } from "@/lib/prospect-spine/contracts";

/** The sites whose inquiry mail PropLane reads as a LEAD (a prospect), not a booked guest. */
export const PLATFORM_LEAD_SITES = ["spareroom", "roomies", "zillow", "craigslist", "facebook", "roomster"] as const satisfies readonly PlatformSource[];
export type PlatformLeadSite = (typeof PLATFORM_LEAD_SITES)[number];

export const PLATFORM_LEAD_LABEL: Record<PlatformLeadSite, string> = {
  spareroom: "SpareRoom",
  roomies: "Roomies",
  zillow: "Zillow",
  craigslist: "Craigslist",
  facebook: "Facebook",
  roomster: "Roomster",
};

/** The site's own sending / relay domains. A look-alike (zillow.com.evil.test, notzillow.com) is not one. */
export const PLATFORM_LEAD_DOMAINS: Record<PlatformLeadSite, readonly string[]> = {
  spareroom: ["spareroom.com", "spareroom.co.uk"],
  roomies: ["roomies.com"],
  zillow: ["zillow.com", "zillowrentals.com"],
  craigslist: ["craigslist.org"],
  facebook: ["facebookmail.com"],
  roomster: ["roomster.com"],
};

/**
 * Whether the site-specific parser is built from a REAL notification mail of that site. None is: no real inquiry mail was
 * available (the captain has not forwarded one), so every parser below is written from the site's known notification
 * shape. The verified flag is therefore `false` for all but SpareRoom, whose parser has shipped and handled live mail
 * (its fixture is still synthetic). An unverified site's parser stays OFF by default and its mail takes the GENERIC fallback
 * (sender domain -> site, listing and room matched by text): nothing is dropped. `PLATFORM_LEAD_PARSERS=roomies,zillow`
 * switches a site's parser on once the captain has confirmed it against a real mail.
 */
export const PLATFORM_LEAD_PARSER_VERIFIED: Record<PlatformLeadSite, boolean> = {
  spareroom: true,
  roomies: false,
  zillow: false,
  craigslist: false,
  facebook: false,
  roomster: false,
};

export type PlatformLeadMessage = {
  site: PlatformLeadSite;
  senderName: string;
  body: string;
  /** The listing as the mail names it (an ad title, an address), matched to a house and room later. */
  listingHint: string | null;
  /** "Room 9" style text, when the mail names a room. */
  roomHint: string | null;
  /** Where the site relays a reply, only ever on the site's own domain. */
  replyAddress: string | null;
  /** A phone number the PROSPECT wrote in the message (never PropLane's own line), strict E.164. */
  phoneInBody: string | null;
  platformThreadId: string | null;
  /** The listing or conversation URL the mail carried (for "Open on <site>"). */
  listingUrl: string | null;
  /** Which parser read it: the site's own, or the generic fallback. */
  via: "site" | "generic";
};

export type LeadParseInput = {
  fromEmail: string;
  fromName?: string | null;
  subject: string;
  text: string;
  replyTo?: string | null;
  /** PropLane's own numbers (E.164): never read as the prospect's. */
  excludePhones?: readonly string[];
};
