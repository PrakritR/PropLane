import { toGsm7 } from "@/lib/one-number/segments";
import { composeProspectReply, isSendableProspectUrl } from "@/lib/prospect-replies/compose";
import { classifyProspectIntents } from "@/lib/prospect-replies/intents";
import type { ProspectIntentId, ProspectLinks, ProspectReplyFacts } from "@/lib/prospect-replies/types";

/**
 * Which house is this prospect asking about? Most listing sites forbid links in the ad, so the FIRST text a prospect sends
 * the line is where they learn the right house's pages: the house must be identified reliably, and never guessed.
 *
 * Order of evidence: the house the message names (a street number such as "5259" or "4709", or all of a street name's
 * distinctive words), else the home the prospect is already known to be about (the listing they came from, `knownPropertyId`),
 * else ask ONE short question that carries every home's page. Two houses on one street ("Brooklyn") are ambiguous, never a guess.
 */
export type PickableHome = {
  /** The listing's own property id: the key every link is minted from, never the name or the position in a list. */
  propertyId: string;
  /** "4709A 8th Ave NE" */
  title: string;
  links: ProspectLinks;
  /** What the listing record says, read live for this property id. Absent = unknown, never a guess. */
  facts?: ProspectReplyFacts | null;
};

export type HomePick =
  | { kind: "one"; home: PickableHome; via: "named" | "known" }
  | { kind: "ask"; candidates: PickableHome[] };

const STREET_WORDS = new Set(["ave", "avenue", "st", "street", "rd", "road", "blvd", "dr", "drive", "ln", "lane", "way", "ct", "court", "pl", "place", "ne", "nw", "se", "sw", "n", "s", "e", "w", "house", "home", "the", "at", "in", "on", "of", "and", "a", "an"]);

function tokens(text: string): string[] {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

function streetNumber(title: string): string | null {
  const first = tokens(title)[0] ?? "";
  return /^\d{2,}[a-z]?$/.test(first) ? first : null;
}

/** The street's own words ("8th", "brooklyn"): everything after the street number that is not a generic street word. */
function nameTokens(title: string): string[] {
  const all = tokens(title);
  const rest = streetNumber(title) ? all.slice(1) : all;
  return rest.filter((token) => !STREET_WORDS.has(token));
}

/** Does the text name this home? Its street number (with or without the unit letter), or every word of its street name. */
function namesHome(words: Set<string>, home: PickableHome): "number" | "street" | null {
  const number = streetNumber(home.title);
  if (number) {
    const bare = number.replace(/[a-z]$/, "");
    if (words.has(number) || (bare !== number && words.has(bare))) return "number";
    // "4709 a" typed with a space: the digits alone still name the house.
  }
  const street = nameTokens(home.title);
  if (street.length > 0 && street.every((token) => words.has(token))) return "street";
  // "8th ave" / "8th": an ordinal street ("8th") is a name too.
  return null;
}

export function identifyHome(input: { message: string; homes: readonly PickableHome[]; knownPropertyId?: string | null }): HomePick {
  const homes = input.homes.filter((home) => home.propertyId && isSendableProspectUrl(home.links.listing));
  const words = new Set(tokens(input.message));
  const byNumber = homes.filter((home) => namesHome(words, home) === "number");
  if (byNumber.length === 1) return { kind: "one", home: byNumber[0]!, via: "named" };
  if (byNumber.length > 1) return { kind: "ask", candidates: byNumber };
  const byStreet = homes.filter((home) => namesHome(words, home) === "street");
  if (byStreet.length === 1) return { kind: "one", home: byStreet[0]!, via: "named" };
  if (byStreet.length > 1) return { kind: "ask", candidates: byStreet };
  const known = input.knownPropertyId ? homes.find((home) => home.propertyId === input.knownPropertyId) : undefined;
  if (known) return { kind: "one", home: known, via: "known" };
  return { kind: "ask", candidates: [...homes] };
}

/**
 * The one question for a prospect whose house is not clear, with each candidate's own page in the same text so they can
 * tap straight to it. The links come from each home's own record by property id; the order never decides which link a
 * home gets.
 */
export function composeHomePickerReply(candidates: readonly PickableHome[]): string {
  const homes = candidates.filter((home) => isSendableProspectUrl(home.links.listing));
  if (homes.length === 0) return "";
  const names = homes.map((home) => home.title);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  const lines = [`Which house are you asking about, ${list}?`, ...homes.map((home) => `${home.title}: ${home.links.listing}`)];
  return toGsm7(lines.join("\n"));
}

export type FirstReply = { text: string; bubbles: string[]; pick: HomePick; intents: ProspectIntentId[] };

/**
 * The reply to a prospect's FIRST text on the line. The house is identified first (`identifyHome`); only then is anything
 * about a home answered, from THAT home's own facts and links. A prospect who just asks what else there is gets the browse
 * page; a prospect whose house is unclear gets the one question with every home's page, and no fact about any home.
 */
export function composeFirstReply(input: {
  message: string;
  homes: readonly PickableHome[];
  knownPropertyId?: string | null;
  browseUrl?: string | null;
  /** The prospect's first name when the line knows it: the reply opens "Hi Ikshita!", never a business preamble. */
  firstName?: string | null;
}): FirstReply {
  const intents = classifyProspectIntents(input.message);
  const pick = identifyHome(input);
  const greeting = greetingFor(input.firstName);
  const done = (text: string, bubbles: string[] = [text]): FirstReply => ({ text, bubbles, pick, intents });
  if (pick.kind === "one") {
    const reply = composeProspectReply({ message: input.message, facts: pick.home.facts ?? null, links: { ...pick.home.links, ...(input.browseUrl ? { browse: input.browseUrl } : {}) }, firstReply: true });
    const text = greeting ? toGsm7(`${greeting} ${reply.text}`) : reply.text;
    return done(text);
  }
  const nothingNamed = pick.candidates.length === input.homes.length;
  if (nothingNamed && intents.length > 0 && intents.every((id) => id === "browse") && input.browseUrl) {
    return done(composeProspectReply({ message: input.message, facts: null, links: { browse: input.browseUrl } }).text);
  }
  // "What's available?" with no house named: every house's checked rooms, each with its own pages, never a guess at one house.
  const asksWhatThereIs = intents.some((id) => id === "availability" || id === "price" || id === "photos") || /\b(details?|accommodations?|more info|information|share more|what do you have)\b/i.test(input.message);
  if (asksWhatThereIs) {
    const rundown = composeAvailabilityRundown(pick.candidates, { greeting });
    if (rundown) return done(rundown.join("\n\n"), rundown);
  }
  return done(composeHomePickerReply(pick.candidates));
}

function greetingFor(firstName: string | null | undefined): string {
  const name = String(firstName ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-z][A-Za-z'-]{0,24}$/.test(name) ? `Hi ${name[0]!.toUpperCase()}${name.slice(1)}!` : "";
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTH[(m ?? 1) - 1]} ${d}`;
}

const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

/** "Rooms 6 and 9" / "Room 4" from "Room 6", "Room 9"; names that are not "Room N" are listed as written. */
function roomWords(names: string[]): string {
  const numbers = names.map((name) => /^room\s+(\w+)$/i.exec(name.trim())?.[1] ?? null);
  const all = numbers.every(Boolean);
  const parts = all ? (numbers as string[]) : names;
  const list = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return all ? `${parts.length === 1 ? "Room" : "Rooms"} ${list}` : list;
}

/** One house's line in the captain's voice: "4709A 8th Ave NE ($1,000/mo): Rooms 6 and 9 now, Room 4 Oct 28." Null when no room's availability was checked. */
export function availabilityLine(home: PickableHome): string | null {
  const facts = home.facts;
  if (!facts) return null;
  const checked = facts.rooms.filter((room) => room.freeNow !== null && room.freeNow !== undefined || room.freeFrom);
  if (checked.length === 0) return null;
  const now = checked.filter((room) => room.freeNow === true).map((room) => room.name);
  const later = checked.filter((room) => room.freeNow !== true && room.freeFrom).sort((a, b) => String(a.freeFrom).localeCompare(String(b.freeFrom)));
  const rents = facts.rooms.map((room) => room.monthlyRent).filter((rent): rent is number => typeof rent === "number" && rent > 0);
  const price = rents.length === 0 ? "" : ` (${Math.min(...rents) === Math.max(...rents) ? "" : "from "}${money(Math.min(...rents))}/mo)`;
  const bits: string[] = [];
  if (now.length > 0) bits.push(`${roomWords(now)} now`);
  for (const room of later.slice(0, 3)) bits.push(`${roomWords([room.name])} ${shortDate(room.freeFrom as string)}`);
  return `${home.title}${price}: ${bits.length > 0 ? bits.join(", ") : "nothing open right now"}.`;
}

/**
 * The reply to "what's available?": one text per house (the captain's own Marketplace answer, as several quick texts), each
 * with its listing page and tour page from that house's own property id, then one closing question. Every room, date and price
 * is read from the live listing records this turn; a house whose availability could not be checked is left out rather than
 * guessed. Null when no house has a checked room (the caller then asks which house).
 */
export function composeAvailabilityRundown(homes: readonly PickableHome[], options: { greeting?: string } = {}): string[] | null {
  const bubbles: string[] = [];
  for (const home of homes) {
    const line = availabilityLine(home);
    if (!line || !isSendableProspectUrl(home.links.listing)) continue;
    const tour = isSendableProspectUrl(home.links.tour) ? `\nWant to tour? Pick a time: ${home.links.tour}` : "";
    bubbles.push(toGsm7(`${line}\n${home.links.listing}${tour}`));
  }
  if (bubbles.length === 0) return null;
  if (options.greeting) bubbles[0] = toGsm7(`${options.greeting} ${bubbles[0]}`);
  bubbles.push(bubbles.length > 1 ? "Which one are you interested in?" : "Want me to set up a tour?");
  return bubbles;
}
