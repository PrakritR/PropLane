/**
 * What a vendor is asking on the PropLane line, read by code (no model). "hey is there any available jobs in the
 * area to do", "I'm a plumber, any work near Ballard", "98115 cleaning jobs", "send me the link". Pure.
 */
import { extractTrade, extractArea } from "@/lib/one-number/onboarding/vendor-intake";
import { inferSenderRole } from "@/lib/one-number/onboarding/role-detect";
import { resolveSeattlePlace } from "@/lib/places/seattle-places";

export type VendorTradeLabel = "General maintenance" | "Plumbing" | "Electrical" | "HVAC" | "Appliance repair" | "Landscaping" | "Cleaning" | "Pest control" | "Other";

/** The intake's trade word -> the board's trade label (`VENDOR_TRADE_OPTIONS`). */
const TRADE_LABELS: Record<string, VendorTradeLabel> = {
  plumbing: "Plumbing",
  electrical: "Electrical",
  hvac: "HVAC",
  cleaning: "Cleaning",
  handyman: "General maintenance",
  "general contractor": "General maintenance",
  carpentry: "General maintenance",
  painting: "General maintenance",
  flooring: "General maintenance",
  "appliance repair": "Appliance repair",
  locksmith: "General maintenance",
  landscaping: "Landscaping",
  "pest control": "Pest control",
  roofing: "Other",
  "junk removal": "Other",
  moving: "Other",
};

export function tradeLabelFor(trade: string | null | undefined): VendorTradeLabel | null {
  if (!trade) return null;
  return TRADE_LABELS[trade] ?? "Other";
}

export type VendorJobsAsk = {
  /** The words read as a vendor ("any jobs available", "I'm a plumber", "looking for work"). A bare trade word is not enough. */
  vendorish: boolean;
  /** Reads as a jobs question: only meaningful from a sender already known to be a vendor (or a lead). */
  wantsJobs: boolean;
  /** The text asks for the account / sign-up link. */
  wantsLink: boolean;
  /** The intake trade word ("plumbing"), or null. */
  trade: string | null;
  tradeLabel: VendorTradeLabel | null;
  /** The text itself when it names a Seattle place or zip (what `resolveSeattlePlace` reads), else null. */
  areaText: string | null;
  /** An area the text names that the Seattle table does not hold ("Tacoma"), so the reply can say so. */
  unknownArea: string | null;
};

const JOBS_RE = /\b(jobs?|gigs?|work|leads?|openings?|opportunit(?:y|ies)|available|anything)\b/i;
const LINK_RE = /\b(link|sign ?up|sign me up|register|create (an? )?(account|profile)|join|get started|account|profile)\b/i;
const GENERIC_AREA = /^(the|my|your|this|our|any)\b|\barea\b|^(town|me)$/i;

export function readVendorJobsAsk(text: string): VendorJobsAsk {
  const body = String(text ?? "");
  const trade = extractTrade(body);
  const place = resolveSeattlePlace(body);
  const area = place ? null : extractArea(body);
  const unknownArea = area && !GENERIC_AREA.test(area.trim()) && !/^\d{5}$/.test(area.trim()) ? area.trim() : null;
  const role = inferSenderRole(body);
  const vendorish = role === "vendor";
  return {
    vendorish,
    wantsJobs: vendorish || JOBS_RE.test(body) || Boolean(place) || Boolean(trade),
    wantsLink: LINK_RE.test(body),
    trade,
    tradeLabel: tradeLabelFor(trade),
    areaText: place ? body : null,
    unknownArea,
  };
}

/** A control keyword: STOP / START / HELP are never a vendor ask (the route handles them). */
export const CONTROL_ONLY_RE = /^\s*(stop|stopall|unsubscribe|end|quit|cancel|start|unstop|help)\s*[.!]?\s*$/i;

const ASKS_FOR_JOBS_RE = new RegExp(
  [
    "\\b(any|got any|have any|are there|is there|what|show|send)\\b[^.?!]{0,30}\\b(jobs?|gigs?|work (available|open|near|nearby|in (my|the) area|to do|for me))\\b",
    "\\b(jobs?|gigs?) (available|open|near|nearby|around|in (my|the) area|to do)\\b",
    "\\bavailable (jobs?|work|gigs?)\\b",
    "\\b(looking|searching|hunting) for (more )?(work|jobs|gigs)\\b",
    "\\b(need|want) (some |more )?(work|jobs|gigs)\\b",
  ].join("|"),
  "i",
);

/** The text asks what work is open (a question to answer with jobs), as opposed to a vendor describing themselves. */
export function asksForJobs(text: string): boolean {
  return ASKS_FOR_JOBS_RE.test(String(text ?? ""));
}
