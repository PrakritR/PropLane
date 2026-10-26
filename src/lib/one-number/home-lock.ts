import type { MockProperty } from "@/data/types";
import { toGsm7, type LeadOffer, type LeadProfile } from "@/lib/one-number/lead-qualifying";
import { streetLine } from "@/lib/one-number/house-redirect";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";

/**
 * The PropLane line locks a texter to ONE home the first time they pick or name one. This file is the pure part: the
 * words the line says around the lock, and the readings of "yes", "no", "the other one" and "#2". No database, no model:
 * everything a prospect is told is built here from facts the caller already holds, and no offer ever carries a number.
 */

/** The one reply a stranger gets when their first text names nothing specific ("hi", "who is this"). */
export const HOLD_REPLY = "Hi! This is PropLane. Which home are you texting about? (street or house name)";

/** "4709A 8th Ave NE, Room 3": the street line and, when known, the room. Never a city, a unit code or a door code. */
export function homeLabel(home: Pick<MockProperty, "address" | "unitLabel"> | { label: string }, roomName?: string | null): string {
  if ("label" in home) return roomName ? `${home.label}, ${roomName}` : home.label;
  const street = streetLine(home.address);
  const room = (roomName ?? "").trim() || String((home as { unitLabel?: string }).unitLabel ?? "").trim();
  return room ? `${street}, ${room}` : street;
}

/** The label of an offered room: the offer's street line plus its room. */
export const offerLabel = (offer: Pick<LeadOffer, "label" | "roomName">): string => homeLabel({ label: offer.label }, offer.roomName);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/**
 * "Looking for: private room near UW · under $1200 · Dec 1 · 6 mo": the one-line summary the locked manager's
 * conversation opens with, in place of the browsing transcript. Null when the prospect told us nothing to summarize.
 */
export function lookingForLine(profile: LeadProfile): string | null {
  const skipped = new Set(profile.skipped ?? []);
  const kind = profile.bathroom === "private" ? "private room" : profile.bathroom === "shared" ? "room with a shared bath" : "room";
  const area = profile.area && !skipped.has("area") ? ` near ${profile.area.trim()}` : "";
  const parts: string[] = [];
  const hasAny = Boolean(profile.bathroom || profile.area || profile.budgetMax || profile.moveInDate || profile.leaseMonths !== undefined);
  if (!hasAny) return null;
  parts.push(`${kind}${area}`);
  if (profile.budgetMax && !skipped.has("budget")) parts.push(`under $${profile.budgetMax}`);
  if (profile.moveInDate) parts.push(shortDate(profile.moveInDate));
  else if (profile.moveInAsap) parts.push("ASAP");
  if (profile.leaseMonths !== undefined) parts.push(profile.leaseMonths === 0 ? "month to month" : `${profile.leaseMonths} mo`);
  return `Looking for: ${parts.join(" \u00b7 ")}`;
}

/** "12 Ravenna Pl is listed by Marcus. To learn more or book a tour, text Marcus at (206) 555-0142." */
export function paidInterestReply(input: { label: string; firstName: string; number: string }): string {
  const who = input.firstName.trim() || "the manager";
  return toGsm7(`${input.label} is listed by ${who}. To learn more or book a tour, text ${who} at ${formatUsPhoneDisplay(input.number)}.`);
}

/** Said when a paid home is asked about but its manager's number cannot be named: nothing about the home, no guess. */
export const PAID_NUMBER_UNAVAILABLE_REPLY = "I can only help with homes PropLane manages. Tell me your area, budget and move-in date and I will find you a room.";

/** "Are you asking about 4709A 8th Ave NE, Room 3?" for one home; "Which one? 1) ... 2) ..." for several. */
export function switchQuestion(labels: readonly string[]): string {
  if (labels.length === 1) return toGsm7(`Are you asking about ${labels[0]}?`);
  return toGsm7(`Which one? ${labels.map((l, i) => `${i + 1}) ${l}`).join(" ")}`);
}

export const stillTalkingReply = (label: string): string => toGsm7(`OK, still talking about ${label}.`);

/** What a re-lock to a PropLane-managed or free-manager home says: the home and how to go on. Built from the offer, never the model. */
export function relockDetailsReply(input: { label: string; rent: number | null; availability: string | null }): string {
  const facts = [input.rent ? `$${input.rent}/mo` : null, input.availability].filter(Boolean).join(", ");
  return toGsm7(`${input.label}${facts ? `: ${facts}` : ""}. Want to see it? Text me a day and time to tour.`);
}

// ---------------------------------------------------------------------------
// Reading the prospect
// ---------------------------------------------------------------------------

const YES = /^(?:yes|yeah|yep|yup|y|ya|yea|sure|ok|okay|correct|right|that'?s (?:right|it|the one)|that one|please|go ahead|do it)\b[\s.!]*$/i;
const NO = /^(?:no|nope|nah|n|not (?:that|this) one|never ?mind|nevermind|cancel|wrong|no thanks?|no thank you)\b[\s.!]*$/i;

/** A bare yes or no to the switch question. Anything else is not an answer. */
export function parseYesNo(text: string): "yes" | "no" | null {
  const t = text.trim();
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return null;
}

export type OfferReference = { kind: "other" } | { kind: "index"; n: number };

const ORDINAL: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };

/**
 * Does the text point at an offered home by position ("the other one", "the first one", "#2", "interested in 3", "option
 * 2") rather than by name? Deliberately narrow: "is the second bedroom furnished" is not a reference.
 */
export function offerReference(text: string): OfferReference | null {
  const t = text.trim();
  if (!t) return null;
  const marked = t.match(/(?:#\s*|\boption\s+|\bnumber\s+|\bno\.?\s*)(\d)\b/i);
  if (marked) return { kind: "index", n: Number(marked[1]) };
  const interested = t.match(/\b(?:interested in|tell me (?:more )?about|what about|how about|show me|tour|visit|see)\s+(?:the\s+)?(\d)\b/i);
  if (interested) return { kind: "index", n: Number(interested[1]) };
  const ordinal = t.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:one|option|choice|home|house|place|listing)\b/i);
  if (ordinal) return { kind: "index", n: ORDINAL[ordinal[1]!.toLowerCase()]! };
  if (/\b(?:the\s+)?last\s+(?:one|option|choice)\b/i.test(t)) return { kind: "index", n: 99 };
  if (/\b(?:the\s+)?(?:other|another|different)\s+(?:one|option|home|house|place|listing)\b/i.test(t) || /\bthe other\b/i.test(t)) return { kind: "other" };
  if (/^(\d)[.!\s]*$/.test(t)) return { kind: "index", n: Number(t) };
  return null;
}

const TOUR_WORD = /\b(?:tour|tours|touring|visit|viewing|see (?:it|the (?:room|house|place|home))|book(?:ing)?|schedule|appointment)\b/i;
const DAY_WORD = /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|this (?:week|weekend)|next week|\d{1,2}\/\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2})\b/i;

/** "can I tour Saturday": a tour or booking ask with a day. One of the two things (with naming a home) that make a stranger's text specific. */
export function asksTourWithDay(text: string): boolean {
  return TOUR_WORD.test(text) && DAY_WORD.test(text);
}

/** Did the prospect say they want the home (so a paid manager's number may be given)? A pick, a yes and "interested in" all count. */
export function expressesInterest(text: string): boolean {
  return /\b(?:interested|tour|visit|book|apply|application|rent (?:it|this|that)|take it|available|still open|more info|tell me more|learn more|details|price|how much)\b/i.test(text);
}
