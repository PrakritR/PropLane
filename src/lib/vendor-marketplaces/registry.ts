/**
 * Vendor services: the one registry of outside marketplaces where a manager can find someone for an odd job.
 *
 * Pure and client-safe. Nothing here scrapes, calls a marketplace API or drives a browser: every entry is a
 * plain public link the manager opens in their own tab. `integration` is "coming_soon" for all of them -
 * a direct connection (post and read replies from PropLane) is future work; today the manager keeps the
 * account at the marketplace and PropLane only remembers that it exists (`vendor_marketplace_accounts`).
 *
 * URL verification (curl -sIL with a desktop User-Agent, 2026-10-09). 200 unless noted:
 *  - TaskRabbit: /register, /services/{handyman,cleaning,furniture-assembly,moving,painting,plumbing,
 *    electrical-help,yardwork-removal}. /services/{electrical,hvac,locksmith,appliance-repair,junk-removal} are 404, so
 *    TaskRabbit does not list those services.
 *  - Thumbtack: /register, /k/{slug}/near-me/ for handyman, house-cleaning, locksmith, plumbers, electricians,
 *    hvac-technicians, appliance-repair, pest-control, landscaping, junk-removal, furniture-assembly,
 *    interior-painting. (/k/painters/ and /search/... are 404 and unused; Thumbtack has no zip deep link.)
 *  - Angi: https://www.angi.com/ and /auth/login answer behind a Cloudflare 403 bot wall to curl; the /nearme/ and
 *    /companylist/ deep links answer the same 403 for a made-up slug too, so they cannot be told apart from
 *    real ones. Angi therefore links its homepage for search and post. HomeAdvisor is omitted: it is Angi
 *    today (homeadvisor.com serves Angi).
 *  - Yelp: /signup 200; https://www.yelp.com/search?find_desc=...&find_loc=... is Yelp's own search URL and
 *    answers 403 (bot wall) to curl, like the rest of yelp.com; a bogus root path is 404, so the wall does
 *    not mask the search path.
 *  - Nextdoor: https://nextdoor.com/ 200. Its /services, /signup and /find-neighbors paths are 404, so the
 *    homepage is used for every link.
 *  - Craigslist: https://www.craigslist.org/about/sites (area chooser) 200, https://post.craigslist.org/ 200
 *    (area chooser for a post), https://accounts.craigslist.org/login 200. Area subdomains need the city's
 *    Craigslist area, which PropLane does not know, so there is no deep search link.
 *  - Handy: /login 200, /services 200, /services/{handyman,cleaning,electrical,appliance-repair,pest-control,
 *    landscaping,moving,furniture-assembly,painting} 200. /services/{plumbing,hvac} redirect to the index and
 *    /services/{locksmith,junk-removal} are 404, so Handy does not list those.
 *  - Bark: /en/us/ 200, /en/us/{handyman,cleaners,locksmith,plumbers,electricians,hvac,appliance-repair,
 *    pest-control,landscaping,waste-removal,furniture-assembly,painters}/ 200 (bogus slug is 404).
 *  - Porch is omitted: porch.com now answers 404 and presents as a home-insurance company. Airtasker is omitted:
 *    it no longer operates in the US.
 */
import {
  Briefcase,
  Hammer,
  Home,
  MessageSquare,
  Megaphone,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";

import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

export type ServiceKind =
  | "cleaning"
  | "locksmith"
  | "handyman"
  | "plumbing"
  | "electrical"
  | "hvac"
  | "appliance_repair"
  | "pest_control"
  | "landscaping"
  | "moving_junk"
  | "furniture_assembly"
  | "painting";

export type VendorMarketplaceId =
  | "taskrabbit"
  | "thumbtack"
  | "angi"
  | "yelp"
  | "nextdoor"
  | "craigslist"
  | "handy"
  | "bark";

/** What the house tells a search link about where the job is. Either may be empty. */
export type MarketplaceLocation = { zip?: string; city?: string };

export type VendorMarketplaceGuide = {
  /** One paragraph: how the marketplace works for someone hiring. */
  how: string;
  cost: string;
  /** "Keep the account safe": the marketplace's own rules and the usual cautions. */
  rules: string[];
};

export type VendorMarketplaceDef = {
  id: VendorMarketplaceId;
  label: string;
  /** Row order, by reach. */
  order: number;
  glyph: { icon: LucideIcon; tone: string };
  services: readonly ServiceKind[];
  /** The marketplace's own search or category page for this service, or null when it has no useful one. */
  searchUrl: ((service: ServiceKind, location: MarketplaceLocation) => string) | null;
  /** Where a job is posted for this service, or null when posting starts from search results. */
  postUrl: ((service: ServiceKind) => string) | null;
  signupUrl: string;
  guide: VendorMarketplaceGuide;
  integration: "coming_soon";
};

const trade = (label: (typeof VENDOR_TRADE_OPTIONS)[number]) => label;

/** Labels for the service picker. Where a vendor trade already names it, that wording is reused. */
export const SERVICE_LABELS: Record<ServiceKind, string> = {
  cleaning: trade("Cleaning"),
  locksmith: "Locksmith",
  handyman: "Handyman",
  plumbing: trade("Plumbing"),
  electrical: trade("Electrical"),
  hvac: trade("HVAC"),
  appliance_repair: trade("Appliance repair"),
  pest_control: trade("Pest control"),
  landscaping: trade("Landscaping"),
  moving_junk: "Moving and junk removal",
  furniture_assembly: "Furniture assembly",
  painting: "Painting",
};

export const SERVICE_KINDS = Object.keys(SERVICE_LABELS) as ServiceKind[];
export const DEFAULT_SERVICE: ServiceKind = "handyman";

/** One-line starter text for the job post, per service. */
export const SERVICE_DEFAULT_DESCRIPTION: Record<ServiceKind, string> = {
  cleaning: "Looking for a cleaner for a one-time clean. Supplies can be provided.",
  locksmith: "Need a locksmith to rekey or replace a lock. Please share your arrival window and price up front.",
  handyman: "Need a handyman for a small repair job. Please share your availability and a rough price.",
  plumbing: "Need a plumber for a repair. Please share your availability and a rough price.",
  electrical: "Need an electrician for a repair. Please share your availability and a rough price.",
  hvac: "Need an HVAC technician to look at the heating or cooling. Please share your availability and a rough price.",
  appliance_repair: "Need an appliance repair visit. Please share your availability and a rough price.",
  pest_control: "Need a pest control visit. Please share what you treat, your availability and a rough price.",
  landscaping: "Need yard work done. Please share your availability and a rough price.",
  moving_junk: "Need help moving items or hauling away junk. Please share your availability and a rough price.",
  furniture_assembly: "Need furniture assembled. Please share your availability and a rough price.",
  painting: "Need a room or unit painted. Please share your availability and a rough price.",
};

const enc = encodeURIComponent;
const locationText = (loc: MarketplaceLocation): string => (loc.zip?.trim() || loc.city?.trim() || "").trim();

const TASKRABBIT_SLUG: Partial<Record<ServiceKind, string>> = {
  handyman: "handyman",
  cleaning: "cleaning",
  furniture_assembly: "furniture-assembly",
  moving_junk: "moving",
  painting: "painting",
  plumbing: "plumbing",
  electrical: "electrical-help",
  landscaping: "yardwork-removal",
};

const THUMBTACK_SLUG: Record<ServiceKind, string> = {
  cleaning: "house-cleaning",
  locksmith: "locksmith",
  handyman: "handyman",
  plumbing: "plumbers",
  electrical: "electricians",
  hvac: "hvac-technicians",
  appliance_repair: "appliance-repair",
  pest_control: "pest-control",
  landscaping: "landscaping",
  moving_junk: "junk-removal",
  furniture_assembly: "furniture-assembly",
  painting: "interior-painting",
};

const HANDY_SLUG: Partial<Record<ServiceKind, string>> = {
  handyman: "handyman",
  cleaning: "cleaning",
  electrical: "electrical",
  appliance_repair: "appliance-repair",
  pest_control: "pest-control",
  landscaping: "landscaping",
  moving_junk: "moving",
  furniture_assembly: "furniture-assembly",
  painting: "painting",
};

const BARK_SLUG: Record<ServiceKind, string> = {
  cleaning: "cleaners",
  locksmith: "locksmith",
  handyman: "handyman",
  plumbing: "plumbers",
  electrical: "electricians",
  hvac: "hvac",
  appliance_repair: "appliance-repair",
  pest_control: "pest-control",
  landscaping: "landscaping",
  moving_junk: "waste-removal",
  furniture_assembly: "furniture-assembly",
  painting: "painters",
};

const taskrabbitUrl = (service: ServiceKind) => `https://www.taskrabbit.com/services/${TASKRABBIT_SLUG[service] ?? "handyman"}`;
const thumbtackUrl = (service: ServiceKind) => `https://www.thumbtack.com/k/${THUMBTACK_SLUG[service]}/near-me/`;
const handyUrl = (service: ServiceKind) => `https://www.handy.com/services/${HANDY_SLUG[service] ?? ""}`.replace(/\/$/, "");
const barkUrl = (service: ServiceKind) => `https://www.bark.com/en/us/${BARK_SLUG[service]}/`;

const keys = <T extends string>(map: Partial<Record<T, string>>) => Object.keys(map) as T[];

export const VENDOR_MARKETPLACE_DEFS: readonly VendorMarketplaceDef[] = [
  {
    id: "taskrabbit",
    label: "TaskRabbit",
    order: 1,
    glyph: { icon: Hammer, tone: "text-emerald-600" },
    services: keys(TASKRABBIT_SLUG),
    searchUrl: (service) => taskrabbitUrl(service),
    postUrl: (service) => taskrabbitUrl(service),
    signupUrl: "https://www.taskrabbit.com/register",
    guide: {
      how: "Pick a service, enter the address and see Taskers who are free, with prices and reviews. Book one by the hour.",
      cost: "No fee to post. You pay the Tasker's hourly rate plus a service fee.",
      rules: ["Keep the booking and the payment inside the app.", "Describe the job and what to bring before you book."],
    },
    integration: "coming_soon",
  },
  {
    id: "thumbtack",
    label: "Thumbtack",
    order: 2,
    glyph: { icon: Briefcase, tone: "text-sky-600" },
    services: SERVICE_KINDS,
    searchUrl: (service) => thumbtackUrl(service),
    postUrl: (service) => thumbtackUrl(service),
    signupUrl: "https://www.thumbtack.com/register",
    guide: {
      how: "Describe the job and local pros send quotes. Read their messages and reviews, then hire one.",
      cost: "Free to request quotes. You pay the pro you hire.",
      rules: ["Hire and pay through the site so the job is protected.", "Ask for the license number where the trade needs one."],
    },
    integration: "coming_soon",
  },
  {
    id: "angi",
    label: "Angi",
    order: 3,
    glyph: { icon: Home, tone: "text-red-600" },
    services: SERVICE_KINDS.filter((s) => s !== "furniture_assembly"),
    searchUrl: () => "https://www.angi.com/",
    postUrl: () => "https://www.angi.com/",
    signupUrl: "https://www.angi.com/auth/login",
    guide: {
      how: "Search a service on Angi, read reviews of local pros and request quotes from the ones you like.",
      cost: "Free to request. Pros pay Angi for leads.",
      rules: ["Expect calls from several pros after you post.", "Get the price in writing before work starts."],
    },
    integration: "coming_soon",
  },
  {
    id: "yelp",
    label: "Yelp",
    order: 4,
    glyph: { icon: MessageSquare, tone: "text-rose-600" },
    services: SERVICE_KINDS,
    searchUrl: (service, loc) => {
      const where = locationText(loc);
      return `https://www.yelp.com/search?find_desc=${enc(SERVICE_LABELS[service])}${where ? `&find_loc=${enc(where)}` : ""}`;
    },
    postUrl: null,
    signupUrl: "https://www.yelp.com/signup",
    guide: {
      how: "Search the service near the house, read recent reviews and use Request a Quote on the businesses you like.",
      cost: "Free.",
      rules: ["Read the newest reviews, not only the rating.", "Confirm the business is licensed before you book."],
    },
    integration: "coming_soon",
  },
  {
    id: "nextdoor",
    label: "Nextdoor",
    order: 5,
    glyph: { icon: Users, tone: "text-green-600" },
    services: SERVICE_KINDS,
    searchUrl: () => "https://nextdoor.com/",
    postUrl: () => "https://nextdoor.com/",
    signupUrl: "https://nextdoor.com/",
    guide: {
      how: "Ask neighbors for a recommendation in your neighborhood feed, or browse businesses neighbors have recommended.",
      cost: "Free.",
      rules: ["You join the neighborhood that matches your address.", "Do not post a tenant's name or unit number."],
    },
    integration: "coming_soon",
  },
  {
    id: "craigslist",
    label: "Craigslist",
    order: 6,
    glyph: { icon: Megaphone, tone: "text-purple-600" },
    services: SERVICE_KINDS,
    searchUrl: () => "https://www.craigslist.org/about/sites",
    postUrl: () => "https://post.craigslist.org/",
    signupUrl: "https://accounts.craigslist.org/login",
    guide: {
      how: "Choose your city's Craigslist, then post under gigs to ask for help or browse services offered.",
      cost: "Free for most gig posts. Some cities charge for certain posts.",
      rules: ["Use the anonymous reply email Craigslist gives you.", "Never pay before the work is done.", "Do not put the full address in a public post."],
    },
    integration: "coming_soon",
  },
  {
    id: "handy",
    label: "Handy",
    order: 7,
    glyph: { icon: Hammer, tone: "text-orange-600" },
    services: keys(HANDY_SLUG),
    searchUrl: (service) => handyUrl(service),
    postUrl: (service) => handyUrl(service),
    signupUrl: "https://www.handy.com/login",
    guide: {
      how: "Pick a service, enter the address and book a pro for a time slot. The price is shown up front.",
      cost: "The price is shown before you book.",
      rules: ["Book and pay in the app.", "List everything that needs doing in the booking notes."],
    },
    integration: "coming_soon",
  },
  {
    id: "bark",
    label: "Bark",
    order: 8,
    glyph: { icon: Search, tone: "text-teal-600" },
    services: SERVICE_KINDS,
    searchUrl: (service) => barkUrl(service),
    postUrl: (service) => barkUrl(service),
    signupUrl: "https://www.bark.com/en/us/",
    guide: {
      how: "Answer a few questions about the job and professionals who want it send you quotes.",
      cost: "Free to post a request. Professionals pay for each lead.",
      rules: ["Several professionals may contact you; you choose who to reply to.", "Compare at least two quotes."],
    },
    integration: "coming_soon",
  },
];

export const VENDOR_MARKETPLACE_IDS: readonly VendorMarketplaceId[] = VENDOR_MARKETPLACE_DEFS.map((d) => d.id);

export function isVendorMarketplaceId(value: unknown): value is VendorMarketplaceId {
  return typeof value === "string" && VENDOR_MARKETPLACE_IDS.includes(value as VendorMarketplaceId);
}

export function vendorMarketplaceDef(id: string): VendorMarketplaceDef | null {
  return VENDOR_MARKETPLACE_DEFS.find((d) => d.id === id) ?? null;
}

export function isServiceKind(value: unknown): value is ServiceKind {
  return typeof value === "string" && value in SERVICE_LABELS;
}

/** The marketplaces that offer the service, in row order. */
export function marketplacesForService(service: ServiceKind): VendorMarketplaceDef[] {
  return VENDOR_MARKETPLACE_DEFS.filter((d) => d.services.includes(service)).sort((a, b) => a.order - b.order);
}

export function marketplaceSearchUrl(def: VendorMarketplaceDef, service: ServiceKind, location: MarketplaceLocation): string {
  return def.searchUrl ? def.searchUrl(service, location) : def.signupUrl;
}

/** Where "Post a job" opens: the marketplace's post page, else its search page, else its sign-up page. */
export function marketplacePostUrl(def: VendorMarketplaceDef, service: ServiceKind, location: MarketplaceLocation): string {
  return def.postUrl ? def.postUrl(service) : marketplaceSearchUrl(def, service, location);
}

export type VendorMarketplaceAccountRow = {
  marketplace: VendorMarketplaceId;
  accountLabel: string;
  profileUrl: string | null;
  connectedAt: string;
};

/** The text a manager pastes into the marketplace's post form: the service and the area, never the street address. */
export function buildVendorJobPostText(args: { service: ServiceKind; city?: string; zip?: string }): string {
  const place = [args.city?.trim(), args.zip?.trim()].filter(Boolean).join(" ");
  const lines = [`${SERVICE_LABELS[args.service]} needed${place ? ` in ${place}` : ""}`, SERVICE_DEFAULT_DESCRIPTION[args.service]];
  return lines.join("\n");
}
