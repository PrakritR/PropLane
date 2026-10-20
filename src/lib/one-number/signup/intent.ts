/**
 * Sign-up by text, read by code (no model, no db). Pure so every phrase is testable.
 *
 * `readSignupIntent` answers "does this first text ask to create an account, and as what?". It is deliberately narrow: a
 * renter asking about a tour or a room, a landlord asking a question, a vendor asking for jobs are NOT sign-ups (the
 * existing flows answer those). Sign-up needs either an explicit ask ("sign me up", "create an account", "I want to
 * register as a manager") or an unmistakable self-identification as someone who runs houses ("I'm a landlord",
 * "I manage 12 units") or lives in one on PropLane ("my landlord uses PropLane").
 *
 * The other helpers read the ANSWERS of the conversation (name, business, home count, email, role, commands).
 */
import { extractAddress, parseCount } from "@/lib/one-number/onboarding/role-detect";
import { isHousingSearchText } from "@/lib/one-number/line-intent";
import { extractTrade } from "@/lib/one-number/onboarding/vendor-intake";

export type SignupRole = "manager" | "vendor" | "resident";

export type SignupIntent = {
  wantsSignup: boolean;
  /** The role the words point at, or null when the conversation has to ask. */
  role: SignupRole | null;
  /** True when no sign-up verb was used (a self-identification only). */
  implicit: boolean;
};

const norm = (text: string): string => text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

const SIGNUP_VERB =
  /\b(sign ?up|sign me up|signing up|signup|create (?:an?|my|a new|new)\s+(?:[a-z]+\s+){0,2}(?:account|profile|login)|make (?:an?|my) (?:[a-z]+ )?account|open (?:an?|my) (?:[a-z]+ )?account|register(?:ing)?|set me up|get me set up|join propl\w+|become (?:a|an) (?:member|manager|vendor|host))\b/;

/** A "sign up for ..." that is not an account: a tour, a waitlist, alerts, a room. */
const NOT_AN_ACCOUNT =
  /\b(?:sign ?up|register|signing up)\b.{0,40}\b(?:tour|tours|viewing|showing|open house|waitlist|wait list|waiting list|newsletter|alerts?|email list|emails|texts|notifications?|updates|class|webinar|for (?:a|the|that|this) (?:room|apartment|place|house|unit|lease|rental|studio|bed))\b/;

const MANAGER_WORDS =
  /\b(property managers?|landlords?|property owners?|house owners?|home owners? with rentals|owners?|managers?|host|operator|i manage|we manage|manage (?:my |our |a |the )?(?:houses?|homes?|propert\w+|rentals?|units?|apartments?|buildings?|rooms?)|my (?:rentals?|properties|tenants)|rent(?:ing)? out)\b/;

const VENDOR_WORDS =
  /\b(vendors?|contractors?|service providers?|tradesmen|tradesman|handy ?(?:man|men|person)|plumb\w*|electric\w*|cleaners?|cleaning|hvac|locksmith|painters?|landscap\w*|pest|roofer|roofing|carpent\w*|appliance repair|junk removal|jobs?|gigs?)\b/;

const RESIDENT_WORDS =
  /\b(residents?|tenants?|renters?|i live (?:at|in)|i rent (?:at|from)|i'?m renting|my (?:landlord|property manager|manager|building|house|property) (?:uses|is on|is using|signed (?:me )?up (?:for|on|with)))\b/;

/** Unmistakable self-identification as someone who runs houses (no sign-up verb needed). */
const MANAGER_SELF_ID: RegExp[] = [
  /\b(?:i'?m|i am|we'?re|we are|i'?m also|as) (?:a |an |the )?(?:landlord|property manager|property owner|house owner|rental owner)\b/,
  /\b(?:i|we) manage \d+ (?:units?|propert(?:y|ies)|houses?|homes?|rooms|doors|apartments?)\b/,
  /\bmanage \d+ (?:units?|propert(?:y|ies)|houses?|rooms|doors)\b/,
];

/** A person already living in a home on PropLane, asking to be set up. */
const RESIDENT_SELF_ID: RegExp[] = [
  /\bmy (?:landlord|property manager|manager|building|house) (?:uses|is on|is using|signed (?:me )?up (?:for|on|with))\b[^.?!]{0,20}\bpropl\w+/,
  /\bi live at \d/,
  /\b(?:i'?m|i am) (?:a |an )?(?:current )?(?:resident|tenant) (?:at|of|in)\b/,
];

export function readSignupRole(text: string): SignupRole | null {
  const t = norm(text);
  if (!t) return null;
  const manager = MANAGER_WORDS.exec(t);
  const resident = RESIDENT_WORDS.exec(t);
  const vendor = VENDOR_WORDS.exec(t) ?? (extractTrade(t) ? ({ index: 0 } as RegExpExecArray) : null);
  // A resident who says "my landlord" is the resident, not the landlord.
  if (resident && /\bmy (?:landlord|property manager|manager)\b/.test(t) && !/\bi'?m (?:a |the )?(?:landlord|manager|owner)\b/.test(t)) return "resident";
  const hits = [
    manager ? { role: "manager" as const, at: manager.index } : null,
    vendor ? { role: "vendor" as const, at: vendor.index } : null,
    resident ? { role: "resident" as const, at: resident.index } : null,
  ].filter((hit): hit is { role: SignupRole; at: number } => hit !== null);
  if (hits.length === 0) return null;
  // The role named first wins ("sign me up as a vendor, my landlord ..." is a vendor).
  return hits.sort((a, b) => a.at - b.at)[0]!.role;
}

/** The answer to "property manager, vendor, or resident?": a word, or 1 / 2 / 3. */
export function readSignupRoleAnswer(text: string): SignupRole | null {
  const t = norm(text).replace(/[.!]+$/g, "");
  if (t === "1") return "manager";
  if (t === "2") return "vendor";
  if (t === "3") return "resident";
  return readSignupRole(t);
}

export function readSignupIntent(text: string): SignupIntent {
  const t = norm(text);
  const none: SignupIntent = { wantsSignup: false, role: null, implicit: false };
  if (!t || t.length > 400) return none;
  if (NOT_AN_ACCOUNT.test(t)) return none;

  if (SIGNUP_VERB.test(t)) {
    // "sign up for a tour" style asks were excluded above; a bare renter search that merely contains "register" is not one either.
    if (isHousingSearchText(t) && !MANAGER_WORDS.test(t) && !VENDOR_WORDS.test(t) && !RESIDENT_WORDS.test(t)) return none;
    return { wantsSignup: true, role: readSignupRole(t), implicit: false };
  }
  if (MANAGER_SELF_ID.some((re) => re.test(t))) {
    // "I'm a landlord looking for a place to rent" is a search, not a sign-up.
    if (isHousingSearchText(t)) return none;
    return { wantsSignup: true, role: "manager", implicit: true };
  }
  // "I live at 61 Elm and the sink is broken" is a repair, answered by the resident flows, not a sign-up.
  const repair = /\b(?:broken|leak\w*|repair|fix|maintenance|not working|clog\w*|no heat|no hot water|flood\w*|rent|pay|late|lease|lockout|locked out)\b/;
  if (RESIDENT_SELF_ID.some((re) => re.test(t)) && !isHousingSearchText(t) && !repair.test(t)) {
    return { wantsSignup: true, role: "resident", implicit: true };
  }
  return none;
}

// ---------------------------------------------------------------------------
// Commands inside the conversation
// ---------------------------------------------------------------------------

export function isCancelText(text: string): boolean {
  return /^(?:cancel|never ?mind|nevermind|forget it|stop signup|stop sign ?up|exit|quit|no thanks|no thank you)\b/i.test(text.trim());
}

export function isRestartText(text: string): boolean {
  return /^(?:start over|restart|reset|begin again)\W*$/i.test(text.trim());
}

export function isSkipText(text: string): boolean {
  return /^(?:skip|pass|later|no|none|nope|n\/a|na|not now|no email|i don'?t have one|dont have one|-)\W*$/i.test(text.trim());
}

export function isResendCodeText(text: string): boolean {
  return /^(?:code|resend|resend code|new code|send (?:me )?(?:a )?(?:new )?code|again|didn'?t (?:get|receive) (?:it|a code|the code)|no code)\W*$/i.test(text.trim());
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export type Parsed<T> = { kind: "value"; value: T } | { kind: "skip" } | { kind: "invalid" };

const CONTROL_WORD = /^(?:yes|y|yeah|yep|ok|okay|sure|help|stop|start|unsubscribe|cancel|hi|hello|hey|thanks|thank you)\W*$/i;

function titleCaseIfFlat(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (!letters) return name;
  const flat = letters === letters.toLowerCase() || letters === letters.toUpperCase();
  return flat ? name.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase()) : name;
}

/** "my name is jane doe", "Jane Doe", "I'm Jane" -> "Jane Doe". Null when it does not look like a name. */
export function parseFullName(text: string): string | null {
  let t = String(text ?? "").trim().replace(/\s+/g, " ");
  t = t.replace(/^(?:my name is|my name'?s|name is|name:|i'?m|i am|it'?s|its|this is|call me|they call me)\s+/i, "").replace(/[.!,]+$/g, "").trim();
  if (t.length < 2 || t.length > 80) return null;
  if (CONTROL_WORD.test(t) || isSkipText(t)) return null;
  if (/[@\d?!:/\\()<>#$%^&*=+_[\]{}|~`"]/.test(t)) return null;
  if (!/^[\p{L}][\p{L}\p{M}.'’ -]*$/u.test(t)) return null;
  if (t.split(" ").length > 6) return null;
  return titleCaseIfFlat(t);
}

export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/** A business or workspace name. Skip keeps the default workspace name. */
export function parseBusinessName(text: string): Parsed<string> {
  let t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (isSkipText(t)) return { kind: "skip" };
  t = t.replace(/^(?:it'?s|its|we'?re|we are|i'?m|my (?:business|company|workspace) is|called|name is|the name is)\s+/i, "").replace(/[.!]+$/g, "").trim();
  if (t.length < 2 || t.length > 80) return { kind: "invalid" };
  if (CONTROL_WORD.test(t) || /[?<>]/.test(t) || /https?:\/\//i.test(t)) return { kind: "invalid" };
  return { kind: "value", value: t };
}

/** How many homes a manager runs. 0 ("none yet") is a valid answer. */
export function parseHomeCount(text: string): Parsed<number> {
  const t = norm(text).replace(/[.!]+$/g, "");
  if (isSkipText(t)) return { kind: "skip" };
  if (/^(?:none|none yet|zero|no homes?|not yet|just starting|just starting out|starting out|no properties|nothing yet)$/.test(t)) return { kind: "value", value: 0 };
  const digits = /\b(\d{1,3})\b/.exec(t);
  if (digits) return { kind: "value", value: Number(digits[1]) };
  const word = t.split(" ").map((w) => parseCount(w)).find((n): n is number => n !== null);
  return word !== undefined ? { kind: "value", value: word } : { kind: "invalid" };
}

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** An email, lowercased. It is a CLAIM only: stored unverified, never a login (see signup/provision.server.ts). */
export function parseEmailAnswer(text: string): Parsed<string> {
  const raw = String(text ?? "").trim();
  if (isSkipText(raw)) return { kind: "skip" };
  const match = EMAIL_RE.exec(raw);
  if (!match) return { kind: "invalid" };
  const email = match[0].toLowerCase();
  if (email.length > 254 || /\.invalid$/.test(email)) return { kind: "invalid" };
  return { kind: "value", value: email };
}

/** A short free-text answer (a home, a trade, an area). Skip is allowed. */
export function parseShortAnswer(text: string, max = 80): Parsed<string> {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (isSkipText(t)) return { kind: "skip" };
  if (t.length < 2 || CONTROL_WORD.test(t) || /https?:\/\//i.test(t)) return { kind: "invalid" };
  return { kind: "value", value: t.slice(0, max) };
}

/** A resident's home: a street address in the text, else the short answer. */
export function parseHomeAnswer(text: string): Parsed<string> {
  const address = extractAddress(text);
  if (address) return { kind: "value", value: address };
  return parseShortAnswer(text, 80);
}

/** The 6 digits of a code reply, tolerating spaces and a short preamble ("it's 123 456"). */
export function readCodeReply(text: string): string | null {
  const digits = String(text ?? "").replace(/[\s-]/g, "");
  const exact = /^\D{0,12}(\d{6})\D{0,3}$/.exec(digits);
  return exact ? exact[1]! : null;
}
