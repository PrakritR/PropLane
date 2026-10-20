/**
 * Unassigned-lead qualifying: the pure half. No database, no model, no clock but the `now` you pass.
 *
 * A stranger who texts the shared number with no entry code is qualified one question at a time:
 * budget, move-in date and lease length, area or commute, room type, household size. Every answer
 * is read by a deterministic extractor here; the model (lead-extract.server.ts) is only a fallback
 * for an answer these cannot read, and never writes a reply.
 *
 * Fair housing is a property of this file, not of a prompt: a question about people, religion,
 * family, a neighborhood's character and so on is answered with a neutral line and is never read
 * into the profile, so nothing downstream can filter on it. Only price, dates, location and room
 * features that apply to everyone reach the profile.
 */

export const LEAD_STEPS = ["budget", "move_in", "area", "room", "household"] as const;
export type LeadStep = (typeof LEAD_STEPS)[number];

export type LeadOffer = {
  /** 1-based number the prospect replies with. */
  n: number;
  propertyId: string;
  roomId: string;
  /** "5259 Brooklyn" - a house, never a person. */
  label: string;
  rent: number | null;
  availability: string;
};

export type LeadStage = "qualifying" | "offered" | "no_match" | "assigned";

/** The `sms_unassigned_leads.profile` jsonb: answers plus the small amount of flow state the agent needs. */
export type LeadProfile = {
  /** Highest monthly rent, whole dollars. */
  budgetMax?: number;
  /** YYYY-MM-DD. */
  moveInDate?: string;
  /** "As soon as possible": moveInDate is then today. */
  moveInAsap?: boolean;
  /** 0 means month to month. */
  leaseMonths?: number;
  /** The prospect's own words for a place or a commute, never a description of a neighborhood. */
  area?: string;
  bathroom?: "private" | "shared" | "any";
  furnished?: "yes" | "no" | "any";
  /** A headcount. It never filters a match. */
  household?: number;
  /** Steps the prospect declined to narrow ("any", "skip"): answered, with no filter. */
  skipped?: LeadStep[];
  asked?: LeadStep | "pick" | "refine" | null;
  stage?: LeadStage;
  offers?: LeadOffer[];
  /** ISO times the quiet-lead nudges went out. */
  nudged24?: string;
  nudged72?: string;
  /** A later room that fits, texted once. */
  newMatchTexted?: string;
};

export const WELCOME = "Hi, this is PropLane. Reply STOP to opt out.";

export const NEUTRAL_REPLY =
  "I can only help with price, dates, location and room features, which are the same for everyone.";

const isSkipped = (p: LeadProfile, step: LeadStep) => (p.skipped ?? []).includes(step);

/** Which steps still need an answer, in asking order. */
export function missingSteps(p: LeadProfile): LeadStep[] {
  const out: LeadStep[] = [];
  if (p.budgetMax === undefined && !isSkipped(p, "budget")) out.push("budget");
  if (!isSkipped(p, "move_in") && (p.moveInDate === undefined || p.leaseMonths === undefined)) out.push("move_in");
  if (p.area === undefined && !isSkipped(p, "area")) out.push("area");
  if (!isSkipped(p, "room") && (p.bathroom === undefined || p.furnished === undefined)) out.push("room");
  if (p.household === undefined && !isSkipped(p, "household")) out.push("household");
  return out;
}

export function isQualified(p: LeadProfile): boolean {
  return missingSteps(p).length === 0;
}

/** The one question for a step, narrowed to what is still unknown. */
export function questionFor(step: LeadStep, p: LeadProfile): string {
  switch (step) {
    case "budget":
      return "What is your monthly budget for rent?";
    case "move_in":
      if (p.moveInDate !== undefined && p.leaseMonths === undefined) return "How many months would you like to stay?";
      if (p.moveInDate === undefined && p.leaseMonths !== undefined) return "What date would you like to move in?";
      return "When do you want to move in, and for how many months?";
    case "area":
      return "Which area, or what commute, do you want? A school, office or neighborhood name works.";
    case "room":
      if (p.bathroom !== undefined && p.furnished === undefined) return "Do you want it furnished or unfurnished?";
      if (p.bathroom === undefined && p.furnished !== undefined) return "Do you want a private bath or a shared bath?";
      return "Do you want a private or shared bath, and furnished or unfurnished?";
    case "household":
      return "How many people will be moving in?";
  }
}

// ---------------------------------------------------------------------------
// Fair housing
// ---------------------------------------------------------------------------

/**
 * Words that mean a text is about people rather than price, dates, location or room features:
 * a protected class (race, religion, national origin, sex, familial status, disability, age,
 * source of income, sexual orientation, gender identity, marital or military status, plus Seattle's
 * additions such as a voucher or a criminal record), or the character of a neighborhood or its people.
 * It is deliberately wide: a false positive costs one neutral sentence, a false negative is a violation.
 */
const FAIR_HOUSING_PATTERNS: RegExp[] = [
  /\b(race|racial|racist|black|white|asian|hispanic|latino|latina|latinx|arab|indian|chinese|mexican|african|ethnic\w*|nationality|national origin|immigrants?|foreigners?|citizenship|citizens?|undocumented|visa|green card)\b/i,
  /\b(religio\w*|church|mosque|synagogue|temple|christian|muslim|jewish|jews?|hindu|buddhist|catholic|atheist|halal|kosher|pray\w*)\b/i,
  /\b(famil(?:y|ies)|kids?|child|children|baby|babies|toddlers?|pregnan\w*|stroller|daycare|single (?:mom|mother|dad|father|parent)s?|school(?:s| district)?)\b/i,
  /\b(disab\w*|handicap\w*|wheelchair|blind|deaf|autis\w*|mental(?:ly)?|adhd|depress\w*|sober|recovery|rehab|service animal|emotional support)\b/i,
  /\b(elderly|seniors?|senior citizens?|retire\w*|old people|older people|young people|younger|old(?:er)? (?:folks|crowd)|how old|my age|years old|\d{2}\s*(?:yo|y\/o|year old))\b/i,
  /\b(gay|lesbian|lgbt\w*|queer|bisexual|straight|transgender|trans (?:man|woman|person)|non-?binary|gender|sexual\w*|pronouns?|women only|men only|female only|male only|girls only|guys only)\b/i,
  /\b(married|marital|divorc\w*|widow\w*|husband|wife|boyfriend|girlfriend|spouse|single (?:and|or) (?:married|dating))\b/i,
  /\b(veterans?|military|army|navy|marines?|air force|national guard|deployed)\b/i,
  /\b(section ?8|vouchers?|housing assistance|welfare|ssi|ssdi|snap|public assistance|source of income|unemployment benefits|disability income)\b/i,
  /\b(criminal|felony|felon|convict\w*|arrest\w*|record|eviction history|background)\b/i,
  /\b(safe(?:ty)? (?:neighborhood|area|part)|safe (?:to walk|at night)|dangerous|crime|ghetto|sketchy|bad (?:area|neighborhood)|good (?:neighborhood|area|schools)|nice (?:neighborhood|area|people|crowd)|quiet (?:neighborhood|crowd|people)|what is the neighborhood like|what(?:'s| is) the area like|up and coming|gentrif\w*|diverse|diversity)\b/i,
  /\b(who (?:lives|is living|else lives)|what (?:kind|type|sort) of (?:people|person|folks|tenants|residents|crowd)|what (?:are|is) (?:the )?(?:roommates?|neighbou?rs?|tenants?|residents?|housemates?) (?:like|going to be)|(?:roommates?|housemates?|neighbou?rs?) (?:are|is) (?:they|mostly|all)|about (?:the )?(?:roommates?|housemates?|neighbou?rs?|tenants?))\b/i,
];

/** Does this text ask about, or volunteer, anything the profile must never carry? */
export function touchesProtectedTopic(text: string): boolean {
  return FAIR_HOUSING_PATTERNS.some((re) => re.test(text));
}

/**
 * The text with every clause that touches a protected topic removed, so "budget is 1200, no kids please"
 * still yields the budget and never the rest. Splits on sentence ends, commas and "and" / "but".
 */
export function withoutProtectedClauses(text: string): string {
  const clauses = text.split(/(?<=[.!?\n;])\s+|,\s*|\s+(?:and|but|also|plus)\s+/i);
  return clauses.filter((c) => c.trim() && !touchesProtectedTopic(c)).join(", ");
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Whole month names and the usual abbreviations only: "market" and "decent" are not months. */
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthNumber = (token: string) => MONTHS.indexOf(token.slice(0, 3)) + 1;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Today as YYYY-MM-DD in Pacific time, where every house is. */
export function pacificToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts;
}

const wantsAny = (text: string) =>
  /^(?:any|anything|anywhere|either|both|all|no preference|no pref|doesn'?t matter|does not matter|don'?t care|do not care|flexible|open|not sure|idk|i don'?t know|skip|pass|n\/a|na|whatever|no)\b/i.test(text.trim());

export function extractBudget(text: string, opts: { bare?: boolean } = {}): number | undefined {
  const t = text.replace(/,/g, "");
  const accept = (n: number) => (Number.isFinite(n) && n >= 200 && n <= 20000 ? Math.round(n) : undefined);
  const k = t.match(/\$?\s*(\d+(?:\.\d+)?)\s*k\b/i);
  if (k) {
    const v = accept(Number(k[1]) * 1000);
    if (v !== undefined) return v;
  }
  const dollar = t.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (dollar) {
    const v = accept(Number(dollar[1]));
    if (v !== undefined) return v;
  }
  const perMonth = t.match(/\b(\d{3,5})\s*(?:\/|per|a|each)?\s*(?:mo|month|monthly)\b/i);
  if (perMonth) {
    const v = accept(Number(perMonth[1]));
    if (v !== undefined) return v;
  }
  const phrased = t.match(/\b(?:under|below|max(?:imum)?|up to|around|about|budget(?: is| of)?|less than|no more than|at most|within)\s*\$?\s*(\d{3,5})\b/i);
  if (phrased) {
    const v = accept(Number(phrased[1]));
    if (v !== undefined) return v;
  }
  if (opts.bare) {
    const only = t.trim().match(/^\$?\s*(\d{3,5})(?:\.\d+)?\s*(?:dollars|bucks|usd)?\.?$/i);
    if (only) return accept(Number(only[1]));
  }
  return undefined;
}

type MoveIn = { date?: string; asap?: boolean; used?: string };

export function extractMoveIn(text: string, now: Date): MoveIn {
  const today = pacificToday(now);
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  const lower = text.toLowerCase();

  const iso = lower.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return { date: isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3])), used: iso[0] };

  const rollYear = (m: number, d: number) => {
    const thisYear = isoOf(ty, m, d);
    // A date already well past means next year; within a week back is still "now".
    const cutoff = new Date(Date.UTC(ty, tm - 1, td) - 7 * 86400000).toISOString().slice(0, 10);
    return thisYear >= cutoff ? thisYear : isoOf(ty + 1, m, d);
  };
  const named = lower.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (named) {
    const d = Number(named[2]);
    if (d >= 1 && d <= 31) return { date: rollYear(monthNumber(named[1]!), d), used: named[0] };
  }
  const dayFirst = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`));
  if (dayFirst) {
    const d = Number(dayFirst[1]);
    if (d >= 1 && d <= 31) return { date: rollYear(monthNumber(dayFirst[2]!), d), used: dayFirst[0] };
  }
  const slash = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const m = Number(slash[1]);
    const d = Number(slash[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const y = slash[3] ? (slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3])) : null;
      return { date: y ? isoOf(y, m, d) : rollYear(m, d), used: slash[0] };
    }
  }
  const monthOnly = lower.match(new RegExp(`\\b(?:in |by |for |starting |start of |beginning of |early |late |mid |end of )?${MONTH_RE}\\b(?!\\s*\\d)`));
  if (monthOnly) {
    const token = monthOnly[1]!;
    // "may" is also a verb: it is a month only with something date-like in front of it.
    const dateLike = token !== "may" || /\b(in|by|for|start\w*|beginning of|early|late|mid|end of)\s+may\b/.test(lower);
    if (dateLike) return { date: rollYear(monthNumber(token), 1), used: monthOnly[0] };
  }
  if (/\bnext month\b/.test(lower)) {
    const nm = tm === 12 ? 1 : tm + 1;
    return { date: isoOf(tm === 12 ? ty + 1 : ty, nm, 1), used: "next month" };
  }
  const relative = lower.match(/\bin\s+(\d+|a|an|one|two|three|four|five|six)\s+(day|week|month)s?\b/);
  if (relative) {
    const raw = relative[1]!;
    const n = /^\d+$/.test(raw) ? Number(raw) : raw === "a" || raw === "an" ? 1 : NUMBER_WORDS[raw] ?? 0;
    if (n > 0 && n <= 24) {
      const base = new Date(Date.UTC(ty, tm - 1, td));
      if (relative[2] === "day") base.setUTCDate(base.getUTCDate() + n);
      else if (relative[2] === "week") base.setUTCDate(base.getUTCDate() + n * 7);
      else base.setUTCMonth(base.getUTCMonth() + n);
      return { date: base.toISOString().slice(0, 10), used: relative[0] };
    }
  }
  if (/\b(asap|immediately|right away|as soon as (?:possible|i can)|right now|today|tonight|this week|now)\b/.test(lower)) {
    return { date: today, asap: true, used: undefined };
  }
  return {};
}

/** Lease length in months; 0 is month to month. The move-in phrase is removed first so "in 2 months" is not a lease. */
export function extractLeaseMonths(text: string, usedByMoveIn?: string): number | undefined {
  let lower = text.toLowerCase();
  if (usedByMoveIn) lower = lower.replace(usedByMoveIn.toLowerCase(), " ");
  if (/\b(month[- ]to[- ]month|monthly lease|mtm)\b/.test(lower)) return 0;
  const years = lower.match(/\b(\d+|a|an|one|two|three)[- ]?(?:years?|yrs?)\b/);
  if (years) {
    const raw = years[1]!;
    const n = /^\d+$/.test(raw) ? Number(raw) : raw === "a" || raw === "an" ? 1 : NUMBER_WORDS[raw] ?? 0;
    if (n >= 1 && n <= 3) return n * 12;
  }
  if (/\b(annual|yearlong|year-long|full year|a year)\b/.test(lower)) return 12;
  const months = lower.match(/\b(?:for |stay |lease |about |around )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ]?(?:months?|mos?)\b/);
  if (months) {
    const raw = months[1]!;
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 0;
    if (n >= 1 && n <= 36) return n;
  }
  if (/\b(short[- ]term|temporary|few months|just a bit)\b/.test(lower)) return 3;
  return undefined;
}

export function extractBathroom(text: string): LeadProfile["bathroom"] | undefined {
  const t = text.toLowerCase();
  const priv = /\b(private|own|ensuite|en-suite|en suite|attached)\s*(?:bath|bathroom|restroom)?\b/.test(t) && !/\bshared?\b/.test(t);
  const shared = /\bshared?\s*(?:bath|bathroom|restroom)\b|\bshare (?:a |the )?(?:bath|bathroom)\b/.test(t) || (/\bshared?\b/.test(t) && !/\bprivate\b/.test(t));
  if (priv && !shared) return "private";
  if (shared && !priv) return "shared";
  if (/\b(either|any|both|no preference|doesn'?t matter)\b/.test(t)) return "any";
  if (shared && priv) return "any";
  return undefined;
}

export function extractFurnished(text: string): LeadProfile["furnished"] | undefined {
  const t = text.toLowerCase();
  const bare = /\b(unfurnished|not furnished|no furniture|bring my own|my own furniture)\b/.test(t);
  const furnished = /(?<!un)\bfurnished\b|\bwith furniture\b|\bfully furnished\b/.test(t) || /\b(?:either|both)\b.*\bfurnished\b/.test(t);
  if (bare && furnished) return "any";
  if (bare) return "no";
  if (furnished) return "yes";
  return undefined;
}

export function extractHousehold(text: string, opts: { bare?: boolean } = {}): number | undefined {
  const t = text.toLowerCase().trim();
  if (/\b(just me|only me|myself|by myself|alone|solo|just myself|only myself|it'?s me|just one)\b/.test(t)) return 1;
  const counted = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight)\s*(?:of us|people|persons|adults|occupants|residents|tenants)\b/);
  if (counted) {
    const raw = counted[1]!;
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 0;
    if (n >= 1 && n <= 12) return n;
  }
  if (/\b(me and (?:my )?\w+|my \w+ and i|us two|the two of us|we are two|we(?:'re| are) a couple)\b/.test(t) && !/\bme and (?:my )?\w+ and\b/.test(t)) return 2;
  if (opts.bare) {
    const only = t.match(/^(\d{1,2}|one|two|three|four|five|six|seven|eight)\.?$/);
    if (only) {
      const n = /^\d+$/.test(only[1]!) ? Number(only[1]) : NUMBER_WORDS[only[1]!] ?? 0;
      if (n >= 1 && n <= 12) return n;
    }
  }
  return undefined;
}

/** A place or commute in the prospect's own words. Only read when we just asked for it. */
const ACKNOWLEDGEMENT = /^(?:ok(?:ay)?|k|yes|yeah|yep|yup|ya|sure|thanks?|thank you|thx|please|hi|hello|hey|hmm+|um+|good|great|fine|cool|alright|sounds good|got it|go ahead|retry|try again)[.!?\s]*$/i;

export function extractArea(text: string): string | undefined {
  if (ACKNOWLEDGEMENT.test(text.trim())) return undefined;
  const cleaned = text
    .trim()
    .replace(/^(?:i(?:'d| would)? (?:like|want|prefer)(?: to be)?|looking|somewhere|something|a place)\s+/i, "")
    .replace(/^(?:near|around|close to|by|in|at|next to|within walking distance of|commute to|work at|study at|go to school at)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (!/[a-z]{2,}/i.test(cleaned)) return undefined;
  if (cleaned.length > 60) return cleaned.slice(0, 60).trim();
  return cleaned;
}

// ---------------------------------------------------------------------------
// Applying a text to the profile
// ---------------------------------------------------------------------------

export type ApplyResult = {
  profile: LeadProfile;
  /** The text touched a protected topic: the reply opens with the neutral line. */
  neutral: boolean;
  /** Fields that changed, for tests and logs. */
  changed: string[];
};

/**
 * Read a prospect's text into the profile. Deterministic. `asked` is the question we just put; a bare number
 * means a budget when we asked for one and a headcount when we asked for that.
 */
export function applyAnswer(profile: LeadProfile, rawText: string, now: Date): ApplyResult {
  const next: LeadProfile = { ...profile, skipped: [...(profile.skipped ?? [])] };
  const changed: string[] = [];
  const neutral = touchesProtectedTopic(rawText);
  const text = (neutral ? withoutProtectedClauses(rawText) : rawText).trim();
  const asked = profile.asked ?? null;
  const mark = (field: string) => changed.push(field);
  const skip = (step: LeadStep) => {
    if (!next.skipped!.includes(step)) next.skipped!.push(step);
    mark(`skip:${step}`);
  };

  if (!text) return { profile: next, neutral, changed };

  const budget = extractBudget(text, { bare: asked === "budget" || asked === "refine" });
  if (budget !== undefined) {
    next.budgetMax = budget;
    next.skipped = next.skipped!.filter((s) => s !== "budget");
    mark("budgetMax");
  } else if (asked === "budget" && wantsAny(text)) {
    skip("budget");
  }

  const moveIn = extractMoveIn(text, now);
  if (moveIn.date) {
    next.moveInDate = moveIn.date;
    next.moveInAsap = moveIn.asap === true;
    mark("moveInDate");
  }
  const lease = extractLeaseMonths(text, moveIn.used);
  if (lease !== undefined) {
    next.leaseMonths = lease;
    mark("leaseMonths");
  }
  if (asked === "move_in" && wantsAny(text) && moveIn.date === undefined && lease === undefined) skip("move_in");
  // A flexible answer to one half of the question settles the half we asked for.
  if (asked === "move_in" && moveIn.date === undefined && lease !== undefined && next.moveInDate === undefined && /\b(flexible|any ?time|whenever)\b/i.test(text)) {
    next.moveInDate = pacificToday(now);
    next.moveInAsap = true;
  }

  const bathroom = extractBathroom(text);
  if (bathroom !== undefined && (asked === "room" || asked === "refine" || /\bbath/i.test(text))) {
    next.bathroom = bathroom;
    mark("bathroom");
  }
  const furnished = extractFurnished(text);
  if (furnished !== undefined) {
    next.furnished = furnished;
    mark("furnished");
  }
  if (asked === "room" && wantsAny(text) && bathroom === undefined && furnished === undefined) {
    next.bathroom = "any";
    next.furnished = "any";
    mark("room:any");
  }
  // Answering one half of the room question with "either" settles that half only when the other is known.
  if (asked === "room" && next.bathroom !== undefined && next.furnished === undefined && /\b(either|any|doesn'?t matter)\b/i.test(text) && furnished === undefined) {
    next.furnished = "any";
  }

  const household = extractHousehold(text, { bare: asked === "household" });
  if (household !== undefined) {
    next.household = household;
    mark("household");
  } else if (asked === "household" && wantsAny(text)) {
    skip("household");
  }

  if (asked === "area" || asked === "refine") {
    if (wantsAny(text) && budget === undefined && !moveIn.date) {
      if (asked === "area") skip("area");
    } else if (asked === "area" && budget === undefined && !moveIn.date && lease === undefined && bathroom === undefined && furnished === undefined && household === undefined) {
      const area = extractArea(text);
      if (area) {
        next.area = area;
        next.skipped = next.skipped!.filter((s) => s !== "area");
        mark("area");
      }
    } else if (asked === "refine" && budget === undefined && !moveIn.date && bathroom === undefined && furnished === undefined) {
      const area = extractArea(text);
      if (area && !wantsAny(text)) {
        next.area = area;
        mark("area");
      }
    }
  }
  // "near UW" volunteered before we asked.
  if (next.area === undefined && asked !== "area") {
    const near = text.match(/\b(?:near|close to|around|commute to)\s+([A-Za-z0-9][A-Za-z0-9 .'&-]{1,40})/i);
    if (near && !/^\d/.test(near[1]!)) {
      next.area = near[1]!.replace(/[.!,]+$/, "").trim();
      mark("area");
    }
  }
  return { profile: next, neutral, changed };
}

/** What the next outbound text asks. Null when the profile is complete. */
export function nextQuestion(profile: LeadProfile): { step: LeadStep; text: string } | null {
  const step = missingSteps(profile)[0];
  return step ? { step, text: questionFor(step, profile) } : null;
}

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

/**
 * GSM-7 only: no emoji, curly quotes or long dashes in anything we send. ONE implementation
 * (`one-number/segments.ts`), which folds accents instead of deleting them: a second copy here ended with
 * `[^\x20-\x7E]` and texted "Jose" as "Jos" and "Zoe" as "Zo".
 */
export { toGsm7 } from "@/lib/one-number/segments";

// ---------------------------------------------------------------------------
// Model output (fallback extractor)
// ---------------------------------------------------------------------------

const STEP_FIELDS: Record<LeadStep, (keyof LeadProfile)[]> = {
  budget: ["budgetMax"],
  move_in: ["moveInDate", "leaseMonths"],
  area: ["area"],
  room: ["bathroom", "furnished"],
  household: ["household"],
};

/**
 * Whatever the model returned, reduced to fields that are well-formed, in range and free of protected topics.
 * Anything else is dropped; the model can never put a value into the profile that a deterministic extractor
 * would have refused.
 */
export function sanitizeModelFields(raw: unknown, now: Date): Partial<LeadProfile> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<LeadProfile> = {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
  const budget = num(r.budgetMax);
  if (budget >= 200 && budget <= 20000) out.budgetMax = Math.round(budget);
  if (typeof r.moveInDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.moveInDate)) {
    const t = Date.parse(`${r.moveInDate}T00:00:00Z`);
    const today = Date.parse(`${pacificToday(now)}T00:00:00Z`);
    if (Number.isFinite(t) && t >= today - 7 * 86400000 && t <= today + 800 * 86400000) out.moveInDate = r.moveInDate;
  }
  const lease = num(r.leaseMonths);
  if (lease >= 0 && lease <= 36) out.leaseMonths = Math.round(lease);
  if (typeof r.area === "string") {
    const area = r.area.replace(/\s+/g, " ").trim().slice(0, 60);
    if (area.length >= 2 && /[a-z]{2,}/i.test(area) && !touchesProtectedTopic(area)) out.area = area;
  }
  if (r.bathroom === "private" || r.bathroom === "shared" || r.bathroom === "any") out.bathroom = r.bathroom;
  if (r.furnished === "yes" || r.furnished === "no" || r.furnished === "any") out.furnished = r.furnished;
  const household = num(r.household);
  if (household >= 1 && household <= 12) out.household = Math.round(household);
  return out;
}

/** Merge model fields into a profile: the asked step's fields always, any other field only when still unknown. */
export function mergeModelFields(profile: LeadProfile, fields: Partial<LeadProfile>, asked: LeadStep | "pick" | "refine" | null | undefined): LeadProfile {
  const next: LeadProfile = { ...profile };
  const own = asked && asked !== "pick" && asked !== "refine" ? STEP_FIELDS[asked] : [];
  for (const [key, value] of Object.entries(fields) as [keyof LeadProfile, unknown][]) {
    if (value === undefined) continue;
    if (own.includes(key) || next[key] === undefined) (next as Record<string, unknown>)[key] = value;
  }
  if (fields.moveInDate !== undefined && next.moveInAsap === undefined) next.moveInAsap = false;
  return next;
}
