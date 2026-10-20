import type { VendorTrade } from "@/lib/vendor-dispatch/trades";

/**
 * Admin > Service > Network: free-tier people who want to work. Pure helpers shared by the route, the UI and the tests.
 */

const LEAD_TRADE_WORDS: [RegExp, VendorTrade][] = [
  [/\b(clean\w*|janitor\w*|maid)\b/i, "cleaner"],
  [/\block ?smith\w*/i, "locksmith"],
  [/\bplumb\w*/i, "plumber"],
  [/\belectric\w*/i, "electrician"],
  [/\bhvac|heating|air conditioning\b/i, "hvac"],
  [/\bappliance\w*/i, "appliance"],
  [/\bhandy ?(man|men)\b/i, "handyman"],
  [/\bpest\w*|exterminat\w*/i, "pest"],
  [/\b(landscap\w*|lawn\w*|mow\w*|yard)\b/i, "landscaping"],
  [/\b(junk|haul\w*)\b/i, "junk_removal"],
  [/\bcontractor|carpent\w*|paint\w*|roof\w*|floor\w*/i, "general"],
  [/\btour/i, "tour_host"],
];

/** The roster trades a vendor lead's free-text trade names ("cleaning and plumbing" -> cleaner, plumber). May be empty. */
export function tradesFromLeadText(text: string | null | undefined): VendorTrade[] {
  const t = String(text ?? "");
  const out: VendorTrade[] = [];
  for (const [re, trade] of LEAD_TRADE_WORDS) if (re.test(t) && !out.includes(trade)) out.push(trade);
  return out;
}

export type NetworkVendorLead = {
  id: string;
  phoneMasked: string;
  trade: string | null;
  area: string | null;
  status: "collecting" | "pending" | "approved" | "declined";
  createdAt: string;
  /** Roster trades the lead's own words map to; prefilled in the Add to roster form. */
  trades: VendorTrade[];
};

export type NetworkFreeManager = {
  id: string;
  /** `manager-<id>`, the account record's URL segment. */
  accountKey: string;
  name: string;
  email: string;
  /** PropLane ID: what a service workspace invite takes. */
  proplaneId: string;
  houseCount: number;
  joinedAt: string | null;
  city: string | null;
};

/** "Joined Oct 2026". Empty when the date is unknown. */
export function joinedLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `Joined ${d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`;
}
