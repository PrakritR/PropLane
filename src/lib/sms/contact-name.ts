/**
 * A person's name, only ever taken from something that says it IS a name.
 *
 * An unknown texter's first message used to be mined with a case-insensitive
 * pattern, so "I'm looking for a room" saved the phrase "looking for" as the
 * contact's name and the Communication list titled the conversation with it.
 * The rule now:
 *
 *   * a name is captured ONLY from an explicit self-introduction ("my name is",
 *     "name's", "this is", "I'm" / "I am" / "Im");
 *   * the name is 1-3 name-like tokens: capitalized letters only ("maya" is
 *     accepted after "my name is" alone, where the sentence itself says it is
 *     a name);
 *   * a stop-word, verb, preposition, street suffix or number anywhere in the
 *     candidate (looking, interested, here, student, Avenue ...) ends it;
 *   * nothing is ever guessed from a phrase. No name -> no name: the list shows
 *     the formatted phone.
 *
 * Names that come from a real record (application, resident, vendor, a contact
 * the manager typed) never pass through here.
 */

const STOP_WORDS = new Set(
  [
    // articles, pronouns, conjunctions, prepositions
    "a", "an", "the", "and", "or", "but", "so", "if", "for", "from", "to", "of", "in", "on", "at", "by", "with",
    "about", "as", "into", "near", "around", "over", "under", "up", "out", "off", "not", "no", "yes", "ok", "okay",
    "i", "im", "me", "my", "mine", "we", "us", "our", "you", "your", "he", "she", "they", "them", "it", "its",
    "this", "that", "these", "those", "there", "here", "who", "what", "when", "where", "why", "how", "which",
    "hi", "hey", "hello", "yo", "thanks", "thank", "please", "sorry", "just", "also", "very", "really", "still",
    "too", "now", "today", "tomorrow", "tonight", "soon", "again", "back", "new", "old", "currently", "recently",
    // verbs and gerunds that follow "I'm"
    "is", "am", "are", "was", "were", "be", "been", "being", "do", "does", "did", "have", "has", "had",
    "would", "can", "could", "should", "might", "must", "get", "got", "getting", "go", "going", "gonna",
    "come", "coming", "looking", "look", "looked", "searching", "search", "seeking", "need", "needing", "needs",
    "want", "wanting", "wants", "wondering", "wonder", "calling", "texting", "writing", "reaching", "trying",
    "try", "hoping", "thinking", "think", "asking", "ask", "inquiring", "checking", "check", "following",
    "moving", "move", "relocating", "renting", "rent", "leasing", "lease", "touring", "tour", "visiting", "booking",
    "applying", "apply", "available", "interested", "curious", "ready", "unsure", "sure", "glad", "happy",
    "excited", "new", "waiting", "working", "work", "studying", "study", "living", "live", "staying", "stay",
    "interning", "attending", "graduating", "arriving", "flying", "driving", "coming", "reaching", "contacting",
    // roles and phrases ("I'm a student", "this is the property manager")
    "student", "tenant", "resident", "renter", "landlord", "owner", "manager", "agent", "intern", "professional",
    "grad", "undergrad", "applicant", "prospect", "vendor", "plumber", "electrician", "contractor", "handyman",
    "someone", "somebody", "anyone", "anybody", "everyone", "nobody", "person", "guy", "girl", "man", "woman",
    "customer", "client", "guest", "family", "friend", "mom", "dad", "wife", "husband", "roommate", "roommates",
    // housing nouns
    "room", "rooms", "house", "houses", "home", "homes", "apartment", "apt", "unit", "units", "bed", "beds",
    "bedroom", "bedrooms", "bath", "bathroom", "listing", "listings", "property", "properties", "place", "spot",
    "lease", "sublease", "studio", "ad", "post", "number", "text", "message", "msg", "call", "email", "inquiry",
    // address words
    "street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd", "drive", "dr", "lane", "ln", "court", "ct",
    "way", "place", "pl", "terrace", "highway", "hwy", "north", "south", "east", "west",
    // misc
    "other", "another", "some", "any", "all", "one", "two", "three", "first", "last", "next", "more", "less",
    "interest", "info", "information", "question", "questions", "update", "regarding", "re", "per", "via",
    "stop", "start", "help", "unsubscribe", "cancel", "quit", "end",
  ],
);

/** Lower-case word, with the trailing possessive stripped ("Maya's" -> "maya"). */
function wordKey(token: string): string {
  return token.toLowerCase().replace(/['’]s$/, "").replace(/[.'’-]/g, "");
}

/** Words that can never be (part of) a name, even right after "my name is". */
const FUNCTION_WORDS = new Set(
  [
    "a", "an", "the", "and", "or", "but", "so", "if", "for", "from", "to", "of", "in", "on", "at", "by", "with",
    "about", "as", "not", "no", "yes", "i", "im", "me", "my", "we", "you", "your", "he", "she", "they", "it",
    "this", "that", "there", "here", "who", "what", "when", "where", "why", "how", "hi", "hey", "hello",
    "is", "am", "are", "was", "looking", "interested", "wondering", "stop", "start", "help",
  ],
);

/**
 * `strong` = the sentence itself says "my name is ...", so only function words
 * are refused ("my name is Will" is a name; "this is Will" cannot tell).
 */
export function isNameStopWord(token: string, strong = false): boolean {
  const key = wordKey(token);
  return strong ? FUNCTION_WORDS.has(key) : STOP_WORDS.has(key);
}

/** Capital-first, letters / apostrophe / hyphen after: Maya, O'Brien, Mary-Jane, McDonald. Never ALL CAPS. */
const CAPITALIZED_TOKEN_RE = /^[A-Z][a-z]+(?:['’-][A-Za-z]+)*$|^Mc[A-Z][a-z]+$|^[A-Z]'[A-Z][a-z]+$/;
const LOWERCASE_TOKEN_RE = /^[a-z]{2,}(?:['’-][a-z]+)*$/;

function titleCase(token: string): string {
  return token
    .split(/(['’-])/)
    .map((part, index) => (index % 2 === 0 && part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join("");
}

type Introduction = { re: RegExp; allowLowercase: boolean };

// Case-insensitive lead-ins; the NAME tokens that follow are judged by their own case.
const INTRODUCTIONS: readonly Introduction[] = [
  { re: /\bmy\s+(?:full\s+)?name\s+is\s+/i, allowLowercase: true },
  { re: /\bname\s+is\s+/i, allowLowercase: true },
  { re: /\bmy\s+name['’]s\s+/i, allowLowercase: true },
  { re: /\bthis\s+is\s+/i, allowLowercase: false },
  { re: /\bi['’]m\s+/i, allowLowercase: false },
  { re: /\bi\s+am\s+/i, allowLowercase: false },
  { re: /\bim\s+/i, allowLowercase: false },
];

/**
 * The tokens right after `start`: stops at the first non-token (punctuation,
 * digit, symbol) and at the first stop-word.
 */
function leadingNameTokens(text: string, allowLowercase: boolean, strong: boolean): string[] | null {
  const tokens: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  for (const raw of words) {
    // A token is a run of letters; trailing punctuation ends the name after it.
    const match = raw.match(/^([A-Za-z][A-Za-z'’-]*)([^A-Za-z'’-].*)?$/);
    if (!match) break;
    const token = match[1]!.replace(/[-'’]+$/, "");
    const punctuationAfter = Boolean(match[2]) || token !== match[1];
    if (!token) break;
    if (isNameStopWord(token, strong)) {
      // "This is Brooklyn Ave": a CAPITALIZED stop-word right after the name
      // means the whole run is a title or address, not a person. A lowercase
      // one ("Maya and", "Maya from UW") just ends the name.
      if (tokens.length > 0 && /^[A-Z]/.test(token)) return null;
      break;
    }
    const capitalized = CAPITALIZED_TOKEN_RE.test(token);
    const lowercase = allowLowercase && LOWERCASE_TOKEN_RE.test(token);
    if (!capitalized && !lowercase) break;
    // Lowercase is accepted only as the WHOLE name ("my name is maya"), never as a phrase.
    if (lowercase && !capitalized && tokens.length > 0) break;
    tokens.push(capitalized ? token : titleCase(token));
    if (tokens.length === 3 || punctuationAfter) break;
  }
  if (tokens.length === 0) return null;
  // "my name is maya chen" - two lowercase words are a phrase, not a name.
  const raws = words.slice(0, tokens.length);
  if (tokens.length > 1 && raws.some((raw) => !CAPITALIZED_TOKEN_RE.test(raw.replace(/[^A-Za-z'’-]+$/, "")))) {
    return null;
  }
  return tokens;
}

/**
 * The name a text introduces itself with, or "" when it does not. Only an
 * explicit self-introduction counts; a phrase is never a name.
 */
export function parseNameFromInboundText(body: string): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  for (const intro of INTRODUCTIONS) {
    const global = new RegExp(intro.re.source, "gi");
    for (const match of text.matchAll(global)) {
      const rest = text.slice((match.index ?? 0) + match[0].length);
      const tokens = leadingNameTokens(rest, intro.allowLowercase, intro.allowLowercase);
      if (tokens) return tokens.join(" ").slice(0, 80);
    }
  }
  return "";
}

/**
 * Would this pass as a name GUESSED from a text? The gate before a guessed name
 * is written, and nothing else: lenient on case (a manager may type "maya
 * chen"), strict on phrases — no digits or symbols, no stop-word, at most four
 * tokens, and a multi-word name cannot be all lowercase.
 *
 * Not a test of a manager-typed name. "Maya West", "Guy Fieri" and "Unit 4"
 * fail here and are all perfectly good labels; only `contactNameRepairVerdict`
 * decides what a repair may delete.
 */
export function isPlausibleContactName(value: string | null | undefined): boolean {
  const name = String(value ?? "").trim();
  if (name.length < 2 || name.length > 80) return false;
  if (/[\d@<>_/\\:;,!?()[\]{}#$%^&*=+|~`"]/.test(name)) return false;
  const tokens = name.split(/\s+/);
  if (tokens.length > 4) return false;
  if (tokens.some((token) => !/^[A-Za-z][A-Za-z.'’-]*$/.test(token))) return false;
  if (tokens.some((token) => isNameStopWord(token.replace(/\.$/, "")))) return false;
  if (tokens.length > 1 && name === name.toLowerCase()) return false;
  if (tokens.length === 1 && tokens[0]!.length < 2) return false;
  return true;
}

export type ContactNameVerdict = { keep: true } | { keep: false; reason: string };

/** Nothing but a phone number: digits and phone punctuation, at least seven digits. */
function isPhoneLabel(value: string): boolean {
  const name = value.trim();
  return /^[+()\-.\s\d]+$/.test(name) && (name.match(/\d/g)?.length ?? 0) >= 7;
}

/**
 * Pure core of `scripts/repair-sms-contact-display-names.mjs` (mirrored there).
 *
 * The repair DELETES stored data, so it clears only what the old guess could have written and a
 * manager could not plausibly have typed: a bare phone number, the generated "<trade> · <number>"
 * lead label, and a run of nothing but stop-words ("looking for", "a student"). It is NOT the
 * strict rule that gates a *new* guess (`isPlausibleContactName`) — that one rejects real names
 * ("Maya West", "Guy Fieri") and real labels ("Joe's Plumbing 24/7", "Unit 4"), which a manager is
 * free to type and the repair must never touch.
 */
export function contactNameRepairVerdict(value: string | null | undefined): ContactNameVerdict {
  const name = String(value ?? "").trim();
  if (!name) return { keep: true };
  if (isPhoneLabel(name)) return { keep: false, reason: "a phone number, not a name" };
  const parts = name.split("·").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1 && parts.some(isPhoneLabel)) return { keep: false, reason: "a generated \"trade · number\" label" };
  if (isStopWordPhrase(name)) return { keep: false, reason: "a phrase an old name guess stored" };
  return { keep: true };
}

/**
 * A saved name that is nothing but stop-words ("looking for", "interested in",
 * "here") is a phrase an old name guess stored, never a person. Deliberately
 * lenient otherwise: a manager may type any label ("Joe's Plumbing", "Unit 4").
 */
export function isStopWordPhrase(value: string | null | undefined): boolean {
  const tokens = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => /^[A-Za-z][A-Za-z'’.-]*$/.test(token) && isNameStopWord(token.replace(/\.$/, "")));
}
