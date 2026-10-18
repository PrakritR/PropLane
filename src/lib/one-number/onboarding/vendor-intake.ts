/**
 * New-vendor intake, pure. A vendor who texts PropLane cold ("I do cleaning in Seattle") is asked for
 * four things, one per text, in this order: trade, area, rates, insurance. Anything volunteered early
 * is kept and never asked again. The copy is fixed (no model). The result waits for PropLane admin.
 */
export type VendorStep = "trade" | "area" | "rates" | "insurance";

export type VendorProfile = {
  trade?: string;
  area?: string;
  rates?: string;
  /** "yes" | "no" | a short free-text answer. */
  insurance?: string;
  asked?: VendorStep | null;
};

export const VENDOR_STEPS: readonly VendorStep[] = ["trade", "area", "rates", "insurance"];

export const VENDOR_COPY = {
  welcome: "Hi, this is PropLane. Reply STOP to opt out.",
  trade: "What kind of work do you do? For example cleaning, plumbing or handyman.",
  area: "Which city or zip codes do you cover?",
  rates: "What are your rates? Per hour or per job is fine.",
  insurance: "Do you carry liability insurance? Reply YES or NO.",
  retry: "Sorry, I did not get that.",
  done: "Thanks, that is everything. PropLane will review your details and text you. Finish your profile here:",
  pending: "We have your details and PropLane is reviewing them. Your profile link:",
} as const;

const TRADES: [RegExp, string][] = [
  [/\b(clean\w*|janitor\w*|maid)\b/, "cleaning"],
  [/\bplumb\w*/, "plumbing"],
  [/\belectric\w*/, "electrical"],
  [/\bhandy ?(man|men)\b/, "handyman"],
  [/\b(landscap\w*|lawn\w*|mow\w*|yard)\b/, "landscaping"],
  [/\bhvac|heating|air conditioning\b/, "hvac"],
  [/\block ?smith\w*/, "locksmith"],
  [/\bpaint\w*/, "painting"],
  [/\broof\w*/, "roofing"],
  [/\bpest\w*|exterminat\w*/, "pest control"],
  [/\bappliance\w*/, "appliance repair"],
  [/\b(junk|haul\w*)\b/, "junk removal"],
  [/\bcarpent\w*/, "carpentry"],
  [/\bfloor\w*/, "flooring"],
  [/\bmov(er|ing)\b/, "moving"],
  [/\bcontractor\b/, "general contractor"],
];

export function extractTrade(text: string): string | null {
  const t = text.toLowerCase();
  for (const [re, name] of TRADES) if (re.test(t)) return name;
  return null;
}

/** "in Seattle", "around Bellevue and Kirkland", "98115". */
export function extractArea(text: string): string | null {
  const zips = text.match(/\b\d{5}\b/g);
  if (zips?.length) return [...new Set(zips)].slice(0, 6).join(", ");
  const m = /\b(?:in|around|near|across|serving|covering|throughout)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=$|[.,!?;]|\s+(?:for|at|and i|but|with|since|area)\b)/i.exec(text);
  const area = m?.[1]?.trim().replace(/\s+/g, " ");
  return area && area.length >= 2 ? area.slice(0, 60) : null;
}

export function extractRates(text: string): string | null {
  const m = /\$\s?\d{1,5}(?:\.\d\d)?(?:\s?(?:-|to)\s?\$?\d{1,5})?(?:\s?(?:\/|per|an?)\s?(?:hr|hour|job|visit|sq ?ft|room|unit|day))?/i.exec(text);
  return m ? m[0].replace(/\s+/g, " ").trim().slice(0, 60) : null;
}

export function extractInsurance(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(y|yes|yep|yeah|yup|i do|we do|fully insured|insured|licensed and insured|bonded and insured)$/.test(t)) return "yes";
  if (/^(n|no|nope|nah|not yet|i do not|i don't|we do not|we don't|uninsured)$/.test(t)) return "no";
  if (/\b(not insured|no insurance|uninsured)\b/.test(t)) return "no";
  if (/\b(insured|insurance|liability|bonded)\b/.test(t)) return "yes";
  return null;
}

export function nextVendorStep(profile: VendorProfile): VendorStep | null {
  return VENDOR_STEPS.find((s) => !profile[s]) ?? null;
}

/** Read whatever a text answers: the asked step gets a looser read, the rest are volunteered facts. */
export function applyVendorText(profile: VendorProfile, text: string): { profile: VendorProfile; changed: boolean } {
  const next: VendorProfile = { ...profile };
  const asked = profile.asked ?? null;
  const set = (key: VendorStep, value: string | null) => {
    if (value && !next[key]) next[key] = value;
  };
  set("trade", extractTrade(text));
  set("area", extractArea(text));
  set("rates", extractRates(text));
  if (asked === "insurance" || /\b(insured|insurance|liability|bonded)\b/i.test(text)) set("insurance", extractInsurance(text));
  // The step just asked takes a plain answer even when no pattern fits.
  const plain = text.trim().replace(/\s+/g, " ").slice(0, 80);
  if (asked && asked !== "insurance" && !next[asked] && plain.length >= 2) next[asked] = plain;
  const changed = JSON.stringify(next) !== JSON.stringify(profile);
  return { profile: next, changed };
}

export function vendorQuestion(step: VendorStep): string {
  return VENDOR_COPY[step];
}
