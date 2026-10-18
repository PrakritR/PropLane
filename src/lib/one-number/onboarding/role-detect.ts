/**
 * Who is an unknown number? Pure text inference for the first conversation on the shared line.
 * Searcher ("Is Room 3 available?"), landlord ("I own a house"), vendor ("I do plumbing").
 * Deterministic: no model. Anything it cannot read is asked ONCE (`ROLE_QUESTION`), and if the
 * answer is still unclear the sender is treated as a searcher (the default for an unknown number).
 */

export type OnboardingRole = "searcher" | "landlord" | "vendor";

export type HouseHints = { address?: string; rooms?: number; rent?: number };

const norm = (text: string): string => text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

const VENDOR_TRADES =
  "plumb\\w*|electric\\w*|clean\\w*|handyman|handymen|handy man|landscap\\w*|lawn\\w*|hvac|locksmith|paint\\w*|roof\\w*|carpent\\w*|pest\\w*|junk\\w*|moving|appliance\\w*|contractor|maintenance|repair\\w*|janitor\\w*|window\\w*|flooring|drywall";

const VENDOR_PATTERNS: RegExp[] = [
  /\bvendors?\b/,
  /\bhandy ?(man|men)\b/,
  /\bcontractor\b/,
  new RegExp(`\\b(i|we)(?:'m| am| are|'re)? ?(a |an |the )?(?:licensed |local |independent )?(do|does|offer|offers|provide|provides|run|specialize in|work in)\\b[^.?!]{0,40}\\b(${VENDOR_TRADES})\\b`),
  new RegExp(`\\b(i|we)(?:'m| am| are|'re) (a |an )?(?:licensed |local |independent |professional )?(${VENDOR_TRADES})\\b`),
  new RegExp(`\\b(i|we) (${VENDOR_TRADES})\\b`),
  new RegExp(`\\bmy (company|business|crew|team) (does|offers|provides|is)\\b[^.?!]{0,40}\\b(${VENDOR_TRADES})\\b`),
  /\b(looking for|need|want|get) (more )?(work|jobs|gigs|clients|customers)\b/,
  /\b(work orders?|service calls?) (from|for) (landlords?|property managers?)\b/,
  /\bi (clean|fix|repair|paint|mow|haul) (houses|homes|units|apartments|rentals)\b/,
];

const LANDLORD_PATTERNS: RegExp[] = [
  /\b(landlord|property manager|property owner|house owner|home owner of rentals)\b/,
  /\b(i|we)(?:'m| am| are|'re)? ?(a |an )?(own|owns|manage|manages|operate|run)\b[^.?!]{0,50}\b(house|houses|home|homes|propert(y|ies)|units?|apartments?|duplexes|duplex|rentals?|buildings?|rooms)\b/,
  /\b(rent|renting|rents|renting out|rent out) (it |one |them |those )?(out)\b/,
  /\b(i|we) have (a |an |\d+ |two |three |four |five )?(house|houses|home|homes|propert(y|ies)|units?|apartments?|rooms?|duplex|rentals?)\b[^.?!]{0,30}\b(for rent|to rent|to lease|vacant|available)\b/,
  /\brent(ing)? (out )?(my|our)\b/,
  /\b(for|about) my (rentals?|properties|property|tenants|houses?|units?|building)\b/,
  /\bmy (rentals?|properties|tenants|house for rent|rental property)\b/,
  /\b(list|post|advertise) (my|our|a|the) (house|room|rooms|property|rental|unit|place)\b/,
  /\bmanage \d+ (units?|propert(y|ies)|houses?|rooms|doors)\b/,
  /\b\d+ (units?|doors|rentals?|propert(y|ies))\b[^.?!]{0,30}\b(i|we) (own|manage)\b/,
  /\btenants?\b[^.?!]{0,30}\b(rent|late|pay|collect)\b/,
];

const SEARCHER_PATTERNS: RegExp[] = [
  /\b(looking|searching|hunting|shopping) for\b[^.?!]{0,40}\b(room|rooms|place|apartment|apt|housing|rental|studio|house|home|roommate)\b/,
  /\b(need|want|seeking|find) (a |an |to find |to rent )?(room|place|apartment|apt|housing|studio|roommates?)\b/,
  /\b(is|are) (the |that |this )?(room|rooms|unit|place|apartment|listing|house|studio)\b[^.?!]{0,20}\b(still )?(available|open|vacant|taken|rented|for rent)\b/,
  /\b(room|unit|apartment|listing)\s*#?\w{0,3}\s*(still )?(available|open|vacant)\b/,
  /\b(is|are) (it|they|that|this) (still )?(available|open)\b/,
  /\bany (rooms?|openings?|vacanc(y|ies)|units?)\b/,
  /\b(how much|what'?s the|what is the) (is )?(rent|price|deposit)\b/,
  /\b(schedule|book|set up|see|view|get) (a )?(tour|showing|viewing)\b/,
  /\b(saw|found|seen) (your|the|a) (listing|post|ad|flyer|sign)\b/,
  /\b(apply|application) (for|to)\b/,
  /\bmove[- ]in\b[^.?!]{0,30}\b(date|month|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep|oct)\b/,
];

/** The role a first text points at, or null when it does not say. Landlord outranks vendor outranks searcher. */
export function inferSenderRole(text: string): OnboardingRole | null {
  const t = norm(text);
  if (!t) return null;
  if (LANDLORD_PATTERNS.some((re) => re.test(t))) return "landlord";
  if (VENDOR_PATTERNS.some((re) => re.test(t))) return "vendor";
  if (SEARCHER_PATTERNS.some((re) => re.test(t))) return "searcher";
  return null;
}

/**
 * The reply to "Are you looking for a place, renting one out, or a vendor?". Looser than
 * `inferSenderRole` because the question frames the words ("a place", "vendor", "1"). Null when it
 * still does not say, which is the end of asking: the sender becomes a searcher.
 */
export function readRoleAnswer(text: string): OnboardingRole | null {
  const direct = inferSenderRole(text);
  if (direct) return direct;
  const t = norm(text).replace(/[.!?,]+$/g, "");
  if (!t) return null;
  if (/^(1|a place|place|looking|looking for a place|room|a room|an apartment|apartment|housing|searching|a place to live|somewhere to live|a place to rent)$/.test(t)) return "searcher";
  if (/^(2|renting one out|renting out|renting it out|rent out|owner|i own|landlord|property manager|manager|owner operator|i manage|renting my place out|list a property)$/.test(t)) return "landlord";
  if (/^(3|vendor|a vendor|contractor|a contractor|handyman|service provider|i do jobs|work|jobs|trades)$/.test(t)) return "vendor";
  if (/\bvendor\b/.test(t)) return "vendor";
  if (/\b(a place|looking for)\b/.test(t) && !/\bout\b/.test(t)) return "searcher";
  return null;
}

// ---------------------------------------------------------------------------
// House hints (landlord): an address, a room count and a rent the texter volunteered.
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** "3", "three" -> 3 (1-20), else null. */
export function parseCount(raw: string): number | null {
  const t = raw.toLowerCase().trim();
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 20 ? n : null;
  }
  return NUMBER_WORDS[t] ?? null;
}

const STREET_WORDS =
  "st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|way|pl|place|ter|terrace|cir|circle|pkwy|parkway|hwy|loop|sq|square|alley|row";

/** A street address inside free text: "61 Willow Court", "123 N Main St", "4709A 8th Ave". */
export function extractAddress(text: string): string | null {
  const m = new RegExp(`\\b(\\d{1,6}[a-z]?\\s+(?:(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)\\.?\\s+)?(?:[a-z0-9'.-]+\\s+){0,3}?(?:${STREET_WORDS})\\b\\.?)`, "i").exec(text);
  if (!m) return null;
  const address = m[1].replace(/\s+/g, " ").replace(/\.$/, "").trim();
  return address.length >= 5 && address.length <= 80 ? address : null;
}

export function extractRoomCount(text: string): number | null {
  const words = Object.keys(NUMBER_WORDS).join("|");
  const m = new RegExp(`\\b(\\d{1,2}|${words})[- ]?(?:bed(?:room)?s?|br|bd|rooms?|beds)\\b`, "i").exec(text);
  return m ? parseCount(m[1]) : null;
}

/** A monthly rent in whole dollars: "$850", "850/mo", "rent is 900". */
export function extractRent(text: string): number | null {
  const m = /\$\s?(\d{3,5})(?:\.\d\d)?\b/.exec(text) ?? /\b(\d{3,5})\s?(?:\/|per|a)\s?(?:mo|month|room)\b/i.exec(text) ?? /\brent(?: is|:)?\s+(\d{3,5})\b/i.exec(text);
  if (!m) return null;
  const rent = Number(m[1]);
  return rent >= 200 && rent <= 20000 ? rent : null;
}

export function extractHouseHints(text: string): HouseHints {
  const hints: HouseHints = {};
  const address = extractAddress(text);
  if (address) hints.address = address;
  const rooms = extractRoomCount(text);
  if (rooms) hints.rooms = rooms;
  const rent = extractRent(text);
  if (rent) hints.rent = rent;
  return hints;
}

/** Later answers fill gaps and never erase what is known. */
export function mergeHints(base: HouseHints, next: HouseHints): HouseHints {
  return { ...next, ...base };
}

/** A reply that means "not now" to a yes/no offer. */
export function isDecline(text: string): boolean {
  return /^(no|nope|nah|not now|no thanks|no thank you|skip|later|pass|n)\b/i.test(text.trim());
}

/** A reply that accepts an offer ("DEMO", "yes", "sure"). */
export function isAccept(text: string): boolean {
  return /^(yes|yeah|yep|yup|y|sure|ok|okay|please|sounds good|let'?s do it|demo|show me|go|try it|do it)\b/i.test(text.trim());
}
