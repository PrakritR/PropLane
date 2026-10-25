import { looksLikeProspectLeasingCta } from "@/lib/claw-leasing-links";
import { isHousingSearchText } from "@/lib/one-number/line-intent";
import { extractAddress, inferSenderRoles } from "@/lib/one-number/onboarding/role-detect";

/**
 * The first text from a number nobody knows. The PropLane line and a manager's own work number answer it the same way:
 *
 *   a CLEAR first text ("Any rooms near UW under $1,000?", "I'm a plumber") skips the question and goes straight to
 *   the flow it asked for;
 *   an UNCLEAR one ("hi", "who is this", "hello?") gets ONE question: resident, vendor, looking for a place, or
 *   wants to manage their own property. The answer picks the flow.
 *
 * Clarity is a deterministic classifier (patterns, no model): a text is clear only when it carries a signal for exactly
 * one of the four roles. No signal, or signals for two roles, is unclear and asks, which is the safe direction: the
 * question never reveals anything and the sender answers it themselves.
 */

export type FirstTextRole = "resident" | "vendor" | "looking" | "manage";

const QUESTION_TAIL = "Are you a resident, a vendor, looking for a place, or want to manage your own property with PropLane?";

/** The question on the PropLane line. */
export const PROPLANE_ROLE_QUESTION = `Hi, this is PropLane. ${QUESTION_TAIL}`;

/**
 * Kept under its old name: the one fixed line a bare greeting gets on the PropLane line is now the role question.
 * (The first reply of a prospect on the line used to be "Looking for a place to rent?" - see
 * `PROPLANE_PROSPECT_FALLBACK_REPLY`, which still serves as the no-silence fallback for a prospect whose turn failed.)
 */
export const PROPLANE_FIRST_TEXT_REPLY = PROPLANE_ROLE_QUESTION;

/** The fallback for a prospect on the PropLane line whose agent turn produced nothing. */
export const PROPLANE_PROSPECT_FALLBACK_REPLY = "Hi, this is PropLane. Looking for a place to rent? Tell me the area, budget and move-in date.";

/**
 * The question on a manager's own work number: their workspace's name instead of PropLane's. The last clause is kept as
 * it is ("manage your own property with PropLane" still reads right: PropLane is the software behind that number).
 * A name that is empty or "PropLane" gives the PropLane wording; a long name is cut so the text stays one segment.
 */
export function roleQuestionFor(workspaceName?: string | null): string {
  const name = String(workspaceName ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30)
    .trim();
  if (!name || name.toLowerCase() === "proplane") return PROPLANE_ROLE_QUESTION;
  return `Hi, this is ${name}. ${QUESTION_TAIL}`;
}

/**
 * A "manage my own" answer. The long dash of the product copy is a comma here: the send path strips it anyway. The link
 * is a full `https://` URL with nothing glued to its end, so `formatSmsLinks` owns where it sits and a phone cannot
 * swallow a sentence period into the address.
 */
export const MANAGE_OWN_REPLY = "Great, set up your homes here: https://proplane.ai/auth/create-account?role=manager A personal work number comes with Pro.";

/** A "resident" answer from a number no account holds: the resident lookup already ran and found nobody. */
export const RESIDENT_NOT_FOUND_REPLY =
  "I cannot find a resident account for this number. Text from the phone number on your PropLane account, or contact your property team.";

/** A "vendor" answer on a manager's own number (the PropLane line has its own vendor flow). */
export const VENDOR_TRADE_QUESTION = "Thanks. What trade do you do, and what area do you serve?";

/**
 * The opt-out notice. The question's wording is fixed (no STOP line), so the notice rides the first reply that FOLLOWS
 * it - the answer, or the terminal reply a clear first text gets. One place decides it for both line modes.
 */
export const OPT_OUT_NOTICE = "Reply STOP to opt out.";

/** `text` with the opt-out notice on it, once. */
export function withOptOut(text: string): string {
  return /reply stop/i.test(text) ? text : `${text} ${OPT_OUT_NOTICE}`;
}

// ---------------------------------------------------------------------------
// Greetings (kept: the leasing bot and the tests read it).
// ---------------------------------------------------------------------------

const GREETINGS = new Set([
  "hi", "hey", "hello", "hola", "yo", "sup", "hiya", "heya", "howdy", "hi there", "hey there", "hello there", "good morning", "good afternoon",
  "good evening", "morning", "afternoon", "evening", "hi pls", "hey pls", "hi team", "hey team", "hi proplane", "hey proplane", "hello proplane",
  "anyone there", "anybody there", "is anyone there", "are you there", "test", "testing",
]);

/** "heyyy" and "hellooo" match "hey" and "hello": compare with repeated letters collapsed on both sides. */
const squash = (value: string): string => value.replace(/(.)\1+/g, "$1");
const GREETINGS_SQUASHED = new Set([...GREETINGS].map(squash));

/** True when the whole text is a greeting and nothing else. A greeting plus a question is a question and goes to the agent. */
export function isGreetingOnly(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > 40) return false;
  return GREETINGS_SQUASHED.has(squash(normalized));
}

// ---------------------------------------------------------------------------
// Clarity
// ---------------------------------------------------------------------------

const norm = (text: string): string => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** A resident reporting or asking about the place they live in. Deliberately narrow: "my lease" alone is also a prospect's. */
const RESIDENT_PATTERNS: RegExp[] = [
  /\bi(?:'m| am) (?:a |an )?(?:current |new )?(?:resident|tenant)\b/,
  /\bi (?:live|stay|reside) (?:at|in|on)\b/,
  /\bmy (?:landlord|property manager|roommates?|housemates?)\b/,
  /\b(?:maintenance|repair|service) request\b/,
  /\bmy (?:sink|toilet|shower|heater|heat|furnace|faucet|dishwasher|stove|oven|fridge|refrigerator|washer|dryer|water heater|ac|a\/c|lock|door|window|light|outlet|ceiling|roof|drain)\b[^.?!]{0,40}\b(?:broke|broken|leak\w*|clogged|not working|stopped working|won'?t|isn'?t working|flooded|stuck)\b/,
  /\b(?:pay|paying|send me) (?:my )?rent\b/,
  /\bwhen is (?:my )?rent due\b/,
  /\b(?:i'?m |i am |am )?locked out\b/,
];

/** Wanting to run their own property on PropLane (the landlord patterns in role-detect cover owning and renting out). */
const MANAGE_PATTERNS: RegExp[] = [
  /\b(?:want|wanna|like|looking|interested|hoping|trying) to (?:manage|list my|rent out|sign ?up|use proplane|get started)\b/,
  /\bmanage (?:my|our) (?:own )?(?:propert(?:y|ies)|homes?|houses?|rentals?|units?|buildings?)\b/,
  /\b(?:sign me up|create an account|get started with proplane)\b/,
];

/** A listing question without the word "available" near a street number: "Is 5259 Brooklyn still open?". */
const NUMBERED_LISTING_PATTERN = /\b\d{2,5}[a-z]?\b.{0,40}\b(?:available|vacant|for rent|still open|rented|taken|price|rent)\b/;

/** Every role this text carries a signal for. */
export function firstTextRoles(body: string): FirstTextRole[] {
  const text = norm(body);
  if (!text) return [];
  const roles = new Set<FirstTextRole>();
  for (const role of inferSenderRoles(text)) roles.add(role === "landlord" ? "manage" : role === "searcher" ? "looking" : "vendor");
  if (RESIDENT_PATTERNS.some((re) => re.test(text))) roles.add("resident");
  if (MANAGE_PATTERNS.some((re) => re.test(text))) roles.add("manage");
  if (isHousingSearchText(text)) roles.add("looking");
  // A street address, a numbered listing question and the listing page's own "Text us" drafts (or a bare TOUR / APPLY) are a
  // prospect's, but they are weak: an address is also where a resident lives. They decide only when nothing else did.
  if (roles.size === 0 && (extractAddress(body) || NUMBERED_LISTING_PATTERN.test(text) || looksLikeProspectLeasingCta(body))) roles.add("looking");
  return [...roles];
}

export type FirstTextClarity = { kind: "clear"; role: FirstTextRole } | { kind: "unclear" };

/** Clear = a signal for exactly one role. A greeting, a "who is this", no signal, or two roles at once is unclear. */
export function classifyFirstText(body: string): FirstTextClarity {
  const roles = firstTextRoles(body);
  return roles.length === 1 ? { kind: "clear", role: roles[0]! } : { kind: "unclear" };
}

// ---------------------------------------------------------------------------
// The answer to the question
// ---------------------------------------------------------------------------

/** Looser than the first-text patterns because the question frames the words ("resident", "a place", "vendor"). */
const ANSWER_PATTERNS: Record<FirstTextRole, RegExp> = {
  resident: /\b(?:resident|tenant|renter|live there|live here)\b/,
  vendor: /\b(?:vendor|contractor|handy ?man|plumber|electrician|cleaner|service provider|trades?)\b/,
  looking: /\b(?:looking|a place|place to (?:rent|live)|room|apartment|housing|to rent|rent a|searching|prospect)\b/,
  manage: /\b(?:manage|my own|own property|landlord|owner|property manager|i own)\b/,
};

/**
 * The role an answer to the question names, or null when it names none or more than one (the sender is then not pushed
 * into a flow they did not pick).
 */
export function readRoleQuestionAnswer(body: string): FirstTextRole | null {
  const text = norm(body).replace(/[.!?,]+$/g, "");
  if (!text) return null;
  const roles = new Set<FirstTextRole>(firstTextRoles(text));
  for (const [role, pattern] of Object.entries(ANSWER_PATTERNS) as Array<[FirstTextRole, RegExp]>) if (pattern.test(text)) roles.add(role);
  // "Manage my own property" mentions a property, which reads as a search; the manage words are the stronger ones.
  if (roles.has("manage") && roles.has("looking") && /\b(?:manage|my own|i own|landlord|property manager)\b/.test(text)) roles.delete("looking");
  return roles.size === 1 ? [...roles][0]! : null;
}
